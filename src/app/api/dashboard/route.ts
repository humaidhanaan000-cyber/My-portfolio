/**
 * GET /api/dashboard — everything the command centre needs in one request:
 * system status, agent fleet, money, opportunity engine, approvals, alerts and
 * the live activity feed.
 *
 * All figures are read from the database at request time; there is no cached or
 * decorative number anywhere in this response.
 */
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import {
  getDb, agentRuns, agents as agentsTable, alerts, approvals, jobs, notifications,
  opportunities, opportunityScores, projects, revenueTransactions, tasks, workerHeartbeats,
} from '@/lib/db'
import { ok, withApi } from '@/lib/api/http'
import { businessOverview, financialOverview, opportunityEngineStats } from '@/lib/analytics'
import { budgetSnapshot } from '@/lib/budget'
import { systemStatus } from '@/lib/agents/orchestrator'
import { memoryStats } from '@/lib/memory'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const since24h = new Date(Date.now() - 86_400_000)

  const [
    status, financial, business, engineStats, budget, agentRunsRecent, approvalRows, alertRows,
    notificationRows, latestOpportunities, projectRows, taskStats, jobStats, heartbeatRows, memory,
  ] = await Promise.all([
    systemStatus(workspaceId),
    financialOverview(workspaceId, undefined, 30),
    businessOverview(workspaceId),
    opportunityEngineStats(workspaceId),
    budgetSnapshot(workspaceId),
    db
      .select({
        id: agentRuns.id,
        agentKey: agentRuns.agentKey,
        status: agentRuns.status,
        triggeredBy: agentRuns.triggeredBy,
        startedAt: agentRuns.startedAt,
        durationMs: agentRuns.durationMs,
        costCents: agentRuns.costCents,
        error: agentRuns.error,
        summary: sql<string | null>`coalesce(${agentRuns.output}->>'summary', null)`,
      })
      .from(agentRuns)
      .where(eq(agentRuns.workspaceId, workspaceId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(12),
    db
      .select({
        id: approvals.id,
        title: approvals.title,
        actionType: approvals.actionType,
        reason: approvals.reason,
        expectedCostCents: approvals.expectedCostCents,
        potentialBenefit: approvals.potentialBenefit,
        risk: approvals.risk,
        status: approvals.status,
        createdAt: approvals.createdAt,
        requestedByAgent: approvals.requestedByAgent,
        projectName: projects.name,
      })
      .from(approvals)
      .leftJoin(projects, eq(projects.id, approvals.projectId))
      .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, 'pending')))
      .orderBy(desc(approvals.createdAt))
      .limit(10),
    db.select().from(alerts).where(and(eq(alerts.workspaceId, workspaceId), eq(alerts.status, 'active'))).orderBy(desc(alerts.lastSeenAt)).limit(10),
    db
      .select({ id: notifications.id, type: notifications.type, severity: notifications.severity, title: notifications.title, body: notifications.body, link: notifications.link, createdAt: notifications.createdAt, readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.workspaceId, workspaceId))
      .orderBy(desc(notifications.createdAt))
      .limit(12),
    db
      .select({
        id: opportunities.id,
        title: opportunities.title,
        category: opportunities.category,
        sourceName: opportunities.sourceName,
        status: opportunities.status,
        discoveredAt: opportunities.discoveredAt,
        demo: opportunities.demo,
        score: sql<string | null>`(select final_score::text from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
        verdict: sql<string | null>`(select verdict from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
      })
      .from(opportunities)
      .where(and(eq(opportunities.workspaceId, workspaceId), isNull(opportunities.deletedAt)))
      .orderBy(desc(sql`coalesce((select final_score from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1), 0)`))
      .limit(8),
    db
      .select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        progress: projects.progress,
        revenueCents: projects.revenueCents,
        expenseCents: projects.spentCents,
        profitCents: projects.profitCents,
        budgetCents: projects.budgetCents,
        launchedAt: projects.launchedAt,
        updatedAt: projects.updatedAt,
        demo: projects.demo,
        objective: projects.objective,
        nextTask: sql<string | null>`(select t.title from tasks t where t.project_id = ${projects.id} and t.status in ('todo','in_progress','blocked') order by t.priority asc, t.position asc limit 1)`,
      })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
      .orderBy(desc(projects.updatedAt))
      .limit(8),
    db
      .select({
        open: sql<string>`count(*) filter (where ${tasks.status} in ('todo','in_progress','blocked'))::text`,
        done24h: sql<string>`count(*) filter (where ${tasks.status} = 'done' and ${tasks.finishedAt} >= ${since24h.toISOString()})::text`,
        failed: sql<string>`count(*) filter (where ${tasks.status} = 'failed')::text`,
      })
      .from(tasks)
      .where(eq(tasks.workspaceId, workspaceId)),
    db
      .select({ status: jobs.status, value: sql<string>`count(*)::text` })
      .from(jobs)
      .where(eq(jobs.workspaceId, workspaceId))
      .groupBy(jobs.status),
    db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastHeartbeatAt)).limit(5),
    memoryStats(workspaceId),
  ])

  const agents = await db
    .select({
      key: agentsTable.key,
      name: agentsTable.name,
      category: agentsTable.category,
      enabled: agentsTable.enabled,
      status: agentsTable.status,
      lastRunAt: agentsTable.lastRunAt,
      lastError: agentsTable.lastError,
      successCount: agentsTable.successCount,
      failureCount: agentsTable.failureCount,
      spendCents: sql<string>`coalesce((select sum(r.cost_cents)::text from agent_runs r where r.agent_key = ${agentsTable.key} and r.workspace_id = ${workspaceId}), '0')`,
      runs24h: sql<string>`(select count(*)::text from agent_runs r where r.agent_key = ${agentsTable.key} and r.workspace_id = ${workspaceId} and r.started_at >= ${since24h.toISOString()})`,
    })
    .from(agentsTable)
    .orderBy(agentsTable.key)

  const revenueByDay = await db.execute(sql`
    with span as (select generate_series(current_date - 29, current_date, interval '1 day')::date as day)
    select span.day::text as day,
      coalesce((select sum(rt.net_cents) from revenue_transactions rt where rt.workspace_id = ${workspaceId} and rt.demo = false and rt.occurred_at::date = span.day), 0)::text as revenue_cents,
      coalesce((select sum(e.amount_cents) from expenses e where e.workspace_id = ${workspaceId} and e.demo = false and e.occurred_at::date = span.day), 0)::text as expense_cents
    from span order by span.day
  `)

  const rows = Array.isArray(revenueByDay) ? revenueByDay : ((revenueByDay as { rows?: unknown[] }).rows ?? [])

  const totals = await db
    .select({
      demo: sql<string>`count(*) filter (where ${opportunities.demo})::text`,
      real: sql<string>`count(*) filter (where not ${opportunities.demo})::text`,
    })
    .from(opportunities)
    .where(eq(opportunities.workspaceId, workspaceId))

  const scoresPending = await db
    .select({ value: sql<string>`count(*)::text` })
    .from(opportunities)
    .where(and(eq(opportunities.workspaceId, workspaceId), sql`not exists (select 1 from opportunity_scores s where s.opportunity_id = ${opportunities.id})`))

  const latestRevenue = await db
    .select({ grossCents: revenueTransactions.grossCents, netCents: revenueTransactions.netCents, description: revenueTransactions.description, occurredAt: revenueTransactions.occurredAt, verification: revenueTransactions.verification, provider: revenueTransactions.provider, demo: revenueTransactions.demo })
    .from(revenueTransactions)
    .where(and(eq(revenueTransactions.workspaceId, workspaceId), eq(revenueTransactions.demo, false)))
    .orderBy(desc(revenueTransactions.occurredAt))
    .limit(5)

  // Demo money is reported separately and clearly labelled — never added to the
  // real figures above it.
  const demoFinance = await financialOverview(workspaceId, undefined, 30, { demo: 'only' })
  const demoProjects = projectRows.filter((project) => project.demo).length

  void gte
  void opportunityScores

  return ok({
    system: status,
    agents: {
      roster: agents.map((agent) => ({
        ...agent,
        spendCents: Number(agent.spendCents),
        runs24h: Number(agent.runs24h),
        health: !agent.enabled ? 'disabled' : agent.status === 'error' ? 'error' : 'ok',
      })),
      active: agents.filter((agent) => agent.enabled).length,
      total: agents.length,
      recentRuns: agentRunsRecent,
    },
    money: {
      financial,
      business,
      recentRevenue: latestRevenue,
      series: rows.map((row) => {
        const entry = row as Record<string, string>
        return {
          day: entry.day,
          revenueCents: Number(entry.revenue_cents),
          expenseCents: Number(entry.expense_cents),
          profitCents: Number(entry.revenue_cents) - Number(entry.expense_cents),
        }
      }),
    },
    opportunityEngine: {
      ...engineStats,
      demoCount: Number(totals[0]?.demo ?? 0),
      realCount: Number(totals[0]?.real ?? 0),
      awaitingScore: Number(scoresPending[0]?.value ?? 0),
      latest: latestOpportunities,
    },
    approvals: { pending: approvalRows, counts: await approvalCounts(workspaceId) },
    alerts: alertRows.map((alert) => ({ ...alert, demo: false })),
    notifications: notificationRows,
    projects: projectRows.filter((project) => !project.demo),
    demoSummary: {
      label: 'DEMO DATA' as const,
      revenueCents: demoFinance.allTime.revenue,
      expensesCents: demoFinance.allTime.expenses,
      profitCents: demoFinance.allTime.profit,
      projects: demoProjects,
      note: 'Sample data from demo mode — never added to the figures above.',
    },
    tasks: {
      open: Number(taskStats[0]?.open ?? 0),
      done24h: Number(taskStats[0]?.done24h ?? 0),
      failed: Number(taskStats[0]?.failed ?? 0),
    },
    queue: {
      byStatus: Object.fromEntries(jobStats.map((row) => [row.status, Number(row.value)])),
      workers: heartbeatRows.map((row) => ({
        workerId: row.workerId,
        role: row.role,
        status: row.status,
        lastHeartbeatAt: row.lastHeartbeatAt,
        secondsSinceHeartbeat: Math.round((Date.now() - new Date(row.lastHeartbeatAt).getTime()) / 1000),
      })),
    },
    budget,
    memory,
    generatedAt: new Date().toISOString(),
    notices: [
      'Revenue shown here is actual recorded revenue. Projections and estimates are labelled wherever they appear.',
      'Demo data is stored separately and never included in real revenue totals.',
    ],
  })
})

async function approvalCounts(workspaceId: string): Promise<Record<string, number>> {
  const db = await getDb()
  const rows = await db
    .select({ status: approvals.status, value: sql<string>`count(*)::text` })
    .from(approvals)
    .where(eq(approvals.workspaceId, workspaceId))
    .groupBy(approvals.status)
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.value)]))
}
