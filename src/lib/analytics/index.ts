/**
 * Analytics aggregation.
 *
 * Every query is bounded (time-windowed, aggregated in SQL, paginated) — the
 * dashboard never loads thousands of rows into the application to sum them.
 */
import { and, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { SQL, SQLWrapper } from 'drizzle-orm'
import {
  getDb,
  analyticsEvents,
  agentRuns,
  apiUsage,
  approvals,
  expenses,
  opportunities,
  opportunityScores,
  projects,
  revenueTransactions,
  tasks,
  extractRows,
} from '../db'
import { dayKey, percentChange, startOfDay, startOfMonth, startOfWeek } from '../utils'

/**
 * How demo rows are treated in an aggregate.
 *
 * `exclude` is the default everywhere money is reported: demo data must never be
 * added to real revenue, expenses or profit. `only` powers the demo views, and
 * `include` exists for internal diagnostics that intentionally mix both.
 */
export type DemoFilter = 'exclude' | 'only' | 'include'

/** Boolean `demo` column on any table, so one helper serves revenue and expenses. */
function demoCondition(demoColumn: SQLWrapper, filter: DemoFilter): SQL<unknown> | undefined {
  if (filter === 'only') return eq(demoColumn, true)
  if (filter === 'include') return undefined
  return eq(demoColumn, false)
}

/** Workspace scope plus the demo filter as one expression. */
function demoFilterWhere(workspaceClause: SQL<unknown>, demoClause: SQL<unknown> | undefined): SQL<unknown> {
  return demoClause ? (and(workspaceClause, demoClause) as SQL<unknown>) : workspaceClause
}

export type RevenueWindow = {
  grossCents: number
  feeCents: number
  netCents: number
  transactionCount: number
  verifiedCents: number
  manualCents: number
}

export type ExpenseWindow = {
  totalCents: number
  byCategory: { category: string; cents: number }[]
}

export type FinancialOverview = {
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

async function revenueIn(workspaceId: string, from: Date, to?: Date, demo: DemoFilter = 'exclude'): Promise<RevenueWindow> {
  const db = await getDb()
  const conditions = [eq(revenueTransactions.workspaceId, workspaceId), gte(revenueTransactions.occurredAt, from)]
  if (to) conditions.push(lt(revenueTransactions.occurredAt, to))
  const demoClause = demoCondition(revenueTransactions.demo, demo)
  if (demoClause) conditions.push(demoClause)
  const result = await db
    .select({
      gross: sql<string>`coalesce(sum(${revenueTransactions.grossCents}), 0)::text`,
      fees: sql<string>`coalesce(sum(${revenueTransactions.feeCents}), 0)::text`,
      net: sql<string>`coalesce(sum(${revenueTransactions.netCents}), 0)::text`,
      count: sql<string>`count(*)::text`,
      verified: sql<string>`coalesce(sum(${revenueTransactions.grossCents}) filter (where ${revenueTransactions.verification} = 'verified_integration'), 0)::text`,
      manual: sql<string>`coalesce(sum(${revenueTransactions.grossCents}) filter (where ${revenueTransactions.verification} = 'manual'), 0)::text`,
    })
    .from(revenueTransactions)
    .where(and(...conditions))
  const row = result[0]
  return {
    grossCents: Number(row?.gross ?? 0),
    feeCents: Number(row?.fees ?? 0),
    netCents: Number(row?.net ?? 0),
    transactionCount: Number(row?.count ?? 0),
    verifiedCents: Number(row?.verified ?? 0),
    manualCents: Number(row?.manual ?? 0),
  }
}

async function expensesIn(workspaceId: string, from: Date, to?: Date, demo: DemoFilter = 'exclude'): Promise<ExpenseWindow> {
  const db = await getDb()
  const conditions = [eq(expenses.workspaceId, workspaceId), gte(expenses.occurredAt, from)]
  if (to) conditions.push(lt(expenses.occurredAt, to))
  const demoClause = demoCondition(expenses.demo, demo)
  if (demoClause) conditions.push(demoClause)
  const [total, byCategory] = await Promise.all([
    db
      .select({ total: sql<string>`coalesce(sum(${expenses.amountCents}), 0)::text` })
      .from(expenses)
      .where(and(...conditions)),
    db
      .select({ category: expenses.category, cents: sql<string>`coalesce(sum(${expenses.amountCents}), 0)::text` })
      .from(expenses)
      .where(and(...conditions))
      .groupBy(expenses.category),
  ])
  return {
    totalCents: Number(total[0]?.total ?? 0),
    byCategory: byCategory.map((row) => ({ category: row.category, cents: Number(row.cents) })).sort((a, b) => b.cents - a.cents),
  }
}

export async function financialOverview(
  workspaceId: string,
  currency = 'USD',
  days = 30,
  options: { demo?: DemoFilter } = {},
): Promise<FinancialOverview> {
  const demo = options.demo ?? 'exclude'
  const db = await getDb()
  const today = startOfDay()
  const week = startOfWeek()
  const month = startOfMonth()
  const epoch = new Date(0)

  const [todayRevenue, todayExpenses, weekRevenue, weekExpenses, monthRevenue, monthExpenses, allRevenue, allExpenses] = await Promise.all([
    revenueIn(workspaceId, today, undefined, demo),
    expensesIn(workspaceId, today, undefined, demo),
    revenueIn(workspaceId, week, undefined, demo),
    expensesIn(workspaceId, week, undefined, demo),
    revenueIn(workspaceId, month, undefined, demo),
    expensesIn(workspaceId, month, undefined, demo),
    revenueIn(workspaceId, epoch, undefined, demo),
    expensesIn(workspaceId, epoch, undefined, demo),
  ])

  const since = new Date(Date.now() - days * 86_400_000)
  const demoRevenueClause = demo === 'only' ? sql` and r.demo = true` : demo === 'exclude' ? sql` and r.demo = false` : sql``
  const demoExpenseClause = demo === 'only' ? sql` and e.demo = true` : demo === 'exclude' ? sql` and e.demo = false` : sql``
  const seriesResult = await db.execute(sql`
    select
      d::date as day,
      coalesce((select sum(gross_cents) from revenue_transactions r where r.workspace_id = ${workspaceId} and r.occurred_at::date = d::date and r.status = 'confirmed'${demoRevenueClause}), 0)::text as revenue,
      coalesce((select sum(amount_cents) from expenses e where e.workspace_id = ${workspaceId} and e.occurred_at::date = d::date${demoExpenseClause}), 0)::text as expenses
    from generate_series((${since.toISOString()}::date)::date, current_date, interval '1 day') d
    order by day
  `)
  const seriesRows = extractRows<{ day: string; revenue: string; expenses: string }>(seriesResult)

  const revenueBySourceRows = await db
    .select({
      source: revenueTransactions.source,
      cents: sql<string>`coalesce(sum(${revenueTransactions.grossCents}), 0)::text`,
      count: sql<string>`count(*)::text`,
    })
    .from(revenueTransactions)
    .where(demoFilterWhere(eq(revenueTransactions.workspaceId, workspaceId), demoCondition(revenueTransactions.demo, demo)))
    .groupBy(revenueTransactions.source)
    .orderBy(desc(sql`sum(${revenueTransactions.grossCents})`))
    .limit(12)

  const revenueByProjectRows = await db
    .select({
      projectId: revenueTransactions.projectId,
      name: projects.name,
      cents: sql<string>`coalesce(sum(${revenueTransactions.grossCents}), 0)::text`,
    })
    .from(revenueTransactions)
    .leftJoin(projects, eq(revenueTransactions.projectId, projects.id))
    .where(demoFilterWhere(eq(revenueTransactions.workspaceId, workspaceId), demoCondition(revenueTransactions.demo, demo)))
    .groupBy(revenueTransactions.projectId, projects.name)
    .orderBy(desc(sql`sum(${revenueTransactions.grossCents})`))
    .limit(12)

  const netRevenue = allRevenue.grossCents - allRevenue.feeCents - allExpenses.totalCents
  return {
    currency,
    today: { revenue: todayRevenue.grossCents, expenses: todayExpenses.totalCents, profit: todayRevenue.grossCents - todayExpenses.totalCents },
    week: { revenue: weekRevenue.grossCents, expenses: weekExpenses.totalCents, profit: weekRevenue.grossCents - weekExpenses.totalCents },
    month: { revenue: monthRevenue.grossCents, expenses: monthExpenses.totalCents, profit: monthRevenue.grossCents - monthExpenses.totalCents },
    allTime: { revenue: allRevenue.grossCents, expenses: allExpenses.totalCents, profit: allRevenue.grossCents - allExpenses.totalCents },
    margin: allRevenue.grossCents > 0 ? Math.round((netRevenue / allRevenue.grossCents) * 10000) / 100 : 0,
    roi: allExpenses.totalCents > 0 ? Math.round((netRevenue / allExpenses.totalCents) * 10000) / 100 : 0,
    revenueSeries: seriesRows.map((row) => {
      const revenue = Number(row.revenue)
      const expenseTotal = Number(row.expenses)
      return {
        date: typeof row.day === 'string' ? row.day.slice(0, 10) : dayKey(new Date(row.day)),
        revenueCents: revenue,
        expensesCents: expenseTotal,
        profitCents: revenue - expenseTotal,
      }
    }),
    expenseBreakdown: allExpenses.byCategory,
    revenueBySource: revenueBySourceRows.map((row) => ({ source: row.source, cents: Number(row.cents), count: Number(row.count) })),
    revenueByProject: revenueByProjectRows.map((row) => ({ projectId: row.projectId, name: row.name ?? 'Unassigned', cents: Number(row.cents) })),
  }
}

/* --------------------------------------------------------------- dashboard */

export type BusinessOverview = {
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

export async function businessOverview(workspaceId: string, options: { demo?: DemoFilter } = {}): Promise<BusinessOverview> {
  const demo = options.demo ?? 'exclude'
  const demoEventClause = demo === 'only' ? sql` and demo = true` : demo === 'exclude' ? sql` and demo = false` : sql``
  const db = await getDb()
  const monthStart = startOfMonth()
  const prevMonthStart = new Date(monthStart)
  prevMonthStart.setUTCMonth(prevMonthStart.getUTCMonth() - 1)

  const [revenue, expenseTotal, prevRevenue, projectCounts, visitorRows] = await Promise.all([
    db
      .select({ total: sql<string>`coalesce(sum(${revenueTransactions.grossCents}), 0)::text` })
      .from(revenueTransactions)
      .where(
        and(
          demoFilterWhere(eq(revenueTransactions.workspaceId, workspaceId), demoCondition(revenueTransactions.demo, demo)),
          gte(revenueTransactions.occurredAt, monthStart),
          eq(revenueTransactions.status, 'confirmed'),
        ),
      ),
    db
      .select({ total: sql<string>`coalesce(sum(${expenses.amountCents}), 0)::text` })
      .from(expenses)
      .where(
        and(
          demoFilterWhere(eq(expenses.workspaceId, workspaceId), demoCondition(expenses.demo, demo)),
          gte(expenses.occurredAt, monthStart),
        ),
      ),
    db
      .select({ total: sql<string>`coalesce(sum(${revenueTransactions.grossCents}), 0)::text` })
      .from(revenueTransactions)
      .where(
        and(
          demoFilterWhere(eq(revenueTransactions.workspaceId, workspaceId), demoCondition(revenueTransactions.demo, demo)),
          gte(revenueTransactions.occurredAt, prevMonthStart),
          lt(revenueTransactions.occurredAt, monthStart),
          eq(revenueTransactions.status, 'confirmed'),
        ),
      ),
    db
      .select({ status: projects.status, value: count() })
      .from(projects)
      .where(demoFilterWhere(eq(projects.workspaceId, workspaceId), demoCondition(projects.demo, demo)))
      .groupBy(projects.status),
    db.execute(sql`
      select
        coalesce(count(*) filter (where type = 'page_view' and occurred_at >= ${monthStart.toISOString()}), 0)::text as visitors,
        coalesce(count(*) filter (where type = 'conversion' and occurred_at >= ${monthStart.toISOString()}), 0)::text as conversions,
        coalesce(count(*) filter (where type = 'page_view' and occurred_at >= ${prevMonthStart.toISOString()} and occurred_at < ${monthStart.toISOString()}), 0)::text as visitors_prev,
        coalesce(count(*) filter (where type = 'conversion' and occurred_at >= ${prevMonthStart.toISOString()} and occurred_at < ${monthStart.toISOString()}), 0)::text as conversions_prev
      from analytics_events where workspace_id = ${workspaceId}${demoEventClause}
    `),
  ])

  const visitorRow = extractRows<{ visitors: string; conversions: string; visitors_prev: string; conversions_prev: string }>(visitorRows)[0]
  const visitors = Number(visitorRow?.visitors ?? 0)
  const conversions = Number(visitorRow?.conversions ?? 0)
  const visitorsPrev = Number(visitorRow?.visitors_prev ?? 0)
  const conversionsPrev = Number(visitorRow?.conversions_prev ?? 0)
  const revenueCents = Number(revenue[0]?.total ?? 0)
  const expensesCents = Number(expenseTotal[0]?.total ?? 0)
  const activeStatuses = ['APPROVED', 'BUILDING', 'LAUNCHED', 'MONITORING', 'OPTIMIZING']

  return {
    revenueCents,
    expensesCents,
    profitCents: revenueCents - expensesCents,
    margin: revenueCents > 0 ? Math.round(((revenueCents - expensesCents) / revenueCents) * 10000) / 100 : 0,
    activeProjects: projectCounts.filter((row) => activeStatuses.includes(row.status)).reduce((a, b) => a + Number(b.value), 0),
    totalProjects: projectCounts.reduce((a, b) => a + Number(b.value), 0),
    visitors,
    conversions,
    conversionRate: visitors > 0 ? Math.round((conversions / visitors) * 10000) / 100 : 0,
    visitorsPrev,
    conversionRatePrev: visitorsPrev > 0 ? Math.round((conversionsPrev / visitorsPrev) * 10000) / 100 : 0,
    revenueDeltaPct: percentChange(revenueCents, Number(prevRevenue[0]?.total ?? 0)),
  }
}

export type OpportunityEngineStats = {
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
  topCategories: { category: string; count: number; averageScore: number }[]
}

export async function opportunityEngineStats(
  workspaceId: string,
  threshold = 70,
  options: { demo?: DemoFilter } = {},
): Promise<OpportunityEngineStats> {
  const demo = options.demo ?? 'exclude'
  const db = await getDb()
  const dayStart = startOfDay()
  const weekAgo = new Date(Date.now() - 7 * 86_400_000)
  const demoOpportunityClause = demo === 'only' ? sql` and o.demo = true` : demo === 'exclude' ? sql` and o.demo = false` : sql``

  const [statusRows, todayRow, weekRow, scoreRow, distribution, categories] = await Promise.all([
    db
      .select({ status: opportunities.status, value: count() })
      .from(opportunities)
      .where(demoFilterWhere(eq(opportunities.workspaceId, workspaceId), demoCondition(opportunities.demo, demo)))
      .groupBy(opportunities.status),
    db
      .select({ value: count() })
      .from(opportunities)
      .where(
        and(
          demoFilterWhere(eq(opportunities.workspaceId, workspaceId), demoCondition(opportunities.demo, demo)),
          gte(opportunities.discoveredAt, dayStart),
        ),
      ),
    db
      .select({ value: count() })
      .from(opportunities)
      .where(
        and(
          demoFilterWhere(eq(opportunities.workspaceId, workspaceId), demoCondition(opportunities.demo, demo)),
          gte(opportunities.discoveredAt, weekAgo),
        ),
      ),
    db
      .select({
        analyzed: sql<string>`count(*)::text`,
        high: sql<string>`count(*) filter (where ${opportunityScores.finalScore}::numeric >= ${threshold})::text`,
        average: sql<string>`coalesce(avg(${opportunityScores.finalScore}::numeric), 0)::text`,
      })
      .from(opportunityScores)
      .innerJoin(opportunities, eq(opportunities.id, opportunityScores.opportunityId))
      .where(demoFilterWhere(eq(opportunityScores.workspaceId, workspaceId), demoCondition(opportunities.demo, demo))),
    db.execute(sql`
      select width_bucket(s.final_score::numeric, 0, 100, 10) as bucket, count(*)::text as count
      from opportunity_scores s
      join opportunities o on o.id = s.opportunity_id
      where s.workspace_id = ${workspaceId}${demoOpportunityClause}
      group by bucket order by bucket
    `),
    db.execute(sql`
      select o.category,
             count(distinct o.id)::text as count,
             coalesce(avg(s.final_score::numeric), 0)::text as average_score
      from opportunities o
      left join opportunity_scores s on s.opportunity_id = o.id
      where o.workspace_id = ${workspaceId}${demoOpportunityClause}
      group by o.category
      order by count(distinct o.id) desc
      limit 8
    `),
  ])

  const statusCount = (status: string) => Number(statusRows.find((row) => row.status === status)?.value ?? 0)
  const buckets = extractRows<{ bucket: number; count: string }>(distribution)
  const scoreAgg = scoreRow[0]

  return {
    discoveredToday: Number(todayRow[0]?.value ?? 0),
    discovered7d: Number(weekRow[0]?.value ?? 0),
    analyzed: Number(scoreAgg?.analyzed ?? 0),
    highScore: Number(scoreAgg?.high ?? 0),
    approved: statusCount('approved'),
    rejected: statusCount('rejected'),
    archived: statusCount('archived'),
    awaitingStrategy: statusCount('scored'),
    averageScore: Math.round(Number(scoreAgg?.average ?? 0) * 100) / 100,
    scoreDistribution: Array.from({ length: 10 }, (_, i) => ({
      label: `${i * 10}–${i * 10 + 9}`,
      count: Number(buckets.find((b) => Number(b.bucket) === i + 1)?.count ?? 0),
    })),
    topCategories: extractRows<{ category: string; count: string; average_score: string }>(categories).map((row) => ({
      category: row.category,
      count: Number(row.count),
      averageScore: Math.round(Number(row.average_score) * 100) / 100,
    })),
  }
}

/* ------------------------------------------------------- project financials */

export async function recalculateProjectFinancials(projectId: string): Promise<void> {
  const db = await getDb()
  const result = await db.execute(sql`
    select
      coalesce((select sum(r.gross_cents) from revenue_transactions r
        join projects p on p.id = r.project_id
        where r.project_id = ${projectId} and r.status = 'confirmed' and r.demo = p.demo), 0)::text as revenue,
      coalesce((select sum(e.amount_cents) from expenses e
        join projects p on p.id = e.project_id
        where e.project_id = ${projectId} and e.demo = p.demo), 0)::text as expenses
  `)
  const row = extractRows<{ revenue: string; expenses: string }>(result)[0]
  const revenueCents = Number(row?.revenue ?? 0)
  const spentCents = Number(row?.expenses ?? 0)
  await db
    .update(projects)
    .set({ revenueCents, spentCents, profitCents: revenueCents - spentCents, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
}

export type ProjectDetail = {
  project: typeof projects.$inferSelect
  tasks: (typeof tasks.$inferSelect)[]
  revenue: { grossCents: number; netCents: number; count: number }
  expenses: { totalCents: number; byCategory: { category: string; cents: number }[] }
  metrics: {
    visitors: number
    conversions: number
    conversionRate: number
    revenueSeries: { date: string; revenueCents: number; expensesCents: number }[]
  }
  approvals: { id: string; title: string; status: string; risk: string; createdAt: Date }[]
  events: { id: string; type: string; message: string; actor: string; createdAt: Date }[]
  agents: { agentKey: string; runs: number; failures: number; costCents: number }[]
}

export async function projectDetail(workspaceId: string, projectId: string): Promise<ProjectDetail | null> {
  const db = await getDb()
  const project = (
    await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId))).limit(1)
  )[0]
  if (!project) return null

  const { projectEvents } = await import('../db')
  const [taskRows, revenueRow, expenseRows, eventRows, approvalRows, agentRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(tasks.position).limit(200),
    db
      .select({
        gross: sql<string>`coalesce(sum(${revenueTransactions.grossCents}), 0)::text`,
        net: sql<string>`coalesce(sum(${revenueTransactions.netCents}), 0)::text`,
        count: sql<string>`count(*)::text`,
      })
      .from(revenueTransactions)
      .where(and(eq(revenueTransactions.projectId, projectId), eq(revenueTransactions.demo, project.demo))),
    db
      .select({ category: expenses.category, cents: sql<string>`coalesce(sum(${expenses.amountCents}), 0)::text` })
      .from(expenses)
      .where(and(eq(expenses.projectId, projectId), eq(expenses.demo, project.demo)))
      .groupBy(expenses.category),
    db.select().from(projectEvents).where(eq(projectEvents.projectId, projectId)).orderBy(desc(projectEvents.createdAt)).limit(50),
    db
      .select({ id: approvals.id, title: approvals.title, status: approvals.status, risk: approvals.risk, createdAt: approvals.createdAt })
      .from(approvals)
      .where(eq(approvals.projectId, projectId))
      .orderBy(desc(approvals.createdAt))
      .limit(25),
    db
      .select({
        agentKey: agentRuns.agentKey,
        runs: sql<string>`count(*)::text`,
        failures: sql<string>`count(*) filter (where ${agentRuns.status} in ('failed','timeout'))::text`,
        costCents: sql<string>`coalesce(sum(${agentRuns.costCents}), 0)::text`,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, workspaceId), sql`${agentRuns.input}::text like ${`%${projectId}%`}`))
      .groupBy(agentRuns.agentKey),
  ])

  const seriesResult = await db.execute(sql`
    select d::date as day,
      coalesce((select sum(gross_cents) from revenue_transactions r where r.project_id = ${projectId} and r.demo = ${project.demo} and r.occurred_at::date = d::date), 0)::text as revenue,
      coalesce((select sum(amount_cents) from expenses e where e.project_id = ${projectId} and e.demo = ${project.demo} and e.occurred_at::date = d::date), 0)::text as expenses
    from generate_series(current_date - 29, current_date, interval '1 day') d order by day
  `)

  const visitorStats = await db.execute(sql`
    select
      coalesce(count(*) filter (where type = 'page_view'), 0)::text as visitors,
      coalesce(count(*) filter (where type = 'conversion'), 0)::text as conversions
    from analytics_events where project_id = ${projectId} and demo = ${project.demo}
  `)
  const visitorRow = extractRows<{ visitors: string; conversions: string }>(visitorStats)[0]
  const visitors = Number(visitorRow?.visitors ?? 0)
  const conversions = Number(visitorRow?.conversions ?? 0)

  return {
    project,
    tasks: taskRows,
    revenue: { grossCents: Number(revenueRow[0]?.gross ?? 0), netCents: Number(revenueRow[0]?.net ?? 0), count: Number(revenueRow[0]?.count ?? 0) },
    expenses: { totalCents: expenseRows.reduce((a, b) => a + Number(b.cents), 0), byCategory: expenseRows.map((r) => ({ category: r.category, cents: Number(r.cents) })) },
    metrics: {
      visitors,
      conversions,
      conversionRate: visitors > 0 ? Math.round((conversions / visitors) * 10000) / 100 : 0,
      revenueSeries: extractRows<{ day: string; revenue: string; expenses: string }>(seriesResult).map((row) => ({
        date: typeof row.day === 'string' ? row.day.slice(0, 10) : dayKey(new Date(row.day)),
        revenueCents: Number(row.revenue),
        expensesCents: Number(row.expenses),
      })),
    },
    approvals: approvalRows,
    events: eventRows.map((e) => ({ id: e.id, type: e.type, message: e.message, actor: e.actor, createdAt: e.createdAt })),
    agents: agentRows.map((row) => ({ agentKey: row.agentKey, runs: Number(row.runs), failures: Number(row.failures), costCents: Number(row.costCents) })),
  }
}

/* ----------------------------------------------------------------- events */

export async function recordAnalyticsEvent(input: {
  workspaceId: string
  projectId?: string | null
  type: 'page_view' | 'conversion' | 'signup' | 'click' | 'revenue_event' | 'custom'
  name?: string
  value?: number
  properties?: Record<string, unknown>
  visitorId?: string | null
  url?: string | null
  demo?: boolean
  occurredAt?: Date
}): Promise<void> {
  const db = await getDb()
  await db.insert(analyticsEvents).values({
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    type: input.type,
    name: input.name ?? '',
    value: String(input.value ?? 0),
    properties: input.properties ?? {},
    visitorId: input.visitorId ?? null,
    url: input.url ?? null,
    demo: input.demo ?? false,
    occurredAt: input.occurredAt ?? new Date(),
  })
}

export type AgentPerformance = {
  agentKey: string
  runs: number
  successes: number
  failures: number
  successRate: number
  costCents: number
  avgDurationMs: number
  tokens: number
}

export async function agentPerformance(workspaceId: string, days = 30): Promise<AgentPerformance[]> {
  const db = await getDb()
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await db
    .select({
      agentKey: agentRuns.agentKey,
      runs: sql<string>`count(*)::text`,
      successes: sql<string>`count(*) filter (where ${agentRuns.status} = 'succeeded')::text`,
      failures: sql<string>`count(*) filter (where ${agentRuns.status} in ('failed','timeout'))::text`,
      costCents: sql<string>`coalesce(sum(${agentRuns.costCents}), 0)::text`,
      avgDuration: sql<string>`coalesce(avg(${agentRuns.durationMs}), 0)::text`,
      tokens: sql<string>`coalesce(sum(${agentRuns.tokensUsed}), 0)::text`,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, workspaceId), gte(agentRuns.startedAt, since)))
    .groupBy(agentRuns.agentKey)
    .orderBy(agentRuns.agentKey)
  return rows.map((row) => {
    const runs = Number(row.runs)
    const failures = Number(row.failures)
    return {
      agentKey: row.agentKey,
      runs,
      successes: Number(row.successes),
      failures,
      successRate: runs > 0 ? Math.round(((runs - failures) / runs) * 10000) / 100 : 0,
      costCents: Number(row.costCents),
      avgDurationMs: Math.round(Number(row.avgDuration)),
      tokens: Number(row.tokens),
    }
  })
}

export async function apiUsageSummary(workspaceId: string, days = 30) {
  const db = await getDb()
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await db
    .select({
      provider: apiUsage.provider,
      model: apiUsage.model,
      calls: sql<string>`count(*)::text`,
      tokens: sql<string>`coalesce(sum(${apiUsage.totalTokens}), 0)::text`,
      costCents: sql<string>`coalesce(sum(${apiUsage.costCents}), 0)::text`,
      errors: sql<string>`count(*) filter (where ${apiUsage.status} <> 'ok')::text`,
      avgLatency: sql<string>`coalesce(avg(${apiUsage.latencyMs}), 0)::text`,
    })
    .from(apiUsage)
    .where(and(eq(apiUsage.workspaceId, workspaceId), gte(apiUsage.createdAt, since)))
    .groupBy(apiUsage.provider, apiUsage.model)
    .orderBy(desc(sql`count(*)`))
    .limit(30)
  return rows.map((row) => ({
    provider: row.provider,
    model: row.model ?? 'unknown',
    calls: Number(row.calls),
    tokens: Number(row.tokens),
    costCents: Number(row.costCents),
    errors: Number(row.errors),
    avgLatencyMs: Math.round(Number(row.avgLatency)),
  }))
}

export async function conversionMetrics(workspaceId: string, days = 30, options: { demo?: DemoFilter } = {}) {
  const demo = options.demo ?? 'exclude'
  const demoEventClause = demo === 'only' ? sql` and demo = true` : demo === 'exclude' ? sql` and demo = false` : sql``
  const db = await getDb()
  const since = new Date(Date.now() - days * 86_400_000)
  const result = await db.execute(sql`
    select
      coalesce(count(*) filter (where type = 'page_view'), 0)::text as visitors,
      coalesce(count(*) filter (where type = 'conversion'), 0)::text as conversions,
      coalesce(count(*) filter (where type = 'signup'), 0)::text as signups
    from analytics_events
    where workspace_id = ${workspaceId} and occurred_at >= ${since.toISOString()}${demoEventClause}
  `)
  const row = extractRows<{ visitors: string; conversions: string; signups: string }>(result)[0]
  const visitors = Number(row?.visitors ?? 0)
  const conversions = Number(row?.conversions ?? 0)
  return {
    visitors,
    conversions,
    signups: Number(row?.signups ?? 0),
    conversionRate: visitors > 0 ? Math.round((conversions / visitors) * 10000) / 100 : 0,
    costPerOpportunity: 0,
  }
}

export async function projectSuccessRate(workspaceId: string, options: { demo?: DemoFilter } = {}) {
  const demo = options.demo ?? 'exclude'
  const db = await getDb()
  const rows = await db
    .select({
      status: projects.status,
      value: count(),
      revenue: sql<string>`coalesce(sum(${projects.revenueCents}), 0)::text`,
    })
    .from(projects)
    .where(demoFilterWhere(eq(projects.workspaceId, workspaceId), demoCondition(projects.demo, demo)))
    .groupBy(projects.status)
  const total = rows.reduce((a, b) => a + Number(b.value), 0)
  const succeeded = rows.filter((r) => ['LAUNCHED', 'MONITORING', 'OPTIMIZING', 'COMPLETED'].includes(r.status)).reduce((a, b) => a + Number(b.value), 0)
  const failed = rows.filter((r) => r.status === 'FAILED').reduce((a, b) => a + Number(b.value), 0)
  return {
    total,
    launched: succeeded,
    failed,
    successRate: total > 0 ? Math.round((succeeded / total) * 10000) / 100 : 0,
    revenueProducing: rows.filter((r) => Number(r.revenue) > 0).reduce((a, b) => a + Number(b.value), 0),
    byStatus: rows.map((r) => ({ status: r.status, count: Number(r.value), revenueCents: Number(r.revenue) })),
  }
}

export async function costPerOpportunity(workspaceId: string, days = 30, options: { demo?: DemoFilter } = {}): Promise<number> {
  const demo = options.demo ?? 'exclude'
  const demoExpenseClause = demo === 'only' ? sql` and demo = true` : demo === 'exclude' ? sql` and demo = false` : sql``
  const demoOpportunityClause = demo === 'only' ? sql` and demo = true` : demo === 'exclude' ? sql` and demo = false` : sql``
  const db = await getDb()
  const since = new Date(Date.now() - days * 86_400_000)
  const result = await db.execute(sql`
    select
      coalesce((select sum(amount_cents) from expenses where workspace_id = ${workspaceId} and occurred_at >= ${since.toISOString()}${demoExpenseClause}), 0)::text as spend,
      coalesce((select count(*) from opportunities where workspace_id = ${workspaceId} and discovered_at >= ${since.toISOString()}${demoOpportunityClause}), 0)::text as discovered
  `)
  const row = extractRows<{ spend: string; discovered: string }>(result)[0]
  const spend = Number(row?.spend ?? 0)
  const discovered = Number(row?.discovered ?? 0)
  return discovered > 0 ? Math.round((spend / discovered) * 100) / 100 : 0
}

export { inArray }
