'use client'
/**
 * Admin console and team screen.
 *
 * The console is a read-only window into the platform: users, agents, queues,
 * jobs, opportunities, projects, approvals, money, API usage, logs, errors,
 * migrations and health. Every number here is queried live from the database —
 * there are no cached or decorative values.
 */
import { useState } from 'react'
import { Activity, AlertOctagon, Boxes, Cpu, Database, FileWarning, Gauge, HeartPulse, Lightbulb, Server, ShieldCheck, Terminal, Users } from 'lucide-react'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, KeyValue, Select, Stat, Table, Tabs } from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { formatDate, formatMoney, formatNumber, formatPercent, relativeTime } from '@/lib/client/format'

type AdminPayload = {
  platform: { users: number; workspaces: number; opportunities: number; projects: number; plans: { planKey: string; count: number }[] }
  approvals: Record<string, number>
  money: {
    revenueGrossCents: number
    revenueNetCents: number
    verifiedRevenueCents: number
    demoRevenueCents: number
    transactionCount: number
    expenseCents: number
    expenseCount: number
  }
  queues: {
    stats: { driver: string; queued: number; running: number; failed: number; dead: number; succeeded24h: number; oldestQueuedSeconds: number | null; byQueue: { queue: string; queued: number; running: number; failed: number; dead: number }[] }
    byStatus: Record<string, number>
  }
  workers: { id: string; name: string; queue: string; status: string; lastHeartbeatAt: string | null; processed: number; failed: number }[]
  system: {
    status: string
    agentsActive: number
    agentsTotal: number
    uptimeSeconds: number
    currentTask: { name: string; startedAt?: string } | null
    nextScheduledTask: { name: string; runAt: string } | null
    database: { ok: boolean; latencyMs: number; driver: string }
    ai: { configured: boolean; provider: string; models: { cheap: string; standard: string; reasoning: string }; networkAllowed: boolean; reason: string }
    workers: number
    version: string
  }
  database: { driver: string; ok: boolean; latencyMs: number; serverVersion: string; migrationsApplied: number }
  migrations: { id: string; name: string; checksum: string; applied_at: string; execution_ms: number; status: string; error: string | null }[]
  agents: {
    roster: { key: string; enabled: boolean; status: string; lastRunAt: string | null; lastError: string | null; successCount: number; failureCount: number }[]
    activity: { agentKey: string; runs: number; costCents: number; failures: number }[]
  }
  alerts: { id: string; type: string; severity: string; title: string; message: string; source: string; status: string; occurrenceCount: number; lastSeenAt: string }[]
  apiUsage: { endpoint: string; calls: number; errors: number; avgMs: number }[]
  errors: { id: string; level: string; source: string; message: string; context: unknown; createdAt: string }[]
  audit: { id: string; action: string; entityType: string | null; entityId: string | null; actorType: string; userId: string | null; workspaceId: string | null; createdAt: string }[]
}

export function AdminConsole() {
  const [tab, setTab] = useState('overview')
  const admin = useApi<AdminPayload>('/api/admin', { pollMs: 60_000 })
  const data = admin.data

  if (admin.loading) return <Card><div className="h-40 animate-pulse rounded bg-ink-100" /></Card>
  if (admin.error) return <ErrorNote message={admin.error} onRetry={() => void admin.refresh()} />
  if (!data) return null

  const uptimeHours = Math.round(data.system.uptimeSeconds / 3600)
  const netMargin = data.money.revenueNetCents > 0 ? ((data.money.revenueNetCents - data.money.expenseCents) / data.money.revenueNetCents) * 100 : 0

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Admin console</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            Platform-wide view. Restricted to administrator accounts; every section reads live data from the database and the queue.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void admin.refresh()} loading={admin.loading}>Refresh</Button>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Accounts" value={formatNumber(data.platform.users)} hint={`${data.platform.workspaces} workspace(s)`} icon={<Users className="h-4 w-4" />} />
        <Stat label="Opportunities" value={formatNumber(data.platform.opportunities)} hint={`${data.platform.projects} project(s)`} icon={<Lightbulb className="h-4 w-4" />} />
        <Stat
          label="Verified revenue"
          value={formatMoney(data.money.verifiedRevenueCents)}
          hint={`${formatNumber(data.money.transactionCount)} transaction(s) · gross ${formatMoney(data.money.revenueGrossCents)}`}
          tone="positive"
        />
        <Stat
          label="Recorded costs"
          value={formatMoney(data.money.expenseCents)}
          hint={`net margin ${formatPercent(netMargin)}`}
          tone={data.money.expenseCents > data.money.revenueNetCents ? 'critical' : 'neutral'}
        />
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: 'Health', count: data.alerts.length || undefined },
          { key: 'agents', label: 'Agents', count: data.agents.roster.length },
          { key: 'queues', label: 'Queues & jobs', count: data.queues.stats.queued + data.queues.stats.running },
          { key: 'money', label: 'Money' },
          { key: 'usage', label: 'API usage', count: data.apiUsage.length },
          { key: 'errors', label: 'Logs & errors', count: data.errors.length },
          { key: 'audit', label: 'Audit trail', count: data.audit.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="System health" subtitle={`${data.system.status} · version ${data.system.version}`} icon={<HeartPulse className="h-4 w-4" />} />
            <div className="grid gap-3 sm:grid-cols-2">
              <KeyValue
                items={[
                  { label: 'Status', value: <Badge tone={data.system.status === 'ONLINE' ? 'positive' : data.system.status === 'DEGRADED' ? 'warning' : 'critical'}>{data.system.status}</Badge> },
                  { label: 'Uptime', value: `${formatNumber(uptimeHours)} h` },
                  { label: 'Agents active', value: `${data.system.agentsActive} / ${data.system.agentsTotal}` },
                  { label: 'Workers', value: formatNumber(data.system.workers) },
                  { label: 'Current task', value: data.system.currentTask?.name ?? 'idle' },
                  { label: 'Next scheduled', value: data.system.nextScheduledTask ? `${data.system.nextScheduledTask.name} ${relativeTime(data.system.nextScheduledTask.runAt)}` : '—' },
                ]}
              />
              <KeyValue
                items={[
                  { label: 'Database', value: `${data.database.driver} · ${data.database.latencyMs} ms · ${data.database.ok ? 'ok' : 'unreachable'}` },
                  { label: 'Migrations applied', value: formatNumber(data.database.migrationsApplied) },
                  { label: 'Queue driver', value: data.queues.stats.driver },
                  { label: 'Queued / running', value: `${data.queues.stats.queued} / ${data.queues.stats.running}` },
                  { label: 'Failed / dead', value: `${data.queues.stats.failed} / ${data.queues.stats.dead}` },
                  { label: 'Succeeded 24h', value: formatNumber(data.queues.stats.succeeded24h) },
                ]}
              />
            </div>
            <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-[11px] text-ink-600">
              <p><strong>AI provider:</strong> {data.system.ai.provider} {data.system.ai.configured ? '(configured)' : '(not configured — agents run deterministically without model calls)'}</p>
              <p className="mt-0.5">{data.system.ai.reason}</p>
              <p className="mt-0.5 text-ink-400">Models: {data.system.ai.models.cheap} · {data.system.ai.models.standard} · {data.system.ai.models.reasoning} · network {data.system.ai.networkAllowed ? 'allowed' : 'blocked'}</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Open alerts" subtitle="Deduplicated by condition" icon={<AlertOctagon className="h-4 w-4" />} />
            {data.alerts.length === 0 ? (
              <p className="text-[11px] text-ink-500">No open alerts. Conditions are re-evaluated on every scheduler pass.</p>
            ) : (
              <ul className="space-y-2">
                {data.alerts.map((alert) => (
                  <li key={alert.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="text-xs font-medium text-amber-900">{alert.title}</p>
                    <p className="mt-0.5 text-[11px] text-amber-800">{alert.message}</p>
                    <p className="mt-1 text-[10px] text-amber-700">{alert.source} · seen {alert.occurrenceCount}× · {relativeTime(alert.lastSeenAt)}</p>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 space-y-1 text-[11px] text-ink-500">
              <p className="font-medium text-ink-700">Migration status</p>
              {data.migrations.length === 0 ? (
                <p>No migrations recorded.</p>
              ) : (
                data.migrations.map((migration) => (
                  <p key={migration.id} className="flex items-center gap-2">
                    <Badge tone={migration.status === 'applied' ? 'positive' : 'warning'}>{migration.status}</Badge>
                    {migration.name} · {migration.execution_ms} ms
                  </p>
                ))
              )}
            </div>
          </Card>

          <Card className="lg:col-span-3">
            <CardHeader title="Approval load by status" subtitle="Platform-wide counts" icon={<ShieldCheck className="h-4 w-4" />} />
            {Object.keys(data.approvals).length === 0 ? (
              <p className="text-[11px] text-ink-500">No approval requests have been created yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.approvals).map(([status, count]) => (
                  <span key={status} className="rounded-lg border border-ink-200 px-3 py-2 text-[11px]">
                    <span className="text-ink-500">{status}</span>
                    <span className="tabular ml-2 font-medium text-ink-900">{formatNumber(Number(count))}</span>
                  </span>
                ))}
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {tab === 'agents' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Agent roster" subtitle="Platform-wide state" icon={<Cpu className="h-4 w-4" />} />
            <Table headers={['Agent', 'State', 'Last run', 'OK / fail', 'Last error']}>
              {data.agents.roster.map((agent) => (
                <tr key={agent.key} className="border-t border-ink-200">
                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink-700">{agent.key}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={!agent.enabled ? 'neutral' : agent.status === 'errored' ? 'critical' : agent.status === 'running' ? 'info' : 'positive'}>{agent.enabled ? agent.status : 'disabled'}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-[11px] text-ink-500">{agent.lastRunAt ? relativeTime(agent.lastRunAt) : 'never'}</td>
                  <td className="tabular px-4 py-2.5 text-[11px] text-ink-600">{agent.successCount} / {agent.failureCount}</td>
                  <td className="px-4 py-2.5 text-[11px] text-ink-400">{agent.lastError ? agent.lastError.slice(0, 60) : '—'}</td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card>
            <CardHeader title="Agent activity" subtitle="Runs and spend by agent" />
            {data.agents.activity.length === 0 ? (
              <p className="text-[11px] text-ink-500">No agent runs recorded yet.</p>
            ) : (
              <Table headers={['Agent', 'Runs', 'Failures', 'Spend']}>
                {data.agents.activity.map((row) => (
                  <tr key={row.agentKey} className="border-t border-ink-200">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-700">{row.agentKey}</td>
                    <td className="tabular px-4 py-2.5 text-[11px] text-ink-700">{row.runs}</td>
                    <td className="tabular px-4 py-2.5 text-[11px] text-ink-600">{row.failures}</td>
                    <td className="tabular px-4 py-2.5 text-[11px] text-ink-700">{formatMoney(row.costCents)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      ) : null}

      {tab === 'queues' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Queue depth" subtitle={`Driver: ${data.queues.stats.driver}`} icon={<Server className="h-4 w-4" />} />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ['Queued', data.queues.stats.queued],
                ['Running', data.queues.stats.running],
                ['Failed', data.queues.stats.failed],
                ['Dead', data.queues.stats.dead],
              ] as const).map(([label, value]) => (
                <div key={label} className="rounded-lg bg-ink-50 px-3 py-2">
                  <p className="text-[11px] text-ink-500">{label}</p>
                  <p className="tabular mt-0.5 text-sm font-semibold text-ink-900">{formatNumber(value)}</p>
                </div>
              ))}
            </div>
            {data.queues.stats.oldestQueuedSeconds !== null ? (
              <p className="mt-3 text-[11px] text-amber-700">Oldest queued job: {formatNumber(data.queues.stats.oldestQueuedSeconds)} s — the worker may be stopped.</p>
            ) : null}
            <Table headers={['Queue', 'Queued', 'Running', 'Failed', 'Dead']}>
              {data.queues.stats.byQueue.map((row) => (
                <tr key={row.queue} className="border-t border-ink-200">
                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink-700">{row.queue}</td>
                  <td className="tabular px-4 py-2.5 text-[11px] text-ink-700">{row.queued}</td>
                  <td className="tabular px-4 py-2.5 text-[11px] text-ink-700">{row.running}</td>
                  <td className="tabular px-4 py-2.5 text-[11px] text-ink-600">{row.failed}</td>
                  <td className="tabular px-4 py-2.5 text-[11px] text-ink-600">{row.dead}</td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card>
            <CardHeader title="Workers" subtitle="Heartbeat check" icon={<Activity className="h-4 w-4" />} />
            {data.workers.length === 0 ? (
              <EmptyState
                icon={<Server className="h-5 w-5" />}
                title="No worker heartbeats"
                description="Jobs are dispatched inline by the web process unless a worker is running. Start the worker to run the business loop at 15-minute cadence."
              />
            ) : (
              <Table headers={['Worker', 'Queue', 'Status', 'Heartbeat', 'Processed', 'Failed']}>
                {data.workers.map((worker) => (
                  <tr key={worker.id} className="border-t border-ink-200">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-700">{worker.name}</td>
                    <td className="px-4 py-2.5 text-[11px] text-ink-600">{worker.queue}</td>
                    <td className="px-4 py-2.5"><Badge tone={worker.status === 'healthy' ? 'positive' : 'warning'}>{worker.status}</Badge></td>
                    <td className="px-4 py-2.5 text-[11px] text-ink-500">{worker.lastHeartbeatAt ? relativeTime(worker.lastHeartbeatAt) : '—'}</td>
                    <td className="tabular px-4 py-2.5 text-[11px] text-ink-700">{worker.processed}</td>
                    <td className="tabular px-4 py-2.5 text-[11px] text-ink-600">{worker.failed}</td>
                  </tr>
                ))}
              </Table>
            )}
            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              <Badge tone="neutral">by status: {Object.entries(data.queues.byStatus).map(([key, value]) => `${key} ${value}`).join(' · ') || 'none'}</Badge>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'money' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Revenue by verification" subtitle="Demo revenue is structurally separated" icon={<Gauge className="h-4 w-4" />} />
            <KeyValue
              items={[
                { label: 'Gross recorded', value: formatMoney(data.money.revenueGrossCents) },
                { label: 'Net after fees', value: formatMoney(data.money.revenueNetCents) },
                { label: 'Provider-verified', value: formatMoney(data.money.verifiedRevenueCents) },
                { label: 'Demo rows (excluded from real totals)', value: formatMoney(data.money.demoRevenueCents) },
                { label: 'Transactions', value: formatNumber(data.money.transactionCount) },
              ]}
            />
          </Card>
          <Card>
            <CardHeader title="Costs & plans" subtitle="Expenses and plan distribution" icon={<Boxes className="h-4 w-4" />} />
            <KeyValue
              items={[
                { label: 'Expenses recorded', value: formatMoney(data.money.expenseCents) },
                { label: 'Expense entries', value: formatNumber(data.money.expenseCount) },
                { label: 'Net position', value: formatMoney(data.money.revenueNetCents - data.money.expenseCents) },
              ]}
            />
            <Table headers={['Plan', 'Workspaces']}>
              {data.platform.plans.map((row) => (
                <tr key={row.planKey} className="border-t border-ink-200">
                  <td className="px-4 py-2.5 text-[11px] text-ink-700">{row.planKey}</td>
                  <td className="tabular px-4 py-2.5 text-[11px] text-ink-700">{row.count}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      ) : null}

      {tab === 'usage' ? (
        <Card>
          <CardHeader title="API usage" subtitle="Call counts and error rates per endpoint" icon={<Terminal className="h-4 w-4" />} />
          {data.apiUsage.length === 0 ? (
            <EmptyState icon={<Terminal className="h-5 w-5" />} title="No API usage recorded" description="Usage rows are written as endpoints are called after migrations are applied." />
          ) : (
            <Table headers={['Endpoint', 'Calls', 'Errors', 'Average duration']}>
              {data.apiUsage.map((row) => (
                <tr key={row.endpoint} className="border-t border-ink-200">
                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink-700">{row.endpoint}</td>
                  <td className="tabular px-4 py-2.5 text-[11px] text-ink-700">{formatNumber(row.calls)}</td>
                  <td className="tabular px-4 py-2.5 text-[11px] text-ink-600">{formatNumber(row.errors)}</td>
                  <td className="tabular px-4 py-2.5 text-[11px] text-ink-600">{Math.round(row.avgMs)} ms</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : null}

      {tab === 'errors' ? (
        <Card>
          <CardHeader title="Logs & errors" subtitle="Server-side log entries with context" icon={<FileWarning className="h-4 w-4" />} />
          {data.errors.length === 0 ? (
            <EmptyState icon={<FileWarning className="h-5 w-5" />} title="No errors logged" description="Unhandled API errors and job failures are written here with their request context." />
          ) : (
            <ul className="space-y-2">
              {data.errors.map((entry) => (
                <li key={entry.id} className="rounded-lg border border-ink-200 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-ink-800">{entry.message}</span>
                    <Badge tone={entry.level === 'error' ? 'critical' : entry.level === 'warn' ? 'warning' : 'info'}>{entry.level}</Badge>
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-500">{entry.source} · {formatDate(entry.createdAt)} · {relativeTime(entry.createdAt)}</p>
                  {entry.context ? <pre className="mt-1 max-h-32 overflow-auto rounded bg-ink-50 p-2 text-[10px] text-ink-600">{JSON.stringify(entry.context, null, 2)}</pre> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === 'audit' ? (
        <Card>
          <CardHeader title="Audit trail" subtitle="Who changed what, and when. Append-only." icon={<Database className="h-4 w-4" />} />
          {data.audit.length === 0 ? (
            <p className="text-[11px] text-ink-500">No audit entries yet.</p>
          ) : (
            <Table headers={['When', 'Action', 'Entity', 'Actor']}>
              {data.audit.map((entry) => (
                <tr key={entry.id} className="border-t border-ink-200">
                  <td className="px-4 py-2.5 text-[11px] text-ink-500">{formatDate(entry.createdAt)}<div className="text-ink-400">{relativeTime(entry.createdAt)}</div></td>
                  <td className="px-4 py-2.5 text-xs text-ink-800">{entry.action}</td>
                  <td className="px-4 py-2.5 text-[11px] text-ink-500">{entry.entityType ?? '—'}{entry.entityId ? ` · ${entry.entityId.slice(0, 8)}` : ''}</td>
                  <td className="px-4 py-2.5 text-[11px] text-ink-500">{entry.actorType}{entry.userId ? ` · ${entry.userId.slice(0, 8)}` : ''}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------- team */

export function TeamSettings() {
  const users = useApi<{
    user: { id: string; email: string; name: string; role: string; status: string; emailVerifiedAt: string | null; lastLoginAt: string | null; timezone: string; createdAt: string }
    profile: { legalName: string | null; country: string; currency: string; interests: string[]; skills: string[]; industries: string[]; businessModels: string[]; monetizationPreferences: string[]; riskTolerance: string; automationLevel: string }
    workspace: { id: string; name: string; slug: string; planKey: string }
  }>('/api/users')
  const [form, setForm] = useState<{ name: string; timezone: string; country: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const data = users.data

  async function save() {
    if (!form) return
    setBusy(true)
    setError(null)
    try {
      await api.patch('/api/users', { name: form.name, timezone: form.timezone, country: form.country })
      setNotice('Account details saved.')
      setForm(null)
      await users.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The account could not be updated.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">Account &amp; team</h1>
        <p className="mt-0.5 text-xs text-ink-500">
          Workspace membership, roles and personal details. Roles are enforced server-side: administrator-only endpoints reject everyone else with HTTP 403.
        </p>
      </header>

      {users.error ? <ErrorNote message={users.error} onRetry={() => void users.refresh()} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      {data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Your account" subtitle={`Workspace ${data.workspace.name} · ${data.workspace.planKey}`} icon={<Users className="h-4 w-4" />} />
            <div className="space-y-3">
              <KeyValue
                items={[
                  { label: 'Email', value: data.user.email },
                  { label: 'Role', value: data.user.role },
                  { label: 'Status', value: data.user.status },
                  { label: 'Email verified', value: data.user.emailVerifiedAt ? formatDate(data.user.emailVerifiedAt) : 'not verified' },
                  { label: 'Last sign-in', value: data.user.lastLoginAt ? relativeTime(data.user.lastLoginAt) : '—' },
                  { label: 'Member since', value: formatDate(data.user.createdAt) },
                ]}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-ink-600">
                  Display name
                  <input
                    className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                    defaultValue={data.user.name}
                    onChange={(event) => setForm({ name: event.target.value, timezone: form?.timezone ?? data.user.timezone, country: form?.country ?? data.profile.country })}
                  />
                </label>
                <label className="text-xs text-ink-600">
                  Timezone
                  <input
                    className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                    defaultValue={data.user.timezone}
                    onChange={(event) => setForm({ name: form?.name ?? data.user.name, timezone: event.target.value, country: form?.country ?? data.profile.country })}
                  />
                </label>
                <label className="text-xs text-ink-600 sm:col-span-2">
                  Country
                  <input
                    className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                    defaultValue={data.profile.country}
                    onChange={(event) => setForm({ name: form?.name ?? data.user.name, timezone: form?.timezone ?? data.user.timezone, country: event.target.value })}
                  />
                </label>
              </div>
              <Button size="sm" loading={busy} disabled={!form} onClick={() => void save()}>Save details</Button>
              <p className="text-[11px] text-ink-400">
                Password changes use the reset link flow (<a className="text-accent-700 hover:underline" href="/forgot-password">forgot password</a>) so the
                new secret is never sent through a client component.
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Workspace profile" subtitle="What the agents know about your business" />
            {data.profile ? (
              <div className="space-y-3 text-[11px] text-ink-600">
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['Risk tolerance', data.profile.riskTolerance],
                    ['Automation level', data.profile.automationLevel],
                    ['Currency', data.profile.currency],
                    ['Legal name', data.profile.legalName ?? 'not set'],
                  ] as const).map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-ink-50 px-3 py-2">
                      <p className="text-ink-500">{label}</p>
                      <p className="mt-0.5 font-medium text-ink-900">{String(value)}</p>
                    </div>
                  ))}
                </div>
                {([
                  ['Interests', data.profile.interests],
                  ['Skills', data.profile.skills],
                  ['Industries', data.profile.industries],
                  ['Business models', data.profile.businessModels],
                  ['Monetisation', data.profile.monetizationPreferences],
                ] as const).map(([label, values]) => (
                  <div key={label}>
                    <p className="text-ink-500">{label}</p>
                    <p className="mt-0.5 text-ink-800">{values.length ? values.join(', ') : 'not set'}</p>
                  </div>
                ))}
                <p className="text-ink-400">
                  Edit these in <a className="text-accent-700 hover:underline" href="/onboarding">the onboarding wizard</a> so answers stay consistent
                  with how scoring was trained.
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-ink-500">No profile row yet.</p>
            )}
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader title="Members & roles" subtitle="Role changes are PATCHed to /api/users by an administrator" />
            <Table headers={['Email', 'Role', 'Status', 'Verified', 'Last sign-in']}>
              <tr className="border-t border-ink-200">
                <td className="px-4 py-2.5 text-xs text-ink-800">{data.user.email}</td>
                <td className="px-4 py-2.5"><Badge tone={data.user.role === 'admin' ? 'info' : 'neutral'}>{data.user.role}</Badge></td>
                <td className="px-4 py-2.5 text-[11px] text-ink-600">{data.user.status}</td>
                <td className="px-4 py-2.5 text-[11px] text-ink-600">{data.user.emailVerifiedAt ? 'yes' : 'no'}</td>
                <td className="px-4 py-2.5 text-[11px] text-ink-500">{data.user.lastLoginAt ? relativeTime(data.user.lastLoginAt) : '—'}</td>
              </tr>
            </Table>
            <p className="mt-2 text-[11px] text-ink-500">
              The API exposes the signed-in member and their workspace. Additional members are added by registering with the same workspace invitation
              flow; the Free plan caps membership (limits are stored per plan and enforced server-side).
            </p>
          </Card>
        </div>
      ) : users.loading ? (
        <Card><div className="h-40 animate-pulse rounded bg-ink-100" /></Card>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- timeline */

export function ActivityTimeline() {
  const [hours, setHours] = useState(72)
  const timeline = useApi<{
    id: string
    kind: string
    title: string
    detail: string
    status: string
    agentKey: string | null
    projectId: string | null
    link: string | null
    costCents: number | null
    at: string
    demo: boolean
  }[]>('/api/timeline', { query: { hours, limit: 120 }, pollMs: 30_000 })
  const meta = timeline.meta as { counts?: { agentRuns24h: number; pendingApprovals: number; activeProjects: number } } | undefined

  const rows = timeline.data ?? []

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Activity timeline</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            Every recorded action — agent runs, approvals, project events, revenue, expenses, workflow runs and audit entries — merged into one
            chronological stream.
          </p>
        </div>
        <Select className="w-40" value={String(hours)} onChange={(event) => setHours(Number(event.target.value))}>
          <option value="24">Last 24 hours</option>
          <option value="72">Last 3 days</option>
          <option value="168">Last 7 days</option>
          <option value="720">Last 30 days</option>
        </Select>
      </header>

      {timeline.error ? <ErrorNote message={timeline.error} onRetry={() => void timeline.refresh()} /> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Agent runs (24h)" value={formatNumber(meta?.counts?.agentRuns24h ?? 0)} />
        <Stat label="Pending approvals" value={formatNumber(meta?.counts?.pendingApprovals ?? 0)} tone={meta?.counts?.pendingApprovals ? 'warning' : 'neutral'} />
        <Stat label="Active projects" value={formatNumber(meta?.counts?.activeProjects ?? 0)} />
      </div>

      <Card>
        <CardHeader title="Stream" subtitle={`${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} in the selected window`} />
        {rows.length === 0 ? (
          <EmptyState
            icon={<Activity className="h-5 w-5" />}
            title="Nothing recorded yet"
            description="Once the worker runs a cycle, agent runs, approvals and project events appear here in order."
          />
        ) : (
          <ol className="relative space-y-3 border-l border-ink-200 pl-4">
            {rows.map((entry) => (
              <li key={entry.id} className="relative">
                <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-accent-400" />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-ink-900">{entry.title}</span>
                  <Badge tone={entry.status === 'failed' || entry.status === 'error' ? 'critical' : entry.status === 'awaiting_approval' || entry.status === 'pending' ? 'warning' : 'neutral'}>
                    {entry.kind.replace('_', ' ')}
                  </Badge>
                  {entry.demo ? <Badge tone="demo">DEMO DATA</Badge> : null}
                </div>
                <p className="mt-0.5 text-[11px] text-ink-600">{entry.detail}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-ink-400">
                  <span>{formatDate(entry.at)} · {relativeTime(entry.at)}</span>
                  {entry.agentKey ? <span className="font-mono">{entry.agentKey}</span> : null}
                  {entry.costCents ? <span>{formatMoney(entry.costCents)} recorded cost</span> : null}
                  {entry.link ? <a className="text-accent-700 hover:underline" href={entry.link}>open</a> : null}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}
