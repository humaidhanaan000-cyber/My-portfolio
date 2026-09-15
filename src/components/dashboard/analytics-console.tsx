'use client'
/**
 * Analytics console.
 *
 * Every chart is drawn from recorded rows; there is no sampling, smoothing or
 * invented data. Figures that are projections are labelled as estimates, and
 * demo data is shown in its own series so it can never be read as real revenue.
 */
import { useState } from 'react'
import { BadgeDollarSign, BarChart3, Percent, Target, TrendingUp, Users } from 'lucide-react'
import { Badge, Card, CardHeader, EmptyState, ErrorNote, KeyValue, ProgressBar, Select, Stat } from '@/components/ui'
import { useApi } from '@/lib/client/hooks'
import { formatMoney, formatNumber, formatPercent, relativeTime } from '@/lib/client/format'
import { MoneyStrip } from './widgets'

type AnalyticsPayload = {
  window: { days: number; since: string }
  financial: {
    currency: string
    today: { revenue: number; expenses: number; profit: number }
    week: { revenue: number; expenses: number; profit: number }
    month: { revenue: number; expenses: number; profit: number }
    allTime: { revenue: number; expenses: number; profit: number }
    margin: number
    roi: number
    revenueSeries: { date: string; revenueCents: number; expensesCents: number; profitCents: number }[]
    expenseBreakdown: { category: string; cents: number }[]
    revenueBySource: { source: string; cents: number; count: number }[]
    revenueByProject: { projectId: string | null; name: string; cents: number }[]
  }
  business: {
    revenueCents: number
    expensesCents: number
    profitCents: number
    margin: number
    activeProjects: number
    totalProjects: number
    visitors: number
    conversions: number
    conversionRate: number
    visitorsPrev: number
    conversionRatePrev: number
    revenueDeltaPct: number
  }
  opportunityEngine: {
    discoveredToday: number
    discovered7d: number
    analyzed: number
    highScore: number
    approved: number
    rejected: number
    archived: number
    awaitingStrategy: number
    averageScore: number
    scoreDistribution: { label: string; count: number }[]
    topCategories: { category: string; count: number; avgScore: number }[]
  }
  conversions: { visitors: number; conversions: number; signups: number; conversionRate: number; costPerOpportunity: number }
  projectSuccessRate: { total: number; launched: number; failed: number; successRate: number; revenueProducing: number; byStatus: { status: string; count: number }[] }
  costPerOpportunityCents: number
  budget: {
    currency: string
    daily: { limitCents: number; spentCents: number; percentUsed: number; resetsAt: string }
    monthly: { limitCents: number; spentCents: number; percentUsed: number; resetsAt: string }
    projectMaxCents: number
    agentDailyLimitCents: number
    alerting: { level: string; message?: string }[]
  }
  charts: {
    dailyRevenue: { day: string; grossCents: number; netCents: number; expenseCents: number; profitCents: number; demoGrossCents: number; label: string }[]
    projectStatus: { status: string; count: number }[]
    eventsByType: { type: string; count: number }[]
    revenueByDemo: { demo: boolean; totalCents: number }[]
  }
  scope: 'real' | 'demo'
  scopeLabel: string
  demoSummary: {
    label: string
    revenueCents: number
    expensesCents: number
    profitCents: number
    comparableRealRevenueCents: number
    projects: number
    opportunities: number
    note: string
  } | null
  topOpportunities: { id: string; title: string; category: string; status: string; score: number | null }[]
  roster: { agents: number; enabled: number }
}

export function AnalyticsConsole() {
  const [days, setDays] = useState(30)
  const [scope, setScope] = useState<'real' | 'demo'>('real')
  const analytics = useApi<AnalyticsPayload>('/api/analytics', { query: { days, demo: scope === 'demo' ? 'only' : 'false' } })
  const data = analytics.data

  if (analytics.error) return <ErrorNote message={analytics.error} onRetry={() => void analytics.refresh()} />
  if (!data) return <Card><div className="h-64 animate-pulse rounded bg-ink-100" /></Card>

  const demo = data.demoSummary
  const maxGross = Math.max(1, ...data.charts.dailyRevenue.map((point) => Math.max(point.grossCents, point.demoGrossCents, point.expenseCents)))
  const budgetUsed = data.budget.monthly.percentUsed
  const realRevenueByDemo = data.charts.revenueByDemo.find((row) => row.demo === false)?.totalCents ?? 0
  const demoRevenueBySeries = data.charts.revenueByDemo.find((row) => row.demo === true)?.totalCents ?? 0

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-ink-900">Analytics</h1>
            <Badge tone={data.scope === 'demo' ? 'demo' : 'neutral'}>{data.scopeLabel}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-ink-500">
            Window: last {data.window.days} days from {relativeTime(data.window.since)}. Charts are drawn from recorded transactions, expenses and
            analytics events — nothing is interpolated.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select className="w-40" value={scope} onChange={(event) => setScope(event.target.value as 'real' | 'demo')}>
            <option value="real">Real data</option>
            <option value="demo">Demo data only</option>
          </Select>
          <Select className="w-32" value={String(days)} onChange={(event) => setDays(Number(event.target.value))}>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">12 months</option>
          </Select>
        </div>
      </header>

      {scope === 'demo' ? (
        <div className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-2 text-[11px] text-violet-900">
          <Badge tone="demo" className="mr-2">DEMO DATA</Badge>
          {demo?.note ?? 'Every figure on this screen is demo data — it is never added to real revenue.'}
        </div>
      ) : null}

      <MoneyStrip financial={data.financial} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Visitors (window)" value={formatNumber(data.business.visitors)} hint={`previous period ${formatNumber(data.business.visitorsPrev)}`} icon={<Users className="h-4 w-4" />} />
        <Stat label="Conversions" value={formatNumber(data.business.conversions)} hint={`rate ${formatPercent(data.business.conversionRate)}`} icon={<Percent className="h-4 w-4" />} />
        <Stat
          label="Revenue change"
          value={formatPercent(data.business.revenueDeltaPct)}
          hint="versus the previous period (actuals only)"
          tone={data.business.revenueDeltaPct >= 0 ? 'positive' : 'critical'}
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <Stat
          label="Cost per opportunity"
          value={formatMoney(data.costPerOpportunityCents)}
          hint="recorded cost ÷ opportunities analysed"
          icon={<Target className="h-4 w-4" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Daily revenue, demo revenue and cost"
            subtitle="Green = real recorded revenue · violet = demo rows (never added to real totals) · red = recorded cost"
            icon={<BarChart3 className="h-4 w-4" />}
          />
          {data.charts.dailyRevenue.length === 0 ? (
            <EmptyState title="No daily series yet" description="Rows appear once revenue or expenses are recorded." />
          ) : (
            <div className="space-y-1.5">
              {data.charts.dailyRevenue.slice(-21).map((point) => (
                <div key={point.day} className="flex items-center gap-2 text-[11px]">
                  <span className="w-16 shrink-0 text-ink-500">{point.day.slice(5)}</span>
                  <div className="flex-1 space-y-0.5">
                    <div className="h-2 rounded-full bg-emerald-300" style={{ width: `${Math.max(1, (point.grossCents / maxGross) * 100)}%` }} />
                    {point.demoGrossCents > 0 ? (
                      <div className="h-1.5 rounded-full bg-violet-300" style={{ width: `${Math.max(1, (point.demoGrossCents / maxGross) * 100)}%` }} />
                    ) : null}
                    <div className="h-1.5 rounded-full bg-rose-300" style={{ width: `${Math.max(1, (point.expenseCents / maxGross) * 100)}%` }} />
                  </div>
                  <span className="tabular w-32 shrink-0 text-right text-ink-600">
                    {formatMoney(point.grossCents)} / {formatMoney(point.expenseCents)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Opportunity engine" subtitle="Counters from the opportunities table" />
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {([
                ['Discovered today', data.opportunityEngine.discoveredToday],
                ['Last 7 days', data.opportunityEngine.discovered7d],
                ['Analysed', data.opportunityEngine.analyzed],
                ['High score', data.opportunityEngine.highScore],
                ['Awaiting strategy', data.opportunityEngine.awaitingStrategy],
                ['Average score', data.opportunityEngine.averageScore.toFixed(1)],
              ] as const).map(([label, value]) => (
                <div key={label} className="rounded-lg border border-ink-100 bg-ink-50/60 px-3 py-2">
                  <p className="text-ink-500">{label}</p>
                  <p className="tabular mt-0.5 text-sm font-semibold text-ink-900">{typeof value === 'number' ? formatNumber(value) : value}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] text-ink-400">Scores are research estimates. They rank work; they do not forecast income.</p>
          </Card>

          <Card>
            <CardHeader title="Score distribution" subtitle="How the engine is ranking candidates" />
            {data.opportunityEngine.scoreDistribution.length === 0 ? (
              <p className="text-[11px] text-ink-500">No scored opportunities in this window.</p>
            ) : (
              <div className="space-y-2">
                {data.opportunityEngine.scoreDistribution.map((bucket) => (
                  <div key={bucket.label}>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-ink-600">{bucket.label}</span>
                      <span className="tabular text-ink-800">{bucket.count}</span>
                    </div>
                    <ProgressBar
                      value={(bucket.count / Math.max(1, data.opportunityEngine.discovered7d + data.opportunityEngine.analyzed)) * 100}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Revenue by source" subtitle="Verified integrations and manual entries" />
          {data.financial.revenueBySource.length === 0 ? (
            <p className="text-[11px] text-ink-500">No revenue recorded in this window.</p>
          ) : (
            <ul className="space-y-2">
              {data.financial.revenueBySource.map((row) => (
                <li key={row.source} className="flex items-center justify-between text-xs">
                  <span className="text-ink-600">{row.source} <span className="text-ink-400">({row.count})</span></span>
                  <span className="tabular font-medium text-ink-900">{formatMoney(row.cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Cost breakdown" subtitle="Recorded expenses by category" />
          {data.financial.expenseBreakdown.length === 0 ? (
            <p className="text-[11px] text-ink-500">No costs recorded in this window.</p>
          ) : (
            <ul className="space-y-3">
              {data.financial.expenseBreakdown.map((row) => (
                <li key={row.category}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-ink-600">{row.category.replace(/_/g, ' ')}</span>
                    <span className="tabular font-medium text-ink-900">{formatMoney(row.cents)}</span>
                  </div>
                  <ProgressBar
                    value={(
                      row.cents /
                      Math.max(1, data.financial.expenseBreakdown.reduce((sum, entry) => sum + Math.max(0, entry.cents), 0))
                    ) * 100}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Project outcomes" subtitle="Launched versus failed, from real state history" />
          <KeyValue
            items={[
              { label: 'Projects in window', value: formatNumber(data.projectSuccessRate.total) },
              { label: 'Launched', value: formatNumber(data.projectSuccessRate.launched) },
              { label: 'Failed', value: formatNumber(data.projectSuccessRate.failed) },
              {
                label: 'Success rate',
                value: `${formatPercent(data.projectSuccessRate.successRate)} (launched ÷ total)`,
              },
              { label: 'Earning revenue', value: formatNumber(data.projectSuccessRate.revenueProducing) },
            ]}
          />
          {data.projectSuccessRate.byStatus.length > 0 ? (
            <ul className="mt-3 space-y-1 text-[11px] text-ink-500">
              {data.projectSuccessRate.byStatus.map((row) => (
                <li key={row.status} className="flex items-center justify-between">
                  <span>{row.status.replace(/_/g, ' ')}</span>
                  <span className="tabular text-ink-800">{row.count}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Budget position"
            subtitle="The same guardrails the agents are checked against before every paid action"
            icon={<BadgeDollarSign className="h-4 w-4" />}
          />
          <div className="space-y-4">
            <ProgressBar
              value={data.budget.daily.percentUsed}
              tone={data.budget.daily.percentUsed >= 100 ? 'critical' : data.budget.daily.percentUsed > 80 ? 'warning' : 'positive'}
              label={`Today ${formatMoney(data.budget.daily.spentCents)} of ${data.budget.daily.limitCents > 0 ? formatMoney(data.budget.daily.limitCents) : 'no limit set'}`}
            />
            <ProgressBar
              value={budgetUsed}
              tone={budgetUsed >= 100 ? 'critical' : budgetUsed > 80 ? 'warning' : 'positive'}
              label={`This month ${formatMoney(data.budget.monthly.spentCents)} of ${data.budget.monthly.limitCents > 0 ? formatMoney(data.budget.monthly.limitCents) : 'no limit set'}`}
            />
            <KeyValue
              items={[
                { label: 'Max per project', value: formatMoney(data.budget.projectMaxCents) },
                { label: 'Per agent / day', value: formatMoney(data.budget.agentDailyLimitCents) },
                { label: 'Agents enabled', value: `${data.roster.enabled} of ${data.roster.agents}` },
              ]}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Demo versus real" subtitle="Structurally separated, shown side by side for transparency" />
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3">
              <p className="font-medium text-emerald-900">Real revenue</p>
              <p className="tabular mt-1 text-lg font-semibold text-emerald-900">{formatMoney(realRevenueByDemo)}</p>
              <p className="mt-1 text-emerald-800">Counted in every real total: revenue, margin, ROI and budget.</p>
            </div>
            <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-3">
              <p className="font-medium text-violet-900">{demo?.label ?? 'DEMO DATA'}</p>
              <p className="tabular mt-1 text-lg font-semibold text-violet-900">
                {formatMoney(demo ? Math.max(demoRevenueBySeries, demo.revenueCents) : demoRevenueBySeries)}
              </p>
              {demo ? (
                <>
                  <p className="mt-1 text-violet-800">{demo.projects} demo project(s) · {demo.opportunities} demo opportunit(ies). Excluded from real totals.</p>
                  <p className="mt-1 text-xs text-violet-700">Real recorded revenue for the same period: {formatMoney(Math.max(realRevenueByDemo, demo.comparableRealRevenueCents))} — kept separate, never combined.</p>
                </>
              ) : (
                <p className="mt-1 text-violet-800">
                  Demo scope is active: every figure on this page is demo data. Real entries are reported separately under{' '}
                  <code className="font-mono">scope=real</code> and are never added to these totals.
                </p>
              )}
            </div>
          </div>
          <p className="mt-3 text-[10px] text-ink-400">
            Demo rows carry a demo flag in the database. No code path adds them to a real figure without an explicit scope of
            <code className="mx-1 font-mono">demo=only</code>.
          </p>
        </Card>
      </div>

      {data.topOpportunities.length > 0 ? (
        <Card>
          <CardHeader title="Top opportunities in this window" subtitle="Ranked by their latest score" />
          <ul className="space-y-2">
            {data.topOpportunities.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-ink-700">
                  {row.title} <span className="text-ink-400">· {row.category}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone="neutral">{row.status}</Badge>
                  <span className="tabular w-10 text-right font-medium text-ink-900">{row.score === null ? '—' : row.score.toFixed(0)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}
