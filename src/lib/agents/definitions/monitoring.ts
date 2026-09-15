/**
 * AGENT 8 — MONITORING AGENT
 *
 * Watches uptime, traffic, conversions, revenue, expenses, API usage, failures,
 * project performance and automation health; detects anomalies with simple,
 * explainable statistics (z-score against a rolling baseline) and raises alerts.
 * It never mutates business data — it only observes and reports.
 */
import { z } from 'zod'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { getDb, projects, extractRows } from '../../db'
import { checkDatabaseHealth } from '../../db'
import { pingRedis } from '../../queue/redis'
import { queueStats } from '../../queue'
import { aiStatus } from '../../ai'
import { raiseAlert } from '../../notifications'
import { variance } from '../../utils'
import type { AgentDefinition, AgentOutput } from '../types'

export const monitoringInputSchema = z.object({
  windowHours: z.number().int().min(1).max(720).default(24),
  raiseAlerts: z.boolean().default(true),
})
export type MonitoringInput = z.infer<typeof monitoringInputSchema>

export type MonitoringOutput = {
  health: {
    database: { ok: boolean; latencyMs: number; message?: string }
    queue: { driver: string; queued: number; running: number; failed: number; dead: number }
    workers: { role: string; status: string; lastHeartbeatAt: string | null; stale: boolean }[]
    ai: { configured: boolean; provider: string }
    redis: { configured: boolean; ok: boolean }
  }
  window: { hours: number; from: string; to: string }
  metrics: {
    revenueCents: number
    expensesCents: number
    profitCents: number
    visitors: number
    conversions: number
    conversionRate: number
    agentRuns: number
    agentFailures: number
    agentSuccessRate: number
  }
  projects: { id: string; name: string; status: string; revenueCents: number; expensesCents: number; profitCents: number; progress: number }[]
  anomalies: { type: string; severity: 'info' | 'warning' | 'critical'; message: string; metric: string; observed: number; expected: number }[]
  alertsRaised: number
}

/** Simple, explainable anomaly detection: |z| > 2.5 against a 7-day baseline. */
export function detectAnomaly(series: number[], observed: number, options: { minAbsolute?: number } = {}): { isAnomaly: boolean; mean: number; stddev: number; z: number } {
  const clean = series.filter((v) => Number.isFinite(v))
  if (clean.length < 5) return { isAnomaly: false, mean: 0, stddev: 0, z: 0 }
  const { mean, stddev } = variance(clean)
  if (stddev === 0) return { isAnomaly: false, mean, stddev, z: 0 }
  const z = (observed - mean) / stddev
  const minAbsolute = options.minAbsolute ?? 0
  return { isAnomaly: Math.abs(z) > 2.5 && Math.abs(observed - mean) >= minAbsolute, mean, stddev, z }
}

export const monitoringAgent: AgentDefinition<MonitoringInput, MonitoringOutput> = {
  key: 'monitoring',
  name: 'Monitoring Agent',
  description: 'Tracks uptime, traffic, revenue, cost, API usage, failures and automation health; raises anomalies as alerts.',
  category: 'operations',
  policyAction: 'system_maintenance',
  estimatedCostCents: 0,
  modelTier: 'cheap',
  timeoutSeconds: 180,
  cadenceMinutes: 15,
  requiresWorkspace: true,
  inputSchema: monitoringInputSchema,

  async run(input, ctx): Promise<AgentOutput<MonitoringOutput>> {
    const db = await getDb()
    const from = new Date(Date.now() - input.windowHours * 3_600_000)
    const anomalies: MonitoringOutput['anomalies'] = []
    let alertsRaised = 0

    /* -------------------------------------------------------------- health */
    const dbHealth = await checkDatabaseHealth()
    const queue = await queueStats()
    const redis = await pingRedis()
    const ai = aiStatus()

    const heartbeats = await db.execute(sql`
      select role, worker_id, status, last_heartbeat_at
      from worker_heartbeats
      order by last_heartbeat_at desc limit 10
    `)
    const workers = extractRows<{ role: string; worker_id: string; status: string; last_heartbeat_at: string }>(heartbeats).map((row) => {
      const last = row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null
      const stale = !last || Date.now() - last.getTime() > 120_000
      return { role: row.role, status: stale ? 'offline' : row.status, lastHeartbeatAt: last ? last.toISOString() : null, stale }
    })

    const { env } = await import('../../env')
    if (!dbHealth.ok) {
      anomalies.push({ type: 'database', severity: 'critical', message: `Database health check failed: ${dbHealth.error}`, metric: 'db_latency_ms', observed: dbHealth.latencyMs, expected: 50 })
    } else if (dbHealth.latencyMs > 1500) {
      anomalies.push({ type: 'database', severity: 'warning', message: `Database latency is high (${dbHealth.latencyMs}ms).`, metric: 'db_latency_ms', observed: dbHealth.latencyMs, expected: 100 })
    }
    if (dbHealth.ok && dbHealth.migrationsApplied !== undefined && dbHealth.migrationsApplied === 0) {
      anomalies.push({ type: 'database', severity: 'critical', message: 'No migrations have been applied. Run `npm run db:migrate`.', metric: 'migrations', observed: 0, expected: 1 })
    }
    if (queue.dead > 0) {
      anomalies.push({ type: 'queue', severity: 'warning', message: `${queue.dead} job(s) in the dead-letter state — inspect them in the admin panel.`, metric: 'dead_jobs', observed: queue.dead, expected: 0 })
    }
    if (queue.oldestQueuedSeconds !== null && queue.oldestQueuedSeconds > Math.max(300, env.WORKER_POLL_MS / 1000 * 60)) {
      anomalies.push({ type: 'queue', severity: 'warning', message: `Oldest queued job is ${Math.round(queue.oldestQueuedSeconds)}s old — is a worker process running?`, metric: 'queue_lag_seconds', observed: queue.oldestQueuedSeconds, expected: 30 })
    }
    if (env.REDIS_URL !== 'memory' && !redis.ok) {
      anomalies.push({ type: 'redis', severity: 'warning', message: `Redis is configured but not reachable: ${redis.error ?? 'unknown error'}`, metric: 'redis_ok', observed: 0, expected: 1 })
    }
    const staleWorkers = workers.filter((w) => w.stale && w.role !== 'web')
    if (staleWorkers.length > 0 && queue.queued > 0) {
      anomalies.push({ type: 'worker_offline', severity: 'critical', message: `${staleWorkers.length} worker heartbeat(s) are stale while ${queue.queued} job(s) are queued.`, metric: 'stale_workers', observed: staleWorkers.length, expected: 0 })
    }
    if (!ai.configured) {
      anomalies.push({ type: 'ai_provider', severity: 'info', message: 'No AI provider configured — deterministic engines are active. Add an API key to enable model-assisted analysis.', metric: 'ai_configured', observed: 0, expected: 1 })
    }

    /* ------------------------------------------------------------- metrics */
    const metricsResult = await db.execute(sql`
      select
        coalesce((select sum(gross_cents) from revenue_transactions where workspace_id = ${ctx.workspaceId} and demo = false and occurred_at >= ${from.toISOString()} and status = 'confirmed'), 0) as revenue,
        coalesce((select sum(amount_cents) from expenses where workspace_id = ${ctx.workspaceId} and demo = false and occurred_at >= ${from.toISOString()}), 0) as expenses,
        coalesce((select count(*) from analytics_events where workspace_id = ${ctx.workspaceId} and demo = false and type = 'page_view' and occurred_at >= ${from.toISOString()}), 0) as visitors,
        coalesce((select count(*) from analytics_events where workspace_id = ${ctx.workspaceId} and demo = false and type = 'conversion' and occurred_at >= ${from.toISOString()}), 0) as conversions,
        coalesce((select count(*) from agent_runs where workspace_id = ${ctx.workspaceId} and started_at >= ${from.toISOString()}), 0) as agent_runs,
        coalesce((select count(*) from agent_runs where workspace_id = ${ctx.workspaceId} and started_at >= ${from.toISOString()} and status in ('failed','timeout')), 0) as agent_failures
    `)
    const row = extractRows<Record<string, string>>(metricsResult)[0] ?? {}
    const revenueCents = Number(row.revenue ?? 0)
    const expensesCents = Number(row.expenses ?? 0)
    const visitors = Number(row.visitors ?? 0)
    const conversions = Number(row.conversions ?? 0)
    const agentRuns = Number(row.agent_runs ?? 0)
    const agentFailures = Number(row.agent_failures ?? 0)

    const metrics = {
      revenueCents,
      expensesCents,
      profitCents: revenueCents - expensesCents,
      visitors,
      conversions,
      conversionRate: visitors > 0 ? Math.round((conversions / visitors) * 10000) / 100 : 0,
      agentRuns,
      agentFailures,
      agentSuccessRate: agentRuns > 0 ? Math.round(((agentRuns - agentFailures) / agentRuns) * 10000) / 100 : 100,
    }

    if (agentRuns >= 10 && metrics.agentSuccessRate < 80) {
      anomalies.push({
        type: 'automation_health',
        severity: metrics.agentSuccessRate < 60 ? 'critical' : 'warning',
        message: `Agent success rate is ${metrics.agentSuccessRate}% over the last ${input.windowHours}h (${agentFailures} failures of ${agentRuns} runs).`,
        metric: 'agent_success_rate',
        observed: metrics.agentSuccessRate,
        expected: 95,
      })
    }

    /* -------------------------------------------------------- cost anomaly */
    const dailyCosts = await dailySeries(ctx.workspaceId, 'expenses', 14)
    const todayCost = dailyCosts.at(-1) ?? 0
    const costAnomaly = detectAnomaly(dailyCosts.slice(0, -1), todayCost, { minAbsolute: 50 })
    if (costAnomaly.isAnomaly && costAnomaly.z > 0) {
      anomalies.push({
        type: 'cost_spike',
        severity: todayCost > (ctx.learning.notes?.length ? 0 : 0) + costAnomaly.mean * 3 ? 'critical' : 'warning',
        message: `Today's spend (${(todayCost / 100).toFixed(2)}) is ${costAnomaly.z.toFixed(1)}σ above the 14-day average (${(costAnomaly.mean / 100).toFixed(2)}).`,
        metric: 'daily_expense_cents',
        observed: todayCost,
        expected: Math.round(costAnomaly.mean),
      })
    }

    const weeklyRevenue = await dailySeries(ctx.workspaceId, 'revenue', 28)
    const dropAnomaly = detectAnomaly(weeklyRevenue.slice(0, -1), weeklyRevenue.at(-1) ?? 0)
    if (dropAnomaly.isAnomaly && (weeklyRevenue.at(-1) ?? 0) < dropAnomaly.mean) {
      anomalies.push({
        type: 'revenue_drop',
        severity: 'warning',
        message: `Revenue today is well below the 28-day baseline (${((weeklyRevenue.at(-1) ?? 0) / 100).toFixed(2)} vs ${(dropAnomaly.mean / 100).toFixed(2)} average).`,
        metric: 'daily_revenue_cents',
        observed: weeklyRevenue.at(-1) ?? 0,
        expected: Math.round(dropAnomaly.mean),
      })
    }

    /* ------------------------------------------------------ project health */
    const projectRows = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, ctx.workspaceId),
          eq(projects.demo, false),
          inArray(projects.status, ['LAUNCHED', 'MONITORING', 'OPTIMIZING', 'BUILDING', 'PAUSED']),
        ),
      )
      .orderBy(desc(projects.updatedAt))
      .limit(25)

    const projectStats: MonitoringOutput['projects'] = []
    for (const project of projectRows) {
      const result = await db.execute(sql`
        select
          coalesce((select sum(gross_cents) from revenue_transactions where project_id = ${project.id} and demo = false and status = 'confirmed'), 0) as revenue,
          coalesce((select sum(amount_cents) from expenses where project_id = ${project.id} and demo = false), 0) as expenses
      `)
      const stats = extractRows<{ revenue: string; expenses: string }>(result)[0]
      const revenue = Number(stats?.revenue ?? 0)
      const expenseTotal = Number(stats?.expenses ?? 0)
      projectStats.push({
        id: project.id,
        name: project.name,
        status: project.status,
        revenueCents: revenue,
        expensesCents: expenseTotal,
        profitCents: revenue - expenseTotal,
        progress: project.progress,
      })

      const launchedDays = project.launchedAt ? (Date.now() - new Date(project.launchedAt).getTime()) / 86_400_000 : null
      if (launchedDays !== null && launchedDays > 30 && revenue === 0) {
        anomalies.push({
          type: 'project_stalled',
          severity: 'warning',
          message: `"${project.name}" has been live for ${Math.round(launchedDays)} days with no recorded revenue.`,
          metric: 'project_days_without_revenue',
          observed: Math.round(launchedDays),
          expected: 30,
        })
      }
      if (project.budgetCents > 0 && expenseTotal > project.budgetCents) {
        anomalies.push({
          type: 'project_over_budget',
          severity: 'critical',
          message: `"${project.name}" has spent ${(expenseTotal / 100).toFixed(2)} against a budget of ${(project.budgetCents / 100).toFixed(2)}.`,
          metric: 'project_spend_cents',
          observed: expenseTotal,
          expected: project.budgetCents,
        })
      }
    }

    if (input.raiseAlerts) {
      for (const anomaly of anomalies) {
        if (anomaly.severity === 'info') continue
        await raiseAlert({
          workspaceId: ctx.workspaceId,
          type: anomaly.type,
          severity: anomaly.severity,
          title: anomalyTitle(anomaly.type),
          message: anomaly.message,
          source: 'monitoring',
          metadata: { metric: anomaly.metric, observed: anomaly.observed, expected: anomaly.expected },
        })
        alertsRaised++
      }
    }

    return {
      data: {
        health: {
          database: { ok: dbHealth.ok, latencyMs: dbHealth.latencyMs, message: dbHealth.error },
          queue: { driver: queue.driver, queued: queue.queued, running: queue.running, failed: queue.failed, dead: queue.dead },
          workers,
          ai: { configured: ai.configured, provider: ai.provider },
          redis,
        },
        window: { hours: input.windowHours, from: from.toISOString(), to: new Date().toISOString() },
        metrics,
        projects: projectStats,
        anomalies,
        alertsRaised,
      },
      summary: `Monitoring: database ${dbHealth.ok ? 'healthy' : 'DOWN'}, queue ${queue.queued} queued / ${queue.running} running, ${agentRuns} agent run(s), ${anomalies.filter((a) => a.severity !== 'info').length} anomaly(ies).`,
      notes: anomalies.filter((a) => a.severity !== 'info').map((a) => a.message),
      metrics: {
        revenueCents,
        expensesCents,
        agentSuccessRate: metrics.agentSuccessRate,
        anomalies: anomalies.length,
      },
    }
  },
}

function anomalyTitle(type: string): string {
  const titles: Record<string, string> = {
    database: 'Database health issue detected',
    queue: 'Job queue requires attention',
    redis: 'Redis unavailable',
    worker_offline: 'Worker process appears offline',
    ai_provider: 'AI provider not configured',
    automation_health: 'Automation success rate degraded',
    cost_spike: 'Unusual spend detected',
    revenue_drop: 'Revenue below baseline',
    project_stalled: 'Project has produced no revenue',
    project_over_budget: 'Project over budget',
  }
  return titles[type] ?? `Anomaly detected: ${type}`
}

async function dailySeries(workspaceId: string, kind: 'revenue' | 'expenses', days: number): Promise<number[]> {
  const db = await getDb()
  const table = kind === 'revenue' ? 'revenue_transactions' : 'expenses'
  const amount = kind === 'revenue' ? 'gross_cents' : 'amount_cents'
  const result = await db.execute(sql`
    select d::date as day,
      coalesce((select sum(${sql.raw(amount)}) from ${sql.raw(table)} t
        where t.workspace_id = ${workspaceId} and t.demo = false and t.occurred_at::date = d::date), 0) as total
    from generate_series(current_date - (${days - 1})::int, current_date, interval '1 day') d
    order by day
  `)
  const rows = extractRows<{ day: string; total: string }>(result)
  return rows.map((r) => Number(r.total ?? 0))
}

export { gte }
