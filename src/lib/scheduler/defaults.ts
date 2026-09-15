/**
 * Default platform schedules.
 *
 * These are seeded per workspace and are fully user-editable (enable/disable,
 * change cadence, run now). They are what makes AIBA continuous: with the worker
 * and scheduler containers running, the loop keeps turning while the operator's
 * computer is off.
 */
import { and, eq } from 'drizzle-orm'
import { getDb, schedules } from '../db'
import { JOB_NAMES } from '../queue/handlers'
import { nextCronRun } from './cron'

export type ScheduleSeed = {
  key: string
  name: string
  cron: string
  jobName: string
  payload: Record<string, unknown>
  enabled: boolean
}

export const DEFAULT_SCHEDULES: ScheduleSeed[] = [
  {
    key: 'health-checks',
    name: 'Health & maintenance check',
    cron: '*/15 * * * *',
    jobName: JOB_NAMES.maintenance,
    payload: {},
    enabled: true,
  },
  {
    key: 'research-scan',
    name: 'Research scan (discovery → clean → analyse)',
    cron: '0 * * * *',
    jobName: JOB_NAMES.pipelineDiscovery,
    payload: { useAi: true },
    enabled: true,
  },
  {
    key: 'opportunity-analysis',
    name: 'Opportunity analysis sweep',
    cron: '0 */3 * * *',
    jobName: JOB_NAMES.agent('analysis'),
    payload: { batchSize: 20, useAi: true, autoStrategy: true },
    enabled: true,
  },
  {
    key: 'strategy-generation',
    name: 'Strategy generation sweep',
    cron: '0 */6 * * *',
    jobName: JOB_NAMES.pipelineFull,
    payload: { useAi: true },
    enabled: true,
  },
  {
    key: 'monitoring',
    name: 'Monitoring & anomaly detection',
    cron: '*/15 * * * *',
    jobName: JOB_NAMES.agent('monitoring'),
    payload: { windowHours: 24, raiseAlerts: true },
    enabled: true,
  },
  {
    key: 'daily-report',
    name: 'Daily performance report',
    cron: '0 8 * * *',
    jobName: JOB_NAMES.reportDaily,
    payload: { useAi: true },
    enabled: true,
  },
  {
    key: 'weekly-learning',
    name: 'Weekly learning & optimisation',
    cron: '0 8 * * 1',
    jobName: JOB_NAMES.agent('learning'),
    payload: { windowDays: 90, useAi: true, applyAdjustments: true },
    enabled: true,
  },
  {
    key: 'weekly-report',
    name: 'Weekly performance report',
    cron: '0 9 * * 1',
    jobName: JOB_NAMES.reportWeekly,
    payload: { useAi: true },
    enabled: true,
  },
  {
    key: 'email-outbox',
    name: 'Email outbox flush',
    cron: '*/5 * * * *',
    jobName: JOB_NAMES.emailFlush,
    payload: {},
    enabled: true,
  },
  {
    key: 'memory-prune',
    name: 'Memory retention pruning',
    cron: '0 4 * * *',
    jobName: JOB_NAMES.memoryPrune,
    payload: { retentionDays: 180 },
    enabled: true,
  },
]

export async function seedDefaultSchedules(workspaceId: string): Promise<number> {
  const db = await getDb()
  let created = 0
  for (const seed of DEFAULT_SCHEDULES) {
    const existing = await db
      .select({ id: schedules.id })
      .from(schedules)
      .where(and(eq(schedules.workspaceId, workspaceId), eq(schedules.key, seed.key)))
      .limit(1)
    if (existing[0]) continue
    await db.insert(schedules).values({
      workspaceId,
      key: seed.key,
      name: seed.name,
      cron: seed.cron,
      jobName: seed.jobName,
      payload: seed.payload,
      enabled: seed.enabled,
      system: true,
      nextRunAt: nextCronRun(seed.cron),
    })
    created++
  }
  return created
}

/** Recompute nextRunAt for every enabled schedule (used after cron edits). */
export async function rescheduleAll(workspaceId?: string): Promise<number> {
  const db = await getDb()
  const rows = workspaceId
    ? await db.select().from(schedules).where(eq(schedules.workspaceId, workspaceId))
    : await db.select().from(schedules)
  let updated = 0
  for (const row of rows) {
    if (!row.enabled) continue
    try {
      await db.update(schedules).set({ nextRunAt: nextCronRun(row.cron), updatedAt: new Date() }).where(eq(schedules.id, row.id))
      updated++
    } catch {
      await db.update(schedules).set({ lastStatus: 'error', lastError: `Invalid cron: ${row.cron}` }).where(eq(schedules.id, row.id))
    }
  }
  return updated
}
