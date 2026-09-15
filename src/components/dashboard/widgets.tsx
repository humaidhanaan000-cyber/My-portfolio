'use client'

/**
 * Dashboard widgets. Each one renders data that came from a real API call and
 * offers real actions — a button that cannot do anything is never shown.
 */
import { useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, Bot, CheckCircle2, CircleDollarSign, Clock, Gauge, Play, RefreshCw, ShieldAlert, TrendingUp, Users, XCircle, Zap,
} from 'lucide-react'
import { Badge, Button, Card, CardHeader, DemoBadge, EmptyState, EstimateBadge, ErrorNote, Input, Modal, ProgressBar, Sparkline, Table, Textarea } from '@/components/ui'
import { ApiClientError, api } from '@/lib/client/api'
import { cn, formatMoney, formatNumber, formatPercent, relativeTime, STATUS_TONE } from '@/lib/client/format'

export type Approval = {
  id: string
  title: string
  actionType: string
  reason: string
  expectedCostCents: number
  potentialBenefit: string
  risk: string
  status: string
  createdAt: string
  requestedByAgent: string
  projectName: string | null
  payload?: Record<string, unknown>
  expiresAt?: string | null
}

/* --------------------------------------------------------------- status card */

export function SystemStatusCard({ status }: { status: StatusPayload | null }) {
  if (!status) return <Card><CardHeader title="System status" subtitle="Waiting for the first status response" /></Card>
  return (
    <Card>
      <CardHeader
        title="System status"
        subtitle={`Uptime ${Math.floor(status.uptimeSeconds / 3600)}h ${Math.floor((status.uptimeSeconds % 3600) / 60)}m · v${status.version}`}
        icon={<Zap className="h-4 w-4" />}
        action={
          <Badge tone={status.status === 'ONLINE' ? 'positive' : status.status === 'DEGRADED' ? 'warning' : 'critical'}>
            {status.status}
          </Badge>
        }
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric label="Agents active" value={`${status.agentsActive}/${status.agentsTotal}`} icon={<Bot className="h-3.5 w-3.5" />} />
        <Metric label="Queue" value={`${status.queue.running} running`} hint={`${status.queue.queued} queued · ${status.queue.failed} failed`} />
        <Metric label="Workers" value={String(status.workers)} hint={status.workers === 0 ? 'start the worker process' : 'heartbeats within 2 min'} tone={status.workers === 0 ? 'warning' : 'neutral'} />
      </div>
      <div className="mt-4 space-y-2 border-t border-ink-100 pt-3 text-xs">
        <div className="flex items-center justify-between gap-4">
          <span className="text-ink-500">Current task</span>
          <span className="truncate text-right font-medium text-ink-800">{status.currentTask ?? 'Idle — waiting for the next schedule'}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-ink-500">Next scheduled</span>
          <span className="text-right font-medium text-ink-800">
            {status.nextScheduledTask ? `${status.nextScheduledTask.name} · ${relativeTime(status.nextScheduledTask.runAt)}` : 'No schedule registered'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-ink-500">AI provider</span>
          <span className="text-right font-medium text-ink-800">
            {status.ai.configured ? status.ai.provider : `${status.ai.provider} (heuristics only)`}
          </span>
        </div>
      </div>
    </Card>
  )
}

export type StatusPayload = {
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE'
  agentsActive: number
  agentsTotal: number
  uptimeSeconds: number
  currentTask: string | null
  nextScheduledTask: { name: string; runAt: string } | null
  queue: { queued: number; running: number; failed: number; dead: number }
  ai: { configured: boolean; provider: string }
  workers: number
  version: string
  database: { ok: boolean; latencyMs: number; driver: string }
}

function Metric({ label, value, hint, icon, tone = 'neutral' }: { label: string; value: string; hint?: string; icon?: React.ReactNode; tone?: 'neutral' | 'warning' }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-ink-50/60 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-ink-500">
        {icon}
        {label}
      </div>
      <p className={cn('tabular mt-1 text-sm font-semibold', tone === 'warning' ? 'text-signal-warning' : 'text-ink-900')}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-ink-400">{hint}</p> : null}
    </div>
  )
}

/* ---------------------------------------------------------------- agent fleet */

export function AgentFleet({ agents }: { agents: StatusFleetAgent[] }) {
  const healthy = agents.filter((agent) => agent.health === 'ok').length
  return (
    <Card>
      <CardHeader
        title="Agent fleet"
        subtitle={`${healthy} of ${agents.length} agents healthy`}
        icon={<Bot className="h-4 w-4" />}
        action={
          <Link href="/dashboard/agents" className="text-xs font-medium text-accent-700 hover:underline">
            Configure
          </Link>
        }
      />
      <ul className="divide-y divide-ink-100">
        {agents.map((agent) => (
          <li key={agent.key} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate text-xs font-medium text-ink-800">
                {agent.name}
                {agent.health === 'error' ? <Badge tone="critical">error</Badge> : null}
                {!agent.enabled ? <Badge tone="neutral">disabled</Badge> : null}
              </p>
              <p className="truncate text-[11px] text-ink-500">
                {agent.lastRunAt ? `last run ${relativeTime(agent.lastRunAt)}` : 'never run'} · {agent.runs24h} runs / 24h · {formatMoney(agent.spendCents)} spend
              </p>
            </div>
            <Badge tone={agent.health === 'ok' ? 'positive' : agent.health === 'error' ? 'critical' : 'neutral'}>{agent.health}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export type StatusFleetAgent = {
  key: string
  name: string
  enabled: boolean
  health: string
  lastRunAt: string | null
  runs24h: number
  spendCents: number
  lastError: string | null
}

/* -------------------------------------------------------------- activity feed */

export function ActivityFeed({ runs }: { runs: ActivityRun[] }) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader title="Live agent activity" subtitle="Most recent runs, newest first" icon={<Clock className="h-4 w-4" />} />
      {runs.length === 0 ? (
        <EmptyState title="No agent runs yet" description="Trigger a scan from the Sources page, or wait for the scheduler to start the first cycle." />
      ) : (
        <ul className="max-h-96 space-y-3 overflow-y-auto pr-1">
          {runs.map((run) => (
            <li key={run.id} className="border-l-2 border-ink-100 pl-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink-800 capitalize">{run.agentKey}</span>
                <Badge tone={run.status === 'succeeded' ? 'positive' : run.status === 'failed' ? 'critical' : run.status === 'awaiting_approval' ? 'warning' : 'neutral'}>
                  {run.status.replace(/_/g, ' ')}
                </Badge>
              </div>
              <p className="mt-0.5 line-clamp-3 text-[11px] leading-relaxed text-ink-600">{run.summary ?? run.error ?? 'No summary recorded.'}</p>
              <p className="mt-1 text-[10px] text-ink-400">
                {relativeTime(run.startedAt)} · {run.triggeredBy} · {(run.durationMs / 1000).toFixed(1)}s
                {run.costCents > 0 ? ` · ${formatMoney(run.costCents)} cost` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export type ActivityRun = {
  id: string
  agentKey: string
  status: string
  triggeredBy: string
  startedAt: string
  durationMs: number
  costCents: number
  error: string | null
  summary: string | null
}

/* ------------------------------------------------------------------ approvals */

export function ApprovalCard({ approval, onDecided, compact }: { approval: Approval; onDecided: () => void; compact?: boolean }) {
  const [modal, setModal] = useState<'reject' | 'edit' | null>(null)
  const [note, setNote] = useState('')
  const [edits, setEdits] = useState(JSON.stringify((approval.payload ?? {}) as Record<string, unknown>, null, 2))
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)

  async function decide(decision: 'approve' | 'reject' | 'defer' | 'edit', body: Record<string, unknown> = {}) {
    setPending(decision)
    setError(null)
    try {
      const result = await api.post<{ execution?: { ran: boolean; status?: string; error?: string }; requiresSeparateAuthorization?: boolean }>(
        `/api/approvals/${approval.id}`,
        { decision, note: note || undefined, ...body },
      )
      const execution = result.data.execution
      setOutcome(
        result.data.requiresSeparateAuthorization
          ? 'Approved. AIBA does not perform this action — it is recorded as operator-executed.'
          : execution?.ran
            ? `Approved and executed (${execution.status ?? 'done'}).`
            : 'Decision recorded.',
      )
      setModal(null)
      setNote('')
      onDecided()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The decision could not be recorded.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900">{approval.title}</p>
          <p className="mt-1 text-[11px] text-ink-500">
            <span className="font-medium text-ink-700">{approval.actionType.replace(/_/g, ' ')}</span> · requested by {approval.requestedByAgent} · {relativeTime(approval.createdAt)}
            {approval.projectName ? ` · ${approval.projectName}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {approval.risk === 'high' ? <Badge tone="critical">high risk</Badge> : approval.risk === 'medium' ? <Badge tone="warning">medium risk</Badge> : <Badge tone="positive">low risk</Badge>}
          <Badge tone="neutral">{approval.status}</Badge>
        </div>
      </div>

      {!compact ? (
        <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-3">
          <div className="rounded-lg bg-ink-50 px-3 py-2">
            <p className="text-ink-500">Expected cost</p>
            <p className="tabular mt-0.5 font-medium text-ink-900">
              {formatMoney(approval.expectedCostCents)} {approval.expectedCostCents > 0 ? <EstimateBadge label="estimate" className="ml-1" /> : null}
            </p>
          </div>
          <div className="rounded-lg bg-ink-50 px-3 py-2 sm:col-span-2">
            <p className="text-ink-500">Expected benefit</p>
            <p className="mt-0.5 font-medium text-ink-900">{approval.potentialBenefit || 'Not stated by the requesting agent.'}</p>
          </div>
        </div>
      ) : null}

      <p className="mt-3 text-xs leading-relaxed text-ink-600">{approval.reason}</p>

      {!compact && approval.payload && Object.keys(approval.payload).length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-medium text-ink-500 hover:text-ink-800">Request payload</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-ink-950 p-3 text-[11px] leading-relaxed text-ink-100">{JSON.stringify(approval.payload, null, 2)}</pre>
        </details>
      ) : null}

      {error ? <div className="mt-3"><ErrorNote message={error} /></div> : null}
      {outcome ? <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800">{outcome}</p> : null}

      {approval.status === 'pending' || approval.status === 'deferred' ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="success" loading={pending === 'approve'} onClick={() => decide('approve')}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            Approve &amp; execute
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setModal('edit')}>
            Edit &amp; approve
          </Button>
          <Button size="sm" variant="danger" loading={pending === 'reject'} onClick={() => setModal('reject')}>
            <XCircle className="h-3.5 w-3.5" />
            Reject
          </Button>
          <Button size="sm" variant="ghost" loading={pending === 'defer'} onClick={() => decide('defer')}>
            Defer 24h
          </Button>
        </div>
      ) : null}

      <Modal
        open={modal === 'reject'}
        onClose={() => setModal(null)}
        title="Reject this request"
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
            <Button variant="danger" loading={pending === 'reject'} onClick={() => decide('reject')}>
              Reject request
            </Button>
          </>
        }
      >
        <p className="text-xs text-ink-600">
          The requesting agent is told why. Rejections are written to the audit log and fed into the learning agent so the same class of
          request is not repeated blindly.
        </p>
        <div className="mt-3">
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reason for rejecting (optional)" />
        </div>
      </Modal>

      <Modal
        open={modal === 'edit'}
        onClose={() => setModal(null)}
        wide
        title="Edit and approve"
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
            <Button
              variant="success"
              loading={pending === 'edit'}
              onClick={() => {
                let parsed: Record<string, unknown> = {}
                try {
                  parsed = JSON.parse(edits) as Record<string, unknown>
                } catch {
                  setError('The payload must be valid JSON.')
                  return
                }
                void decide('edit', { edits: { payload: parsed } })
              }}
            >
              Approve with edits
            </Button>
          </>
        }
      >
        <p className="text-xs text-ink-600">
          Adjust the payload the agent will execute. Your edits are stored on the approval and in the audit log, and the execution agent
          uses exactly this payload.
        </p>
        <div className="mt-3">
          <Textarea value={edits} onChange={(event) => setEdits(event.target.value)} className="min-h-64 font-mono text-[11px]" spellCheck={false} />
        </div>
        <div className="mt-3">
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note for the audit trail (optional)" />
        </div>
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------- money */

export function MoneyStrip({
  financial,
}: {
  financial: {
    today: { revenue: number; expenses: number; profit: number }
    week: { revenue: number; expenses: number; profit: number }
    month: { revenue: number; expenses: number; profit: number }
    allTime: { revenue: number; expenses: number; profit: number }
    margin: number
    roi: number
    revenueSeries: { date: string; revenueCents: number; expensesCents: number; profitCents: number }[]
  }
}) {
  const series = financial.revenueSeries.map((point) => point.profitCents)
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Today" value={formatMoney(financial.today.revenue)} hint={`profit ${formatMoney(financial.today.profit)}`} />
        <StatCard label="This week" value={formatMoney(financial.week.revenue)} hint={`profit ${formatMoney(financial.week.profit)}`} />
        <StatCard label="This month" value={formatMoney(financial.month.revenue)} hint={`profit ${formatMoney(financial.month.profit)}`} />
        <StatCard label="All time net" value={formatMoney(financial.allTime.revenue - financial.allTime.expenses)} hint={`margin ${formatPercent(financial.margin)} · ROI ${formatPercent(financial.roi)}`} />
      </div>
      <Card>
        <CardHeader title="Profit trend" subtitle="Net revenue minus recorded costs, last 30 days" icon={<TrendingUp className="h-4 w-4" />} />
        <Sparkline points={series} tone={series[series.length - 1] >= 0 ? 'positive' : 'critical'} className="h-16" />
        <p className="mt-2 text-[11px] text-ink-500">
          Figures come from recorded transactions and expenses only. Nothing here is projected.
        </p>
      </Card>
    </div>
  )
}

export function StatCard({ label, value, hint, tone = 'neutral', icon }: { label: string; value: string; hint?: string; tone?: 'neutral' | 'positive' | 'warning' | 'critical'; icon?: React.ReactNode }) {
  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium tracking-wide text-ink-500 uppercase">{label}</span>
        {icon ? <span className="text-ink-400">{icon}</span> : null}
      </div>
      <p className={cn('tabular mt-2 text-xl font-semibold', tone === 'positive' ? 'text-signal-positive' : tone === 'critical' ? 'text-signal-critical' : tone === 'warning' ? 'text-signal-warning' : 'text-ink-900')}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-[11px] text-ink-500">{hint}</p> : null}
    </div>
  )
}

/* -------------------------------------------------------------- opportunities */

export function OpportunityRow({ opportunity, onChanged }: { opportunity: OpportunitySummary; onChanged?: () => void }) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(endpoint: string, body: Record<string, unknown>, label: string) {
    setPending(label)
    setError(null)
    try {
      await api.post(endpoint, body)
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Action failed.')
    } finally {
      setPending(null)
    }
  }

  const score = opportunity.score === null ? null : Number(opportunity.score)

  return (
    <tr className="align-top">
      <td className="px-3 py-3">
        <Link href={`/dashboard/opportunities/${opportunity.id}`} className="text-xs font-medium text-ink-900 hover:text-accent-700">
          {opportunity.title}
        </Link>
        <p className="mt-0.5 text-[11px] text-ink-500">
          {opportunity.category.replace(/_/g, ' ')} · {opportunity.sourceName} · {relativeTime(opportunity.discoveredAt)}
          {opportunity.demo ? ' · ' : ''}
          {opportunity.demo ? <DemoBadge /> : null}
        </p>
        {error ? <p className="mt-1 text-[11px] text-signal-critical">{error}</p> : null}
      </td>
      <td className="px-3 py-3">
        <span className="tabular text-sm font-semibold text-ink-900">{score === null ? '—' : score.toFixed(1)}</span>
        {opportunity.verdict ? <p className="text-[11px] text-ink-500">{opportunity.verdict.replace(/_/g, ' ')}</p> : null}
      </td>
      <td className="px-3 py-3">
        <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_TONE[opportunity.status] ?? 'border-ink-200 bg-ink-50 text-ink-600')}>
          {opportunity.status.replace(/_/g, ' ')}
        </span>
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" loading={pending === 'analyze'} onClick={() => act(`/api/opportunities/${opportunity.id}/score`, {}, 'analyze')}>
            Analyze
          </Button>
          <Button size="sm" variant="secondary" loading={pending === 'strategy'} onClick={() => act(`/api/opportunities/${opportunity.id}/strategy`, { createProject: true, requestApproval: true }, 'strategy')}>
            Strategy
          </Button>
          <Button size="sm" variant="success" loading={pending === 'approve'} onClick={() => act(`/api/opportunities/${opportunity.id}/decision`, { decision: 'approve', createStrategy: false }, 'approve')}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" loading={pending === 'reject'} onClick={() => act(`/api/opportunities/${opportunity.id}/decision`, { decision: 'reject' }, 'reject')}>
            Reject
          </Button>
          <Button size="sm" variant="ghost" loading={pending === 'archive'} onClick={() => act(`/api/opportunities/${opportunity.id}/decision`, { decision: 'archive' }, 'archive')}>
            Archive
          </Button>
        </div>
      </td>
    </tr>
  )
}

export type OpportunitySummary = {
  id: string
  title: string
  category: string
  sourceName: string
  status: string
  discoveredAt: string
  score: string | null
  verdict: string | null
  demo: boolean
}

/* ------------------------------------------------------------------ projects */

export function ProjectCard({ project }: { project: ProjectSummary }) {
  const budgetUsed = project.budgetCents > 0 ? (project.expenseCents / project.budgetCents) * 100 : 0
  return (
    <div className="surface flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm font-semibold text-ink-900 hover:text-accent-700">
          {project.name}
        </Link>
        <div className="flex items-center gap-1.5">
          {project.demo ? <DemoBadge /> : null}
          <Badge tone={project.status === 'LAUNCHED' || project.status === 'MONITORING' ? 'positive' : project.status === 'FAILED' ? 'critical' : project.status === 'PAUSED' ? 'warning' : 'info'}>
            {project.status.replace(/_/g, ' ').toLowerCase()}
          </Badge>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-ink-600">{project.objective}</p>

      <div className="mt-3 space-y-2">
        <ProgressBar value={project.progress} label="Progress" />
        {project.budgetCents > 0 ? (
          <ProgressBar
            value={budgetUsed}
            tone={budgetUsed > 90 ? 'critical' : budgetUsed > 70 ? 'warning' : 'positive'}
            label={`Budget ${formatMoney(project.expenseCents)} of ${formatMoney(project.budgetCents)}`}
          />
        ) : (
          <p className="text-[11px] text-ink-500">No project budget allocated.</p>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-ink-100 pt-3 text-[11px]">
        <div>
          <dt className="text-ink-500">Revenue</dt>
          <dd className="tabular font-medium text-ink-900">{formatMoney(project.revenueCents)}</dd>
        </div>
        <div>
          <dt className="text-ink-500">Costs</dt>
          <dd className="tabular font-medium text-ink-900">{formatMoney(project.expenseCents)}</dd>
        </div>
        <div>
          <dt className="text-ink-500">Net</dt>
          <dd className={cn('tabular font-medium', project.profitCents >= 0 ? 'text-signal-positive' : 'text-signal-critical')}>{formatMoney(project.profitCents)}</dd>
        </div>
      </dl>

      {project.nextTask ? (
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-600">
          <Play className="h-3 w-3" />
          Next: {project.nextTask}
        </p>
      ) : null}
    </div>
  )
}

export type ProjectSummary = {
  id: string
  name: string
  status: string
  progress: number
  objective: string
  budgetCents: number
  expenseCents: number
  revenueCents: number
  profitCents: number
  nextTask: string | null
  demo: boolean
}

/* --------------------------------------------------------------------- alerts */

export function AlertList({ alerts, onResolved }: { alerts: AlertRow[]; onResolved: () => void }) {
  const [pending, setPending] = useState<string | null>(null)
  if (alerts.length === 0) {
    return <EmptyState title="No active alerts" description="The monitoring agent raises an alert when a metric moves outside its expected range, or when a subsystem is unhealthy." icon={<CheckCircle2 className="h-6 w-6" />} />
  }
  return (
    <ul className="space-y-2">
      {alerts.map((alert) => (
        <li key={alert.id} className="flex items-start justify-between gap-3 rounded-lg border border-ink-200 bg-white p-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-medium text-ink-900">
              {alert.severity === 'critical' ? <ShieldAlert className="h-3.5 w-3.5 text-signal-critical" /> : <AlertTriangle className="h-3.5 w-3.5 text-signal-warning" />}
              {alert.title}
            </p>
            <p className="mt-1 text-[11px] text-ink-600">{alert.message}</p>
            <p className="mt-1 text-[10px] text-ink-400">
              {alert.source} · seen {alert.occurrenceCount}× · last {relativeTime(alert.lastSeenAt)}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={pending === alert.id}
            onClick={async () => {
              setPending(alert.id)
              try {
                await api.post(`/api/notifications/alerts/${alert.id}`, { resolve: true })
                onResolved()
              } finally {
                setPending(null)
              }
            }}
          >
            Resolve
          </Button>
        </li>
      ))}
    </ul>
  )
}

export type AlertRow = {
  id: string
  title: string
  message: string
  severity: string
  source: string
  status: string
  occurrenceCount: number
  lastSeenAt: string
}

/* ------------------------------------------------------------------- budget */

export function BudgetPanel({
  budget,
}: {
  budget: {
    currency: string
    daily: { limitCents: number; spentCents: number; percentUsed: number; resetsAt: string }
    monthly: { limitCents: number; spentCents: number; percentUsed: number; resetsAt: string }
    projectMaxCents: number
    agentDailyLimitCents: number
    alerting: { level: string; message?: string }[]
  }
}) {
  return (
    <Card>
      <CardHeader
        title="Budget guardrails"
        subtitle="Checked before every paid action. Limits are enforced in the database, not in the prompt."
        icon={<Gauge className="h-4 w-4" />}
      />
      <div className="space-y-4">
        <ProgressBar
          value={budget.daily.percentUsed}
          tone={budget.daily.percentUsed >= 100 ? 'critical' : budget.daily.percentUsed > 80 ? 'warning' : 'positive'}
          label={`Today: ${formatMoney(budget.daily.spentCents)} of ${budget.daily.limitCents > 0 ? formatMoney(budget.daily.limitCents) : 'no limit set'}`}
        />
        <ProgressBar
          value={budget.monthly.percentUsed}
          tone={budget.monthly.percentUsed >= 100 ? 'critical' : budget.monthly.percentUsed > 80 ? 'warning' : 'positive'}
          label={`This month: ${formatMoney(budget.monthly.spentCents)} of ${budget.monthly.limitCents > 0 ? formatMoney(budget.monthly.limitCents) : 'no limit set'}`}
        />
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-lg bg-ink-50 px-3 py-2">
            <p className="text-ink-500">Max per project</p>
            <p className="tabular mt-0.5 font-medium text-ink-900">{formatMoney(budget.projectMaxCents)}</p>
          </div>
          <div className="rounded-lg bg-ink-50 px-3 py-2">
            <p className="text-ink-500">Per agent / day</p>
            <p className="tabular mt-0.5 font-medium text-ink-900">{formatMoney(budget.agentDailyLimitCents)}</p>
          </div>
        </div>
        {budget.alerting.length ? (
          <ul className="space-y-1 text-[11px] text-amber-800">
            {budget.alerting.map((entry, index) => (
              <li key={index} className="flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3" />
                {entry.message ?? entry.level}
              </li>
            ))}
          </ul>
        ) : null}
        <Link href="/dashboard/budget" className="inline-flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline">
          Adjust limits
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------- opportunity counters */

export function EngineCounters({
  engine,
}: {
  engine: { discoveredToday: number; discovered7d: number; analyzed: number; highScore: number; awaitingStrategy: number; averageScore: number }
}) {
  return (
    <Card>
      <CardHeader title="Opportunity engine" subtitle="Counters computed from the opportunities table" icon={<Users className="h-4 w-4" />} />
      <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
        <Counter label="Discovered today" value={formatNumber(engine.discoveredToday)} />
        <Counter label="Last 7 days" value={formatNumber(engine.discovered7d)} />
        <Counter label="Analysed" value={formatNumber(engine.analyzed)} />
        <Counter label="High score" value={formatNumber(engine.highScore)} />
        <Counter label="Awaiting strategy" value={formatNumber(engine.awaitingStrategy)} />
        <Counter label="Average score" value={engine.averageScore.toFixed(1)} />
      </div>
    </Card>
  )
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-ink-50/60 px-3 py-2">
      <p className="text-ink-500">{label}</p>
      <p className="tabular mt-0.5 text-sm font-semibold text-ink-900">{value}</p>
    </div>
  )
}

/* ---------------------------------------------------------------------- misc */

export function RefreshButton({ onClick, loading }: { onClick: () => void; loading?: boolean }) {
  return (
    <Button size="sm" variant="secondary" onClick={onClick} loading={loading}>
      {!loading ? <RefreshCw className="h-3.5 w-3.5" /> : null}
      Refresh
    </Button>
  )
}

export function MoneyIcon() {
  return <CircleDollarSign className="h-4 w-4" />
}

export { Table }
