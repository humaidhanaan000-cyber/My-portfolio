/** GET /api/workflows/:id — definition, runs and steps. PATCH — pause / resume / reschedule. */
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { getDb, schedules, workflows, workflowRuns } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'
import { describeCron, isValidCron, nextCronRun } from '@/lib/scheduler/cron'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workflow = (
    await db.select().from(workflows).where(and(eq(workflows.id, ctx.params.id!), eq(workflows.workspaceId, ctx.session.workspaceId))).limit(1)
  )[0]
  if (!workflow) throw new ApiError('not_found', 'Workflow not found.')
  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflow.id)).orderBy(desc(workflowRuns.startedAt)).limit(20)
  return ok({ workflow: { ...workflow, scheduleDescription: workflow.schedule ? describeCron(workflow.schedule) : null }, runs })
})

const schema = z.object({
  status: z.enum(['active', 'paused', 'archived']).optional(),
  schedule: z.string().max(120).nullable().optional(),
  name: z.string().min(3).max(160).optional(),
  description: z.string().max(2000).optional(),
})

export const PATCH = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const workflow = (
    await db.select().from(workflows).where(and(eq(workflows.id, ctx.params.id!), eq(workflows.workspaceId, workspaceId))).limit(1)
  )[0]
  if (!workflow) throw new ApiError('not_found', 'Workflow not found.')

  const input = await parseBody(ctx.request, schema)
  if (input.schedule && !isValidCron(input.schedule)) {
    throw new ApiError('validation_error', `"${input.schedule}" is not a valid 5-field cron expression.`)
  }

  const rows = await db
    .update(workflows)
    .set({
      ...input,
      ...(input.schedule !== undefined ? { nextRunAt: input.schedule ? nextCronRun(input.schedule) : null } : {}),
      ...(input.status ? { enabled: input.status === 'active' } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workflows.id, workflow.id))
    .returning()

  await db
    .update(schedules)
    .set({
      ...(input.schedule !== undefined ? { cron: input.schedule ?? undefined, nextRunAt: input.schedule ? nextCronRun(input.schedule) : null } : {}),
      ...(input.status ? { enabled: input.status === 'active' } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(schedules.workspaceId, workspaceId), eq(schedules.jobName, 'workflow.run')))

  return ok({ workflow: rows[0] })
})

export const DELETE = withApi(async (ctx) => {
  const db = await getDb()
  const rows = await db
    .update(workflows)
    .set({ status: 'archived', enabled: false, updatedAt: new Date() })
    .where(and(eq(workflows.id, ctx.params.id!), eq(workflows.workspaceId, ctx.session.workspaceId)))
    .returning({ id: workflows.id })
  if (!rows[0]) throw new ApiError('not_found', 'Workflow not found.')
  return ok({ archived: true })
})
