/**
 * AGENT 3 — OPPORTUNITY ANALYSIS AGENT
 *
 * Scores every opportunity across the ten required dimensions, stores the
 * breakdown plus a written "why this score?" rationale for each dimension, and
 * raises the strategy job for anything above the user's threshold.
 *
 * The deterministic engine always runs. When an AI provider is configured the
 * model's assessment is blended in (60/40) — and if the model is unavailable or
 * returns invalid data, the deterministic result stands. Analysis therefore
 * never silently degrades to nothing.
 */
import { z } from 'zod'
import { and, desc, eq, inArray, isNull, gte, sql } from 'drizzle-orm'
import { getDb, opportunities, opportunityScores, profiles, sources } from '../../db'
import { SCORE_DIMENSIONS, blendScores, scoreOpportunity, scoringSanityCheck, type ScoreResult } from '../scoring'
import { analysisPrompt } from '../../ai/prompts'
import { analysisSchema } from '../../ai/schemas'
import { notify } from '../../notifications'
import type { AgentDefinition, AgentContext, AgentOutput } from '../types'

export const analysisInputSchema = z.object({
  opportunityIds: z.array(z.string().uuid()).optional(),
  batchSize: z.number().int().min(1).max(50).default(15),
  useAi: z.boolean().default(true),
  rescore: z.boolean().default(false),
  autoStrategy: z.boolean().default(true),
})
export type AnalysisInput = z.infer<typeof analysisInputSchema>

export type AnalysisOutput = {
  analyzed: {
    opportunityId: string
    title: string
    finalScore: number
    verdict: string
    confidence: number
    engine: string
    topDimension: string
    weakestDimension: string
  }[]
  aboveThreshold: string[]
  strategyQueued: number
  averageScore: number
  attention: string[]
}

export const analysisAgent: AgentDefinition<AnalysisInput, AnalysisOutput> = {
  key: 'analysis',
  name: 'Opportunity Analysis Agent',
  description: 'Scores opportunities on ten dimensions with an explicit, user-visible rationale.',
  category: 'analysis',
  policyAction: 'analyze_opportunity',
  estimatedCostCents: 40,
  modelTier: 'standard',
  timeoutSeconds: 300,
  cadenceMinutes: 60,
  requiresWorkspace: true,
  inputSchema: analysisInputSchema,

  async run(input, ctx): Promise<AgentOutput<AnalysisOutput>> {
    const db = await getDb()
    const profile = (await db.select().from(profiles).where(eq(profiles.workspaceId, ctx.workspaceId)).limit(1))[0]
    const threshold = profile?.scoreThreshold ?? 70

    const candidates = await db
      .select()
      .from(opportunities)
      .where(
        input.opportunityIds?.length
          ? and(eq(opportunities.workspaceId, ctx.workspaceId), inArray(opportunities.id, input.opportunityIds))
          : input.rescore
            ? and(eq(opportunities.workspaceId, ctx.workspaceId), isNull(opportunities.deletedAt), inArray(opportunities.status, ['cleaned', 'scored']))
            : and(
                eq(opportunities.workspaceId, ctx.workspaceId),
                isNull(opportunities.deletedAt),
                inArray(opportunities.status, ['cleaned', 'discovered']),
              ),
      )
      .orderBy(desc(opportunities.discoveredAt))
      .limit(input.batchSize)

    if (candidates.length === 0) {
      return {
        data: { analyzed: [], aboveThreshold: [], strategyQueued: 0, averageScore: 0, attention: [] },
        summary: 'No opportunities awaiting analysis. Run a research scan first.',
      }
    }

    const sourceRows = await db.select().from(sources).where(eq(sources.workspaceId, ctx.workspaceId))
    const reliabilityByName = new Map(sourceRows.map((s) => [s.name, Number(s.reliabilityScore)]))

    const analyzed: AnalysisOutput['analyzed'] = []
    const aboveThreshold: string[] = []
    const notes: string[] = []
    let aiCostCents = 0
    let aiUsed = false

    for (const opportunity of candidates) {
      const base = scoreOpportunity({
        title: opportunity.title,
        description: opportunity.description,
        category: opportunity.category,
        sourceName: opportunity.sourceName,
        sourceReliability: reliabilityByName.get(opportunity.sourceName) ?? 70,
        url: opportunity.url,
        region: opportunity.region,
        profile: profile
          ? {
              currency: profile.currency,
              country: profile.country,
              riskTolerance: profile.riskTolerance,
              skills: profile.skills,
              industries: profile.industries,
              monetizationPreferences: profile.monetizationPreferences,
              businessModels: profile.businessModels,
              dailyBudgetCents: profile.dailyBudgetCents,
              monthlyBudgetCents: profile.monthlyBudgetCents,
              maxOperatingCostCentsMonth: profile.maxOperatingCostCentsMonth,
              minTimeToRevenueDays: profile.minTimeToRevenueDays,
              scoreThreshold: profile.scoreThreshold,
            }
          : undefined,
        learning: ctx.learning,
      })

      let result: ScoreResult = base
      let provider: string | null = null
      let model: string | null = null

      if (input.useAi && ctx.ai.available) {
        const enriched = await aiAssess(ctx, opportunity, base, profile)
        if (enriched) {
          result = enriched.result
          provider = enriched.provider
          model = enriched.model
          aiCostCents += enriched.costCents
          aiUsed = true
        }
      }

      const existingVersions = await db
        .select({ version: opportunityScores.version })
        .from(opportunityScores)
        .where(eq(opportunityScores.opportunityId, opportunity.id))
        .orderBy(desc(opportunityScores.version))
        .limit(1)

      await db.insert(opportunityScores).values({
        opportunityId: opportunity.id,
        workspaceId: ctx.workspaceId,
        demand: result.scores.demand,
        competition: result.scores.competition,
        monetization: result.scores.monetization,
        startupCost: result.scores.startupCost,
        operatingCost: result.scores.operatingCost,
        automationPotential: result.scores.automationPotential,
        scalability: result.scores.scalability,
        timeToRevenue: result.scores.timeToRevenue,
        difficulty: result.scores.difficulty,
        risk: result.scores.risk,
        finalScore: result.finalScore.toFixed(2),
        confidence: result.confidence,
        verdict: result.verdict,
        rationale: { ...result.rationale, ...(result.appliedAdjustments.length ? { adjustments: result.appliedAdjustments.join(' ') } : {}) },
        summary: result.summary,
        weights: result.weights as unknown as Record<string, number>,
        engine: provider ? 'heuristic+ai' : 'heuristic',
        provider,
        model,
        version: (existingVersions[0]?.version ?? 0) + 1,
      })

      await db
        .update(opportunities)
        .set({ status: 'scored', updatedAt: new Date() })
        .where(eq(opportunities.id, opportunity.id))

      const best = SCORE_DIMENSIONS.slice().sort((a, b) => result.scores[b] - result.scores[a])
      analyzed.push({
        opportunityId: opportunity.id,
        title: opportunity.title,
        finalScore: result.finalScore,
        verdict: result.verdict,
        confidence: result.confidence,
        engine: provider ? `heuristic+${provider}` : 'heuristic',
        topDimension: best[0]!,
        weakestDimension: best[best.length - 1]!,
      })

      if (result.finalScore >= threshold) {
        aboveThreshold.push(opportunity.id)
        notes.push(`"${opportunity.title}" scored ${result.finalScore}/100 (≥ threshold ${threshold}).`)
      }
    }

    const sanity = scoringSanityCheck(analyzed.map((a) => a.finalScore))
    const attention = sanity.ok ? [] : [sanity.message!]

    let strategyQueued = 0
    if (input.autoStrategy && aboveThreshold.length > 0) {
      const { enqueue } = await import('../../queue')
      const grouped = aboveThreshold.slice(0, 10)
      for (const opportunityId of grouped) {
        await enqueue(
          'agent.strategy',
          { opportunityIds: [opportunityId], useAi: true },
          { queue: 'analysis', priority: 3, workspaceId: ctx.workspaceId, dedupeKey: `strategy:${opportunityId}` },
        )
        strategyQueued++
      }
      // Continue with a broader batch so all high scorers get strategies.
      if (aboveThreshold.length > grouped.length) {
        await enqueue(
          'agent.strategy',
          { opportunityIds: aboveThreshold.slice(10), useAi: true },
          { queue: 'analysis', priority: 4, workspaceId: ctx.workspaceId },
        )
      }
    }

    if (aboveThreshold.length > 0) {
      const top = analyzed.filter((a) => aboveThreshold.includes(a.opportunityId)).sort((a, b) => b.finalScore - a.finalScore)[0]!
      await notify({
        workspaceId: ctx.workspaceId,
        type: 'high_score_opportunity',
        severity: 'success',
        title: `${aboveThreshold.length} high-scoring opportunit${aboveThreshold.length === 1 ? 'y' : 'ies'} found`,
        body: `Top: "${top.title}" scored ${top.finalScore}/100.`,
        link: '/dashboard/opportunities',
        dedupeKey: `analysis:${new Date().toISOString().slice(0, 13)}`,
      })
    }

    const averageScore = analyzed.length ? Math.round((analyzed.reduce((a, b) => a + b.finalScore, 0) / analyzed.length) * 100) / 100 : 0

    return {
      data: { analyzed, aboveThreshold, strategyQueued, averageScore, attention },
      summary: `Analyzed ${analyzed.length} opportunit${analyzed.length === 1 ? 'y' : 'ies'} (average ${averageScore}/100); ${aboveThreshold.length} above the ${threshold} threshold.`,
      notes,
      warnings: attention,
      costCents: aiCostCents,
      provider: aiUsed ? ctx.ai.provider : undefined,
      model: aiUsed ? 'analysis' : undefined,
      metrics: { analyzed: analyzed.length, aboveThreshold: aboveThreshold.length, averageScore, aiUsed: aiUsed ? 1 : 0 },
    }
  },

  async memory(output, _input, ctx) {
    const db = await getDb()
    await db.insert(agentMemoryTable).values({
      workspaceId: ctx.workspaceId,
      agentKey: 'analysis',
      kind: 'summary',
      key: `analysis:${new Date().toISOString().slice(0, 13)}`,
      content: `Analyzed ${output.data.analyzed.length} opportunities, average score ${output.data.averageScore}/100, ${output.data.aboveThreshold.length} above threshold.`,
      importance: 3,
      data: { analyzed: output.data.analyzed.slice(0, 20) },
      expiresAt: new Date(Date.now() + 60 * 86_400_000),
    })
  },
}

import { agentMemory as agentMemoryTable } from '../../db'

async function aiAssess(
  ctx: AgentContext,
  opportunity: typeof opportunities.$inferSelect,
  fallback: ScoreResult,
  profile: typeof profiles.$inferSelect | undefined,
): Promise<{ result: ScoreResult; provider: string; model: string; costCents: number } | null> {
  const prompt = analysisPrompt({
    title: opportunity.title,
    description: opportunity.description,
    category: opportunity.category,
    source: opportunity.sourceName,
    url: opportunity.url,
    region: opportunity.region,
    profile: profile
      ? {
          country: profile.country,
          currency: profile.currency,
          riskTolerance: profile.riskTolerance,
          skills: profile.skills,
          industries: profile.industries,
          monetizationPreferences: profile.monetizationPreferences,
          dailyBudgetCents: profile.dailyBudgetCents,
          monthlyBudgetCents: profile.monthlyBudgetCents,
        }
      : undefined,
    learningContext: ctx.learning.notes?.join(' ') ?? '',
  })

  const budget = await ctx.reserveSpend(8, `AI analysis: ${opportunity.title.slice(0, 60)}`, opportunity.id)
  if ('blocked' in budget) {
    ctx.logger.warn('AI analysis skipped: budget block', { reason: budget.blocked })
    return null
  }

  try {
    const response = await ctx.ai.generateJson(
      {
        system: prompt.system,
        prompt: prompt.prompt,
        tier: 'standard',
        maxTokens: 1600,
        temperature: 0.2,
        schemaName: 'analysis',
        workspaceId: ctx.workspaceId,
        agentKey: 'analysis',
      },
      analysisSchema,
    )
    const blended = blendScores(fallback, response, 0.6)
    blended.summary = response.summary
    blended.rationale = { ...blended.rationale, ...response.rationale }
    if (response.assumptions?.length) {
      blended.appliedAdjustments = [
        ...blended.appliedAdjustments,
        `Model-stated assumptions: ${response.assumptions.slice(0, 4).join('; ')}`,
      ]
    }
    if (response.risks?.length) {
      blended.rationale.risks = `Identified risks: ${response.risks.slice(0, 5).join('; ')}`
    }
    return { result: blended, provider: ctx.ai.provider, model: 'standard', costCents: 8 }
  } catch (error) {
    ctx.logger.warn('AI assessment failed; using deterministic score', {
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** Latest score for an opportunity (used by UI and the orchestrator). */
export async function latestScore(opportunityId: string) {
  const db = await getDb()
  const rows = await db
    .select()
    .from(opportunityScores)
    .where(eq(opportunityScores.opportunityId, opportunityId))
    .orderBy(desc(opportunityScores.version))
    .limit(1)
  return rows[0] ?? null
}

export async function scoreDistribution(workspaceId: string) {
  const db = await getDb()
  const result = await db.execute(sql`
    select width_bucket(final_score::numeric, 0, 100, 10) as bucket, count(*)::text as count
    from opportunity_scores where workspace_id = ${workspaceId}
    group by bucket order by bucket
  `)
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as { bucket: number; count: string }[]
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    label: `${i * 10}-${i * 10 + 9}`,
    count: Number(rows.find((r) => Number(r.bucket) === i + 1)?.count ?? 0),
  }))
  return buckets
}

export { gte }
