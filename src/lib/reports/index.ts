/**
 * Automatic reports (daily + weekly).
 *
 * Reports are assembled from realised data first and only then summarised by a
 * model. If no provider is configured the deterministic summary is used, so the
 * report is always available and never contains invented numbers.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb, agentRuns, approvals, opportunities, projects, reports, tasks, extractRows } from '../db'
import { businessOverview, financialOverview, opportunityEngineStats, projectSuccessRate } from '../analytics'
import { agentPerformance } from '../analytics'
import { reportPrompt } from '../ai/prompts'
import { dailyReportSchema } from '../ai/schemas'
import { notify } from '../notifications'
import { startOfDay } from '../utils'
import { createLogger } from '../observability/logger'

const log = createLogger({ component: 'reports' })

export type ReportPeriod = 'daily' | 'weekly'

export type ReportData = {
  period: ReportPeriod
  windowStart: string
  windowEnd: string
  currency: string
  revenue: { grossCents: number; netCents: number; transactions: number; verifiedCents: number; manualCents: number }
  expenses: { totalCents: number; byCategory: { category: string; cents: number }[] }
  profitCents: number
  opportunities: { discovered: number; analyzed: number; highScore: number; approved: number; rejected: number; top: { id: string; title: string; score: number }[] }
  projects: { active: number; launched: number; failed: number; awaitingApproval: number }
  tasks: { open: number; done: number; failed: number }
  agents: { runs: number; failures: number; costCents: number; worstAgent: string | null }
  approvals: { pending: number; decided: number; avgDecisionMinutes: number | null }
  alerts: string[]
  recommendations: string[]
  summary: string
  demoDataIncluded: boolean
}

export async function buildReport(workspaceId: string, period: ReportPeriod, options: { useAi?: boolean } = {}): Promise<ReportData> {
  const db = await getDb()
  const days = period === 'weekly' ? 7 : 1
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - days * 86_400_000)
  const workspaceRows = await db.execute(sql`select demo_mode from workspaces where id = ${workspaceId} limit 1`)
  const demoMode = Boolean(extractRows<{ demo_mode: boolean }>(workspaceRows)[0]?.demo_mode)

  const [finance, engine, overview, success, agentStats, taskStats, approvalStats, topOpportunities] = await Promise.all([
    financialOverview(workspaceId, 'USD', days),
    opportunityEngineStats(workspaceId),
    businessOverview(workspaceId),
    projectSuccessRate(workspaceId),
    agentPerformance(workspaceId, days),
    db.execute(sql`
      select
        count(*) filter (where status in ('todo','in_progress','blocked'))::text as open,
        count(*) filter (where status = 'done' and finished_at >= ${windowStart.toISOString()})::text as done,
        count(*) filter (where status = 'failed' and updated_at >= ${windowStart.toISOString()})::text as failed
      from tasks where workspace_id = ${workspaceId}
        and (project_id is null or project_id not in (select id from projects where demo = true))
    `),
    db.execute(sql`
      select
        count(*) filter (where status = 'pending')::text as pending,
        count(*) filter (where decided_at >= ${windowStart.toISOString()})::text as decided,
        avg(extract(epoch from (decided_at - created_at)) / 60) filter (where decided_at >= ${windowStart.toISOString()})::text as avg_minutes
      from approvals where workspace_id = ${workspaceId}
        and (project_id is null or project_id not in (select id from projects where demo = true))
    `),
    db
      .select({ id: opportunities.id, title: opportunities.title, score: sql<string>`coalesce((select final_score::text from opportunity_scores where opportunity_id = ${opportunities.id} order by version desc limit 1), '0')` })
      .from(opportunities)
      .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.demo, false), gte(opportunities.discoveredAt, windowStart)))
      .orderBy(desc(opportunities.discoveredAt))
      .limit(50),
  ])

  const taskRow = extractRows<{ open: string; done: string; failed: string }>(taskStats)[0]
  const approvalRow = extractRows<{ pending: string; decided: string; avg_minutes: string | null }>(approvalStats)[0]

  const top = topOpportunities
    .map((row) => ({ id: row.id, title: row.title, score: Number(row.score) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  const windowRevenue = finance.revenueSeries
    .filter((point) => new Date(point.date) >= startOfDay(windowStart))
    .reduce((acc, point) => ({ gross: acc.gross + point.revenueCents }), { gross: 0 }).gross
  const windowExpenses = finance.revenueSeries
    .filter((point) => new Date(point.date) >= startOfDay(windowStart))
    .reduce((acc, point) => ({ total: acc.total + point.expensesCents }), { total: 0 }).total

  const alertsList = await db.execute(sql`
    select title, message from alerts where workspace_id = ${workspaceId} and status = 'open'
      and last_seen_at >= ${windowStart.toISOString()} order by last_seen_at desc limit 10
  `)
  const openAlerts = extractRows<{ title: string; message: string }>(alertsList).map((row) => `${row.title}: ${row.message}`)

  const agentRuns = agentStats.reduce((a, b) => a + b.runs, 0)
  const agentFailures = agentStats.reduce((a, b) => a + b.failures, 0)
  const worstAgent = agentStats.slice().sort((a, b) => b.failures - a.failures)[0]

  const data: ReportData = {
    period,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    currency: 'USD',
    revenue: {
      grossCents: windowRevenue,
      netCents: windowRevenue - finance.allTime.expenses,
      transactions: finance.revenueBySource.reduce((a, b) => a + b.count, 0),
      verifiedCents: overview.revenueCents,
      manualCents: 0,
    },
    expenses: { totalCents: windowExpenses, byCategory: finance.expenseBreakdown },
    profitCents: windowRevenue - windowExpenses,
    opportunities: {
      discovered: engine.discoveredToday + (period === 'weekly' ? engine.discovered7d : 0),
      analyzed: engine.analyzed,
      highScore: engine.highScore,
      approved: engine.approved,
      rejected: engine.rejected,
      top,
    },
    projects: {
      active: overview.activeProjects,
      launched: success.launched,
      failed: success.failed,
      awaitingApproval: Number(approvalRow?.pending ?? 0),
    },
    tasks: { open: Number(taskRow?.open ?? 0), done: Number(taskRow?.done ?? 0), failed: Number(taskRow?.failed ?? 0) },
    agents: { runs: agentRuns, failures: agentFailures, costCents: agentStats.reduce((a, b) => a + b.costCents, 0), worstAgent: worstAgent && worstAgent.failures > 0 ? worstAgent.agentKey : null },
    approvals: {
      pending: Number(approvalRow?.pending ?? 0),
      decided: Number(approvalRow?.decided ?? 0),
      avgDecisionMinutes: approvalRow?.avg_minutes ? Math.round(Number(approvalRow.avg_minutes)) : null,
    },
    alerts: openAlerts,
    recommendations: [],
    summary: '',
    demoDataIncluded: demoMode,
  }

  data.recommendations = deterministicRecommendations(data)
  data.summary = deterministicSummary(data)

  if (options.useAi) {
    try {
      const { aiStatus, generateJson } = await import('../ai')
      if (aiStatus().configured) {
        const prompt = reportPrompt({ period, metrics: data as unknown as Record<string, unknown>, alerts: openAlerts, currency: 'USD' })
        const enriched = await generateJson(
          { system: prompt.system, prompt: prompt.prompt, tier: 'standard', maxTokens: 1200, schemaName: 'daily_report', workspaceId, agentKey: 'monitoring' },
          dailyReportSchema,
        )
        data.summary = enriched.summary
        data.recommendations = [...new Set([...(enriched.recommendedActions ?? []), ...data.recommendations])].slice(0, 8)
        if (enriched.concerns?.length) data.alerts = [...data.alerts, ...enriched.concerns].slice(0, 12)
      }
    } catch (error) {
      log.warn('AI report enrichment failed; deterministic report retained', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return data
}

function deterministicSummary(data: ReportData): string {
  const parts: string[] = []
  parts.push(`${data.period === 'weekly' ? 'Weekly' : 'Daily'} report: revenue ${(data.revenue.grossCents / 100).toFixed(2)}, expenses ${(data.expenses.totalCents / 100).toFixed(2)}, net ${(data.profitCents / 100).toFixed(2)} ${data.currency}.`)
  parts.push(`${data.opportunities.discovered} opportunit${data.opportunities.discovered === 1 ? 'y' : 'ies'} discovered, ${data.opportunities.highScore} scoring at or above your threshold.`)
  parts.push(`${data.projects.active} active project(s), ${data.projects.awaitingApproval} awaiting your approval.`)
  if (data.agents.failures > 0) parts.push(`${data.agents.failures} agent failure(s) recorded.`)
  if (data.revenue.grossCents === 0) parts.push('No verified revenue was recorded in this period — all projections remain unvalidated.')
  return parts.join(' ')
}

function deterministicRecommendations(data: ReportData): string[] {
  const out: string[] = []
  if (data.approvals.pending > 0) out.push(`Review ${data.approvals.pending} pending approval(s) — automation is blocked until you decide.`)
  if (data.opportunities.highScore > 5) out.push(`${data.opportunities.highScore} opportunities scored above your threshold; generate strategies for the best two only.`)
  if (data.revenue.grossCents === 0 && data.projects.launched > 0) out.push('Launched projects have produced no verified revenue yet — prioritise validation conversations over more building.')
  if (data.agents.failures > 0) out.push(`Investigate agent failures (${data.agents.failures}); run the monitoring agent or check System Logs in the admin panel.`)
  if (data.expenses.totalCents > data.revenue.grossCents * 2 && data.expenses.totalCents > 0) out.push('Operating costs exceed twice the revenue recorded — review the budget limits.')
  if (out.length === 0) out.push('System is operating within expectations; continue the current plan.')
  return out.slice(0, 6)
}

export async function generateAndStoreReport(workspaceId: string, period: ReportPeriod, options: { useAi?: boolean } = {}): Promise<{ id: string; data: ReportData }> {
  const db = await getDb()
  const data = await buildReport(workspaceId, period, options)
  const rows = await db
    .insert(reports)
    .values({
      workspaceId,
      type: period,
      periodStart: new Date(data.windowStart),
      periodEnd: new Date(data.windowEnd),
      summary: data.summary,
      data: data as unknown as Record<string, unknown>,
      recommendations: data.recommendations,
      demo: data.demoDataIncluded,
    })
    .returning({ id: reports.id })

  const id = rows[0]!.id
  await notify({
    workspaceId,
    type: 'report_ready',
    severity: 'info',
    title: `${period === 'weekly' ? 'Weekly' : 'Daily'} report ready`,
    body: data.summary,
    link: `/dashboard/reports`,
    dedupeKey: `report:${period}:${new Date().toISOString().slice(0, period === 'weekly' ? 10 : 13)}`,
  })
  return { id, data }
}

export async function listReports(workspaceId: string, limit = 20) {
  const db = await getDb()
  return db.select().from(reports).where(eq(reports.workspaceId, workspaceId)).orderBy(desc(reports.createdAt)).limit(limit)
}

export async function latestReport(workspaceId: string, period: ReportPeriod) {
  const db = await getDb()
  const rows = await db
    .select()
    .from(reports)
    .where(and(eq(reports.workspaceId, workspaceId), eq(reports.type, period)))
    .orderBy(desc(reports.createdAt))
    .limit(1)
  return rows[0] ?? null
}

export { projects, approvals, tasks, agentRuns }
