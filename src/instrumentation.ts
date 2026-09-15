/**
 * Next.js instrumentation hook — runs once when a server process boots.
 *
 * Two things can be switched on here, both for single-process deployments (the
 * required shape when the database is the embedded PGlite driver, where a second
 * process cannot safely share the store — see `multiProcessDriverProblem`):
 *
 *   ENABLE_INLINE_JOBS=true    drain the job queue in this process, so a job the
 *                              scheduler queued always gets executed even though
 *                              there is no request behind it
 *   ENABLE_SCHEDULER=true      evaluate cron entries in this process
 *
 * On PostgreSQL deployments the web container sets ENABLE_INLINE_JOBS=false and
 * ENABLE_SCHEDULER=false, and `npm run worker` + `npm run scheduler` (the worker
 * and scheduler services in docker-compose) own those loops instead — so job
 * execution and cron survive web restarts and can be scaled independently.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { createLogger } = await import('./lib/observability/logger')
  const log = createLogger({ component: 'instrumentation' })

  // 1. Queue drain loop. With the embedded pglite:// driver this process is the
  //    only one allowed to touch the database, so jobs the scheduler queues have
  //    to be executed here. On PostgreSQL deployments ENABLE_INLINE_JOBS is
  //    "false" in the web container and `npm run worker` drains the queue instead.
  if (process.env.ENABLE_INLINE_JOBS === 'true') {
    try {
      const { startInlineWorker } = await import('./lib/queue/inline-worker')
      const worker = startInlineWorker({ label: 'web' })
      log.info('inline worker started inside the web process', {
        workerId: worker.id,
        note: 'ENABLE_INLINE_JOBS=true — queued jobs execute in this process.',
      })
      process.once('SIGTERM', () => void worker.stop())
      process.once('SIGINT', () => void worker.stop())
    } catch (error) {
      log.error('inline worker failed to start', error)
    }
  }

  // 2. Cron loop — only when asked for; the scheduler container normally owns it.
  if (process.env.ENABLE_SCHEDULER !== 'true') return

  const { startScheduler } = await import('./lib/scheduler/runner')

  try {
    const scheduler = startScheduler({ label: 'web-inline' })
    log.info('scheduler started inside the web process', {
      schedulerId: scheduler.id,
      note: 'ENABLE_SCHEDULER=true — one process owns the database and the cron loop.',
    })

    const stop = async (signal: string) => {
      log.info('stopping inline scheduler', { signal })
      await scheduler.stop().catch(() => undefined)
    }
    process.once('SIGTERM', () => void stop('SIGTERM'))
    process.once('SIGINT', () => void stop('SIGINT'))
  } catch (error) {
    // Never block boot because of a scheduler failure — the web app must serve.
    log.error('inline scheduler failed to start', error)
  }
}
