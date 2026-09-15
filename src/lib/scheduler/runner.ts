/**
 * Scheduler runner.
 *
 * The tick loop that decides *when* agents run, extracted from the process that
 * hosts it so it can be started in two ways:
 *
 *   1. as its own process    — `npm run scheduler`, or the `scheduler` service in
 *      docker-compose. This is the production shape: it keeps evaluating cron
 *      entries with the web app stopped or restarted.
 *   2. inside the web process — `ENABLE_SCHEDULER=true`, started from
 *      `instrumentation.ts`. Required when the database is the embedded PGlite
 *      driver, because that store belongs to a single process: a second process
 *      would see stale rows (see `multiProcessDriverProblem`).
 *
 * Both shapes call the same `claimDueSchedules` / `rearmStalledSchedules`, so the
 * exactly-once claim guarantees hold either way.
 */
import { eq, sql } from 'drizzle-orm'
import { getDb, schedules, workerHeartbeats } from '../db'
import { claimDueSchedules, rearmStalledSchedules, type DueSchedule } from './claim'
import { env } from '../env'
import { createLogger } from '../observability/logger'
import { enqueue } from '../queue'
import { acquireLock } from '../queue/redis'
import { JOB_NAMES, registerAllHandlers, workspacesWithAutomation } from '../queue/handlers'
import os from 'node:os'

const log = createLogger({ component: 'scheduler' })

export type SchedulerHandle = {
  id: string
  /** Stop ticking and mark the scheduler offline. Safe to call twice. */
  stop: () => Promise<void>
  /** Run one tick immediately — used by tests and the operator CLI. */
  tickOnce: () => Promise<number>
}

/** Fan-out jobs resolve their own workspace list; everything else runs per workspace. */
const fanOutJobs: string[] = [JOB_NAMES.reportDaily, JOB_NAMES.reportWeekly, JOB_NAMES.memoryPrune, JOB_NAMES.emailFlush]

async function heartbeat(schedulerId: string, status: 'online' | 'offline' = 'online') {
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

export async function dispatchSchedule(schedule: DueSchedule): Promise<void> {
  const targetWorkspaces = schedule.workspaceId ? [schedule.workspaceId] : await workspacesWithAutomation()
  const payload = { ...schedule.payload }
  delete (payload as Record<string, unknown>).workspacesResolved
  if (targetWorkspaces.length === 0) return

  if (fanOutJobs.includes(schedule.jobName) && !schedule.workspaceId) {
    await enqueue(
      schedule.jobName,
      { ...payload, useAi: payload.useAi !== false },
      { queue: 'default', priority: 5, dedupeKey: `${schedule.key}:${new Date().toISOString().slice(0, 13)}` },
    )
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

/** Claim everything due, dispatch it, and record the outcome. Returns how many ran. */
export async function runSchedulerTick(limit = 25): Promise<number> {
  const release = await acquireLock('scheduler-tick', env.SCHEDULER_LEADER_LOCK_MS)
  const db = await getDb()
  try {
    const due = await claimDueSchedules(limit)
    for (const schedule of due) {
      try {
        await dispatchSchedule(schedule)
        await db
          .update(schedules)
          .set({ lastStatus: 'ok', lastError: null, runCount: sql`${schedules.runCount} + 1` })
          .where(eq(schedules.id, schedule.id))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('schedule dispatch failed', error, { key: schedule.key })
        await db.update(schedules).set({ lastStatus: 'error', lastError: message.slice(0, 500) }).where(eq(schedules.id, schedule.id))
      }
    }
    return due.length
  } finally {
    await release?.()
  }
}

/**
 * Start ticking. Returns a handle so the caller can stop it (process shutdown,
 * test teardown). Never throws for a single failing tick — a broken schedule must
 * not take the scheduler down.
 */
export function startScheduler(options: { tickMs?: number; label?: string } = {}): SchedulerHandle {
  registerAllHandlers()
  const schedulerId = `scheduler-${options.label ?? os.hostname()}-${process.pid}`
  const tickMs = options.tickMs ?? env.SCHEDULER_TICK_MS
  let running = true
  let beat: NodeJS.Timeout | undefined

  const tickOnce = async () => {
    try {
      return await runSchedulerTick()
    } catch (error) {
      log.error('scheduler tick error', error)
      return 0
    }
  }

  const loop = async () => {
    log.info('scheduler starting', { schedulerId, tickMs })
    await heartbeat(schedulerId)
    await rearmStalledSchedules().catch((error) => log.error('schedule repair failed', error))
    beat = setInterval(() => void heartbeat(schedulerId), 60_000)
    beat.unref?.()

    while (running) {
      await tickOnce()
      if (!running) break
      await new Promise((resolve) => setTimeout(resolve, tickMs))
    }
  }

  void loop()

  return {
    id: schedulerId,
    tickOnce,
    stop: async () => {
      if (!running) return
      running = false
      if (beat) clearInterval(beat)
      await heartbeat(schedulerId, 'offline')
      log.info('scheduler stopped', { schedulerId })
    },
  }
}
