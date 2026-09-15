/**
 * GET /api/status — public, unauthenticated system status.
 * Exposes only booleans and counters; no secrets, no workspace data.
 */
import { ok } from '@/lib/api/http'
import { queueStats } from '@/lib/queue'
import { checkDatabaseHealth } from '@/lib/db'
import { aiStatus } from '@/lib/ai'
import { paymentStatus } from '@/lib/payments'
import { storageStatus } from '@/lib/storage'
import { env } from '@/lib/env'
import { systemStatus } from '@/lib/agents/orchestrator'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [database, queue, ai] = await Promise.all([checkDatabaseHealth(), queueStats().catch(() => null), Promise.resolve(aiStatus())])
  const payments = paymentStatus()
  const storage = storageStatus()

  return ok({
    service: env.APP_NAME,
    version: env.SERVICE_VERSION,
    environment: env.NODE_ENV,
    uptimeSeconds: Math.floor(process.uptime()),
    status: database.ok ? 'operational' : 'degraded',
    components: {
      database: { ok: database.ok, latencyMs: database.latencyMs, driver: database.driver },
      queue: queue ? { driver: queue.driver, queued: queue.queued, failed: queue.failed, dead: queue.dead } : null,
      ai: { configured: ai.configured, provider: ai.provider },
      payments: { provider: payments.provider, configured: payments.configured },
      storage: { driver: storage.driver, ready: storage.ready },
    },
    timestamp: new Date().toISOString(),
  })
}

export async function HEAD() {
  const status = await systemStatus('00000000-0000-0000-0000-000000000000').catch(() => null)
  void status
  return new Response(null, { status: 200 })
}
