import type { Metadata } from 'next'
import { SectionFooter } from './_footer'
import { SectionHeading, SiteFooter, SiteNav } from '@/components/landing'
import { StatusView } from '@/components/landing/status-view'
import { getSession } from '@/lib/auth'
import { queueStats } from '@/lib/queue'
import { checkDatabaseHealth } from '@/lib/db'
import { aiStatus } from '@/lib/ai'
import { paymentStatus } from '@/lib/payments'
import { storageStatus } from '@/lib/storage'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'System status',
  description:
    'Live status of the AIBA deployment: database round trip, queue depth, AI provider, payment provider and storage — read straight from the running server.',
  alternates: { canonical: '/status' },
}

export default async function StatusPage() {
  const session = await getSession().catch(() => null)
  const [database, queue] = await Promise.all([checkDatabaseHealth().catch(() => ({ ok: false, latencyMs: 0, driver: 'unknown' })), queueStats().catch(() => null)])
  const ai = aiStatus()
  const payments = paymentStatus()
  const storage = storageStatus()

  const status = !database.ok ? 'OFFLINE' : (queue?.failed ?? 0) > 0 || (queue?.dead ?? 0) > 0 ? 'DEGRADED' : 'ONLINE'

  return (
    <div className="min-h-screen bg-ink-50">
      <SiteNav signedIn={Boolean(session)} />

      <section className="border-b border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <SectionHeading
            eyebrow="Status"
            title="This page reports the deployment, live"
            description="The same values the Docker health check and any uptime monitor read. If a component is not configured it says so rather than pretending to be healthy."
          />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12">
        <StatusView
          initial={{
            service: 'aiba',
            version: env.SERVICE_VERSION,
            environment: env.APP_URL,
            uptimeSeconds: Math.round(process.uptime()),
            status,
            components: {
              database: { ok: database.ok, latencyMs: database.latencyMs, driver: database.driver },
              queue: { driver: queue?.driver ?? 'inline', queued: queue?.queued ?? 0, failed: queue?.failed ?? 0, dead: queue?.dead ?? 0 },
              ai: { configured: ai.configured, provider: ai.provider },
              payments: { provider: payments.provider, configured: payments.configured },
              storage: { driver: storage.driver, ready: storage.ready },
            },
            timestamp: new Date().toISOString(),
          }}
        />
        <SectionFooter />
      </section>

      <SiteFooter />
    </div>
  )
}
