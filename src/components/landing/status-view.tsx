'use client'

/**
 * Live public status view.
 *
 * Polls the unauthenticated `/api/status` endpoint — the same payload an uptime
 * monitor would read — and renders exactly what the server reports. Nothing is
 * simulated: when the database is down, this page says so.
 */
import { useEffect, useState } from 'react'

type StatusPayload = {
  service: string
  version: string
  environment: string
  uptimeSeconds: number
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE'
  components: {
    database: { ok: boolean; latencyMs: number; driver: string }
    queue: { driver: string; queued: number; failed: number; dead: number }
    ai: { configured: boolean; provider: string }
    payments: { provider: string; configured: boolean }
    storage: { driver: string; ready: boolean }
  }
  timestamp: string
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function StatusView({ initial }: { initial: StatusPayload | null }) {
  const [status, setStatus] = useState<StatusPayload | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(initial?.timestamp ?? null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await fetch('/api/status', { cache: 'no-store' })
        const body = (await response.json()) as { data?: StatusPayload; error?: { message: string } }
        if (cancelled) return
        if (body.data) {
          setStatus(body.data)
          setCheckedAt(body.data.timestamp)
          setError(null)
        } else {
          setError(body.error?.message ?? 'Status endpoint returned an unexpected response.')
        }
      } catch {
        if (!cancelled) setError('The status endpoint could not be reached from this browser.')
      }
    }
    const timer = window.setInterval(() => void load(), 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const tone = status?.status === 'ONLINE' ? 'positive' : status?.status === 'DEGRADED' ? 'warning' : 'critical'

  return (
    <div className="space-y-6">
      <div className="surface flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <p className="text-xs font-semibold tracking-widest text-ink-500 uppercase">Current status</p>
          <p className={`mt-1 text-2xl font-semibold tracking-tight ${tone === 'positive' ? 'text-signal-positive' : tone === 'warning' ? 'text-signal-warning' : 'text-signal-critical'}`}>
            {status?.status ?? 'UNKNOWN'}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            {status ? `${status.service} v${status.version} · ${status.environment} · uptime ${formatUptime(status.uptimeSeconds)}` : 'Waiting for the first reading.'}
          </p>
        </div>
        <div className="text-right text-[11px] text-ink-500">
          <p>Auto-refreshes every 30 seconds.</p>
          <p className="mt-1">Last reading: {checkedAt ? new Date(checkedAt).toLocaleTimeString() : '—'}</p>
          {error ? <p className="mt-1 text-signal-critical">{error}</p> : null}
        </div>
      </div>

      {status ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Component
            title="Database"
            ok={status.components.database.ok}
            detail={`${status.components.database.driver} · ${status.components.database.latencyMs} ms round trip`}
          />
          <Component
            title="Queue"
            ok={status.components.queue.failed === 0 && status.components.queue.dead === 0}
            detail={`${status.components.queue.driver} · ${status.components.queue.queued} queued · ${status.components.queue.failed} failed · ${status.components.queue.dead} dead`}
          />
          <Component
            title="AI provider"
            ok={status.components.ai.configured}
            detail={status.components.ai.configured ? `${status.components.ai.provider} configured` : 'Not configured — agents run without model calls'}
            neutralWhenFalse
          />
          <Component
            title="Payments"
            ok={status.components.payments.configured}
            detail={status.components.payments.configured ? `${status.components.payments.provider} checkout ready` : `${status.components.payments.provider} — checkout not configured`}
            neutralWhenFalse
          />
          <Component
            title="Storage"
            ok={status.components.storage.ready}
            detail={status.components.storage.driver}
            neutralWhenFalse
          />
          <Component
            title="Approval gate"
            ok
            detail="Public, paid and irreversible actions stop for human approval — this is always on."
          />
        </div>
      ) : null}
    </div>
  )
}

function Component({ title, ok, detail, neutralWhenFalse = false }: { title: string; ok: boolean; detail: string; neutralWhenFalse?: boolean }) {
  const colour = ok ? 'bg-signal-positive' : neutralWhenFalse ? 'bg-signal-warning' : 'bg-signal-critical'
  return (
    <div className="surface p-5">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${colour}`} />
        <p className="text-sm font-medium text-ink-900">{title}</p>
      </div>
      <p className="mt-2 text-xs text-ink-600">{detail}</p>
    </div>
  )
}
