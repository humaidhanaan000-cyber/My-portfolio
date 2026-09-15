/**
 * Structured JSON logging with a request/run correlation id.
 * Chosen over a vendor SDK so logs are portable to any collector
 * (Loki, CloudWatch, Datadog, journald) without a code change.
 */
import { env } from '../env'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 }
const MIN = LEVELS[env.LOG_LEVEL as LogLevel] ?? LEVELS.info

export type LogContext = Record<string, unknown>

function serialiseError(error: unknown): LogContext {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message, stack: error.stack?.split('\n').slice(0, 8).join('\n') }
  }
  if (error !== undefined) return { error: String(error) }
  return {}
}

function emit(level: LogLevel, message: string, context?: LogContext) {
  if (LEVELS[level] < MIN) return
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'aiba',
    version: env.SERVICE_VERSION,
    msg: message,
    ...context,
  }
  const line = JSON.stringify(entry, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  if (LEVELS[level] >= LEVELS.error) console.error(line)
  else if (LEVELS[level] === LEVELS.warn) console.warn(line)
  else console.log(line)
}

export type Logger = {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, error?: unknown, context?: LogContext): void
  fatal(message: string, error?: unknown, context?: LogContext): void
  child(context: LogContext): Logger
}

export function createLogger(context: LogContext = {}): Logger {
  const base = context
  return {
    debug: (m, c) => emit('debug', m, { ...base, ...c }),
    info: (m, c) => emit('info', m, { ...base, ...c }),
    warn: (m, c) => emit('warn', m, { ...base, ...c }),
    error: (m, e, c) => emit('error', m, { ...base, ...serialiseError(e), ...c }),
    fatal: (m, e, c) => emit('fatal', m, { ...base, ...serialiseError(e), ...c }),
    child: (c) => createLogger({ ...base, ...c }),
  }
}

export const logger = createLogger({ component: 'app' })

/** Persist a structured log line into `system_logs` (best-effort, never throws). */
export async function persistLog(entry: {
  level: LogLevel
  source: string
  message: string
  context?: LogContext
  workspaceId?: string | null
  userId?: string | null
  requestId?: string | null
  durationMs?: number | null
}): Promise<void> {
  try {
    const { getDb, systemLogs } = await import('../db')
    const db = await getDb()
    await db.insert(systemLogs).values({
      workspaceId: entry.workspaceId ?? null,
      userId: entry.userId ?? null,
      level: entry.level === 'fatal' ? 'fatal' : entry.level,
      source: entry.source,
      message: entry.message.slice(0, 4000),
      context: (entry.context ?? {}) as Record<string, unknown>,
      requestId: entry.requestId ?? null,
      durationMs: entry.durationMs ?? null,
    })
  } catch (error) {
    // Never let observability break the request path.
    console.error('[logger] persistLog failed', error instanceof Error ? error.message : error)
  }
}
