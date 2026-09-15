/**
 * AGENT 4 — BUSINESS STRATEGY AGENT
 *
 * For any opportunity above the configured threshold this produces a complete,
 * executable strategy: problem, customer, solution, model, monetisation,
 * acquisition, operating model, cost estimate, three labelled revenue
 * scenarios, risks, technology requirements, a 12-week launch plan and success
 * metrics — then creates the Project container and raises the approval that
 * gates building and launch.
 *
 * Every monetary value is a projection and is labelled as such in the UI.
 */
import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import { getDb, opportunities, opportunityScores, profiles, projects, strategies, tasks } from '../../db'
import { slugify, truncate } from '../../utils'
import { scoreOpportunity, type ScoreResult } from '../scoring'
import { strategyPrompt } from '../../ai/prompts'
import { strategySchema, type StrategyOutput as StrategyPayload } from '../../ai/schemas'
import { createApproval } from '../../approvals'
import { scoreOpportunityFallbackCategory } from '../heuristics'
import type { AgentDefinition, AgentContext, AgentOutput } from '../types'

export const strategyInputSchema = z.object({
  opportunityIds: z.array(z.string().uuid()).min(1),
  useAi: z.boolean().default(true),
  createProject: z.boolean().default(true),
  requestApproval: z.boolean().default(true),
})
export type StrategyInput = z.infer<typeof strategyInputSchema>

export type StrategyOutput = {
  strategies: {
    id: string
    opportunityId: string
    title: string
    version: number
    engine: string
    finalScore: number
    projectId?: string
    approvalId?: string
    monthlyCostCents: number
    scenarioHeadline: string
  }[]
  created: number
  projectsCreated: number
  approvalsCreated: number
  warnings: string[]
}

export const strategyAgent: AgentDefinition<StrategyInput, StrategyOutput> = {
  key: 'strategy',
  name: 'Business Strategy Agent',
  description: 'Generates a full business strategy with three labelled revenue projections, then creates the project.',
  category: 'analysis',
  policyAction: 'generate_strategy',
  estimatedCostCents: 60,
  modelTier: 'reasoning',
  timeoutSeconds: 420,
  cadenceMinutes: 360,
  requiresWorkspace: true,
  inputSchema: strategyInputSchema,

  async run(input, ctx): Promise<AgentOutput<StrategyOutput>> {
    const db = await getDb()
    const profile = (await db.select().from(profiles).where(eq(profiles.workspaceId, ctx.workspaceId)).limit(1))[0]
    const created: StrategyOutput['strategies'] = []
    const warnings: string[] = []
    const notes: string[] = []
    let projectsCreated = 0
    let approvalsCreated = 0
    let aiCost = 0
    let provider: string | null = null
    let model: string | null = null

    for (const opportunityId of input.opportunityIds) {
      const opportunity = (
        await db
          .select()
          .from(opportunities)
          .where(eq(opportunities.id, opportunityId))
          .limit(1)
      )[0]
      if (!opportunity || opportunity.workspaceId !== ctx.workspaceId) {
        warnings.push(`Opportunity ${opportunityId} not found in this workspace.`)
        continue
      }

      const scoreRow = (
        await db
          .select()
          .from(opportunityScores)
          .where(eq(opportunityScores.opportunityId, opportunityId))
          .orderBy(desc(opportunityScores.version))
          .limit(1)
      )[0]

      const score = scoreRow
        ? {
            finalScore: Number(scoreRow.finalScore),
            scores: {
              demand: scoreRow.demand,
              competition: scoreRow.competition,
              monetization: scoreRow.monetization,
              startupCost: scoreRow.startupCost,
              operatingCost: scoreRow.operatingCost,
              automationPotential: scoreRow.automationPotential,
              scalability: scoreRow.scalability,
              timeToRevenue: scoreRow.timeToRevenue,
              difficulty: scoreRow.difficulty,
              risk: scoreRow.risk,
            },
            summary: scoreRow.summary,
          }
        : (() => {
            const fallback = scoreOpportunity({
              title: opportunity.title,
              description: opportunity.description,
              category: opportunity.category,
              profile: profile
                ? {
                    currency: profile.currency,
                    country: profile.country,
                    riskTolerance: profile.riskTolerance,
                    skills: profile.skills,
                    industries: profile.industries,
                    monetizationPreferences: profile.monetizationPreferences,
                  }
                : undefined,
              learning: ctx.learning,
            })
            return { finalScore: fallback.finalScore, scores: fallback.scores, summary: fallback.summary }
          })()

      const existing = await db.select({ version: strategies.version }).from(strategies).where(eq(strategies.opportunityId, opportunityId)).orderBy(desc(strategies.version)).limit(1)
      const version = (existing[0]?.version ?? 0) + 1

      let payload: StrategyPayload | null = null

      if (input.useAi && ctx.ai.available) {
        const prompt = strategyPrompt({
          title: opportunity.title,
          description: opportunity.description,
          category: opportunity.category,
          scores: score.scores,
          finalScore: score.finalScore,
          profile: profile ? { currency: profile.currency, country: profile.country, skills: profile.skills, riskTolerance: profile.riskTolerance } : undefined,
          dailyBudgetCents: profile?.dailyBudgetCents,
          monthlyBudgetCents: profile?.monthlyBudgetCents,
        })

        const budget = await ctx.reserveSpend(20, `Strategy generation: ${opportunity.title.slice(0, 50)}`, opportunityId)
        if ('blocked' in budget) {
          warnings.push(`Strategy for "${opportunity.title}" used the deterministic engine: ${budget.blocked}`)
        } else {
          try {
            payload = await ctx.ai.generateJson(
              {
                system: prompt.system,
                prompt: prompt.prompt,
                tier: 'reasoning',
                maxTokens: 3000,
                temperature: 0.4,
                schemaName: 'strategy',
                workspaceId: ctx.workspaceId,
                agentKey: 'strategy',
              },
              strategySchema,
            )
            provider = ctx.ai.provider
            model = 'reasoning'
            aiCost += 20
          } catch (error) {
            warnings.push(`AI strategy failed for "${truncate(opportunity.title, 50)}"; deterministic strategy used instead.`)
            ctx.logger.warn('AI strategy generation failed', { message: error instanceof Error ? error.message : String(error) })
          }
        }
      }

      if (!payload) {
        payload = heuristicStrategy(opportunity, score, profile)
        notes.push(`Deterministic strategy generated for "${truncate(opportunity.title, 60)}" (no AI provider required).`)
      }

      const inserted = await db
        .insert(strategies)
        .values({
          workspaceId: ctx.workspaceId,
          opportunityId,
          version,
          status: 'draft',
          title: payload.title,
          problem: payload.problem,
          targetCustomer: payload.targetCustomer,
          solution: payload.solution,
          businessModel: payload.businessModel,
          monetization: payload.monetization,
          acquisition: payload.acquisition,
          operatingModel: payload.operatingModel,
          costEstimate: payload.costEstimate as unknown as Record<string, unknown>,
          scenarios: { scenarios: payload.scenarios, disclaimer: 'All figures are projections based on the stated assumptions. They are not guarantees.' } as unknown as Record<string, unknown>,
          risks: payload.risks,
          techRequirements: payload.techRequirements,
          launchPlan: payload.launchPlan,
          successMetrics: payload.successMetrics,
          engine: provider ? 'heuristic+ai' : 'heuristic',
          provider,
          model,
          promptVersion: 'strategy/v3',
        })
        .returning({ id: strategies.id })

      const strategyId = inserted[0]!.id
      await db.update(opportunities).set({ status: 'strategy_ready', updatedAt: new Date() }).where(eq(opportunities.id, opportunityId))

      let projectId: string | undefined
      let approvalId: string | undefined

      if (input.createProject) {
        const createdProject = await createProjectFromStrategy({
          workspaceId: ctx.workspaceId,
          opportunity,
          strategyId,
          payload,
          score: score.finalScore,
          profile,
        })
        projectId = createdProject.projectId
        projectsCreated++

        if (input.requestApproval) {
          const approval = await createApproval({
            workspaceId: ctx.workspaceId,
            actionType: 'create_project',
            title: `Approve build & launch: ${payload.title}`,
            reason: `Strategy v${version} is ready for "${truncate(opportunity.title, 60)}" (score ${score.finalScore}/100). Approving releases the build workflow, which generates the product specification, landing page and first content bundle, then moves the project to LAUNCHED.`,
            expectedCostCents: payload.costEstimate.monthlyCents,
            potentialBenefit: `Projected base-case revenue ${(payload.scenarios.find((s) => s.label === 'base')?.monthlyRevenueLowCents ?? 0) / 100}–${(payload.scenarios.find((s) => s.label === 'base')?.monthlyRevenueHighCents ?? 0) / 100} per month after launch (projection, not a guarantee).`,
            risk: score.finalScore >= 80 ? 'low' : score.finalScore >= 65 ? 'medium' : 'high',
            payload: { projectId, strategyId, launchPlan: payload.launchPlan, costEstimate: payload.costEstimate },
            projectId,
            opportunityId,
            requestedByAgent: 'strategy',
            dedupeKey: `project-approval:${projectId}`,
          })
          approvalId = approval.id
          if (approval.created) approvalsCreated++
          await db
            .update(projects)
            .set({ status: 'WAITING_FOR_APPROVAL', updatedAt: new Date() })
            .where(eq(projects.id, projectId))
        }
      }

      created.push({
        id: strategyId,
        opportunityId,
        title: payload.title,
        version,
        engine: provider ? 'heuristic+ai' : 'heuristic',
        finalScore: score.finalScore,
        projectId,
        approvalId,
        monthlyCostCents: payload.costEstimate.monthlyCents,
        scenarioHeadline: summariseScenarios(payload.scenarios),
      })
    }

    return {
      data: { strategies: created, created: created.length, projectsCreated, approvalsCreated, warnings },
      summary: `Generated ${created.length} strateg${created.length === 1 ? 'y' : 'ies'}, created ${projectsCreated} project(s) and ${approvalsCreated} approval request(s).`,
      notes,
      warnings,
      costCents: aiCost,
      provider: provider ?? undefined,
      model: model ?? undefined,
      metrics: { created: created.length, projectsCreated, approvalsCreated, aiUsed: aiCost > 0 ? 1 : 0 },
    }
  },

  async memory(output, _input, ctx) {
    const db = await getDb()
    const { agentMemory } = await import('../../db')
    await db.insert(agentMemory).values({
      workspaceId: ctx.workspaceId,
      agentKey: 'strategy',
      kind: 'decision',
      key: `strategy:${new Date().toISOString().slice(0, 13)}`,
      content: `Created ${output.data.created} strateg${output.data.created === 1 ? 'y' : 'ies'} and ${output.data.projectsCreated} project(s).`,
      importance: 3,
      data: { strategies: output.data.strategies.slice(0, 10) },
      expiresAt: new Date(Date.now() + 180 * 86_400_000),
    })
  },
}

/** Deterministic strategy generator — used with or without an AI provider. */
export function heuristicStrategy(
  opportunity: typeof opportunities.$inferSelect,
  score: { finalScore: number; scores: Record<string, number>; summary: string },
  profile: typeof profiles.$inferSelect | undefined,
): StrategyPayload {
  const currency = profile?.currency ?? 'USD'
  const category = opportunity.category
  const blueprint = scoreOpportunityFallbackCategory(category)
  const monthlyBudget = profile?.monthlyBudgetCents ?? 5000

  const setupCents = Math.round(blueprint.setupMultiplier * Math.min(12000, Math.max(2000, monthlyBudget)))
  const monthlyCents = Math.round(blueprint.monthlyMultiplier * Math.min(20000, Math.max(1500, monthlyBudget)))

  const pricePointCents = blueprint.pricePointCents
  const conversionBase = blueprint.conversionRate
  const visitorsLow = blueprint.visitorsPerMonth[0]
  const visitorsHigh = blueprint.visitorsPerMonth[1]

  const conservativeCustomers = Math.max(1, Math.round(visitorsLow * conversionBase * 0.5))
  const baseCustomers = Math.max(2, Math.round(((visitorsLow + visitorsHigh) / 2) * conversionBase))
  const optimisticCustomers = Math.max(4, Math.round(visitorsHigh * conversionBase * 1.6))

  return {
    title: opportunity.title.slice(0, 180),
    problem: `The signal from ${opportunity.sourceName} suggests an unmet need: ${truncate(opportunity.description, 300)}`,
    targetCustomer: blueprint.customer,
    solution: blueprint.solution(opportunity.title),
    businessModel: blueprint.businessModel,
    monetization: blueprint.monetization(pricePointCents, currency),
    acquisition: blueprint.acquisition,
    operatingModel: blueprint.operatingModel,
    costEstimate: {
      setupCents,
      monthlyCents,
      breakdown: blueprint.costBreakdown(setupCents, monthlyCents, currency),
    },
    scenarios: [
      {
        label: 'conservative',
        assumptions: [
          `${visitorsLow} monthly visitors with a ${(conversionBase * 50).toFixed(1)}% conversion rate`,
          'No paid acquisition; organic and community channels only',
          'Pricing held at the launch level with no upsell',
        ],
        monthlyRevenueLowCents: conservativeCustomers * pricePointCents,
        monthlyRevenueHighCents: Math.round(conservativeCustomers * pricePointCents * 1.3),
        monthlyCostCents: monthlyCents,
        timeToFirstRevenueDays: blueprint.timeToRevenueDays[0],
        confidence: 70,
        notes: 'Downside planning case. Assumes the launch earns little attention — the most common real outcome.',
      },
      {
        label: 'base',
        assumptions: [
          `${Math.round((visitorsLow + visitorsHigh) / 2)} monthly visitors with a ${(conversionBase * 100).toFixed(1)}% conversion rate`,
          'One content channel compounding monthly',
          'Costs at the estimated run rate with no scaling spend',
        ],
        monthlyRevenueLowCents: baseCustomers * pricePointCents,
        monthlyRevenueHighCents: Math.round(baseCustomers * pricePointCents * 1.4),
        monthlyCostCents: monthlyCents,
        timeToFirstRevenueDays: blueprint.timeToRevenueDays[1],
        confidence: 50,
        notes: 'Central estimate. Treat as a planning figure only — it is a projection, not a forecast.',
      },
      {
        label: 'optimistic',
        assumptions: [
          `${visitorsHigh} monthly visitors with a ${(conversionBase * 160).toFixed(1)}% conversion rate`,
          'Distribution channel partnership lands in month two',
          'A higher-priced tier converts above expectations',
        ],
        monthlyRevenueLowCents: optimisticCustomers * pricePointCents,
        monthlyRevenueHighCents: Math.round(optimisticCustomers * pricePointCents * 1.8),
        monthlyCostCents: Math.round(monthlyCents * 1.6),
        timeToFirstRevenueDays: blueprint.timeToRevenueDays[1],
        confidence: 20,
        notes: 'Upside case. Requires several favourable conditions to hold simultaneously.',
      },
    ],
    risks: [
      {
        risk: 'Demand unvalidated — the source signal may not represent paying customers.',
        severity: 'high' as const,
        mitigation: 'Run five customer conversations before spending on build; pre-sell if possible.',
      },
      {
        risk: `Estimated monthly operating cost of ${(monthlyCents / 100).toFixed(2)} ${currency}.`,
        severity: score.scores.operatingCost < 55 ? ('high' as const) : ('medium' as const),
        mitigation: 'Keep automation inside the configured budget; review the spend ledger weekly.',
      },
      {
        risk: 'Acquisition channel may not produce traffic within the projected window.',
        severity: 'medium' as const,
        mitigation: 'Test two channels in parallel during weeks 1–4 and double down on the one that works.',
      },
      {
        risk: 'Competitive response from established players.',
        severity: score.scores.competition < 50 ? ('high' as const) : ('low' as const),
        mitigation: 'Target a narrower segment and a specific workflow they serve poorly.',
      },
    ],
    techRequirements: blueprint.tech,
    launchPlan: [
      { week: 1, milestone: 'Validate demand', tasks: ['Five customer interviews', 'Landing page with waitlist', 'Define the offer and price'] },
      { week: 2, milestone: 'Build v1', tasks: ['Product specification', 'Core deliverable built', 'Payment link configured'] },
      { week: 3, milestone: 'Launch', tasks: ['Publish landing page', 'Announce to relevant communities', 'Set up analytics'] },
      { week: 4, milestone: 'First revenue', tasks: ['Follow up with waitlist', 'Collect testimonials', 'Publish first case study'] },
      { week: 6, milestone: 'Optimise', tasks: ['Improve conversion from analytics', 'Add second content channel', 'Review unit economics'] },
      { week: 12, milestone: 'Scale or stop', tasks: ['Compare against success metrics', 'Decide: scale, pivot or archive'] },
    ],
    successMetrics: [
      { metric: 'Paying customers', target: `${Math.max(3, Math.round(baseCustomers * 0.4))} in first 60 days`, window: '60 days' },
      { metric: 'Conversion rate', target: `${(conversionBase * 100).toFixed(1)}% visitor → customer`, window: '90 days' },
      { metric: 'Monthly profit', target: `${((baseCustomers * pricePointCents - monthlyCents) / 100).toFixed(2)} ${currency}`, window: '90 days' },
      { metric: 'Blended acquisition cost', target: '< 30% of first-year revenue', window: '90 days' },
    ],
  }
}

function summariseScenarios(scenarios: StrategyPayload['scenarios']): string {
  const base = scenarios.find((s) => s.label === 'base') ?? scenarios[0]!
  return `Base projection: ${(base.monthlyRevenueLowCents / 100).toFixed(0)}–${(base.monthlyRevenueHighCents / 100).toFixed(0)}/month (estimated)`
}

async function createProjectFromStrategy(input: {
  workspaceId: string
  opportunity: typeof opportunities.$inferSelect
  strategyId: string
  payload: StrategyPayload
  score: number
  profile: typeof profiles.$inferSelect | undefined
}): Promise<{ projectId: string }> {
  const db = await getDb()
  const baseSlug = slugify(input.payload.title)
  const existing = await db.select({ slug: projects.slug }).from(projects).where(eq(projects.workspaceId, input.workspaceId))
  const taken = new Set(existing.map((p) => p.slug))
  let slug = baseSlug
  let n = 2
  while (taken.has(slug)) slug = `${baseSlug}-${n++}`

  const budgetCents = Math.min(
    input.profile?.maxProjectBudgetCents ?? 20000,
    Math.max(input.payload.costEstimate.setupCents * 2, input.payload.costEstimate.monthlyCents * 3),
  )

  const projectRows = await db
    .insert(projects)
    .values({
      workspaceId: input.workspaceId,
      opportunityId: input.opportunity.id,
      strategyId: input.strategyId,
      name: input.payload.title.slice(0, 160),
      slug,
      objective: input.payload.problem.slice(0, 1000),
      status: 'STRATEGY_READY',
      businessModel: input.payload.businessModel,
      revenueModel: input.payload.monetization,
      costModel: input.payload.costEstimate as unknown as Record<string, unknown>,
      automationLevel: input.profile?.automationLevel ?? 'approval_required',
      budgetCents,
      progress: 10,
      metrics: {
        projectedMonthlyRevenueLowCents: input.payload.scenarios.find((s) => s.label === 'base')?.monthlyRevenueLowCents ?? 0,
        projectedMonthlyRevenueHighCents: input.payload.scenarios.find((s) => s.label === 'base')?.monthlyRevenueHighCents ?? 0,
        projectedMonthlyCostCents: input.payload.costEstimate.monthlyCents,
        projectionsLabel: 'estimate',
        opportunityScore: input.score,
      },
    })
    .returning({ id: projects.id })

  const projectId = projectRows[0]!.id

  const taskRows = input.payload.launchPlan.flatMap((phase, phaseIndex) =>
    phase.tasks.map((task, taskIndex) => ({
      workspaceId: input.workspaceId,
      projectId,
      title: task,
      description: `Week ${phase.week} — ${phase.milestone}`,
      status: phaseIndex === 0 ? 'todo' : 'todo',
      priority: phaseIndex === 0 ? 2 : 3,
      assigneeAgentKey: inferTaskAgent(task),
      position: phaseIndex * 10 + taskIndex,
      requiresApproval: /publish|launch|announce|send|advert|campaign|payment/i.test(task),
      estimatedCostCents: 0,
    })),
  )
  if (taskRows.length > 0) await db.insert(tasks).values(taskRows)

  const { projectEvents } = await import('../../db')
  await db.insert(projectEvents).values({
    workspaceId: input.workspaceId,
    projectId,
    type: 'created',
    actor: 'strategy',
    message: `Project created from strategy v${1} for opportunity "${input.opportunity.title}" (score ${input.score}/100). All revenue figures are projections.`,
    data: { opportunityId: input.opportunity.id, strategyId: input.strategyId },
  })

  return { projectId }
}

function inferTaskAgent(task: string): string {
  const lower = task.toLowerCase()
  if (/publish|announce|content|post|blog|seo/.test(lower)) return 'content'
  if (/landing|spec|build|product|page/.test(lower)) return 'product'
  if (/payment|pricing|revenue|invoice/.test(lower)) return 'execution'
  if (/analytics|metric|review|monitor|conversion/.test(lower)) return 'monitoring'
  if (/interview|customer|research|validate|competitor/.test(lower)) return 'research'
  return 'execution'
}
