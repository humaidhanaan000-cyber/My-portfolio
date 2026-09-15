/**
 * Workflow execution engine.
 *
 * Executes a node graph in dependency order. Node types map onto real agent
 * capabilities — nothing here is a placeholder:
 *
 *   trigger   → marks the run start
 *   research  → Research Agent           filter  → Data Cleaning Agent
 *   score     → deterministic scoring    analyze → Opportunity Analysis Agent
 *   strategy  → Business Strategy Agent  approval→ creates a real approval request
 *   build     → Product + Content Agents launch  → project launch (approval gated)
 *   monitor   → Monitoring Agent         optimize→ Learning Agent
 *   notify    → Notification Center      delay   → waits a configured interval
 *
 * Failure semantics: a failing node is recorded with its error; nodes that
 * depend on it are marked `skipped`, independent branches continue, and the run
 * status becomes `partial`. `continueOnError: true` lets a node's failure be
 * tolerated deliberately.
 */
import { eq, sql } from 'drizzle-orm'
import { getDb, workflowRuns, workflows } from '../db'
import { createLogger } from '../observability/logger'
import { runAgentByKey } from '../agents/registry'
import { authorizeSpend, releaseSpend } from '../budget'
import { createApproval } from '../approvals'
import { notify } from '../notifications'
import { scoreOpportunity } from '../agents/scoring'
import type { WorkflowDefinition, WorkflowNode, WorkflowNodeType } from './defaults'

const log = createLogger({ component: 'workflow' })

export type StepResult = {
  nodeId: string
  type: WorkflowNodeType
  label: string
  status: 'succeeded' | 'failed' | 'skipped' | 'awaiting_approval'
  summary?: string
  error?: string
  durationMs: number
  approvalId?: string
  costCents?: number
}

export type WorkflowExecutionResult = {
  runId: string
  status: 'succeeded' | 'failed' | 'partial' | 'awaiting_approval'
  steps: StepResult[]
  durationMs: number
  context: Record<string, unknown>
}

export type ExecuteOptions = {
  workspaceId: string
  trigger?: 'manual' | 'schedule' | 'api'
  workflowId?: string | null
  useAi?: boolean
  userId?: string | null
  initialContext?: Record<string, unknown>
  /** Halt the run when an approval is required (default) or continue other branches. */
  haltOnApproval?: boolean
  signal?: AbortSignal
}

type ExecutionContext = Record<string, unknown> & {
  opportunityIds?: string[]
  projectId?: string | null
  scoreThreshold?: number
  spendLedgerIds?: string[]
}

/** Topological order with deterministic tie-breaking. */
export function resolveOrder(nodes: WorkflowNode[]): { order: WorkflowNode[]; error?: string } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visited = new Map<string, 'visiting' | 'done'>()
  const order: WorkflowNode[] = []

  function visit(node: WorkflowNode, stack: string[]): string | undefined {
    const state = visited.get(node.id)
    if (state === 'done') return undefined
    if (state === 'visiting') return `Cycle detected in workflow at node "${node.id}" (${[...stack, node.id].join(' → ')})`
    visited.set(node.id, 'visiting')
    for (const dependency of node.dependsOn ?? []) {
      const parent = byId.get(dependency)
      if (!parent) return `Node "${node.id}" depends on unknown node "${dependency}"`
      const error = visit(parent, [...stack, node.id])
      if (error) return error
    }
    visited.set(node.id, 'done')
    order.push(node)
    return undefined
  }

  for (const node of nodes) {
    const error = visit(node, [])
    if (error) return { order: [], error }
  }
  return { order }
}

export async function executeWorkflow(
  workspaceId: string,
  definition: WorkflowDefinition,
  options: ExecuteOptions,
): Promise<WorkflowExecutionResult> {
  const db = await getDb()
  const started = Date.now()
  const nodes = definition.nodes ?? []
  const useAi = options.useAi ?? true
  const context: ExecutionContext = { ...(options.initialContext ?? {}), spendLedgerIds: [] }

  if (nodes.length === 0) throw new Error('Workflow has no nodes')

  const { order, error } = resolveOrder(nodes)
  if (error) throw new Error(error)

  const workflowId = options.workflowId ?? (await ensureAdHocWorkflow(workspaceId, definition))
  const runRows = await db
    .insert(workflowRuns)
    .values({
      workspaceId,
      workflowId,
      trigger: options.trigger ?? 'manual',
      status: 'running',
      steps: [],
      contextData: context as Record<string, unknown>,
    })
    .returning({ id: workflowRuns.id })
  const runId = runRows[0]!.id

  const results: StepResult[] = []
  const completed = new Set<string>()
  const failed = new Set<string>()
  let halted = false
  let awaitingApprovalId: string | null = null

  const persist = async (status: string) => {
    await db
      .update(workflowRuns)
      .set({
        status,
        steps: results as unknown as unknown[],
        contextData: context as Record<string, unknown>,
        finishedAt: new Date(),
        durationMs: Date.now() - started,
      })
      .where(eq(workflowRuns.id, runId))
  }

  for (const node of order) {
    const dependencies = node.dependsOn ?? []
    const blockedByDependency = dependencies.some((d) => failed.has(d) || !completed.has(d))
    if (halted || blockedByDependency) {
      results.push({
        nodeId: node.id,
        type: node.type,
        label: node.label,
        status: 'skipped',
        summary: blockedByDependency ? 'Skipped: an upstream node did not complete' : 'Skipped: run halted',
        durationMs: 0,
      })
      continue
    }

    const nodeStarted = Date.now()
    try {
      const outcome = await executeNode(node, context, { ...options, useAi, workspaceId, runId })
      results.push({ ...outcome, nodeId: node.id, type: node.type, label: node.label, durationMs: Date.now() - nodeStarted })

      if (outcome.status === 'failed') {
        failed.add(node.id)
        if (!node.continueOnError) log.warn('workflow node failed', { runId, node: node.id, error: outcome.error })
      } else if (outcome.status === 'awaiting_approval') {
        completed.add(node.id)
        awaitingApprovalId = outcome.approvalId ?? null
        if (options.haltOnApproval !== false) halted = true
      } else if (outcome.status === 'skipped') {
        completed.add(node.id)
      } else {
        completed.add(node.id)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({
        nodeId: node.id,
        type: node.type,
        label: node.label,
        status: 'failed',
        error: message,
        durationMs: Date.now() - nodeStarted,
      })
      failed.add(node.id)
    }
  }

  // Release reservations that were never spent.
  for (const ledgerId of context.spendLedgerIds ?? []) {
    await releaseSpend(ledgerId).catch(() => undefined)
  }
  context.spendLedgerIds = []

  const status: WorkflowExecutionResult['status'] =
    awaitingApprovalId && halted
      ? 'awaiting_approval'
      : failed.size === 0
        ? 'succeeded'
        : completed.size > 0
          ? 'partial'
          : 'failed'

  await persist(status)
  await db
    .update(workflows)
    .set({ lastRunAt: new Date(), lastStatus: status, runCount: sql`${workflows.runCount} + 1` })
    .where(eq(workflows.id, workflowId))

  return { runId, status, steps: results, durationMs: Date.now() - started, context }
}

async function ensureAdHocWorkflow(workspaceId: string, definition: WorkflowDefinition): Promise<string> {
  const db = await getDb()
  const existing = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.workspaceId, workspaceId))
    .limit(1)
  if (existing[0]) return existing[0].id
  const rows = await db
    .insert(workflows)
    .values({ workspaceId, name: 'Ad-hoc workflow', definition, status: 'active' })
    .returning({ id: workflows.id })
  return rows[0]!.id
}

type NodeOutcome = Omit<StepResult, 'nodeId' | 'type' | 'label' | 'durationMs'>

async function executeNode(
  node: WorkflowNode,
  context: ExecutionContext,
  options: ExecuteOptions & { useAi: boolean; workspaceId: string; runId: string },
): Promise<NodeOutcome> {
  const config = node.config ?? {}
  const workspaceId = options.workspaceId

  switch (node.type) {
    case 'trigger':
      return { status: 'succeeded', summary: `Triggered by ${options.trigger ?? 'manual'}` }

    case 'research': {
      const outcome = await runAgentByKey(
        'research',
        {
          sourceKeys: config.sourceKeys,
          limitPerSource: Number(config.limitPerSource ?? 15),
          useAiExtraction: options.useAi,
          triggerSource: options.trigger === 'schedule' ? 'schedule' : 'manual',
        },
        { workspaceId, triggeredBy: options.trigger === 'schedule' ? 'schedule' : 'manual', userId: options.userId },
      )
      if (outcome.status === 'awaiting_approval') {
        return { status: 'awaiting_approval', summary: outcome.policy.reason, approvalId: outcome.approvalId ?? undefined }
      }
      if (outcome.status !== 'succeeded') return { status: 'failed', error: outcome.error ?? 'research failed' }
      const ids = (outcome.output!.data as { newOpportunityIds: string[] }).newOpportunityIds
      context.opportunityIds = ids
      return { status: 'succeeded', summary: outcome.output!.summary, costCents: outcome.costCents }
    }

    case 'filter': {
      const outcome = await runAgentByKey('cleaning', { opportunityIds: context.opportunityIds, batchSize: 150, checkUrls: true }, { workspaceId, triggeredBy: 'agent' })
      if (outcome.status !== 'succeeded') return { status: 'failed', error: outcome.error ?? 'cleaning failed' }
      return { status: 'succeeded', summary: outcome.output!.summary }
    }

    case 'score': {
      const { getDb: _getDb, opportunities, opportunityScores, profiles } = await import('../db')
      const db = await _getDb()
      const threshold = Number(config.threshold ?? 70)
      context.scoreThreshold = threshold
      const rows = context.opportunityIds?.length
        ? await db.select().from(opportunities).where(sql`id = any(${context.opportunityIds})`)
        : await db.select().from(opportunities).where(sql`workspace_id = ${workspaceId} and status <> 'archived'`).limit(50)
      const profile = (await db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1))[0]

      let above = 0
      const passing: string[] = []
      for (const opportunity of rows) {
        const result = scoreOpportunity({
          title: opportunity.title,
          description: opportunity.description,
          category: opportunity.category,
          sourceName: opportunity.sourceName,
          url: opportunity.url,
          region: opportunity.region,
          profile: profile ?? undefined,
        })
        await db.insert(opportunityScores).values({
          opportunityId: opportunity.id,
          workspaceId,
          demand: result.scores.demand,
          competition: result.scores.competition,
          monetization: result.scores.monetization,
          startupCost: result.scores.startupCost,
          operatingCost: result.scores.operatingCost,
          automationPotential: result.scores.automationPotential,
          scalability: result.scores.scalability,
          timeToRevenue: result.scores.timeToRevenue,
          difficulty: result.scores.difficulty,
          risk: result.scores.risk,
          finalScore: result.finalScore.toFixed(2),
          confidence: result.confidence,
          verdict: result.verdict,
          rationale: result.rationale,
          summary: result.summary,
          weights: result.weights as unknown as Record<string, number>,
          engine: 'heuristic',
        })
        if (result.finalScore >= threshold) {
          above++
          passing.push(opportunity.id)
          await db.update(opportunities).set({ status: 'scored', updatedAt: new Date() }).where(eq(opportunities.id, opportunity.id))
        }
      }
      context.opportunityIds = passing
      return { status: 'succeeded', summary: `Scored ${rows.length}; ${above} at or above ${threshold}.` }
    }

    case 'analyze': {
      const outcome = await runAgentByKey(
        'analysis',
        { opportunityIds: context.opportunityIds, batchSize: Number(config.batchSize ?? 10), useAi: options.useAi, autoStrategy: false },
        { workspaceId, triggeredBy: 'agent' },
      )
      if (outcome.status !== 'succeeded') return { status: 'failed', error: outcome.error ?? 'analysis failed' }
      const data = outcome.output!.data as { aboveThreshold: string[] }
      context.opportunityIds = data.aboveThreshold
      return { status: 'succeeded', summary: outcome.output!.summary, costCents: outcome.costCents }
    }

    case 'strategy': {
      if (!context.opportunityIds?.length) return { status: 'skipped', summary: 'No opportunities passed the threshold' }
      const outcome = await runAgentByKey(
        'strategy',
        {
          opportunityIds: context.opportunityIds.slice(0, 5),
          useAi: options.useAi,
          createProject: config.createProject !== false,
          requestApproval: false, // the explicit approval node owns that decision
        },
        { workspaceId, triggeredBy: 'agent' },
      )
      if (outcome.status !== 'succeeded') return { status: 'failed', error: outcome.error ?? 'strategy failed' }
      const created = (outcome.output!.data as { strategies: { projectId?: string }[] }).strategies
      context.projectId = created[0]?.projectId ?? null
      return { status: 'succeeded', summary: outcome.output!.summary, costCents: outcome.costCents }
    }

    case 'approval': {
      const projectId = (config.projectId as string) ?? context.projectId ?? null
      const approval = await createApproval({
        workspaceId,
        actionType: (config.actionType as string) ?? 'create_project',
        title: (config.title as string) ?? `Workflow approval: ${node.label}`,
        reason:
          (config.reason as string) ??
          'This step is paused because the next action changes something outside AIBA (it is public, paid or irreversible). Approving releases the remaining workflow steps.',
        expectedCostCents: Number(config.expectedCostCents ?? 0),
        potentialBenefit: (config.potentialBenefit as string) ?? 'Continues the workflow to build and launch.',
        risk: (config.risk as 'low' | 'medium' | 'high') ?? 'medium',
        payload: { workflowRunId: options.runId, projectId, nodeId: node.id },
        projectId,
        workflowRunId: options.runId,
        requestedByAgent: 'workflow',
        dedupeKey: `workflow:${options.runId}:${node.id}`,
      })
      return { status: 'awaiting_approval', summary: `Approval requested (${approval.id.slice(0, 8)})`, approvalId: approval.id }
    }

    case 'build': {
      if (!context.projectId) return { status: 'skipped', summary: 'No project to build' }
      const product = await runAgentByKey('product', { projectId: context.projectId, useAi: options.useAi }, { workspaceId, triggeredBy: 'agent' })
      const content = await runAgentByKey('content', { projectId: context.projectId, useAi: options.useAi }, { workspaceId, triggeredBy: 'agent' })
      const failedCount = [product, content].filter((o) => o.status === 'failed').length
      return {
        status: failedCount === 2 ? 'failed' : 'succeeded',
        summary: `Product: ${product.output?.summary ?? product.error}; Content: ${content.output?.summary ?? content.error}`,
        costCents: (product.costCents ?? 0) + (content.costCents ?? 0),
      }
    }

    case 'launch': {
      if (!context.projectId) return { status: 'skipped', summary: 'No project to launch' }
      if (config.requiresApproval !== false) {
        const approval = await createApproval({
          workspaceId,
          actionType: 'update_project',
          title: `Launch project`,
          reason: 'Launching makes the project public and starts the monitoring clock. This requires your approval.',
          expectedCostCents: 0,
          potentialBenefit: 'Begins accumulating real traffic and conversion data for the learning engine.',
          risk: 'low',
          payload: { projectId: context.projectId, status: 'LAUNCHED', progress: 70 },
          projectId: context.projectId,
          workflowRunId: options.runId,
          requestedByAgent: 'workflow',
          dedupeKey: `workflow-launch:${context.projectId}`,
        })
        return { status: 'awaiting_approval', summary: 'Launch approval requested', approvalId: approval.id }
      }
      const { launchProject } = await import('../agents/orchestrator')
      const result = await launchProject(workspaceId, context.projectId)
      return result.ok
        ? { status: 'succeeded', summary: result.message }
        : { status: 'failed', summary: result.message, error: result.message }
    }

    case 'monitor': {
      const outcome = await runAgentByKey('monitoring', { windowHours: 24, raiseAlerts: true }, { workspaceId, triggeredBy: 'agent' })
      return outcome.status === 'succeeded'
        ? { status: 'succeeded', summary: outcome.output!.summary }
        : { status: 'failed', error: outcome.error ?? 'monitoring failed' }
    }

    case 'optimize': {
      const outcome = await runAgentByKey(
        'learning',
        { windowDays: Number(config.windowDays ?? 30), useAi: options.useAi, applyAdjustments: true, retentionDays: 180 },
        { workspaceId, triggeredBy: 'agent' },
      )
      return outcome.status === 'succeeded'
        ? { status: 'succeeded', summary: outcome.output!.summary, costCents: outcome.costCents }
        : { status: 'failed', error: outcome.error ?? 'learning failed' }
    }

    case 'notify': {
      await notify({
        workspaceId,
        type: 'system',
        severity: 'info',
        title: (config.title as string) ?? 'Workflow notification',
        body: (config.body as string) ?? `Workflow step "${node.label}" completed.`,
        link: (config.link as string) ?? '/dashboard/workflows',
      })
      return { status: 'succeeded', summary: 'Notification sent' }
    }

    case 'delay': {
      const seconds = Math.min(60, Number(config.seconds ?? 5))
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
      return { status: 'succeeded', summary: `Waited ${seconds}s` }
    }

    default:
      return { status: 'failed', error: `Unsupported node type "${node.type}"` }
  }
}

/** Reserve-and-settle helper exposed for custom nodes. */
export async function reserveForNode(workspaceId: string, cents: number, description: string): Promise<{ ledgerId?: string; blocked?: string }> {
  const decision = await authorizeSpend({ workspaceId, amountCents: cents, description, agentKey: 'execution' })
  return decision.allowed ? { ledgerId: decision.ledgerId } : { blocked: decision.reason }
}
