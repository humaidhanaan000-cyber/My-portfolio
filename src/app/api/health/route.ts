/**
 * GET /api/health — liveness and readiness probe.
 * Public by design (used by Docker health checks and uptime monitors) but it
 * never exposes secrets: only booleans and latencies.
 */
import { NextResponse } from 'next/server'
import { checkDatabaseHealth } from '@/lib/db'
import { queueStats, registeredHandlers } from '@/lib/queue'
import { registerAllHandlers } from '@/lib/queue/handlers'
import { pingRedis } from '@/lib/queue/redis'
import { aiStatus } from '@/lib/ai'
import { env, publicConfig } from '@/lib/env'
import { appliedMigrations } from '@/lib/db/migrate'
import { getDb, workerHeartbeats } from '@/lib/db'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function GET() {
  registerAllHandlers()
  const started = Date.now()
  const [database, redis, queue] = await Promise.all([checkDatabaseHealth(), pingRedis(), queueStats().catch(() => null)])

  let migrations: { applied: number; failed: number } = { applied: 0, failed: 0 }
  try {
    const records = await appliedMigrations()
    migrations = { applied: records.filter((r) => r.status === 'applied').length, failed: records.filter((r) => r.status === 'failed').length }
  } catch {
    /* reported via database.ok */
  }

  let workers: { role: string; status: string; lastHeartbeatAt: string }[] = []
  try {
    const db = await getDb()
    const rows = await db.execute(sql`
      select role, status, last_heartbeat_at from worker_heartbeats
      where last_heartbeat_at > now() - interval '3 minutes' order by last_heartbeat_at desc limit 5
    `)
    const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as { role: string; status: string; last_heartbeat_at: string }[]
    workers = list.map((row) => ({ role: row.role, status: row.status, lastHeartbeatAt: new Date(row.last_heartbeat_at).toISOString() }))
  } catch {
    /* database unavailable — reported below */
  }
  void workerHeartbeats

  const ai = aiStatus()
  const healthy = database.ok && migrations.failed === 0
  const degraded = !ai.configured || workers.length === 0

  return NextResponse.json(
    {
      status: healthy ? (degraded ? 'degraded' : 'ok') : 'error',
      version: env.SERVICE_VERSION,
      environment: env.NODE_ENV,
      uptimeSeconds: Math.floor(process.uptime()),
      latencyMs: Date.now() - started,
      checks: {
        database: { ok: database.ok, driver: database.driver, latencyMs: database.latencyMs, error: database.error },
        migrations,
        redis: { configured: redis.configured, ok: redis.ok, latencyMs: redis.latencyMs },
        queue: queue ? { driver: queue.driver, queued: queue.queued, running: queue.running, failed: queue.failed, dead: queue.dead } : null,
        workers,
        ai: { configured: ai.configured, provider: ai.provider, networkAllowed: ai.networkAllowed },
        handlers: registeredHandlers().length,
      },
      config: publicConfig(),
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  )
}
