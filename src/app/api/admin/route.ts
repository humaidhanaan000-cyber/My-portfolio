/**
 * GET /api/admin — the operator console: platform-wide counters, queue health,
 * worker heartbeats, error feed, API spend and the storage footprint.
 *
 * Every count here is a live SQL aggregate over real rows — the console shows
 * what the system actually did, never a decorative number.
 */
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { getDb, agentRuns, agents, alerts, apiUsage, approvals, auditLogs, expenses, jobs, opportunities, projects, revenueTransactions, systemLogs, users, workerHeartbeats, workspaces } from '@/lib/db'
import { ok, withApi } from '@/lib/api/http'
import { queueStats } from '@/lib/queue'
import { systemStatus } from '@/lib/agents/orchestrator'
import { checkDatabaseHealth } from '@/lib/db'
import { appliedMigrations } from '@/lib/db/migrate'

export const dynamic = 'force-dynamic'

export const GET = withApi(
  async (ctx) => {
    const db = await getDb()
    const since24h = new Date(Date.now() - 86_400_000)
    const since7d = new Date(Date.now() - 7 * 86_400_000)

    const [
      userCount, workspaceCount, opportunityCount, projectCount, approvalCounts, revenueTotals, expenseTotals,
      queue, status, heartbeats, errorFeed, usage, recentAudit, migrationRecords, jobCounts, agentCounts, alertRows, planSplit,
    ] = await Promise.all([
      db.select({ value: sql<string>`count(*)::text` }).from(users),
      db.select({ value: sql<string>`count(*)::text` }).from(workspaces),
      db.select({ value: sql<string>`count(*)::text` }).from(opportunities).where(isNull(opportunities.deletedAt)),
      db.select({ value: sql<string>`count(*)::text` }).from(projects).where(isNull(projects.deletedAt)),
      db.select({ status: approvals.status, value: sql<string>`count(*)::text` }).from(approvals).groupBy(approvals.status),
      db
        .select({
          gross: sql<string>`coalesce(sum(${revenueTransactions.grossCents}), 0)::text`,
          net: sql<string>`coalesce(sum(${revenueTransactions.netCents}), 0)::text`,
          demo: sql<string>`coalesce(sum(${revenueTransactions.grossCents}) filter (where ${revenueTransactions.demo}), 0)::text`,
          verified: sql<string>`coalesce(sum(${revenueTransactions.grossCents}) filter (where ${revenueTransactions.verification} = 'verified_integration'), 0)::text`,
          count: sql<string>`count(*)::text`,
        })
        .from(revenueTransactions),
      db.select({ total: sql<string>`coalesce(sum(${expenses.amountCents}), 0)::text`, count: sql<string>`count(*)::text` }).from(expenses),
      queueStats(),
      systemStatus(ctx.session.workspaceId),
      db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastHeartbeatAt)).limit(10),
      db
        .select({ id: systemLogs.id, level: systemLogs.level, source: systemLogs.source, message: systemLogs.message, createdAt: systemLogs.createdAt, context: systemLogs.context })
        .from(systemLogs)
        .where(and(gte(systemLogs.createdAt, since24h), sql`${systemLogs.level} in ('error','fatal','warn')`))
        .orderBy(desc(systemLogs.createdAt))
        .limit(50),
      db
        .select({
          provider: apiUsage.provider,
          model: apiUsage.model,
          calls: sql<string>`count(*)::text`,
          tokens: sql<string>`coalesce(sum(${apiUsage.totalTokens}), 0)::text`,
          costCents: sql<string>`coalesce(sum(${apiUsage.costCents}), 0)::text`,
          failures: sql<string>`count(*) filter (where ${apiUsage.status} <> 'ok')::text`,
        })
        .from(apiUsage)
        .where(gte(apiUsage.createdAt, since7d))
        .groupBy(apiUsage.provider, apiUsage.model),
      db
        .select({ id: auditLogs.id, action: auditLogs.action, entityType: auditLogs.entityType, entityId: auditLogs.entityId, actorType: auditLogs.actorType, userId: auditLogs.userId, workspaceId: auditLogs.workspaceId, createdAt: auditLogs.createdAt })
        .from(auditLogs)
        .orderBy(desc(auditLogs.createdAt))
        .limit(50),
      appliedMigrations(),
      db.select({ status: jobs.status, value: sql<string>`count(*)::text` }).from(jobs).groupBy(jobs.status),
      db
        .select({
          agentKey: agentRuns.agentKey,
          runs: sql<string>`count(*)::text`,
          failures: sql<string>`count(*) filter (where ${agentRuns.status} = 'failed')::text`,
          costCents: sql<string>`coalesce(sum(${agentRuns.costCents}), 0)::text`,
          tokens: sql<string>`coalesce(sum(${agentRuns.tokensUsed}), 0)::text`,
          avgMs: sql<string>`coalesce(round(avg(${agentRuns.durationMs})), 0)::text`,
        })
        .from(agentRuns)
        .where(gte(agentRuns.startedAt, since7d))
        .groupBy(agentRuns.agentKey),
      db.select({ severity: alerts.severity, status: alerts.status, value: sql<string>`count(*)::text` }).from(alerts).groupBy(alerts.severity, alerts.status),
      db.select({ planKey: workspaces.planKey, value: sql<string>`count(*)::text` }).from(workspaces).groupBy(workspaces.planKey),
    ])

    const [dbHealth, roster] = await Promise.all([checkDatabaseHealth(), db.select({ key: agents.key, enabled: agents.enabled, status: agents.status, lastRunAt: agents.lastRunAt, lastError: agents.lastError, successCount: agents.successCount, failureCount: agents.failureCount }).from(agents)])

    return ok({
      platform: {
        users: Number(userCount[0]?.value ?? 0),
        workspaces: Number(workspaceCount[0]?.value ?? 0),
        opportunities: Number(opportunityCount[0]?.value ?? 0),
        projects: Number(projectCount[0]?.value ?? 0),
        plans: planSplit.map((row) => ({ planKey: row.planKey, count: Number(row.value) })),
      },
      approvals: Object.fromEntries(approvalCounts.map((row) => [row.status, Number(row.value)])),
      money: {
        revenueGrossCents: Number(revenueTotals[0]?.gross ?? 0),
        revenueNetCents: Number(revenueTotals[0]?.net ?? 0),
        verifiedRevenueCents: Number(revenueTotals[0]?.verified ?? 0),
        demoRevenueCents: Number(revenueTotals[0]?.demo ?? 0),
        transactionCount: Number(revenueTotals[0]?.count ?? 0),
        expenseCents: Number(expenseTotals[0]?.total ?? 0),
        expenseCount: Number(expenseTotals[0]?.count ?? 0),
      },
      queues: { stats: queue, byStatus: Object.fromEntries(jobCounts.map((row) => [row.status, Number(row.value)])) },
      workers: heartbeats.map((row) => ({
        workerId: row.workerId,
        role: row.role,
        status: row.status,
        lastHeartbeatAt: row.lastHeartbeatAt,
        secondsSinceHeartbeat: Math.round((Date.now() - new Date(row.lastHeartbeatAt).getTime()) / 1000),
        processedCount: row.processedCount,
        errorCount: row.errorCount,
      })),
      system: status,
      database: dbHealth,
      migrations: migrationRecords,
      agents: { roster, activity: agentCounts.map((row) => ({ agentKey: row.agentKey, runs: Number(row.runs), failures: Number(row.failures), costCents: Number(row.costCents), tokens: Number(row.tokens), avgDurationMs: Number(row.avgMs) })) },
      alerts: alertRows.map((row) => ({ severity: row.severity, status: row.status, count: Number(row.value) })),
      apiUsage: usage.map((row) => ({ provider: row.provider, model: row.model, calls: Number(row.calls), tokens: Number(row.tokens), costCents: Number(row.costCents), failures: Number(row.failures) })),
      errors: errorFeed,
      audit: recentAudit,
    })
  },
  { admin: true },
)
