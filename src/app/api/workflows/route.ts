/**
 * GET  /api/workflows — workflow definitions, recent runs and the scheduler view.
 * POST /api/workflows — create a definition from the visual builder, or run one now.
 */
import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb, schedules, workflowRuns, workflows } from '@/lib/db'
import { ApiError, created, ok, parseBody, withApi } from '@/lib/api/http'
import { executeWorkflow } from '@/lib/workflows/engine'
import { describeCron, isValidCron, nextCronRun } from '@/lib/scheduler/cron'
import { WORKFLOW_TEMPLATES, type WorkflowDefinition } from '@/lib/workflows/defaults'

export const dynamic = 'force-dynamic'

const NODE_KINDS = [
  'trigger', 'research', 'filter', 'score', 'analyze', 'strategy', 'approval',
  'build', 'launch', 'monitor', 'optimize', 'notify', 'delay',
] as const

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const [definitions, runs, scheduleRows] = await Promise.all([
    db.select().from(workflows).where(eq(workflows.workspaceId, workspaceId)).orderBy(desc(workflows.updatedAt)),
    db.select().from(workflowRuns).where(eq(workflowRuns.workspaceId, workspaceId)).orderBy(desc(workflowRuns.startedAt)).limit(25),
    db.select().from(schedules).where(and(eq(schedules.workspaceId, workspaceId), eq(schedules.enabled, true))).orderBy(schedules.nextRunAt),
  ])

  return ok({
    workflows: definitions.map((definition) => {
      const nodes = (definition.definition?.nodes ?? []) as { id: string; type: string }[]
      const edges = (definition.definition?.edges ?? []) as unknown[]
      return {
        ...definition,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodeTypes: Array.from(new Set(nodes.map((node) => node.type))),
        scheduleDescription: definition.schedule ? describeCron(definition.schedule) : null,
      }
    }),
    runs,
    schedules: scheduleRows.map((row) => ({ ...row, description: describeCron(row.cron) })),
    templates: WORKFLOW_TEMPLATES.map((template) => ({
      key: template.key,
      name: template.name,
      description: template.description,
      schedule: template.schedule ?? null,
      nodeCount: template.definition.nodes.length,
      definition: template.definition,
    })),
    nodeCatalog: NODE_KINDS.map((kind) => ({ kind, description: NODE_DESCRIPTIONS[kind] ?? '' })),
  })
})

const NODE_DESCRIPTIONS: Record<string, string> = {
  trigger: 'Entry point for the run',
  research: 'Collect new opportunities from configured sources',
  filter: 'Drop items below the relevance / score threshold',
  score: 'Score every opportunity',
  analyze: 'Deep analysis of each opportunity',
  strategy: 'Generate a go-to-market strategy',
  approval: 'Pause and wait for a human decision',
  build: 'Generate the project deliverables',
  launch: 'Launch the project (always requires approval)',
  monitor: 'Watch results and raise alerts',
  optimize: 'Apply improvements to a running project',
  notify: 'Send a notification',
  delay: 'Wait for a fixed duration',
}

const createSchema = z.object({
  name: z.string().min(3).max(160),
  description: z.string().max(2000).default(''),
  schedule: z.string().max(120).nullable().default(null),
  templateKey: z.string().max(60).optional(),
  definition: z
    .object({
      nodes: z
        .array(
          z.object({
            id: z.string().min(1).max(80),
            type: z.enum(NODE_KINDS),
            label: z.string().max(120).default(''),
            config: z.record(z.unknown()).default({}),
            dependsOn: z.array(z.string().max(80)).max(20).optional(),
            continueOnError: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(60),
      edges: z
        .array(z.object({ from: z.string().max(80), to: z.string().max(80) }))
        .max(120)
        .default([]),
    })
    .optional(),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, createSchema)

  let definition: WorkflowDefinition | undefined = input.definition as WorkflowDefinition | undefined
  if (!definition && input.templateKey) {
    const template = WORKFLOW_TEMPLATES.find((entry) => entry.key === input.templateKey)
    if (!template) throw new ApiError('not_found', `No workflow template named "${input.templateKey}".`)
    definition = template.definition
  }
  if (!definition) throw new ApiError('validation_error', 'Provide either a definition or a templateKey.')

  if (input.schedule && !isValidCron(input.schedule)) {
    throw new ApiError('validation_error', `"${input.schedule}" is not a valid 5-field cron expression.`)
  }

  const rows = await db
    .insert(workflows)
    .values({
      workspaceId,
      name: input.name,
      description: input.description,
      definition: definition as unknown as WorkflowDefinition,
      schedule: input.schedule,
      status: 'active',
      enabled: true,
      nextRunAt: input.schedule ? nextCronRun(input.schedule) : null,
    })
    .returning()

  if (input.schedule && rows[0]) {
    await db.insert(schedules).values({
      workspaceId,
      key: `workflow-${rows[0].id.slice(0, 8)}`,
      name: input.name,
      cron: input.schedule,
      jobName: 'workflow.run',
      payload: { workflowId: rows[0].id, workspaceId },
      enabled: true,
      system: false,
      nextRunAt: nextCronRun(input.schedule),
    })
  }

  return created({ workflow: rows[0] })
})

const runSchema = z.object({
  workflowId: z.string().uuid(),
  async: z.boolean().default(false),
  dryRun: z.boolean().default(false),
})

export const PUT = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, runSchema)
  const definition = (
    await db.select().from(workflows).where(and(eq(workflows.id, input.workflowId), eq(workflows.workspaceId, workspaceId))).limit(1)
  )[0]
  if (!definition) throw new ApiError('not_found', 'Workflow not found.')

  const result = await executeWorkflow(
    workspaceId,
    { nodes: definition.definition.nodes, edges: definition.definition.edges } as unknown as WorkflowDefinition,
    { workspaceId, trigger: 'manual', userId: ctx.session.id, workflowId: definition.id, useAi: !input.dryRun },
  )

  await db
    .update(workflows)
    .set({ lastRunAt: new Date(), lastStatus: result.status, runCount: sql`${workflows.runCount} + 1`, updatedAt: new Date() })
    .where(eq(workflows.id, definition.id))

  return ok(result)
})
