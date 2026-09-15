/**
 * Job queue.
 *
 * PostgreSQL is the durable store of record for every job (`jobs` table), which
 * means queue state is observable, auditable and survives restarts without an
 * extra service. Redis (when configured) is used purely for low-latency wakeups
 * and cross-worker locks.
 *
 * Guarantees
 *  - at-least-once delivery with exponential backoff + full jitter
 *  - `FOR UPDATE SKIP LOCKED` claiming so N workers never run the same job
 *  - per-job timeout, attempt ceiling, and a terminal `dead` state
 *  - one failing handler can never crash the worker loop
 */
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { getDb, jobs as jobsTable, schema } from '../db'
import { env } from '../env'
import { createLogger, persistLog } from '../observability/logger'
import { publish } from './redis'
import type { EnqueueOptions, JobContext, JobHandler, JobRecord, JobStatus, QueueStats } from './types'

const log = createLogger({ component: 'queue' })

const registry = new Map<string, JobHandler<never, unknown>>()
type HandlerEntry = { name: string; handler: JobHandler<never, unknown>; maxAttempts: number; timeoutMs: number }

export function registerHandler<T>(name: string, handler: JobHandler<T>, options: { maxAttempts?: number; timeoutMs?: number } = {}) {
  registry.set(name, handler as unknown as JobHandler<never, unknown>)
  handlerDefaults.set(name, {
    maxAttempts: options.maxAttempts ?? env.JOB_MAX_ATTEMPTS,
    timeoutMs: options.timeoutMs ?? env.JOB_DEFAULT_TIMEOUT_MS,
  })
}

const handlerDefaults = new Map<string, { maxAttempts: number; timeoutMs: number }>()

export function hasHandler(name: string): boolean {
  return registry.has(name)
}

export function registeredHandlers(): string[] {
  return [...registry.keys()].sort()
}

/** Backoff: 2^attempt seconds, capped at 10 minutes, with ±25% jitter. */
export function backoffDelayMs(attempt: number, baseMs = 2000, capMs = 600_000): number {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1))
  const jitter = 1 + (Math.random() - 0.5) * 0.5
  return Math.round(raw * jitter)
}

export async function enqueue<TPayload extends Record<string, unknown>>(
  name: string,
  payload: TPayload,
  options: EnqueueOptions = {},
): Promise<{ id: string; deduped: boolean }> {
  const db = await getDb()
  const defaults = handlerDefaults.get(name)
  const runAt = options.runAt ?? new Date(Date.now() + (options.delayMs ?? 0))
  const values = {
    queue: options.queue ?? 'default',
    name,
    payload: payload as Record<string, unknown>,
    priority: options.priority ?? 5,
    attempts: 0,
    maxAttempts: options.maxAttempts ?? defaults?.maxAttempts ?? env.JOB_MAX_ATTEMPTS,
    timeoutMs: options.timeoutMs ?? defaults?.timeoutMs ?? env.JOB_DEFAULT_TIMEOUT_MS,
    runAt,
    workspaceId: options.workspaceId ?? null,
    dedupeKey: options.dedupeKey ?? null,
    status: 'queued' as JobStatus,
  }

  if (values.dedupeKey) {
    const existing = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(and(eq(jobsTable.dedupeKey, values.dedupeKey), inArray(jobsTable.status, ['queued', 'running'])))
      .limit(1)
    if (existing[0]) return { id: existing[0].id, deduped: true }
  }

  const inserted = await db.insert(jobsTable).values(values).returning({ id: jobsTable.id })
  const id = inserted[0]!.id
  await publish('jobs', JSON.stringify({ id, name, queue: values.queue }))
  return { id, deduped: false }
}

type ClaimedRow = {
  id: string
  queue: string
  name: string
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
  timeout_ms: number
  priority: number
  run_at: Date
  workspace_id: string | null
  locked_by: string | null
  dedupe_key: string | null
}

/**
 * Atomically claim the next runnable job. `SKIP LOCKED` keeps concurrent
 * workers from blocking on the same row.
 */
export async function claimJob(workerId: string, queues: string[] = []): Promise<JobRecord | null> {
  const db = await getDb()
  const queueFilter = queues.length ? sql`and queue in (${sql.join(queues.map((q) => sql`${q}`), sql`, `)})` : sql``
  const query = sql`
    update jobs set
      status = 'running',
      locked_by = ${workerId},
      locked_at = now(),
      started_at = coalesce(started_at, now()),
      attempts = attempts + 1,
      updated_at = now()
    where id = (
      select id from jobs
      where status = 'queued' and run_at <= now()
      ${queueFilter}
      order by priority asc, run_at asc
      for update skip locked
      limit 1
    )
    returning id, queue, name, payload, attempts, max_attempts, timeout_ms, priority, run_at,
              workspace_id, locked_by, dedupe_key
  `
  const result = await db.execute(query)
  const rows = extract<ClaimedRow>(result)
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    queue: row.queue,
    name: row.name,
    payload: row.payload ?? {},
    status: 'running',
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    timeoutMs: row.timeout_ms,
    runAt: new Date(row.run_at),
    lockedBy: row.locked_by,
    workspaceId: row.workspace_id,
    dedupeKey: row.dedupe_key,
    lastError: null,
  }
}

function extract<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object' && 'rows' in result) return ((result as { rows: unknown[] }).rows ?? []) as T[]
  return []
}

export type RunOutcome = {
  jobId: string
  name: string
  status: JobStatus
  durationMs: number
  result?: unknown
  error?: string
  retryInMs?: number
}

/** Execute a single claimed job, applying timeout, retry and dead-letter rules. */
export async function runJob(job: JobRecord, workerId: string): Promise<RunOutcome> {
  const db = await getDb()
  const started = Date.now()
  const handler = registry.get(job.name)
  const jobLog = createLogger({ component: 'worker', job: job.name, jobId: job.id, workerId })

  const finish = async (
    status: JobStatus,
    patch: { result?: unknown; error?: string | null; durationMs: number },
  ) => {
    await db
      .update(jobsTable)
      .set({
        status,
        finishedAt: new Date(),
        durationMs: patch.durationMs,
        result: status === 'succeeded' ? (patch.result as Record<string, unknown>) : undefined,
        lastError: patch.error ?? null,
        lockedBy: null,
        lockedAt: null,
        updatedAt: new Date(),
        stack: null,
      })
      .where(eq(jobsTable.id, job.id))
  }

  if (!handler) {
    const durationMs = Date.now() - started
    await finish('failed', { error: `No handler registered for job "${job.name}"`, durationMs })
    return { jobId: job.id, name: job.name, status: 'failed', durationMs, error: 'missing handler' }
  }

  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`Job timed out after ${job.timeoutMs}ms`))
    }, job.timeoutMs)
  })

  const ctx: JobContext = {
    job,
    workerId,
    attempt: job.attempts,
    log: (message, context) => jobLog.info(message, context),
    signal: controller.signal,
  }

  try {
    const result = await Promise.race([
      handler(job.payload as never, ctx),
      timeout,
    ])
    if (timer) clearTimeout(timer)
    const durationMs = Date.now() - started
    await finish('succeeded', { result, durationMs })
    jobLog.info('job succeeded', { durationMs })
    return { jobId: job.id, name: job.name, status: 'succeeded', durationMs, result }
  } catch (error) {
    if (timer) clearTimeout(timer)
    const durationMs = Date.now() - started
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    const aborted = controller.signal.aborted || /timed out/i.test(message)

    if (job.attempts >= job.maxAttempts) {
      await finish('dead', { error: message, durationMs })
      await db.update(jobsTable).set({ stack: stack ?? null }).where(eq(jobsTable.id, job.id))
      await persistLog({
        level: 'error',
        source: 'queue',
        message: `Job ${job.name} exhausted ${job.attempts} attempts: ${message}`,
        context: { jobId: job.id, stack },
        workspaceId: job.workspaceId,
        durationMs,
      })
      jobLog.error('job dead-lettered', error, { attempts: job.attempts })
      return { jobId: job.id, name: job.name, status: 'dead', durationMs, error: message }
    }

    const retryInMs = backoffDelayMs(job.attempts)
    await db
      .update(jobsTable)
      .set({
        status: 'queued',
        runAt: new Date(Date.now() + retryInMs),
        lastError: message,
        stack: stack ?? null,
        lockedBy: null,
        lockedAt: null,
        finishedAt: new Date(),
        durationMs,
        updatedAt: new Date(),
      })
      .where(eq(jobsTable.id, job.id))
    jobLog.warn('job failed, will retry', { attempt: job.attempts, retryInMs, aborted, message })
    return {
      jobId: job.id,
      name: job.name,
      status: 'failed',
      durationMs,
      error: message,
      retryInMs,
    }
  }
}

/** Requeue jobs whose worker died mid-flight (locked but stale). */
export async function requeueStalledJobs(staleSeconds = 300): Promise<number> {
  const db = await getDb()
  const cutoff = new Date(Date.now() - staleSeconds * 1000)
  const result = await db
    .update(jobsTable)
    .set({
      status: 'queued',
      lockedBy: null,
      lockedAt: null,
      lastError: 'requeued: worker heartbeat lost',
      updatedAt: new Date(),
      runAt: new Date(),
    })
    .where(and(eq(jobsTable.status, 'running'), lt(jobsTable.lockedAt, cutoff)))
    .returning({ id: jobsTable.id })
  if (result.length) log.warn('requeued stalled jobs', { count: result.length })
  return result.length
}

export async function cancelJob(id: string): Promise<boolean> {
  const db = await getDb()
  const result = await db
    .update(jobsTable)
    .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(jobsTable.id, id), inArray(jobsTable.status, ['queued', 'running'])))
    .returning({ id: jobsTable.id })
  return result.length > 0
}

export async function retryJob(id: string): Promise<boolean> {
  const db = await getDb()
  const result = await db
    .update(jobsTable)
    .set({
      status: 'queued',
      attempts: 0,
      runAt: new Date(),
      lastError: null,
      lockedBy: null,
      lockedAt: null,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(jobsTable.id, id), inArray(jobsTable.status, ['failed', 'dead', 'cancelled'])))
    .returning({ id: jobsTable.id })
  return result.length > 0
}

export async function queueStats(): Promise<QueueStats> {
  const db = await getDb()
  const since = new Date(Date.now() - 86_400_000)
  const [counts, byQueue, oldest, succeeded] = await Promise.all([
    db.select({ status: jobsTable.status, value: count() }).from(jobsTable).groupBy(jobsTable.status),
    db
      .select({ queue: jobsTable.queue, status: jobsTable.status, value: count() })
      .from(jobsTable)
      .where(inArray(jobsTable.status, ['queued', 'running', 'failed']))
      .groupBy(jobsTable.queue, jobsTable.status),
    db
      .select({ runAt: jobsTable.runAt })
      .from(jobsTable)
      .where(eq(jobsTable.status, 'queued'))
      .orderBy(asc(jobsTable.runAt))
      .limit(1),
    db
      .select({ value: count() })
      .from(jobsTable)
      .where(and(eq(jobsTable.status, 'succeeded'), gte(jobsTable.finishedAt, since))),
  ])

  const statusCount = (status: JobStatus) => Number(counts.find((c) => c.status === status)?.value ?? 0)
  const queueNames = [...new Set(byQueue.map((r) => r.queue))]

  return {
    driver: env.REDIS_URL === 'memory' ? 'memory' : 'redis',
    queued: statusCount('queued'),
    running: statusCount('running'),
    failed: statusCount('failed'),
    dead: statusCount('dead'),
    succeeded24h: Number(succeeded[0]?.value ?? 0),
    oldestQueuedSeconds: oldest[0]?.runAt
      ? Math.max(0, Math.round((Date.now() - new Date(oldest[0].runAt).getTime()) / 1000))
      : null,
    byQueue: queueNames.map((queue) => ({
      queue,
      queued: Number(byQueue.find((r) => r.queue === queue && r.status === 'queued')?.value ?? 0),
      running: Number(byQueue.find((r) => r.queue === queue && r.status === 'running')?.value ?? 0),
      failed: Number(byQueue.find((r) => r.queue === queue && r.status === 'failed')?.value ?? 0),
    })),
  }
}

export async function listJobs(options: {
  status?: JobStatus[]
  queue?: string
  limit?: number
  workspaceId?: string
} = {}) {
  const db = await getDb()
  const conditions = [
    options.status?.length ? inArray(jobsTable.status, options.status) : undefined,
    options.queue ? eq(jobsTable.queue, options.queue) : undefined,
    options.workspaceId ? eq(jobsTable.workspaceId, options.workspaceId) : undefined,
  ].filter(Boolean)
  const query = db.select().from(jobsTable).orderBy(desc(jobsTable.createdAt)).limit(Math.min(options.limit ?? 50, 200))
  if (conditions.length) return query.where(and(...(conditions as never[])))
  return query
}

/**
 * Run a job inline (await the handler directly, still recording a `jobs` row).
 * Used for user-triggered actions in environments without a separate worker
 * process, so the product is fully usable on a single container.
 */
export async function runInline<T = unknown>(
  name: string,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<{ jobId: string; result: T | null; status: JobStatus; error?: string }> {
  const db = await getDb()
  const { id } = await enqueue(name, payload, options)
  const handler = registry.get(name)
  const job: JobRecord = {
    id,
    queue: options.queue ?? 'default',
    name,
    payload,
    status: 'running',
    priority: options.priority ?? 5,
    attempts: 1,
    maxAttempts: options.maxAttempts ?? env.JOB_MAX_ATTEMPTS,
    timeoutMs: options.timeoutMs ?? env.JOB_DEFAULT_TIMEOUT_MS,
    runAt: new Date(),
    lockedBy: 'inline',
    workspaceId: options.workspaceId ?? null,
    dedupeKey: options.dedupeKey ?? null,
    lastError: null,
  }
  if (!handler) {
    await db.update(jobsTable).set({ status: 'dead', lastError: `No handler for ${name}` }).where(eq(jobsTable.id, id))
    return { jobId: id, result: null, status: 'dead', error: `No handler for ${name}` }
  }
  await db
    .update(jobsTable)
    .set({ status: 'running', lockedBy: 'inline', startedAt: new Date(), attempts: 1 })
    .where(eq(jobsTable.id, id))
  const outcome = await runJob(job, 'inline')
  return {
    jobId: id,
    result: (outcome.result as T) ?? null,
    status: outcome.status,
    error: outcome.error,
  }
}

export function memoryQueueNote(): string {
  return env.REDIS_URL === 'memory'
    ? 'Queue driver: postgres (Redis disabled). Jobs are durable and processed by the worker process.'
    : 'Queue driver: postgres + redis (Redis provides low-latency dispatch and locks).'
}

export const queueTables = { jobsTable, schema }
export { isNull, lte, or }
