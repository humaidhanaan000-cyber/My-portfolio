#!/usr/bin/env tsx
/**
 * AIBA scheduler process.
 *
 * Runs inside the worker container (or standalone) and ticks every
 * SCHEDULER_TICK_MS. It is safe to run multiple replicas: each due schedule is
 * claimed with an atomic conditional UPDATE plus an optional Redis lock, so a
 * schedule fires once even with several schedulers running.
 *
 * Default schedules (all user-configurable from the UI / database):
 *   every 15 minutes  health checks + maintenance
 *   hourly            research scan
 *   every 3 hours     opportunity analysis
 *   every 6 hours     strategy generation
 *   daily             performance report
 *   weekly            learning + optimisation report
 */
import { and, eq, lte, or, isNull, sql } from 'drizzle-orm'
import { closeDb, getDb, schedules, workerHeartbeats } from '../lib/db'
import { env } from '../lib/env'
import { createLogger } from '../lib/observability/logger'
import { enqueue } from '../lib/queue'
import { acquireLock, closeRedis } from '../lib/queue/redis'
import { registerAllHandlers, JOB_NAMES, workspacesWithAutomation } from '../lib/queue/handlers'
import { nextCronRun } from '../lib/scheduler/cron'
import os from 'node:os'

const log = createLogger({ component: 'scheduler' })
const schedulerId = `scheduler-${os.hostname()}-${process.pid}`
let running = true

registerAllHandlers()

async function heartbeat(status: 'online' | 'offline' = 'online') {
  try {
    const db = await getDb()
    await db
      .insert(workerHeartbeats)
      .values({ workerId: schedulerId, role: 'scheduler', hostname: os.hostname(), version: env.SERVICE_VERSION, status })
      .onConflictDoUpdate({
        target: [workerHeartbeats.workerId, workerHeartbeats.role],
        set: { status, lastHeartbeatAt: new Date() },
      })
  } catch (error) {
    log.error('scheduler heartbeat failed', error)
  }
}

export type DueSchedule = {
  id: string
  key: string
  name: string
  cron: string
  jobName: string
  payload: Record<string, unknown>
  workspaceId: string | null
  nextRunAt: Date | null
}

/** Claim due schedules atomically, then advance their next run time. */
async function claimDueSchedules(limit = 20): Promise<DueSchedule[]> {
  const db = await getDb()
  const now = new Date()
  const claimed: DueSchedule[] = []

  for (let i = 0; i < limit; i++) {
    const result = await db.execute(sql`
      update schedules set
        next_run_at = null,
        last_run_at = now(),
        updated_at = now()
      where id = (
        select id from schedules
        where enabled = true and next_run_at is not null and next_run_at <= ${now.toISOString()}
        order by next_run_at asc
        for update skip locked
        limit 1
      )
      returning id, key, name, cron, job_name, payload, workspace_id, next_run_at
    `)
    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
      id: string
      key: string
      name: string
      cron: string
      job_name: string
      payload: Record<string, unknown>
      workspace_id: string | null
      next_run_at: string | null
    }[]
    if (!rows[0]) break
    claimed.push({
      id: rows[0].id,
      key: rows[0].key,
      name: rows[0].name,
      cron: rows[0].cron,
      jobName: rows[0].job_name,
      payload: rows[0].payload ?? {},
      workspaceId: rows[0].workspace_id,
      nextRunAt: rows[0].next_run_at ? new Date(rows[0].next_run_at) : null,
    })
  }

  for (const schedule of claimed) {
    const next = nextCronRun(schedule.cron, new Date())
    await db
      .update(schedules)
      .set({ nextRunAt: next, lastStatus: 'queued', updatedAt: new Date() })
      .where(eq(schedules.id, schedule.id))
  }

  return claimed
}

async function dispatch(schedule: DueSchedule): Promise<void> {
  const targetWorkspaces = schedule.workspaceId ? [schedule.workspaceId] : await workspacesWithAutomation()
  const payload = { ...schedule.payload }
  delete (payload as Record<string, unknown>).workspacesResolved

  if (targetWorkspaces.length === 0) return

  // System-wide fan-out jobs resolve their own workspace list; others run per workspace.
  const fanOutJobs: string[] = [JOB_NAMES.reportDaily, JOB_NAMES.reportWeekly, JOB_NAMES.memoryPrune, JOB_NAMES.emailFlush]
  if (fanOutJobs.includes(schedule.jobName as string) && !schedule.workspaceId) {
    await enqueue(schedule.jobName, { ...payload, useAi: payload.useAi !== false }, { queue: 'default', priority: 5, dedupeKey: `${schedule.key}:${new Date().toISOString().slice(0, 13)}` })
    log.info('scheduled job queued (platform-wide)', { job: schedule.jobName })
    return
  }

  for (const workspaceId of targetWorkspaces) {
    await enqueue(
      schedule.jobName,
      { ...payload, workspaceId },
      {
        queue: schedule.jobName.startsWith('agent.research') || schedule.jobName.includes('discovery') ? 'research' : 'default',
        priority: 5,
        workspaceId,
        dedupeKey: `${schedule.key}:${workspaceId}:${new Date().toISOString().slice(0, 13)}`,
      },
    )
  }
  log.info('scheduled job queued', { job: schedule.jobName, workspaces: targetWorkspaces.length })
}

async function tick(): Promise<void> {
  const release = await acquireLock('scheduler-tick', env.SCHEDULER_LEADER_LOCK_MS)
  const db = await getDb()
  try {
    const due = await claimDueSchedules(25)
    for (const schedule of due) {
      try {
        await dispatch(schedule)
        await db.update(schedules).set({ lastStatus: 'ok', lastError: null, runCount: sql`${schedules.runCount} + 1` }).where(eq(schedules.id, schedule.id))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('schedule dispatch failed', error, { key: schedule.key })
        await db.update(schedules).set({ lastStatus: 'error', lastError: message.slice(0, 500) }).where(eq(schedules.id, schedule.id))
      }
    }
    if (due.length > 0) log.debug('scheduler tick', { due: due.length })
  } finally {
    await release?.()
  }
}

async function loop() {
  log.info('scheduler starting', { schedulerId, tickMs: env.SCHEDULER_TICK_MS })
  await heartbeat()
  const beat = setInterval(() => void heartbeat(), 60_000)

  while (running) {
    try {
      await tick()
    } catch (error) {
      log.error('scheduler tick error', error)
    }
    await new Promise((resolve) => setTimeout(resolve, env.SCHEDULER_TICK_MS))
  }

  clearInterval(beat)
  await heartbeat('offline')
}

async function shutdown(signal: string) {
  log.info('scheduler shutting down', { signal })
  running = false
  await closeRedis().catch(() => undefined)
  await closeDb().catch(() => undefined)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

void loop()
