/**
 * Job handler registration.
 *
 * Imported by the worker process, the scheduler, and the API layer (for inline
 * execution when no separate worker is deployed). Job names are stable contract
 * strings — they appear in the jobs table, the admin panel and the API.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { getDb, emailOutbox, jobs, projects, tasks, workspaces } from '../db'
import { createLogger } from '../observability/logger'
import { registerHandler, enqueue } from './index'
import { runAgentByKey } from '../agents/registry'
import { runBuildPipeline, runDiscoveryCycle, runFullCycle, runMaintenance } from '../agents/orchestrator'
import { generateAndStoreReport } from '../reports'
import { pruneMemory } from '../agents/definitions/learning'
import type { AgentKey } from '../agents/types'

const log = createLogger({ component: 'handlers' })

export const JOB_NAMES = {
  agent: (key: AgentKey | string) => `agent.${key}`,
  approvalExecute: 'approval.execute',
  pipelineDiscovery: 'pipeline.discovery',
  pipelineFull: 'pipeline.full',
  pipelineBuild: 'pipeline.build',
  maintenance: 'maintenance.cleanup',
  reportDaily: 'reports.daily',
  reportWeekly: 'reports.weekly',
  memoryPrune: 'memory.prune',
  emailFlush: 'email.flush',
} as const

let registered = false

export function registerAllHandlers(): void {
  if (registered) return
  registered = true

  /* --------------------------------------------------------------- agents */
  for (const key of ['research', 'cleaning', 'analysis', 'strategy', 'product', 'content', 'monitoring', 'learning'] as AgentKey[]) {
    registerHandler(
      JOB_NAMES.agent(key),
      async (payload: Record<string, unknown>, ctx) => {
        const workspaceId = String(payload.workspaceId ?? ctx.job.workspaceId ?? '')
        if (!workspaceId) throw new Error(`${JOB_NAMES.agent(key)} requires a workspaceId`)
        const { workspaceId: _drop, ...input } = payload
        const outcome = await runAgentByKey(key, input, {
          workspaceId,
          triggeredBy: 'schedule',
          jobId: ctx.job.id,
          signal: ctx.signal,
        })
        ctx.log('agent job finished', { agent: key, status: outcome.status, costCents: outcome.costCents })
        return { status: outcome.status, summary: outcome.output?.summary, error: outcome.error, approvalId: outcome.approvalId }
      },
      { maxAttempts: 2, timeoutMs: 600_000 },
    )
  }

  /* ------------------------------------------------- approval execution */
  registerHandler(
    JOB_NAMES.approvalExecute,
    async (payload: Record<string, unknown>, ctx) => {
      const workspaceId = String(payload.workspaceId ?? '')
      const approvalId = String(payload.approvalId ?? '')
      if (!workspaceId || !approvalId) throw new Error('approval.execute requires workspaceId and approvalId')
      const outcome = await runAgentByKey('execution', { approvalId }, {
        workspaceId,
        triggeredBy: 'agent',
        jobId: ctx.job.id,
        approveImmediately: true, // the human already approved; policy ran at decision time
        signal: ctx.signal,
      })
      if (outcome.status === 'failed') throw new Error(outcome.error ?? 'Execution agent failed')
      return { status: outcome.status, summary: outcome.output?.summary }
    },
    { maxAttempts: 2, timeoutMs: 420_000 },
  )

  // The execution agent is registered under its own name too (for direct runs).
  registerHandler(
    JOB_NAMES.agent('execution'),
    async (payload: Record<string, unknown>, ctx) => {
      const workspaceId = String(payload.workspaceId ?? '')
      const outcome = await runAgentByKey('execution', payload, {
        workspaceId,
        triggeredBy: 'agent',
        jobId: ctx.job.id,
        approveImmediately: true,
        signal: ctx.signal,
      })
      return { status: outcome.status, summary: outcome.output?.summary, error: outcome.error }
    },
    { maxAttempts: 2, timeoutMs: 420_000 },
  )

  /* ------------------------------------------------------------- pipelines */
  registerHandler(
    JOB_NAMES.pipelineDiscovery,
    async (payload: Record<string, unknown>, ctx) => {
      const workspaceId = String(payload.workspaceId ?? '')
      if (!workspaceId) throw new Error('pipeline.discovery requires a workspaceId')
      const result = await runDiscoveryCycle(workspaceId, {
        triggeredBy: 'schedule',
        batchSize: Number(payload.batchSize ?? 15),
        useAi: payload.useAi !== false,
      })
      ctx.log('discovery cycle finished', { discovered: result.opportunitiesDiscovered, scored: result.opportunitiesScored })
      return result
    },
    { maxAttempts: 2, timeoutMs: 900_000 },
  )

  registerHandler(
    JOB_NAMES.pipelineFull,
    async (payload: Record<string, unknown>, ctx) => {
      const workspaceId = String(payload.workspaceId ?? '')
      if (!workspaceId) throw new Error('pipeline.full requires a workspaceId')
      const result = await runFullCycle(workspaceId, { useAi: payload.useAi !== false })
      ctx.log('full cycle finished', { discovered: result.opportunitiesDiscovered, builds: result.builds })
      return result
    },
    { maxAttempts: 1, timeoutMs: 1_500_000 },
  )

  registerHandler(
    JOB_NAMES.pipelineBuild,
    async (payload: Record<string, unknown>, ctx) => {
      const workspaceId = String(payload.workspaceId ?? '')
      const projectId = String(payload.projectId ?? '')
      if (!workspaceId || !projectId) throw new Error('pipeline.build requires workspaceId and projectId')
      const result = await runBuildPipeline(workspaceId, projectId, { useAi: payload.useAi !== false, triggeredBy: 'agent' })
      ctx.log('build pipeline finished', { projectId })
      return result
    },
    { maxAttempts: 2, timeoutMs: 900_000 },
  )

  /* ---------------------------------------------------------- maintenance */
  registerHandler(
    JOB_NAMES.maintenance,
    async (payload: Record<string, unknown>, ctx) => {
      const workspaceId = payload.workspaceId ? String(payload.workspaceId) : undefined
      const result = await runMaintenance(workspaceId)
      ctx.log('maintenance finished', result)
      return result
    },
    { maxAttempts: 1, timeoutMs: 300_000 },
  )

  registerHandler(
    JOB_NAMES.memoryPrune,
    async (payload: Record<string, unknown>) => {
      const db = await getDb()
      const workspaceId = payload.workspaceId ? String(payload.workspaceId) : null
      const rows = workspaceId
        ? await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId))
        : await db.select({ id: workspaces.id }).from(workspaces)
      let pruned = 0
      for (const row of rows) pruned += await pruneMemory(row.id, Number(payload.retentionDays ?? 180))
      return { workspaces: rows.length, pruned }
    },
    { maxAttempts: 1, timeoutMs: 300_000 },
  )

  /* -------------------------------------------------------------- reports */
  registerHandler(
    JOB_NAMES.reportDaily,
    async (payload: Record<string, unknown>) => {
      const db = await getDb()
      const workspaceId = payload.workspaceId ? String(payload.workspaceId) : null
      const rows = workspaceId
        ? await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId))
        : await db.select({ id: workspaces.id }).from(workspaces)
      const created: string[] = []
      for (const row of rows) {
        const report = await generateAndStoreReport(row.id, 'daily', { useAi: payload.useAi !== false })
        created.push(report.id)
      }
      return { reports: created.length }
    },
    { maxAttempts: 2, timeoutMs: 600_000 },
  )

  registerHandler(
    JOB_NAMES.reportWeekly,
    async (payload: Record<string, unknown>) => {
      const db = await getDb()
      const workspaceId = payload.workspaceId ? String(payload.workspaceId) : null
      const rows = workspaceId
        ? await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId))
        : await db.select({ id: workspaces.id }).from(workspaces)
      const created: string[] = []
      for (const row of rows) {
        const report = await generateAndStoreReport(row.id, 'weekly', { useAi: payload.useAi !== false })
        created.push(report.id)
      }
      return { reports: created.length }
    },
    { maxAttempts: 2, timeoutMs: 900_000 },
  )

  /* ---------------------------------------------------------------- email */
  registerHandler(
    JOB_NAMES.emailFlush,
    async (_payload, ctx) => {
      const db = await getDb()
      const pending = await db
        .select()
        .from(emailOutbox)
        .where(and(eq(emailOutbox.status, 'queued'), lt(emailOutbox.attempts, 3)))
        .limit(25)
      if (pending.length === 0) return { sent: 0 }

      const { sendTransactionalEmail } = await import('../notifications')
      let sent = 0
      for (const message of pending) {
        try {
          const result = await sendTransactionalEmail({ to: message.to, subject: message.subject, body: message.body })
          await db
            .update(emailOutbox)
            .set({ status: result.includes('failed') ? 'failed' : 'sent', sentAt: new Date(), attempts: message.attempts + 1, error: result.includes('failed') ? result : null })
            .where(eq(emailOutbox.id, message.id))
          if (!result.includes('failed')) sent++
        } catch (error) {
          await db
            .update(emailOutbox)
            .set({ attempts: message.attempts + 1, error: error instanceof Error ? error.message : String(error) })
            .where(eq(emailOutbox.id, message.id))
        }
      }
      ctx.log('email outbox flushed', { sent, considered: pending.length })
      return { sent, considered: pending.length }
    },
    { maxAttempts: 3, timeoutMs: 120_000 },
  )
}

/**
 * Recover project tasks that have been "in_progress" for too long: they are
 * marked failed with a reason, so a stalled task never blocks a project forever.
 */
export async function failStaleTasks(olderThanMinutes = 180): Promise<number> {
  const db = await getDb()
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const rows = await db
    .update(tasks)
    .set({ status: 'failed', lastError: `No progress for ${olderThanMinutes} minutes`, updatedAt: new Date() })
    .where(and(eq(tasks.status, 'in_progress'), lt(tasks.updatedAt, cutoff)))
    .returning({ id: tasks.id })
  if (rows.length > 0) log.warn('stale tasks marked failed', { count: rows.length })
  return rows.length
}

/** Queue a full discovery cycle for every workspace that has automation enabled. */
export async function enqueueRoutineScans(workspaceIds: string[], options: { useAi?: boolean } = {}): Promise<number> {
  let queued = 0
  for (const workspaceId of workspaceIds) {
    const { deduped } = await enqueue(
      JOB_NAMES.pipelineDiscovery,
      { workspaceId, useAi: options.useAi ?? true },
      { queue: 'research', priority: 4, workspaceId, dedupeKey: `discovery:${workspaceId}:${new Date().toISOString().slice(0, 13)}` },
    )
    if (!deduped) queued++
  }
  return queued
}

export async function workspacesWithAutomation(): Promise<string[]> {
  const db = await getDb()
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(sql`${workspaces.deletedAt} is null`)
  return rows.map((row) => row.id)
}

export async function jobHealthSummary(): Promise<{ total: number; queued: number; running: number; failed: number; dead: number }> {
  const db = await getDb()
  const rows = await db.select({ status: jobs.status, value: sql<string>`count(*)::text` }).from(jobs).groupBy(jobs.status)
  const get = (status: string) => Number(rows.find((row) => row.status === status)?.value ?? 0)
  return {
    total: rows.reduce((a, b) => a + Number(b.value), 0),
    queued: get('queued'),
    running: get('running'),
    failed: get('failed'),
    dead: get('dead'),
  }
}

export { inArray, projects }
