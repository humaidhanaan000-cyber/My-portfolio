/**
 * In-process job runner ("inline worker").
 *
 * The cheap way to run AIBA is a single process: web + job execution + cron. That
 * is also the *required* shape when the database is the embedded PGlite driver,
 * because that store belongs to one process.
 *
 * User-triggered actions are executed inline by their own request handler, but a
 * job the *scheduler* queues (research scan, monitoring, reports, maintenance) has
 * no request behind it: without a drain loop it would sit in `queued` forever.
 * This module is that drain loop — the same claim-and-run primitives the
 * standalone worker uses (`claimJob` / `runJob`, so SKIP LOCKED already prevents
 * two runners from taking the same job), minus the process management.
 *
 * Started from `instrumentation.ts` when `ENABLE_INLINE_JOBS=true`.
 */
import os from 'node:os'
import { getDb, workerHeartbeats } from '../db'
import { env } from '../env'
import { createLogger } from '../observability/logger'
import { claimJob, requeueStalledJobs, runJob, registeredHandlers } from '.'
import { failStaleTasks, registerAllHandlers } from './handlers'

const log = createLogger({ component: 'worker', module: 'inline' })

export type InlineWorkerHandle = {
  id: string
  stop: () => Promise<void>
  /** Execute at most one queued job. Returns whether work was done. */
  processOne: () => Promise<boolean>
  stats: () => { processed: number; errors: number; currentJobId: string | null }
}

export type InlineWorkerOptions = {
  pollMs?: number
  concurrency?: number
  label?: string
}

/**
 * Start draining the queue inside the current process.
 *
 * Returns a handle immediately; failures inside the loop are logged and retried,
 * never thrown into the caller (a background job must not take the server down).
 */
export function startInlineWorker(options: InlineWorkerOptions = {}): InlineWorkerHandle {
  registerAllHandlers()

  const workerId = `inline-worker-${options.label ?? os.hostname()}-${process.pid}`
  const pollMs = options.pollMs ?? env.WORKER_POLL_MS
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? env.WORKER_CONCURRENCY))
  let running = true
  let processed = 0
  let errors = 0
  let currentJobId: string | null = null
  let heartbeatTimer: NodeJS.Timeout | undefined
  let maintenanceTimer: NodeJS.Timeout | undefined

  async function heartbeat(status: 'online' | 'degraded' | 'offline' = 'online') {
    try {
      const db = await getDb()
      await db
        .insert(workerHeartbeats)
        .values({
          workerId,
          role: 'worker',
          hostname: os.hostname(),
          version: env.SERVICE_VERSION,
          status,
          processedCount: processed,
          errorCount: errors,
          metadata: { pid: process.pid, mode: 'inline', concurrency, queues: ['default', 'research', 'analysis', 'creation', 'execution'] },
        })
        .onConflictDoUpdate({
          target: [workerHeartbeats.workerId, workerHeartbeats.role],
          set: { status, processedCount: processed, errorCount: errors, lastHeartbeatAt: new Date(), version: env.SERVICE_VERSION },
        })
    } catch (error) {
      log.error('inline worker heartbeat failed', error)
    }
  }

  const processOne = async (): Promise<boolean> => {
    const job = await claimJob(workerId)
    if (!job) return false
    currentJobId = job.id
    try {
      const outcome = await runJob(job, workerId)
      processed++
      if (outcome.status === 'failed' || outcome.status === 'dead') errors++
      log.info('job processed', { name: job.name, status: outcome.status, durationMs: outcome.durationMs, workerId })
    } catch (error) {
      errors++
      log.error('unhandled error while processing job', error, { jobId: job.id, name: job.name })
    } finally {
      currentJobId = null
    }
    return true
  }

  const loop = async () => {
    log.info('inline worker starting', { workerId, concurrency, handlers: registeredHandlers().length, pollMs })
    await heartbeat()
    try {
      const requeued = await requeueStalledJobs(300)
      if (requeued > 0) log.warn('requeued stalled jobs at startup', { count: requeued })
    } catch (error) {
      log.error('inline worker startup requeue failed', error)
    }

    heartbeatTimer = setInterval(() => void heartbeat(), 30_000)
    heartbeatTimer.unref?.()
    maintenanceTimer = setInterval(() => {
      void (async () => {
        try {
          await requeueStalledJobs(300)
          await failStaleTasks(180)
        } catch (error) {
          log.error('inline worker periodic maintenance failed', error)
        }
      })()
    }, 120_000)
    maintenanceTimer.unref?.()

    let idleTicks = 0
    while (running) {
      try {
        // Drain up to `concurrency` jobs per pass so a burst is not processed one
        // poll interval at a time.
        let didWork = false
        for (let slot = 0; slot < concurrency && running; slot++) {
          if (!(await processOne())) break
          didWork = true
        }
        if (didWork) {
          idleTicks = 0
          continue
        }
        idleTicks++
        const delay = Math.min(5000, pollMs * (1 + Math.floor(idleTicks / 10)))
        await new Promise((resolve) => setTimeout(resolve, delay))
      } catch (error) {
        errors++
        log.error('inline worker loop error', error)
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    }

    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (maintenanceTimer) clearInterval(maintenanceTimer)
    await heartbeat('offline')
    log.info('inline worker stopped', { processed, errors })
  }

  void loop()

  return {
    id: workerId,
    processOne,
    stats: () => ({ processed, errors, currentJobId }),
    stop: async () => {
      running = false
    },
  }
}
