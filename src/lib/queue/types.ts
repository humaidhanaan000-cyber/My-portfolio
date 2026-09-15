export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled'

export type JobRecord = {
  id: string
  queue: string
  name: string
  payload: Record<string, unknown>
  status: JobStatus
  priority: number
  attempts: number
  maxAttempts: number
  timeoutMs: number
  runAt: Date
  lockedBy: string | null
  workspaceId: string | null
  dedupeKey: string | null
  lastError: string | null
}

export type EnqueueOptions = {
  queue?: string
  priority?: number
  delayMs?: number
  runAt?: Date
  maxAttempts?: number
  timeoutMs?: number
  workspaceId?: string | null
  dedupeKey?: string | null
}

export type JobContext = {
  job: JobRecord
  workerId: string
  attempt: number
  log: (message: string, context?: Record<string, unknown>) => void
  signal: AbortSignal
}

export type JobHandler<TPayload = Record<string, unknown>, TResult = unknown> = (
  payload: TPayload,
  ctx: JobContext,
) => Promise<TResult>

export type QueueStats = {
  driver: 'redis' | 'memory'
  queued: number
  running: number
  failed: number
  dead: number
  succeeded24h: number
  oldestQueuedSeconds: number | null
  byQueue: { queue: string; queued: number; running: number; failed: number }[]
}
