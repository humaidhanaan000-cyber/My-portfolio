'use client'
/**
 * Command centre. One request to /api/dashboard returns the whole picture; the
 * component re-polls on an interval so the operator sees the system change
 * rather than a snapshot from page load.
 */
import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, Bot, ClipboardCheck, ListChecks, Lightbulb, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, CardHeader, DemoBadge, EmptyState, ErrorNote, ProgressBar, Table } from '@/components/ui'
import { useApi } from '@/lib/client/hooks'
import { api } from '@/lib/client/api'
import { formatMoney, formatNumber, formatPercent, relativeTime } from '@/lib/client/format'
import {
  ActivityFeed, AlertList, AgentFleet, ApprovalCard, BudgetPanel, EngineCounters, MoneyStrip, ProjectCard, StatCard, SystemStatusCard,
  type ActivityRun, type AlertRow, type Approval, type ProjectSummary, type StatusFleetAgent, type StatusPayload,
} from './widgets'

type DashboardPayload = {
  system: StatusPayload
  agents: { roster: StatusFleetAgent[]; active: number; total: number; recentRuns: ActivityRun[] }
  money: {
    financial: {
      currency: string
      today: { revenue: number; expenses: number; profit: number }
      week: { revenue: number; expenses: number; profit: number }
      month: { revenue: number; expenses: number; profit: number }
      allTime: { revenue: number; expenses: number; profit: number }
      margin: number
      roi: number
      revenueSeries: { date: string; revenueCents: number; expensesCents: number; profitCents: number }[]
      revenueBySource: { source: string; cents: number; count: number }[]
    }
    business: {
      totalProjects: number
      activeProjects: number
      launchedProjects: number
      visitors: number
      conversions: number
      conversionRate: number
      tasksOpen: number
      tasksDone: number
    }
    recentRevenue: { grossCents: number; netCents: number; description: string; occurredAt: string; verification: string; provider: string; demo: boolean }[]
  }
  opportunityEngine: {
    latest: { id: string; title: string; category: string; sourceName: string; status: string; discoveredAt: string; demo: boolean; score: string | null; verdict: string | null }[]
    discoveredToday: number
    discovered7d: number
    analyzed: number
    highScore: number
    awaitingStrategy: number
    averageScore: number
    awaitingScore: number
    demoCount: number
    realCount: number
    scoreDistribution: { label: string; count: number }[]
    topCategories: { category: string; count: number; averageScore: number }[]
  }
  approvals: { pending: Approval[]; counts: Record<string, number> }
  alerts: AlertRow[]
  notifications: { id: string; type: string; severity: string; title: string; body: string; link: string | null; createdAt: string; readAt: string | null }[]
  projects: ProjectSummary[]
  tasks: { open: number; done24h: number; failed: number }
  queue: { byStatus: Record<string, number>; workers: { workerId: string; role: string; status: string; lastHeartbeatAt: string; secondsSinceHeartbeat: number }[] }
  budget: {
    currency: string
    daily: { limitCents: number; spentCents: number; percentUsed: number; resetsAt: string }
    monthly: { limitCents: number; spentCents: number; percentUsed: number; resetsAt: string }
    projectMaxCents: number
    agentDailyLimitCents: number
    alerting: { level: string; message?: string }[]
  }
  memory: { totalEntries: number; withinBudget: boolean; oldestAt: string | null }
  generatedAt: string
  notices: string[]
}

export function CommandCenter() {
  const dashboard = useApi<DashboardPayload>('/api/dashboard', { pollMs: 20_000 })
  const [running, setRunning] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const data = dashboard.data

  async function runCycle(kind: 'discovery' | 'full' | 'maintenance') {
    setRunning(kind)
    setActionError(null)
    try {
      const path = kind === 'discovery' ? '/api/agents/research/run' : kind === 'full' ? '/api/agents/monitoring/run' : '/api/agents/execution/run'
      const body =
        kind === 'discovery'
          ? { useAi: true }
          : kind === 'full'
            ? { useAi: true, input: { action: 'monitor_all' } }
            : { useAi: true, input: { action: 'maintenance_sweep' } }
      await api.post(path, body)
      await dashboard.refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The run could not be started.')
    } finally {
      setRunning(null)
    }
  }

  if (dashboard.error && !data) {
    return <ErrorNote message={`The dashboard could not load: ${dashboard.error}`} onRetry={() => void dashboard.refresh()} />
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Command center</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            {data ? `Updated ${relativeTime(data.generatedAt)} · every figure below is read from the database` : 'Loading the current system state…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void dashboard.refresh()} loading={dashboard.loading}>
            {!dashboard.loading ? <RefreshCw className="h-3.5 w-3.5" /> : null}
            Refresh
          </Button>
          <Button size="sm" variant="primary" loading={running === 'discovery'} onClick={() => void runCycle('discovery')}>
            <Lightbulb className="h-3.5 w-3.5" />
            Run discovery
          </Button>
          <Button size="sm" variant="secondary" loading={running === 'full'} onClick={() => void runCycle('full')}>
            <Bot className="h-3.5 w-3.5" />
            Monitor all
          </Button>
        </div>
      </header>

      {actionError ? <ErrorNote message={actionError} /> : null}

      {!data ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <div key={key} className="surface h-40 animate-pulse bg-white/60" />
          ))}
        </div>
      ) : (
        <>
          {data.notices.length ? (
            <div className="rounded-lg border border-ink-200 bg-white px-4 py-2.5 text-[11px] text-ink-600">
              {data.notices.map((notice) => (
                <p key={notice}>• {notice}</p>
              ))}
            </div>
          ) : null}

          {/* --------------------------------------------------------- top row */}
          <div className="grid gap-4 lg:grid-cols-3">
            <SystemStatusCard status={data.system} />
            <EngineCounters engine={data.opportunityEngine} />
            <BudgetPanel budget={data.budget} />
          </div>

          {/* ------------------------------------------------------- money row */}
          <MoneyStrip financial={data.money.financial} />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Projects" value={`${data.money.business.activeProjects} active`} hint={`${data.money.business.totalProjects} total · ${data.money.business.launchedProjects} launched`} />
            <StatCard label="Visitors (30d)" value={formatNumber(data.money.business.visitors)} hint={`${formatNumber(data.money.business.conversions)} conversions · ${formatPercent(data.money.business.conversionRate)}`} />
            <StatCard label="Open tasks" value={formatNumber(data.tasks.open)} hint={`${formatNumber(data.tasks.done24h)} done in 24h · ${formatNumber(data.tasks.failed)} failed`} />
            <StatCard
              label="Pending approvals"
              value={formatNumber(data.approvals.counts.pending ?? 0)}
              hint={data.approvals.pending.length ? 'Nothing public, paid or risky proceeds without these' : 'Nothing waiting on you'}
              tone={data.approvals.pending.length ? 'warning' : 'neutral'}
              icon={<ClipboardCheck className="h-4 w-4" />}
            />
          </div>

          {/* --------------------------------------------------- main two-col */}
          <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <Card>
              <CardHeader
                title="Approval center"
                subtitle="Risky, public, outbound and paid actions stop here"
                icon={<ClipboardCheck className="h-4 w-4" />}
                action={
                  <Link href="/dashboard/approvals" className="text-xs font-medium text-accent-700 hover:underline">
                    Open queue
                  </Link>
                }
              />
              {data.approvals.pending.length === 0 ? (
                <EmptyState
                  title="No approvals waiting"
                  description="When an agent wants to spend money, publish something, launch a project or create an account, the request appears here with its reason, expected cost and risk."
                />
              ) : (
                <div className="space-y-3">
                  {data.approvals.pending.slice(0, 4).map((approval) => (
                    <ApprovalCard key={approval.id} approval={approval} onDecided={() => void dashboard.refresh()} />
                  ))}
                  {data.approvals.pending.length > 4 ? (
                    <Link href="/dashboard/approvals" className="inline-flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline">
                      {data.approvals.pending.length - 4} more waiting
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  ) : null}
                </div>
              )}
            </Card>

            <div className="space-y-4">
              <ActivityFeed runs={data.agents.recentRuns} />
              <Card>
                <CardHeader title="Queue & workers" subtitle="Durable job state, not an in-memory counter" icon={<ListChecks className="h-4 w-4" />} />
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(data.queue.byStatus).length === 0 ? <span className="text-xs text-ink-500">No jobs recorded yet.</span> : null}
                  {Object.entries(data.queue.byStatus).map(([status, count]) => (
                    <Badge key={status} tone={status === 'failed' || status === 'dead' ? 'critical' : status === 'running' ? 'info' : 'neutral'}>
                      {status}: {count}
                    </Badge>
                  ))}
                </div>
                <div className="mt-3 space-y-2">
                  {data.queue.workers.length === 0 ? (
                    <p className="text-[11px] text-amber-800">
                      No worker heartbeat detected. Start the worker process (<code className="font-mono">npm run worker</code>) so scheduled jobs run
                      after your browser closes.
                    </p>
                  ) : (
                    data.queue.workers.map((worker) => (
                      <div key={worker.workerId} className="flex items-center justify-between text-[11px]">
                        <span className="truncate text-ink-600">
                          {worker.role} · {worker.workerId.slice(0, 8)}
                        </span>
                        <Badge tone={worker.secondsSinceHeartbeat < 120 ? 'positive' : 'warning'}>
                          {worker.secondsSinceHeartbeat}s ago
                        </Badge>
                      </div>
                    ))
                  )}
                </div>
              </Card>
            </div>
          </div>

          {/* -------------------------------------------------------- projects */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-ink-900">Projects</h2>
              <Link href="/dashboard/projects" className="text-xs font-medium text-accent-700 hover:underline">
                All projects
              </Link>
            </div>
            {data.projects.length === 0 ? (
              <EmptyState
                title="No projects yet"
                description="Approve an opportunity to create a strategy, then approve the strategy to create a project. AIBA never creates a project on your behalf without that step."
                action={
                  <Link href="/dashboard/opportunities" className="rounded-lg bg-accent-600 px-4 py-2 text-xs font-medium text-white hover:bg-accent-700">
                    Review opportunities
                  </Link>
                }
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {data.projects.slice(0, 6).map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            )}
          </div>

          {/* --------------------------------------------------- alerts + fleet */}
          <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <Card>
              <CardHeader title="Alerts" subtitle="Raised by the monitoring agent and the health checks" icon={<AlertTriangle className="h-4 w-4" />} />
              <AlertList alerts={data.alerts} onResolved={() => void dashboard.refresh()} />
            </Card>
            <div className="space-y-4">
              <AgentFleet agents={data.agents.roster} />
              <Card>
                <CardHeader title="Latest recorded revenue" subtitle="Wallet-verified rows and manual entries are labelled separately" />
                {data.money.recentRevenue.length === 0 ? (
                  <p className="text-xs text-ink-500">No revenue recorded yet. AIBA never estimates revenue into this list.</p>
                ) : (
                  <ul className="space-y-2 text-[11px]">
                    {data.money.recentRevenue.map((entry, index) => (
                      <li key={index} className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-ink-800">{entry.description}</p>
                          <p className="text-ink-500">
                            {entry.provider} · {entry.verification} · {relativeTime(entry.occurredAt)}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="tabular font-medium text-signal-positive">{formatMoney(entry.netCents)}</p>
                          <p className="tabular text-ink-400">gross {formatMoney(entry.grossCents)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card>
                <CardHeader title="Agent memory" subtitle="Bounded, summarised and prunable" />
                <div className="space-y-2 text-[11px]">
                  <ProgressBar
                    value={Math.min(100, data.memory.totalEntries)}
                    tone={data.memory.withinBudget ? 'positive' : 'warning'}
                    label={`${formatNumber(data.memory.totalEntries)} stored entries`}
                  />
                  <p className="text-ink-500">
                    {data.memory.withinBudget ? 'Within the configured budget.' : 'Above the configured budget — the pruning job will summarise and remove the oldest low-importance entries.'}
                    {data.memory.oldestAt ? ` Oldest: ${relativeTime(data.memory.oldestAt)}.` : ''}
                  </p>
                  <Link href="/dashboard/memory" className="inline-flex items-center gap-1 font-medium text-accent-700 hover:underline">
                    Inspect memory
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              </Card>
            </div>
          </div>

          {/* ------------------------------------------------------- top opps */}
          <Card>
            <CardHeader
              title="Highest scoring opportunities"
              subtitle="Ranked by the latest score; demo rows are flagged and excluded from real totals"
              action={
                <Link href="/dashboard/opportunities" className="text-xs font-medium text-accent-700 hover:underline">
                  Open database
                </Link>
              }
            />
            {data.opportunityEngine.latest.length === 0 ? (
              <p className="text-xs text-ink-500">Nothing discovered yet. Run a discovery cycle to populate the database.</p>
            ) : (
              <Table headers={['Opportunity', 'Score', 'Category', 'Source', 'Status', 'Discovered', '']}>
                {data.opportunityEngine.latest.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <Link href={`/dashboard/opportunities/${row.id}`} className="text-xs font-medium text-ink-900 hover:text-accent-700">
                          {row.title}
                        </Link>
                        {row.demo ? <DemoBadge /> : null}
                      </span>
                    </td>
                    <td className="tabular px-3 py-2 text-xs font-semibold text-ink-900">{row.score ? Number(row.score).toFixed(1) : '—'}</td>
                    <td className="px-3 py-2 text-xs text-ink-600 capitalize">{row.category.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 text-xs text-ink-600">{row.sourceName}</td>
                    <td className="px-3 py-2">
                      <Badge tone={row.status === 'approved' ? 'positive' : row.status === 'rejected' || row.status === 'archived' ? 'neutral' : 'info'}>
                        {row.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-ink-500">{relativeTime(row.discoveredAt)}</td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/dashboard/opportunities/${row.id}`} className="text-[11px] font-medium text-accent-700 hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

export { DemoBadge }
