/**
 * Agent runtime.
 *
 * Wraps every agent execution with:
 *   1. input validation (zod)                     — bad input never reaches a model
 *   2. compliance policy evaluation                — prohibited work is refused
 *   3. budget authorization + reservation          — no runaway spend, ever
 *   4. hard timeout + cancellation                  — one agent cannot hang the worker
 *   5. full agent_runs record (cost, tokens, model) — observability & auditing
 *   6. structured memory write                      — learning without unbounded growth
 *   7. failure isolation + alerting                 — a failing agent cannot crash the platform
 */
import { and, eq, sql } from 'drizzle-orm'
import { getDb, agentMemory, agentRuns, agents, profiles, extractRows } from '../db'
import { env } from '../env'
import { createLogger, persistLog } from '../observability/logger'
import { evaluateAction, type AutomationLevel } from '../compliance/policy'
import { authorizeSpend, evaluateBudget, recordExpense, releaseSpend } from '../budget'
import { notify } from '../notifications'
import { createApproval } from '../approvals'
import { raiseAlert } from '../notifications'
import { aiStatus } from '../ai'
import type { AgentContext, AgentDefinition, AgentOutput, AgentRunOutcome } from './types'
import type { LearningAdjustments } from './scoring'

const log = createLogger({ component: 'agent.runtime' })

export type RunAgentOptions = {
  workspaceId: string
  userId?: string | null
  triggeredBy?: AgentContext['triggeredBy']
  jobId?: string | null
  automationLevel?: AutomationLevel
  /** Force execution even if policy would normally require approval (user-initiated). */
  approveImmediately?: boolean
  runId?: string
  signal?: AbortSignal
}

export async function runAgent<TInput, TOutput>(
  definition: AgentDefinition<TInput, TOutput>,
  rawInput: unknown,
  options: RunAgentOptions,
): Promise<AgentRunOutcome<TOutput>> {
  const db = await getDb()
  const started = Date.now()
  const workspaceId = options.workspaceId

  const parsedInput = definition.inputSchema.safeParse(rawInput)
  if (!parsedInput.success) {
    const error = `Invalid input for ${definition.key}: ${parsedInput.error.issues
      .map((i) => `${i.path.join('.')} ${i.message}`)
      .join('; ')}`
    return {
      runId: '',
      agentKey: definition.key,
      status: 'failed',
      error,
      policy: { allowed: false, requiresApproval: false, risk: 'low', reason: 'invalid input', policyLabel: 'input validation', violations: ['invalid_input'], estimatedCostCents: 0 },
      durationMs: Date.now() - started,
      costCents: 0,
    }
  }

  if (options.signal?.aborted) {
    const runId = await recordAbortedRun(definition, parsedInput.data, options)
    await touchAgent(definition.key, 'idle')
    return {
      runId,
      agentKey: definition.key,
      status: 'failed',
      error: 'Run cancelled before execution started.',
      policy: { allowed: false, requiresApproval: false, risk: 'low', reason: 'cancelled', policyLabel: 'cancellation', violations: ['cancelled'], estimatedCostCents: 0 },
      durationMs: Date.now() - started,
      costCents: 0,
    }
  }

  const automationLevel = await resolveAutomationLevel(workspaceId, options.automationLevel)
  const policy = evaluateAction({
    actionType: definition.policyAction,
    automationLevel,
    estimatedCostCents: definition.estimatedCostCents,
    payload: (parsedInput.data ?? {}) as Record<string, unknown>,
  })

  // Record the run row first so an approval, timeout or crash always has a trace.
  const runRows = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentKey: definition.key,
      jobId: options.jobId ?? null,
      triggeredBy: options.triggeredBy ?? 'manual',
      status: policy.allowed || options.approveImmediately ? 'running' : 'awaiting_approval',
      input: (parsedInput.data ?? {}) as Record<string, unknown>,
      provider: null,
    })
    .returning({ id: agentRuns.id })
  const runId = options.runId ?? runRows[0]!.id

  if (!policy.allowed && !options.approveImmediately) {
    const approval = await createApproval({
      workspaceId,
      actionType: definition.policyAction,
      title: `${definition.name}: ${describeInput(parsedInput.data)}`,
      reason: policy.reason,
      expectedCostCents: definition.estimatedCostCents,
      risk: policy.risk === 'prohibited' ? 'high' : policy.risk,
      payload: { agentKey: definition.key, input: parsedInput.data, policy },
      requestedByAgent: definition.key,
      dedupeKey: `${definition.key}:${hashInput(parsedInput.data)}`,
    })
    await db
      .update(agentRuns)
      .set({
        status: 'awaiting_approval',
        output: { approvalId: approval.id, reason: policy.reason } as Record<string, unknown>,
        finishedAt: new Date(),
        durationMs: Date.now() - started,
      })
      .where(eq(agentRuns.id, runId))
    await touchAgent(definition.key, 'idle')
    return {
      runId,
      agentKey: definition.key,
      status: 'awaiting_approval',
      policy,
      durationMs: Date.now() - started,
      costCents: 0,
      approvalId: approval.id,
    }
  }

  await touchAgent(definition.key, 'running')

  /* ------------------------------------------------- budget preflight gate */
  // A paid agent run must be able to pay for itself before it starts. When the
  // remaining budget cannot cover the estimated cost, the run STOPS and asks the
  // operator: hard limits are never silently exceeded.
  const spendCapable = aiStatus().configured && definition.estimatedCostCents > 0
  if (spendCapable && !options.approveImmediately) {
    const preflight = await evaluateBudget({
      workspaceId,
      amountCents: definition.estimatedCostCents,
      description: `${definition.name} estimated run cost`,
      agentKey: definition.key,
      refType: 'agent_run',
      refId: runId,
    })
    if (!preflight.allowed) {
      const approval = await createApproval({
        workspaceId,
        actionType: 'spend_money',
        title: `Budget limit reached before ${definition.name} could run`,
        reason: `${preflight.reason} The run was stopped before making any paid request. Raise the limit, or approve this one-off spend.`,
        expectedCostCents: definition.estimatedCostCents,
        risk: 'medium',
        payload: { agentKey: definition.key, input: parsedInput.data, blockedBy: preflight.checks.filter((check) => !check.ok) },
        requestedByAgent: definition.key,
        dedupeKey: `budget:${definition.key}:${new Date().toISOString().slice(0, 13)}`,
      })
      await db
        .update(agentRuns)
        .set({
          status: 'awaiting_approval',
          output: { approvalId: approval.id, blockedBy: 'budget', reason: preflight.reason } as Record<string, unknown>,
          finishedAt: new Date(),
          durationMs: Date.now() - started,
        })
        .where(eq(agentRuns.id, runId))
      await touchAgent(definition.key, 'idle')
      await notify({
        workspaceId,
        type: 'budget_limit_reached',
        severity: 'warning',
        title: 'Budget limit stopped an agent run',
        body: `${definition.name} needed up to ${(definition.estimatedCostCents / 100).toFixed(2)} USD. ${preflight.reason}`,
        link: '/dashboard/approvals',
        dedupeKey: `budget-blocked:${approval.id}`,
      })
      return {
        runId,
        agentKey: definition.key,
        status: 'awaiting_approval',
        policy: { allowed: false, requiresApproval: true, risk: 'medium', reason: preflight.reason, policyLabel: 'budget guardrail', violations: ['budget_exceeded'], estimatedCostCents: definition.estimatedCostCents },
        durationMs: Date.now() - started,
        costCents: 0,
        approvalId: approval.id,
      }
    }
  }

  /* ---------------------------------------------------------- budget gate */
  let ledgerId: string | undefined
  const reserveSpend: AgentContext['reserveSpend'] = async (amountCents, description, refId) => {
    if (amountCents <= 0) return {}
    const decision = await authorizeSpend({
      workspaceId,
      amountCents,
      description,
      agentKey: definition.key,
      refType: 'agent_run',
      refId: refId ?? runId,
    })
    if (!decision.allowed) return { blocked: decision.reason }
    ledgerId = decision.ledgerId
    return { ledgerId: decision.ledgerId }
  }

  const ai = aiStatus()
  const controller = new AbortController()
  const timeoutMs = definition.timeoutSeconds * 1000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const runLogger = createLogger({ component: 'agent', agent: definition.key, runId, workspaceId })

  const ctx: AgentContext = {
    workspaceId,
    userId: options.userId ?? null,
    runId,
    jobId: options.jobId ?? null,
    triggeredBy: options.triggeredBy ?? 'manual',
    logger: {
      debug: (m, c) => runLogger.debug(m, c),
      info: (m, c) => runLogger.info(m, c),
      warn: (m, c) => runLogger.warn(m, c),
      error: (m, e, c) => runLogger.error(m, e, c),
    },
    automationLevel,
    ai: {
      available: ai.configured && env.AI_ALLOW_NETWORK,
      provider: ai.provider,
      generate: (await import('../ai')).generate,
      generateJson: (await import('../ai')).generateJson,
    },
    reserveSpend,
    signal: options.signal ?? controller.signal,
    now: new Date(),
    learning: await loadLearning(workspaceId),
  }

  try {
    const output = await definition.run(parsedInput.data as TInput, ctx)
    clearTimeout(timer)

    const costCents = Math.max(0, Math.round(output.costCents ?? 0))
    if (ledgerId) {
      if (costCents > 0) {
        await recordExpense({
          workspaceId,
          amountCents: costCents,
          category: 'ai_api',
          description: `${definition.name} run`,
          agentRunId: runId,
          provider: output.provider ?? null,
          verification: output.provider ? 'verified_integration' : 'metered_estimate',
        })
      } else {
        await releaseSpend(ledgerId)
      }
    }

    await db
      .update(agentRuns)
      .set({
        status: 'succeeded',
        output: output as unknown as Record<string, unknown>,
        provider: output.provider ?? null,
        model: output.model ?? null,
        tokensUsed: output.tokens ?? 0,
        costCents,
        durationMs: Date.now() - started,
        finishedAt: new Date(),
        attempt: 1,
      })
      .where(eq(agentRuns.id, runId))

    await touchAgent(definition.key, 'idle', { success: true, durationMs: Date.now() - started })

    if (definition.memory) {
      try {
        await definition.memory(output, parsedInput.data as TInput, ctx)
      } catch (error) {
        runLogger.warn('memory write failed', { message: error instanceof Error ? error.message : String(error) })
      }
    }

    await persistLog({
      level: output.warnings?.length ? 'warn' : 'info',
      source: `agent:${definition.key}`,
      message: output.summary,
      context: { notes: output.notes, warnings: output.warnings, metrics: output.metrics },
      workspaceId,
      userId: options.userId ?? null,
      durationMs: Date.now() - started,
    })

    return {
      runId,
      agentKey: definition.key,
      status: 'succeeded',
      output: output as AgentOutput<TOutput>,
      policy,
      durationMs: Date.now() - started,
      costCents,
    }
  } catch (error) {
    clearTimeout(timer)
    const message = timedOut
      ? `Agent ${definition.key} timed out after ${definition.timeoutSeconds}s`
      : error instanceof Error
        ? error.message
        : String(error)
    const stack = error instanceof Error ? error.stack : undefined

    if (ledgerId) await releaseSpend(ledgerId).catch(() => undefined)

    await db
      .update(agentRuns)
      .set({
        status: timedOut ? 'timeout' : 'failed',
        error: message,
        durationMs: Date.now() - started,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))

    await touchAgent(definition.key, 'error', { failure: true, error: message })

    // Failure isolation: alert, but never rethrow into the caller's loop.
    await raiseAlert({
      workspaceId,
      type: 'agent_failure',
      severity: 'warning',
      title: `${definition.name} failed`,
      message: message.slice(0, 500),
      source: `agent:${definition.key}`,
      metadata: { runId, stack: stack?.split('\n').slice(0, 5).join('\n') },
    }).catch(() => undefined)

    runLogger.error('agent run failed', error, { durationMs: Date.now() - started })

    return {
      runId,
      agentKey: definition.key,
      status: timedOut ? 'timeout' : 'failed',
      error: message,
      policy,
      durationMs: Date.now() - started,
      costCents: 0,
    }
  }
}

async function resolveAutomationLevel(workspaceId: string, override?: AutomationLevel): Promise<AutomationLevel> {
  if (override) return override
  const db = await getDb()
  const rows = await db.select({ level: profiles.automationLevel }).from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1)
  return (rows[0]?.level as AutomationLevel) ?? 'approval_required'
}

/**
 * Aborted runs are recorded as failed so the ledger shows what was attempted and
 * what was stopped — nothing disappears silently.
 */
async function recordAbortedRun<TInput, TOutput>(
  definition: AgentDefinition<TInput, TOutput>,
  input: TInput,
  options: RunAgentOptions,
): Promise<string> {
  const db = await getDb()
  const rows = await db
    .insert(agentRuns)
    .values({
      workspaceId: options.workspaceId,
      agentKey: definition.key,
      jobId: options.jobId ?? null,
      triggeredBy: options.triggeredBy ?? 'manual',
      status: 'failed',
      input: (input ?? {}) as Record<string, unknown>,
      error: 'cancelled',
      finishedAt: new Date(),
    })
    .returning({ id: agentRuns.id })
  return options.runId ?? rows[0]!.id
}

async function touchAgent(
  key: string,
  status: string,
  outcome: { success?: boolean; failure?: boolean; error?: string; durationMs?: number } = {},
): Promise<void> {
  try {
    const db = await getDb()
    await db
      .update(agents)
      .set({
        status,
        lastRunAt: new Date(),
        lastHeartbeatAt: new Date(),
        ...(outcome.success
          ? { successCount: sql`${agents.successCount} + 1`, lastError: null }
          : {}),
        ...(outcome.failure ? { failureCount: sql`${agents.failureCount} + 1`, lastError: outcome.error ?? null } : {}),
        ...(outcome.durationMs
          ? {
              avgDurationMs: sql`((${agents.avgDurationMs} * ${agents.successCount}) + ${outcome.durationMs}) / (${agents.successCount} + 1)`,
            }
          : {}),
      })
      .where(eq(agents.key, key))
  } catch (error) {
    log.warn('could not update agent counters', { key, message: error instanceof Error ? error.message : String(error) })
  }
}

/** Load learned adjustments from the most recent learning-engine summary. */
export async function loadLearning(workspaceId: string): Promise<LearningAdjustments> {
  try {
    const db = await getDb()
    const rows = await db
      .select({ data: agentMemory.data, createdAt: agentMemory.createdAt })
      .from(agentMemory)
      .where(and(eq(agentMemory.workspaceId, workspaceId), eq(agentMemory.agentKey, 'learning'), eq(agentMemory.kind, 'pattern')))
      .orderBy(sql`${agentMemory.createdAt} desc`)
      .limit(3)
    const latest = rows[0]?.data as LearningAdjustments | undefined
    if (!latest) return {}
    return {
      weights: latest.weights,
      categoryBias: latest.categoryBias,
      sourceBias: latest.sourceBias,
      keywordBiases: latest.keywordBiases,
      notes: latest.notes,
    }
  } catch {
    return {}
  }
}

export async function agentHealth(): Promise<
  { key: string; name: string; status: string; enabled: boolean; lastRunAt: Date | null; successCount: number; failureCount: number; avgDurationMs: number; lastError: string | null }[]
> {
  const db = await getDb()
  const rows = await db.select().from(agents).orderBy(agents.key)
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    status: row.status,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    successCount: row.successCount,
    failureCount: row.failureCount,
    avgDurationMs: row.avgDurationMs,
    lastError: row.lastError,
  }))
}

export async function agentRunStats(workspaceId: string, hours = 24) {
  const db = await getDb()
  const result = await db.execute(sql`
    select
      count(*) as total,
      count(*) filter (where status = 'succeeded') as succeeded,
      count(*) filter (where status = 'failed' or status = 'timeout') as failed,
      count(*) filter (where status = 'awaiting_approval') as awaiting_approval,
      coalesce(sum(cost_cents), 0) as cost_cents,
      coalesce(avg(duration_ms), 0) as avg_duration_ms,
      coalesce(sum(tokens_used), 0) as tokens
    from agent_runs
    where workspace_id = ${workspaceId} and started_at >= now() - (${hours} || ' hours')::interval
  `)
  const row = extractRows<{ total: string; succeeded: string; failed: string; awaiting_approval: string; cost_cents: string; avg_duration_ms: string; tokens: string }>(result)[0]
  return {
    total: Number(row?.total ?? 0),
    succeeded: Number(row?.succeeded ?? 0),
    failed: Number(row?.failed ?? 0),
    awaitingApproval: Number(row?.awaiting_approval ?? 0),
    costCents: Number(row?.cost_cents ?? 0),
    avgDurationMs: Number(row?.avg_duration_ms ?? 0),
    tokens: Number(row?.tokens ?? 0),
  }
}

function describeInput(input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>
  const candidate = record.title ?? record.name ?? record.projectName ?? record.opportunityId ?? record.projectId ?? record.action
  return typeof candidate === 'string' ? candidate.slice(0, 80) : 'automated agent action'
}

function hashInput(input: unknown): string {
  const text = JSON.stringify(input ?? {})
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0
  return Math.abs(hash).toString(36)
}
