/**
 * GET  /api/approvals/:id — approval detail plus its audit history.
 * POST /api/approvals/:id — decide: approve | reject | edit | defer.
 *
 * Decisions are delegated to the approvals library so that policy is
 * re-evaluated at decision time, budget is reserved, the audit log is written
 * and execution is queued through the durable job queue. When inline execution
 * is enabled the operator gets the real result back in the same response.
 */
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getDb, approvals, auditLogs, jobs } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'
import { decideApproval } from '@/lib/approvals'
import { runJob } from '@/lib/queue'
import { registerAllHandlers } from '@/lib/queue/handlers'
import type { JobRecord } from '@/lib/queue/types'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const row = (
    await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, ctx.params.id!), eq(approvals.workspaceId, ctx.session.workspaceId)))
      .limit(1)
  )[0]
  if (!row) throw new ApiError('not_found', 'Approval not found.')

  const [history, executionJobs] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        actorType: auditLogs.actorType,
        userId: auditLogs.userId,
        createdAt: auditLogs.createdAt,
        after: auditLogs.after,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'approval'), eq(auditLogs.entityId, row.id)))
      .orderBy(auditLogs.createdAt),
    db
      .select({ id: jobs.id, name: jobs.name, status: jobs.status, createdAt: jobs.createdAt, lastError: jobs.lastError, result: jobs.result })
      .from(jobs)
      .where(eq(jobs.dedupeKey, `approval-exec:${row.id}`)),
  ])

  return ok({ approval: row, history, executionJobs })
})

const schema = z.object({
  decision: z.enum(['approve', 'reject', 'edit', 'defer']),
  note: z.string().max(2000).optional(),
  deferUntil: z.string().datetime().optional(),
  edits: z
    .object({
      title: z.string().min(3).max(200).optional(),
      reason: z.string().max(2000).optional(),
      payload: z.record(z.unknown()).optional(),
      expectedCostCents: z.number().int().min(0).optional(),
    })
    .optional(),
  /** Run the approved action immediately instead of waiting for the worker. */
  executeInline: z.boolean().default(true),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, schema)

  const result = await decideApproval({
    workspaceId,
    approvalId: ctx.params.id!,
    decision: input.decision,
    userId: ctx.session.id,
    note: input.note,
    deferUntil: input.deferUntil ? new Date(input.deferUntil) : undefined,
    edits: input.edits,
    execute: input.decision === 'approve',
  })

  if (!result.ok) {
    const code = result.status === 'pending' ? 'not_found' : 'conflict'
    throw new ApiError(code === 'not_found' ? 'not_found' : 'conflict', result.error ?? 'Decision rejected.')
  }

  let execution: { ran: boolean; status?: string; error?: string } = { ran: false }
  if (result.executionQueued && input.executeInline && env.ENABLE_INLINE_JOBS) {
    registerAllHandlers()
    const jobRows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, `approval-exec:${ctx.params.id!}`), eq(jobs.workspaceId, workspaceId)))
      .limit(1)
    if (jobRows[0]) {
      const outcome = await runJob(jobRows[0] as unknown as JobRecord, `api-inline:${ctx.session.id.slice(0, 8)}`)
      execution = { ran: true, status: outcome.status, error: outcome.error }
    }
  }

  const approval = (
    await db.select().from(approvals).where(eq(approvals.id, ctx.params.id!)).limit(1)
  )[0]

  return ok({
    approval,
    status: result.status,
    executionQueued: result.executionQueued ?? false,
    requiresSeparateAuthorization: result.requiresSeparateAuthorization ?? false,
    execution,
  })
})
