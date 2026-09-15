/**
 * GET   /api/agents — roster with health, configuration and recent activity.
 * PATCH /api/agents — per-agent configuration (enable, limits, schedule override).
 *
 * The agent registry is global (shared code), while runtime state is per
 * workspace: spend, runs and errors are all computed from `agent_runs`.
 */
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { getDb, agentRuns, agents as agentsTable, profiles, schedules, workspaces } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'
import type { AgentKey } from '@/lib/agents/types'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId

  const [roster, profileRow, workspaceRow] = await Promise.all([
    db
      .select({
        id: agentsTable.id,
        key: agentsTable.key,
        name: agentsTable.name,
        description: agentsTable.description,
        category: agentsTable.category,
        enabled: agentsTable.enabled,
        status: agentsTable.status,
        modelTier: agentsTable.modelTier,
        maxDailyRuns: agentsTable.maxDailyRuns,
        maxCostCentsPerRun: agentsTable.maxCostCentsPerRun,
        timeoutSeconds: agentsTable.timeoutSeconds,
        avgDurationMs: agentsTable.avgDurationMs,
        successCount: agentsTable.successCount,
        failureCount: agentsTable.failureCount,
        lastRunAt: agentsTable.lastRunAt,
        lastHeartbeatAt: agentsTable.lastHeartbeatAt,
        lastError: agentsTable.lastError,
      })
      .from(agentsTable)
      .orderBy(agentsTable.key),
    db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1),
    db.select({ demoMode: workspaces.demoMode, planKey: workspaces.planKey }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
  ])

  const runStats = await db
    .select({
      agentKey: agentRuns.agentKey,
      totalRuns: sql<string>`count(*)::text`,
      successRuns: sql<string>`count(*) filter (where ${agentRuns.status} = 'succeeded')::text`,
      failedRuns: sql<string>`count(*) filter (where ${agentRuns.status} = 'failed')::text`,
      spendCents: sql<string>`coalesce(sum(${agentRuns.costCents}), 0)::text`,
      avgDurationMs: sql<string>`coalesce(round(avg(${agentRuns.durationMs})), 0)::text`,
      last24hRuns: sql<string>`count(*) filter (where ${agentRuns.startedAt} > now() - interval '24 hours')::text`,
      tokensUsed: sql<string>`coalesce(sum(${agentRuns.tokensUsed}), 0)::text`,
    })
    .from(agentRuns)
    .where(eq(agentRuns.workspaceId, workspaceId))
    .groupBy(agentRuns.agentKey)

  const memoryCounts = await db
    .select({ agentKey: sql<string>`agent_key`, value: sql<string>`count(*)::text` })
    .from(sql`agent_memory`)
    .where(sql`workspace_id = ${workspaceId}`)
    .groupBy(sql`agent_key`)

  const scheduleRows = await db
    .select({ key: schedules.key, name: schedules.name, cron: schedules.cron, enabled: schedules.enabled, nextRunAt: schedules.nextRunAt, lastStatus: schedules.lastStatus, workspaceId: schedules.workspaceId })
    .from(schedules)
    .where(sql`(${schedules.workspaceId} = ${workspaceId} or ${schedules.workspaceId} is null)`)

  const statsByKey = new Map(runStats.map((row) => [row.agentKey, row]))
  const memoryByKey = new Map(memoryCounts.map((row) => [row.agentKey, Number(row.value)]))
  const scheduleByKey = new Map(scheduleRows.map((row) => [row.key, row]))

  const agents = roster.map((agent) => {
    const stats = statsByKey.get(agent.key)
    const schedule = scheduleByKey.get(`${agent.key}`) ?? scheduleByKey.get(scheduleKeyForAgent(agent.key as AgentKey)) ?? null
    const stale = agent.lastHeartbeatAt ? Date.now() - new Date(agent.lastHeartbeatAt).getTime() > 30 * 60_000 : true
    return {
      ...agent,
      totalRuns: Number(stats?.totalRuns ?? 0),
      successRuns: Number(stats?.successRuns ?? 0),
      failedRuns: Number(stats?.failedRuns ?? 0),
      last24hRuns: Number(stats?.last24hRuns ?? 0),
      spendCents: Number(stats?.spendCents ?? 0),
      tokensUsed: Number(stats?.tokensUsed ?? 0),
      measuredAvgDurationMs: Number(stats?.avgDurationMs ?? agent.avgDurationMs),
      memoryCount: memoryByKey.get(agent.key) ?? 0,
      schedule,
      health: !agent.enabled ? 'disabled' : agent.status === 'error' ? 'error' : stale ? 'idle' : 'healthy',
    }
  })

  return ok({
    agents,
    summary: {
      total: agents.length,
      enabled: agents.filter((agent) => agent.enabled).length,
      running: agents.filter((agent) => agent.status === 'running').length,
      errored: agents.filter((agent) => agent.health === 'error').length,
      totalRuns: agents.reduce((sum, agent) => sum + agent.totalRuns, 0),
      totalSpendCents: agents.reduce((sum, agent) => sum + agent.spendCents, 0),
    },
    automationLevel: profileRow[0]?.automationLevel ?? 'approval_required',
    demoMode: workspaceRow[0]?.demoMode ?? false,
    planKey: workspaceRow[0]?.planKey ?? 'free',
  })
})

const patchSchema = z.object({
  key: z.string().min(2).max(40),
  enabled: z.boolean().optional(),
  maxCostCentsPerRun: z.number().int().min(0).max(10_000).optional(),
  maxDailyRuns: z.number().int().min(0).max(10_000).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).optional(),
  modelTier: z.enum(['cheap', 'standard', 'reasoning']).optional(),
  scheduleCron: z.string().max(80).nullable().optional(),
  scheduleEnabled: z.boolean().optional(),
})

export const PATCH = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, patchSchema)
  const { key, scheduleCron, scheduleEnabled, ...patch } = input

  const known = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.key, key)).limit(1)
  if (!known[0]) throw new ApiError('not_found', `No agent registered with key "${key}".`)

  const rows = await db.update(agentsTable).set({ ...patch, updatedAt: new Date() }).where(eq(agentsTable.key, key)).returning()

  if (scheduleCron !== undefined || scheduleEnabled !== undefined) {
    const scheduleKey = scheduleKeyForAgent(key as AgentKey)
    const existing = await db.select({ id: schedules.id }).from(schedules).where(and(eq(schedules.workspaceId, workspaceId), eq(schedules.key, scheduleKey))).limit(1)
    if (existing[0]) {
      await db
        .update(schedules)
        .set({
          ...(scheduleCron ? { cron: scheduleCron } : {}),
          ...(scheduleEnabled !== undefined ? { enabled: scheduleEnabled } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schedules.id, existing[0].id))
    } else if (scheduleCron) {
      await db.insert(schedules).values({
        workspaceId,
        key: scheduleKey,
        name: `${key} agent (custom schedule)`,
        jobName: `agent.${key}`,
        payload: { workspaceId, useAi: true },
        cron: scheduleCron,
        enabled: scheduleEnabled ?? true,
        timezone: 'UTC',
        system: false,
      })
    }
  }

  return ok({ agent: rows[0] })
})

/** Schedules seeded for agents use the `agent-<key>` naming convention. */
function scheduleKeyForAgent(key: AgentKey): string {
  return `agent-${key}`
}
