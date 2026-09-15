#!/usr/bin/env tsx
/**
 * AIBA scheduler process.
 *
 * A thin wrapper around `startScheduler()` from `src/lib/scheduler/runner.ts`.
 * Run it as its own process (`npm run scheduler`, or the `scheduler` service in
 * docker-compose) so automation keeps running with the web app stopped.
 *
 * It is safe to run several replicas: each due schedule is claimed with one
 * atomic `UPDATE … FOR UPDATE SKIP LOCKED` statement, so a schedule fires once
 * even with multiple schedulers ticking.
 *
 * When the database is the embedded PGlite driver this process refuses to start
 * (one store, one process) — enable the scheduler inside the web process instead:
 *   ENABLE_SCHEDULER=true npm start
 *
 * Default schedules (all user-configurable from the UI / database):
 *   every 15 minutes  health checks + maintenance + monitoring
 *   hourly            research scan (discovery)
 *   every 3 hours     opportunity analysis
 *   every 6 hours     strategy generation
 *   daily             performance report
 *   weekly            learning + optimisation report
 */
import { closeDb, multiProcessDriverProblem } from '../lib/db'
import { closeRedis } from '../lib/queue/redis'
import { createLogger } from '../lib/observability/logger'
import { startScheduler } from '../lib/scheduler/runner'

const log = createLogger({ component: 'scheduler' })
let stopping = false

// Refuse to run as a second process against the embedded driver: it would see
// stale rows, dispatch jobs the web process cannot see, and could corrupt the
// store (see multiProcessDriverProblem).
const driverProblem = multiProcessDriverProblem('Scheduler')
if (driverProblem) {
  log.error('scheduler cannot start with this database driver')
  console.error(`\n  ${driverProblem}\n`)
  process.exit(1)
}

const scheduler = startScheduler()

const shutdownGraceMs = Number(process.env.WORKER_SHUTDOWN_GRACE_MS ?? 25_000)

async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  log.info('scheduler shutting down', { signal, graceMs: shutdownGraceMs })

  // As with the worker: never leave an orphaned process holding the database.
  const force = setTimeout(() => {
    log.error('shutdown did not finish in time — forcing exit')
    process.exit(0)
  }, shutdownGraceMs)
  force.unref()
  await scheduler.stop().catch(() => undefined)
  await closeRedis().catch(() => undefined)
  await closeDb().catch(() => undefined)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
