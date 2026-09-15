#!/usr/bin/env tsx
/**
 * AIBA worker process.
 *
 * Runs in its own container (see docker-compose.yml). It:
 *   - registers every job handler
 *   - claims and executes jobs with SKIP LOCKED
 *   - emits a heartbeat row so the monitoring agent and admin panel can see it
 *   - requeues jobs whose worker died, on startup and periodically
 *   - shuts down gracefully on SIGTERM (finishing the in-flight job)
 *
 * Nothing here requires the web process to be running, and the web process does
 * not require the worker: user-triggered actions can run inline. The worker is
 * what makes automation continuous after the operator closes their laptop.
 */
import { closeDb, getDb, workerHeartbeats } from '../lib/db'
import { env } from '../lib/env'
import { createLogger } from '../lib/observability/logger'
import { claimJob, queueStats, requeueStalledJobs, runJob, registeredHandlers, hasHandler } from '../lib/queue'
import { registerAllHandlers, failStaleTasks, JOB_NAMES } from '../lib/queue/handlers'
import { closeRedis } from '../lib/queue/redis'
import { persistLog } from '../lib/observability/logger'
import os from 'node:os'

const log = createLogger({ component: 'worker' })
const workerId = env.WORKER_ID ?? `worker-${os.hostname()}-${process.pid}`

let running = true
let processed = 0
let errors = 0
let currentJobId: string | null = null

registerAllHandlers()

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
        metadata: { pid: process.pid, node: process.version, queues: ['default', 'research', 'analysis', 'creation', 'execution'] },
      })
      .onConflictDoUpdate({
        target: [workerHeartbeats.workerId, workerHeartbeats.role],
        set: {
          status,
          processedCount: processed,
          errorCount: errors,
          lastHeartbeatAt: new Date(),
          version: env.SERVICE_VERSION,
        },
      })
  } catch (error) {
    log.error('heartbeat failed', error)
  }
}

async function processOne(): Promise<boolean> {
  const job = await claimJob(workerId)
  if (!job) return false
  if (!hasHandler(job.name)) {
    log.warn('no handler for job; marking failed', { job: job.name })
    // runJob marks it failed/dead with a clear reason.
  }
  currentJobId = job.id
  try {
    const outcome = await runJob(job, workerId)
    processed++
    if (outcome.status === 'failed' || outcome.status === 'dead') errors++
    log.info('job processed', { name: job.name, status: outcome.status, durationMs: outcome.durationMs, retryInMs: outcome.retryInMs })
  } catch (error) {
    errors++
    log.error('unhandled error while processing job', error, { jobId: job.id, name: job.name })
  } finally {
    currentJobId = null
  }
  return true
}

async function loop() {
  log.info('worker starting', { workerId, concurrency: env.WORKER_CONCURRENCY, handlers: registeredHandlers().length })
  await heartbeat()

  // Recover work from a previous crash before accepting new jobs.
  try {
    const requeued = await requeueStalledJobs(300)
    if (requeued > 0) log.warn('requeued stalled jobs at startup', { count: requeued })
  } catch (error) {
    log.error('startup requeue failed', error)
  }

  const heartbeatTimer = setInterval(() => void heartbeat(), 30_000)
  const maintenanceTimer = setInterval(() => {
    void (async () => {
      try {
        await requeueStalledJobs(300)
        await failStaleTasks(180)
      } catch (error) {
        log.error('periodic maintenance failed', error)
      }
    })()
  }, 120_000)

  let idleTicks = 0
  while (running) {
    try {
      const didWork = await processOne()
      if (!didWork) {
        idleTicks++
        // Exponential-ish idle backoff up to 5s keeps the DB quiet when idle.
        const delay = Math.min(5000, env.WORKER_POLL_MS * (1 + Math.floor(idleTicks / 10)))
        await new Promise((resolve) => setTimeout(resolve, delay))
      } else {
        idleTicks = 0
      }
    } catch (error) {
      errors++
      log.error('worker loop error', error)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }

  clearInterval(heartbeatTimer)
  clearInterval(maintenanceTimer)
  await heartbeat('offline')
  log.info('worker stopped', { processed, errors })
}

async function shutdown(signal: string) {
  log.info('shutdown signal received', { signal, currentJobId })
  running = false
  // Give the in-flight job a moment to finish, then exit cleanly.
  const started = Date.now()
  while (currentJobId && Date.now() - started < 20_000) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await persistLog({ level: 'info', source: 'worker', message: `Worker ${workerId} shut down (${signal})`, context: { processed, errors } })
  await closeRedis().catch(() => undefined)
  await closeDb().catch(() => undefined)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => {
  errors++
  log.error('unhandled rejection in worker', reason)
})
process.on('uncaughtException', (error) => {
  errors++
  log.error('uncaught exception in worker', error)
})

void loop()
