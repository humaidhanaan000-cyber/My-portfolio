/**
 * GET /api/analytics — every chart and KPI the dashboard needs, in one call.
 *
 * Revenue figures are split by verification status so estimated, manual and
 * verified-integration money is never silently added together. Every value
 * carries its label.
 */
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { getDb, agents as agentsTable, analyticsEvents, opportunities, projects, revenueTransactions } from '@/lib/db'
import { ok, withApi } from '@/lib/api/http'
import {
  agentPerformance,
  apiUsageSummary,
  businessOverview,
  conversionMetrics,
  costPerOpportunity,
  financialOverview,
  opportunityEngineStats,
  projectSuccessRate,
} from '@/lib/analytics'
import { budgetSnapshot } from '@/lib/budget'
import type { DemoFilter } from '@/lib/analytics'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const days = Math.min(365, Math.max(7, Number(ctx.searchParams.get('days') ?? 30)))
  const since = new Date(Date.now() - days * 86_400_000)
  // `demo=true` switches every figure to the demo ledger; the default is real
  // data only, with demo totals exposed separately under `demoSummary`.
  const demoView = ctx.searchParams.get('demo') === 'true' || ctx.searchParams.get('demo') === 'only'
  const filter: DemoFilter = demoView ? 'only' : 'exclude'

  const [
    financial, business, opportunityEngine, agents, usage, conversions, successRate, costPerOpp, budget, revenueSeries, projectSeries, demoSeries,
  ] = await Promise.all([
    financialOverview(workspaceId, undefined, days, { demo: filter }),
    businessOverview(workspaceId, { demo: filter }),
    opportunityEngineStats(workspaceId, 70, { demo: filter }),
    agentPerformance(workspaceId, days),
    apiUsageSummary(workspaceId, days),
    conversionMetrics(workspaceId, days, { demo: filter }),
    projectSuccessRate(workspaceId, { demo: filter }),
    costPerOpportunity(workspaceId, days, { demo: filter }),
    budgetSnapshot(workspaceId),
    db.execute(sql`
      with span as (select generate_series(current_date - ${days - 1}::int, current_date, interval '1 day')::date as day)
      select span.day::text as day,
             coalesce(sum(rt.gross_cents) filter (where rt.demo = false), 0)::text as gross_cents,
             coalesce(sum(rt.net_cents) filter (where rt.demo = false), 0)::text as net_cents,
             coalesce((select sum(e.amount_cents) from expenses e where e.workspace_id = ${workspaceId} and e.demo = false and e.occurred_at::date = span.day), 0)::text as expense_cents,
             coalesce(sum(rt.gross_cents) filter (where rt.demo = true), 0)::text as demo_gross_cents
      from span
      left join revenue_transactions rt on rt.occurred_at::date = span.day and rt.workspace_id = ${workspaceId}
      group by span.day order by span.day
    `),
    db
      .select({ status: projects.status, value: sql<string>`count(*)::text` })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt), eq(projects.demo, demoView)))
      .groupBy(projects.status),
    db
      .select({ demo: revenueTransactions.demo, value: sql<string>`coalesce(sum(${revenueTransactions.grossCents}), 0)::text` })
      .from(revenueTransactions)
      .where(and(eq(revenueTransactions.workspaceId, workspaceId), gte(revenueTransactions.occurredAt, since)))
      .groupBy(revenueTransactions.demo),
  ])

  const [eventsByType, topOpportunities, agentRoster, demoFinance, demoCounts] = await Promise.all([
    db
      .select({ type: analyticsEvents.type, value: sql<string>`count(*)::text` })
      .from(analyticsEvents)
      .where(and(eq(analyticsEvents.workspaceId, workspaceId), gte(analyticsEvents.occurredAt, since), eq(analyticsEvents.demo, demoView)))
      .groupBy(analyticsEvents.type),
    db
      .select({ id: opportunities.id, title: opportunities.title, category: opportunities.category, sourceName: opportunities.sourceName, status: opportunities.status })
      .from(opportunities)
      .where(and(eq(opportunities.workspaceId, workspaceId), isNull(opportunities.deletedAt), eq(opportunities.demo, demoView)))
      .orderBy(desc(sql`(select final_score from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`))
      .limit(5),
    db.select({ total: sql<string>`count(*)::text`, enabled: sql<string>`count(*) filter (where enabled)::text` }).from(agentsTable),
    demoView ? Promise.resolve(null) : financialOverview(workspaceId, undefined, days, { demo: 'only' }),
    demoView
      ? Promise.resolve(null)
      : db.execute(sql`
          select
            (select count(*) from projects where workspace_id = ${workspaceId} and demo = true)::text as projects,
            (select count(*) from opportunities where workspace_id = ${workspaceId} and demo = true)::text as opportunities
        `),
  ])

  const series = asRows(revenueSeries)
  const demoCountRow = asRows(demoCounts as unknown)[0]

  return ok({
    window: { days, since: since.toISOString() },
    financial,
    business,
    opportunityEngine,
    agents,
    apiUsage: usage,
    conversions,
    projectSuccessRate: successRate,
    costPerOpportunityCents: costPerOpp,
    budget,
    charts: {
      dailyRevenue: series.map((row) => ({
        day: row.day,
        grossCents: Number(row.gross_cents),
        netCents: Number(row.net_cents),
        expenseCents: Number(row.expense_cents),
        profitCents: Number(row.net_cents) - Number(row.expense_cents),
        demoGrossCents: Number(row.demo_gross_cents),
        label: 'actuals',
      })),
      projectStatus: projectSeries.map((row) => ({ status: row.status, count: Number(row.value) })),
      eventsByType: eventsByType.map((row) => ({ type: row.type, count: Number(row.value) })),
      revenueByDemo: demoSeries.map((row) => ({ demo: row.demo, totalCents: Number(row.value) })),
    },
    demoSummary: demoFinance
      ? {
          label: 'DEMO DATA' as const,
          revenueCents: demoFinance.allTime.revenue,
          expensesCents: demoFinance.allTime.expenses,
          profitCents: demoFinance.allTime.profit,
          projects: Number(demoCountRow?.projects ?? 0),
          opportunities: Number(demoCountRow?.opportunities ?? 0),
          note: 'Sample data from demo mode — never added to the figures above.',
        }
      : null,
    topOpportunities,
    roster: { agents: Number(agentRoster[0]?.total ?? 0), enabled: Number(agentRoster[0]?.enabled ?? 0) },
    notes: [
      'Revenue is split into verified integration revenue, manual entries and demo data — they are never combined.',
      'Profit figures exclude demo data. Projected or estimated figures are labelled as estimates.',
    ],
  })
})

function asRows(result: unknown): Record<string, string>[] {
  if (Array.isArray(result)) return result as Record<string, string>[]
  const maybe = result as { rows?: unknown[] }
  return (maybe.rows ?? []) as Record<string, string>[]
}
