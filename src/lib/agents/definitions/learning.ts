/**
 * AGENT 9 — LEARNING AGENT
 *
 * Closes the loop: it analyses *realised* outcomes (verified revenue, recorded
 * expenses, actual conversion rates, failure reasons) and produces bounded,
 * explainable adjustments that change how future opportunities are scored.
 *
 * Memory is intentionally bounded: insights are stored as short summaries with
 * retention, and only the most recent adjustments are applied. There is no
 * unbounded conversation history — this is a summarised memory, not a transcript.
 */
import { z } from 'zod'
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { getDb, agentMemory, agentRuns, analyticsEvents, expenses, memorySummaries, opportunities, opportunityScores, projects, revenueTransactions, tasks, extractRows } from '../../db'
import { DEFAULT_WEIGHTS, SCORE_DIMENSIONS, type LearningAdjustments, type ScoreWeights } from '../scoring'
import { learningPrompt } from '../../ai/prompts'
import { learningDigestSchema } from '../../ai/schemas'
import { notify } from '../../notifications'
import { truncate } from '../../utils'
import type { AgentDefinition, AgentOutput } from '../types'

export const learningInputSchema = z.object({
  windowDays: z.number().int().min(7).max(365).default(90),
  useAi: z.boolean().default(true),
  applyAdjustments: z.boolean().default(true),
  retentionDays: z.number().int().min(7).max(730).default(180),
})
export type LearningInput = z.infer<typeof learningInputSchema>

export type LearningOutput = {
  window: { days: number; from: string; to: string }
  sampleSize: { projects: number; opportunities: number; revenueTransactions: number; agentRuns: number }
  categoryPerformance: { category: string; projects: number; revenueCents: number; costCents: number; profitCents: number; averageScore: number }[]
  channelPerformance: { channel: string; conversions: number; visitors: number; conversionRate: number; spendCents: number }[]
  failurePatterns: { reason: string; count: number }[]
  averages: { timeToFirstRevenueDays: number | null; conversionRate: number | null; costPerProjectCents: number | null; scoreAccuracyDelta: number | null }
  adjustments: LearningAdjustments
  recommendations: string[]
  memoryPruned: number
}

export const learningAgent: AgentDefinition<LearningInput, LearningOutput> = {
  key: 'learning',
  name: 'Learning Agent',
  description: 'Analyses realised results and improves future opportunity scoring with bounded, explainable weight adjustments.',
  category: 'operations',
  policyAction: 'system_maintenance',
  estimatedCostCents: 30,
  modelTier: 'reasoning',
  timeoutSeconds: 300,
  cadenceMinutes: 10_080, // weekly
  requiresWorkspace: true,
  inputSchema: learningInputSchema,

  async run(input, ctx): Promise<AgentOutput<LearningOutput>> {
    const db = await getDb()
    const from = new Date(Date.now() - input.windowDays * 86_400_000)

    /* ------------------------------------------------ realised performance */
    const categoryRows = await db.execute(sql`
      with project_fin as (
        select
          p.id,
          p.opportunity_id,
          coalesce((select sum(r.gross_cents) from revenue_transactions r
              where r.project_id = p.id and r.status = 'confirmed' and r.demo = p.demo), 0) as revenue,
          coalesce((select sum(e.amount_cents) from expenses e where e.project_id = p.id and e.demo = p.demo), 0) as cost
        from projects p
        where p.workspace_id = ${ctx.workspaceId} and p.demo = false and p.created_at >= ${from.toISOString()}
      )
      select
        coalesce(o.category, 'unknown') as category,
        count(distinct f.id)::text as projects,
        coalesce(sum(f.revenue), 0)::text as revenue,
        coalesce(sum(f.cost), 0)::text as cost,
        coalesce(avg(s.final_score::numeric), 0)::text as average_score
      from project_fin f
      left join opportunities o on o.id = f.opportunity_id
      left join opportunity_scores s on s.opportunity_id = f.opportunity_id
      group by coalesce(o.category, 'unknown')
    `)

    const categoryPerformance = extractRows<{ category: string; projects: string; revenue: string; cost: string; average_score: string }>(categoryRows).map((row) => {
      const revenueCents = Number(row.revenue)
      const costCents = Number(row.cost)
      return {
        category: row.category,
        projects: Number(row.projects),
        revenueCents,
        costCents,
        profitCents: revenueCents - costCents,
        averageScore: Math.round(Number(row.average_score) * 100) / 100,
      }
    })

    const channelRows = await db.execute(sql`
      select
        coalesce(properties->>'channel', name, 'unattributed') as channel,
        count(*) filter (where type = 'page_view')::text as visitors,
        count(*) filter (where type = 'conversion')::text as conversions,
        coalesce(sum(value), 0)::text as spend
      from analytics_events
      where workspace_id = ${ctx.workspaceId} and occurred_at >= ${from.toISOString()}
      group by 1 order by conversions desc limit 12
    `)
    const channelPerformance = extractRows<{ channel: string; visitors: string; conversions: string; spend: string }>(channelRows).map((row) => {
      const visitors = Number(row.visitors)
      const conversions = Number(row.conversions)
      return {
        channel: row.channel,
        visitors,
        conversions,
        conversionRate: visitors > 0 ? Math.round((conversions / visitors) * 10000) / 100 : 0,
        spendCents: Math.round(Number(row.spend) * 100),
      }
    })

    const failureRows = await db.execute(sql`
      select coalesce(last_error, 'unspecified') as reason, count(*)::text as count
      from jobs
      where workspace_id = ${ctx.workspaceId} and status in ('failed','dead') and created_at >= ${from.toISOString()}
      group by 1 order by count(*) desc limit 15
    `)
    const failurePatterns = extractRows<{ reason: string; count: string }>(failureRows).map((row) => ({
      reason: truncate(row.reason, 160),
      count: Number(row.count),
    }))

    const timeToRevenueRows = await db.execute(sql`
      select avg(extract(epoch from (r.first_at - p.launched_at)) / 86400)::text as days
      from projects p
      join (select project_id, min(occurred_at) as first_at from revenue_transactions where status = 'confirmed' group by project_id) r
        on r.project_id = p.id
      where p.workspace_id = ${ctx.workspaceId} and p.launched_at is not null
    `)
    const timeToFirstRevenueDays = extractRows<{ days: string | null }>(timeToRevenueRows)[0]?.days

    const conversionRow = await db.execute(sql`
      select
        count(*) filter (where type = 'page_view')::text as visitors,
        count(*) filter (where type = 'conversion')::text as conversions
      from analytics_events where workspace_id = ${ctx.workspaceId} and demo = false and occurred_at >= ${from.toISOString()}
    `)
    const conversion = extractRows<{ visitors: string; conversions: string }>(conversionRow)[0]
    const visitors = Number(conversion?.visitors ?? 0)
    const conversions = Number(conversion?.conversions ?? 0)

    const costRow = await db.execute(sql`
      select
        coalesce((select sum(amount_cents) from expenses where workspace_id = ${ctx.workspaceId} and demo = false and occurred_at >= ${from.toISOString()}), 0)::text as cost,
        coalesce((select count(*) from projects where workspace_id = ${ctx.workspaceId} and demo = false and created_at >= ${from.toISOString()}), 0)::text as projects
    `)
    const costStats = extractRows<{ cost: string; projects: string }>(costRow)[0]

    /* --------------------------------------------- score accuracy (feedback) */
    // Compare the score given at approval time with realised profit: a
    // consistently optimistic model tells us to shift weight onto cost/risk.
    const accuracyRows = await db.execute(sql`
      select s.final_score::numeric as score, p.profit_cents as profit
      from projects p
      join opportunity_scores s on s.opportunity_id = p.opportunity_id
      where p.workspace_id = ${ctx.workspaceId}
        and p.demo = false
        and p.status in ('LAUNCHED','MONITORING','OPTIMIZING','COMPLETED')
        and p.profit_cents is not null
    `)
    const accuracy = extractRows<{ score: string; profit: number }>(accuracyRows)
    let scoreAccuracyDelta: number | null = null
    if (accuracy.length >= 3) {
      // Weighted correlation between predicted score and realised profit.
      const meanScore = accuracy.reduce((a, b) => a + Number(b.score), 0) / accuracy.length
      const meanProfit = accuracy.reduce((a, b) => a + Number(b.profit), 0) / accuracy.length
      let cov = 0
      let varScore = 0
      let varProfit = 0
      for (const row of accuracy) {
        const ds = Number(row.score) - meanScore
        const dp = Number(row.profit) - meanProfit
        cov += ds * dp
        varScore += ds * ds
        varProfit += dp * dp
      }
      const correlation = varScore > 0 && varProfit > 0 ? cov / Math.sqrt(varScore * varProfit) : 0
      scoreAccuracyDelta = Math.round(correlation * 100) / 100
    }

    /* ------------------------------------------------------- adjustments */
    const weights: Partial<ScoreWeights> = {}
    const notes: string[] = []
    const categoryBias: Record<string, number> = {}

    for (const category of categoryPerformance) {
      if (category.projects < 2) continue
      const profitPerProject = category.profitCents / category.projects
      if (profitPerProject > 0) {
        categoryBias[category.category] = Math.min(6, Math.round((profitPerProject / 5000) * 2 * 10) / 10)
        notes.push(`"${category.category}" produced positive profit per project — scoring bias +${categoryBias[category.category]}.`)
      } else if (profitPerProject < 0) {
        categoryBias[category.category] = Math.max(-8, Math.round((profitPerProject / 5000) * 2 * 10) / 10)
        notes.push(`"${category.category}" lost money — scoring bias ${categoryBias[category.category]}.`)
      }
    }

    if (timeToFirstRevenueDays && Number(timeToFirstRevenueDays) > 45) {
      weights.timeToRevenue = 0.03
      notes.push(`Average time to first revenue is ${Math.round(Number(timeToFirstRevenueDays))} days — weighting speed-to-revenue higher.`)
    }
    if (scoreAccuracyDelta !== null && scoreAccuracyDelta < 0.2) {
      weights.demand = -0.02
      weights.risk = 0.03
      weights.operatingCost = 0.02
      notes.push(`Predicted scores correlate weakly with realised profit (r=${scoreAccuracyDelta}) — reducing optimism on demand and weighting risk/cost higher.`)
    } else if (scoreAccuracyDelta !== null && scoreAccuracyDelta > 0.6) {
      weights.automationPotential = 0.02
      notes.push(`Predicted scores track realised profit well (r=${scoreAccuracyDelta}) — reinforcing the current weighting.`)
    }
    if (failurePatterns.length > 0 && failurePatterns.some((f) => /timeout/i.test(f.reason))) {
      weights.difficulty = -0.01
      notes.push('Repeated timeouts suggest under-estimated execution difficulty.')
    }

    // Category evidence without any realised revenue yet: note it, change nothing.
    if (categoryPerformance.every((c) => c.revenueCents === 0)) {
      notes.push('No realised revenue in this window — scoring weights are unchanged. Learning requires real outcomes, not projections.')
    }

    let adjustments: LearningAdjustments = { weights, categoryBias, notes }

    let recommendations: string[] = []
    let summary = buildSummary(categoryPerformance, channelPerformance, failurePatterns, timeToFirstRevenueDays)

    /* ------------------------------------------------------ AI enrichment */
    let costCents = 0
    if (input.useAi && ctx.ai.available && (categoryPerformance.length > 0 || failurePatterns.length > 0)) {
      const budget = await ctx.reserveSpend(12, 'Learning analysis', undefined)
      if ('blocked' in budget) {
        ctx.logger.warn('AI learning analysis skipped', { reason: budget.blocked })
      } else {
        try {
          const prompt = learningPrompt({
            currency: 'USD',
            categories: categoryPerformance,
            channels: channelPerformance.map((c) => ({ channel: c.channel, conversions: c.conversions, spendCents: c.spendCents })),
            failures: failurePatterns,
            averageTimeToRevenueDays: timeToFirstRevenueDays ? Number(timeToFirstRevenueDays) : null,
            averageConversionRate: visitors > 0 ? (conversions / visitors) * 100 : null,
          })
          const digest = await ctx.ai.generateJson(
            { system: prompt.system, prompt: prompt.prompt, tier: 'reasoning', maxTokens: 1800, schemaName: 'learning', workspaceId: ctx.workspaceId, agentKey: 'learning' },
            learningDigestSchema,
          )
          costCents = 12

          // Clamp AI weight deltas so a model cannot destabilise scoring.
          const clampedWeights: Partial<ScoreWeights> = { ...weights }
          for (const [dimension, delta] of Object.entries(digest.weightAdjustments ?? {})) {
            if (!SCORE_DIMENSIONS.includes(dimension as never)) continue
            const base = clampedWeights[dimension as keyof ScoreWeights] ?? 0
            clampedWeights[dimension as keyof ScoreWeights] = Math.max(-0.1, Math.min(0.1, base + Number(delta) * 0.5))
          }
          for (const category of digest.profitableCategories ?? []) {
            categoryBias[category.category] = Math.max(-8, Math.min(8, (categoryBias[category.category] ?? 0) + 2))
          }
          for (const category of digest.unprofitableCategories ?? []) {
            categoryBias[category.category] = Math.max(-8, Math.min(8, (categoryBias[category.category] ?? 0) - 2))
          }
          adjustments = { weights: clampedWeights, categoryBias, notes: [...notes, ...(digest.summary ? [digest.summary] : [])] }
          summary = digest.summary || summary
          recommendations = (digest.recommendations ?? []).slice(0, 6)
        } catch (error) {
          ctx.logger.warn('AI learning analysis failed; deterministic insights retained', {
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    if (recommendations.length === 0) {
      recommendations = buildRecommendations(categoryPerformance, channelPerformance, timeToFirstRevenueDays)
    }

    /* --------------------------------------------------------- persistence */
    let memoryPruned = 0
    if (input.applyAdjustments) {
      await db.insert(agentMemory).values({
        workspaceId: ctx.workspaceId,
        agentKey: 'learning',
        kind: 'pattern',
        key: `weights:${new Date().toISOString().slice(0, 10)}`,
        content: summary,
        importance: 4,
        data: adjustments as unknown as Record<string, unknown>,
        expiresAt: new Date(Date.now() + input.retentionDays * 86_400_000),
      })
    }

    const sampleSize = {
      projects: categoryPerformance.reduce((a, b) => a + b.projects, 0),
      opportunities: Number(
        (
          await db
            .select({ value: sql<string>`count(*)::text` })
            .from(opportunityScores)
            .innerJoin(opportunities, eq(opportunities.id, opportunityScores.opportunityId))
            .where(and(eq(opportunityScores.workspaceId, ctx.workspaceId), eq(opportunities.demo, false), gte(opportunityScores.createdAt, from)))
        )[0]?.value ?? 0,
      ),
      revenueTransactions: Number(
        (
          await db
            .select({ value: sql<string>`count(*)::text` })
            .from(revenueTransactions)
            .where(and(eq(revenueTransactions.workspaceId, ctx.workspaceId), eq(revenueTransactions.demo, false), gte(revenueTransactions.occurredAt, from)))
        )[0]?.value ?? 0,
      ),
      agentRuns: Number(
        (
          await db
            .select({ value: sql<string>`count(*)::text` })
            .from(agentRuns)
            .where(and(eq(agentRuns.workspaceId, ctx.workspaceId), gte(agentRuns.startedAt, from)))
        )[0]?.value ?? 0,
      ),
    }

    await db.insert(memorySummaries).values({
      workspaceId: ctx.workspaceId,
      scope: 'workspace',
      scopeKey: null,
      periodStart: from,
      periodEnd: new Date(),
      summary,
      metrics: {
        categoryPerformance,
        averages: {
          timeToFirstRevenueDays: timeToFirstRevenueDays ? Number(timeToFirstRevenueDays) : null,
          conversionRate: visitors > 0 ? Math.round((conversions / visitors) * 10000) / 100 : null,
          costPerProjectCents: Number(costStats?.projects ?? 0) > 0 ? Math.round(Number(costStats?.cost ?? 0) / Number(costStats!.projects)) : null,
          scoreAccuracyDelta,
        },
      } as Record<string, unknown>,
    })

    memoryPruned = await pruneMemory(ctx.workspaceId, input.retentionDays)

    if (recommendations.length > 0) {
      await notify({
        workspaceId: ctx.workspaceId,
        type: 'report_ready',
        severity: 'info',
        title: 'Weekly learning report is ready',
        body: recommendations[0] ?? summary,
        link: '/dashboard/insights',
        dedupeKey: `learning:${new Date().toISOString().slice(0, 10)}`,
      })
    }

    return {
      data: {
        window: { days: input.windowDays, from: from.toISOString(), to: new Date().toISOString() },
        sampleSize,
        categoryPerformance,
        channelPerformance,
        failurePatterns,
        averages: {
          timeToFirstRevenueDays: timeToFirstRevenueDays ? Math.round(Number(timeToFirstRevenueDays)) : null,
          conversionRate: visitors > 0 ? Math.round((conversions / visitors) * 10000) / 100 : null,
          costPerProjectCents: Number(costStats?.projects ?? 0) > 0 ? Math.round(Number(costStats?.cost ?? 0) / Number(costStats!.projects)) : null,
          scoreAccuracyDelta,
        },
        adjustments,
        recommendations,
        memoryPruned,
      },
      summary,
      notes: [...notes, ...recommendations.slice(0, 3)],
      costCents,
      provider: costCents > 0 ? ctx.ai.provider : undefined,
      metrics: {
        projects: sampleSize.projects,
        categories: categoryPerformance.length,
        adjustments: Object.keys(weights).length,
        scoreAccuracyDelta: scoreAccuracyDelta ?? 0,
      },
    }
  },
}

function buildSummary(
  categories: { category: string; projects: number; profitCents: number }[],
  channels: { channel: string; conversionRate: number }[],
  failures: { reason: string; count: number }[],
  timeToRevenue: string | null,
): string {
  if (categories.length === 0) {
    return 'No completed projects yet, so there is nothing to learn from. Scoring weights remain at their defaults until real outcomes exist.'
  }
  const profitable = categories.filter((c) => c.profitCents > 0).sort((a, b) => b.profitCents - a.profitCents)
  const losing = categories.filter((c) => c.profitCents < 0).sort((a, b) => a.profitCents - b.profitCents)
  const parts: string[] = []
  parts.push(`${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} with activity across ${categories.reduce((a, b) => a + b.projects, 0)} project(s).`)
  if (profitable.length) parts.push(`Most profitable: ${profitable[0]!.category} (${(profitable[0]!.profitCents / 100).toFixed(2)} net).`)
  if (losing.length) parts.push(`Least profitable: ${losing[0]!.category} (${(losing[0]!.profitCents / 100).toFixed(2)} net).`)
  if (channels.length) parts.push(`Best channel by conversion rate: ${channels.slice().sort((a, b) => b.conversionRate - a.conversionRate)[0]!.channel}.`)
  if (failures.length) parts.push(`Most common failure: ${truncate(failures[0]!.reason, 90)}.`)
  if (timeToRevenue) parts.push(`Average time to first revenue: ${Math.round(Number(timeToRevenue))} days.`)
  return parts.join(' ')
}

function buildRecommendations(
  categories: { category: string; profitCents: number; projects: number }[],
  channels: { channel: string; conversionRate: number; visitors: number }[],
  timeToRevenue: string | null,
): string[] {
  const recommendations: string[] = []
  const best = categories.filter((c) => c.profitCents > 0).sort((a, b) => b.profitCents - a.profitCents)[0]
  if (best) recommendations.push(`Prioritise "${best.category}" — it is the only category with positive realised profit.`)
  const worst = categories.filter((c) => c.profitCents < 0)[0]
  if (worst) recommendations.push(`Stop opening new "${worst.category}" projects until the cost structure improves.`)
  const bestChannel = channels.filter((c) => c.visitors >= 50).sort((a, b) => b.conversionRate - a.conversionRate)[0]
  if (bestChannel) recommendations.push(`Concentrate acquisition on "${bestChannel.channel}" (${bestChannel.conversionRate}% conversion).`)
  if (timeToRevenue && Number(timeToRevenue) > 60) {
    recommendations.push('Time to first revenue is long — favour opportunities with a pre-sellable offer.')
  }
  if (recommendations.length === 0) recommendations.push('Collect more realised outcomes before changing the strategy.')
  return recommendations.slice(0, 5)
}

/**
 * Retention policy: keep memory bounded. Insights expire, low-importance rows
 * are pruned, and old summaries are collapsed to their most recent N.
 */
export async function pruneMemory(workspaceId: string, retentionDays: number): Promise<number> {
  const db = await getDb()
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
  const expired = await db
    .delete(agentMemory)
    .where(and(eq(agentMemory.workspaceId, workspaceId), lt(agentMemory.createdAt, cutoff), lt(agentMemory.importance, 4)))
    .returning({ id: agentMemory.id })

  const oldSummaries = await db
    .select({ id: memorySummaries.id })
    .from(memorySummaries)
    .where(and(eq(memorySummaries.workspaceId, workspaceId), lt(memorySummaries.createdAt, cutoff)))
    .orderBy(desc(memorySummaries.createdAt))
  if (oldSummaries.length > 26) {
    const toDelete = oldSummaries.slice(26).map((row) => row.id)
    await db.delete(memorySummaries).where(inArray(memorySummaries.id, toDelete))
    return expired.length + toDelete.length
  }
  return expired.length
}

/** Current scoring weights including learned adjustments (for the UI). */
export async function effectiveWeights(workspaceId: string): Promise<ScoreWeights> {
  const db = await getDb()
  const rows = await db
    .select({ data: agentMemory.data })
    .from(agentMemory)
    .where(and(eq(agentMemory.workspaceId, workspaceId), eq(agentMemory.agentKey, 'learning'), eq(agentMemory.kind, 'pattern')))
    .orderBy(desc(agentMemory.createdAt))
    .limit(1)
  const adjustments = (rows[0]?.data ?? {}) as LearningAdjustments
  const weights: ScoreWeights = { ...DEFAULT_WEIGHTS }
  for (const [dimension, delta] of Object.entries(adjustments.weights ?? {})) {
    if (SCORE_DIMENSIONS.includes(dimension as never) && typeof delta === 'number') {
      weights[dimension as keyof ScoreWeights] = Math.max(0.01, weights[dimension as keyof ScoreWeights] + delta)
    }
  }
  const total = Object.values(weights).reduce((a, b) => a + b, 0)
  for (const key of SCORE_DIMENSIONS) weights[key] = weights[key] / total
  return weights
}

export { tasks, projects, expenses, analyticsEvents }
