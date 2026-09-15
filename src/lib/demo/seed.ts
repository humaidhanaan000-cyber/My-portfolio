/**
 * DEMO MODE data.
 *
 * Demo records are written with `demo = true` on every row that carries
 * financial or performance meaning, and demo revenue uses provider `demo`.
 * Every dashboard query that reports money filters on that flag, so demo figures
 * are shown in a separate DEMO DATA panel and can never be confused with — or
 * added to — real figures.
 */
import { and, eq, sql } from 'drizzle-orm'
import {
  getDb,
  analyticsEvents,
  contentAssets,
  expenses,
  opportunities,
  opportunityScores,
  projects,
  revenueTransactions,
  strategies,
  tasks,
} from '../db'
import { fingerprint, slugify } from '../utils'

export type DemoSeedResult = {
  opportunities: number
  scores: number
  projects: number
  strategies: number
  assets: number
  revenue: number
  expenses: number
  analyticsEvents: number
  tasks: number
}

const DEMO_TAG = 'demo'

export async function clearDemoData(workspaceId: string): Promise<void> {
  const db = await getDb()
  await db.delete(revenueTransactions).where(and(eq(revenueTransactions.workspaceId, workspaceId), eq(revenueTransactions.demo, true)))
  await db.delete(expenses).where(and(eq(expenses.workspaceId, workspaceId), eq(expenses.demo, true)))
  await db.delete(analyticsEvents).where(and(eq(analyticsEvents.workspaceId, workspaceId), eq(analyticsEvents.demo, true)))
  await db.delete(contentAssets).where(and(eq(contentAssets.workspaceId, workspaceId), eq(contentAssets.demo, true)))
  const demoProjects = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, workspaceId), eq(projects.demo, true)))
  for (const project of demoProjects) {
    await db.delete(tasks).where(eq(tasks.projectId, project.id))
    await db.delete(strategies).where(eq(strategies.workspaceId, workspaceId))
  }
  await db.delete(projects).where(and(eq(projects.workspaceId, workspaceId), eq(projects.demo, true)))
  const demoOpportunities = await db.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.demo, true)))
  for (const opportunity of demoOpportunities) {
    await db.delete(opportunityScores).where(eq(opportunityScores.opportunityId, opportunity.id))
  }
  await db.delete(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.demo, true)))
}

/** Deterministic pseudo-random so demo runs are reproducible. */
function makeRandom(seed: number) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

const DEMO_OPPORTUNITIES = [
  {
    title: '[DEMO] Automated shift-handover summaries for care agencies',
    description:
      'Care agency managers describe spending 45 minutes per shift compiling handover notes from paper and messages. Regulatory reporting is mandatory, the workflow is highly repetitive, and existing tools are priced for hospitals. They asked for a lightweight subscription tool.',
    category: 'saas_opportunity',
    tags: ['healthcare', 'compliance', 'saas'],
  },
  {
    title: '[DEMO] Spreadsheet-to-dashboard templates for independent gyms',
    description:
      'Independent gym owners track memberships in spreadsheets and want a simple paid dashboard template. Fast to produce, digital delivery, clear willingness to pay a one-off price, no licensing requirements.',
    category: 'digital_product',
    tags: ['fitness', 'template', 'one-off'],
  },
  {
    title: '[DEMO] Lead-list building service for commercial cleaners',
    description:
      'Local commercial cleaning firms repeatedly post that they need a steady pipeline of office-manager decisions. Deliverable is a qualified lead list; they already pay for advertising and would pay per qualified lead.',
    category: 'lead_generation',
    tags: ['local', 'b2b', 'services'],
  },
  {
    title: '[DEMO] "Help wanted" — open-source invoicing tool lacks recurring billing',
    description:
      'A maintainer published a help-wanted issue requesting recurring invoice support in an existing open-source tool used by freelancers. Clear scope, public request, fixed-price potential.',
    category: 'public_business_request',
    tags: ['open-source', 'invoicing', 'contract'],
  },
  {
    title: '[DEMO] Comparison resource for EU VAT filing software',
    description:
      'Search demand exists for independent comparisons of VAT filing tools across member states. Affiliate programmes pay 20-30% recurring. Requires accurate research and disclosure of affiliate relationships.',
    category: 'affiliate_opportunity',
    tags: ['tax', 'comparison', 'affiliate'],
  },
  {
    title: '[DEMO] Newsletter for independent pharmacy operators',
    description:
      'No dedicated publication exists for small pharmacy operators in the region. Sponsorship from suppliers is plausible once the list grows; requires original regulatory analysis rather than recycled summaries.',
    category: 'content_opportunity',
    tags: ['pharmacy', 'newsletter', 'sponsorship'],
  },
]

export async function seedWorkspaceDemoData(workspaceId: string, options: { force?: boolean } = {}): Promise<DemoSeedResult> {
  const db = await getDb()

  const existing = await db
    .select({ value: sql<string>`count(*)::text` })
    .from(opportunities)
    .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.demo, true)))
  if (Number(existing[0]?.value ?? 0) > 0) {
    if (!options.force) {
      return { opportunities: 0, scores: 0, projects: 0, strategies: 0, assets: 0, revenue: 0, expenses: 0, analyticsEvents: 0, tasks: 0 }
    }
    await clearDemoData(workspaceId)
  }

  const random = makeRandom(42)
  const result: DemoSeedResult = {
    opportunities: 0,
    scores: 0,
    projects: 0,
    strategies: 0,
    assets: 0,
    revenue: 0,
    expenses: 0,
    analyticsEvents: 0,
    tasks: 0,
  }

  const DIMENSIONS = ['demand', 'competition', 'monetization', 'startupCost', 'operatingCost', 'automationPotential', 'scalability', 'timeToRevenue', 'difficulty', 'risk'] as const

  for (const [index, item] of DEMO_OPPORTUNITIES.entries()) {
    const rows = await db
      .insert(opportunities)
      .values({
        workspaceId,
        sourceName: 'DEMO DATA',
        title: item.title,
        description: item.description,
        url: `https://example.com/demo/opportunity-${index + 1}`,
        category: item.category,
        tags: [...item.tags, DEMO_TAG],
        fingerprint: fingerprint('demo', String(index), item.title),
        status: index < 4 ? 'scored' : 'cleaned',
        demo: true,
        metadata: { demo: true, note: 'Generated sample data — never mixed with real figures.' },
      })
      .returning({ id: opportunities.id })
    const opportunityId = rows[0]!.id
    result.opportunities++

    const scores = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, Math.round(45 + random() * 50)])) as Record<string, number>
    const weights = { demand: 0.2, competition: 0.12, monetization: 0.18, startupCost: 0.08, operatingCost: 0.07, automationPotential: 0.12, scalability: 0.08, timeToRevenue: 0.05, difficulty: 0.05, risk: 0.05 }
    const final = Math.round(DIMENSIONS.reduce((acc, dimension) => acc + scores[dimension]! * weights[dimension]!, 0) * 100) / 100

    await db.insert(opportunityScores).values({
      opportunityId,
      workspaceId,
      demand: scores.demand!,
      competition: scores.competition!,
      monetization: scores.monetization!,
      startupCost: scores.startupCost!,
      operatingCost: scores.operatingCost!,
      automationPotential: scores.automationPotential!,
      scalability: scores.scalability!,
      timeToRevenue: scores.timeToRevenue!,
      difficulty: scores.difficulty!,
      risk: scores.risk!,
      finalScore: final.toFixed(2),
      confidence: Math.round(50 + random() * 40),
      verdict: final >= 80 ? 'strong_buy' : final >= 65 ? 'consider' : final >= 50 ? 'watch' : 'avoid',
      rationale: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, `DEMO DATA: illustrative rationale for ${dimension}.`])),
      summary: `DEMO DATA — illustrative score of ${final}/100 for ${item.title}. Not based on a real market study.`,
      weights: weights as unknown as Record<string, number>,
      engine: 'demo',
    })
    result.scores++

    if (index < 2) {
      const projectRows = await db
        .insert(projects)
        .values({
          workspaceId,
          opportunityId,
          name: item.title.replace('[DEMO] ', ''),
          slug: slugify(`${item.title}-${index}`),
          objective: item.description,
          status: index === 0 ? 'LAUNCHED' : 'MONITORING',
          businessModel: 'Self-serve subscription',
          revenueModel: 'Monthly subscription at $29',
          budgetCents: 30000,
          progress: index === 0 ? 70 : 85,
          launchedAt: new Date(Date.now() - (30 - index * 7) * 86_400_000),
          demo: true,
          metrics: { projectionsLabel: 'estimate', demo: true },
        })
        .returning({ id: projects.id })
      const projectId = projectRows[0]!.id
      result.projects++

      const strategyRows = await db.insert(strategies).values({
        workspaceId,
        opportunityId,
        title: item.title.replace('[DEMO] ', ''),
        problem: `DEMO DATA: operators in this segment describe a repetitive manual process.`,
        targetCustomer: 'DEMO DATA: small operators in the segment described above.',
        solution: 'DEMO DATA: a focused, self-serve tool that removes the repetitive step.',
        businessModel: 'Subscription',
        monetization: 'Monthly subscription, annual discount',
        acquisition: 'Search plus two community channels',
        operatingModel: 'Automated delivery with weekly review',
        costEstimate: { setupCents: 12000, monthlyCents: 3500, breakdown: [] },
        scenarios: {
          scenarios: [
            { label: 'conservative', monthlyRevenueLowCents: 8700, monthlyRevenueHighCents: 11600, monthlyCostCents: 3500, timeToFirstRevenueDays: 45, confidence: 70, assumptions: ['DEMO DATA'], notes: 'Illustrative' },
            { label: 'base', monthlyRevenueLowCents: 17400, monthlyRevenueHighCents: 26000, monthlyCostCents: 3500, timeToFirstRevenueDays: 30, confidence: 50, assumptions: ['DEMO DATA'], notes: 'Illustrative' },
            { label: 'optimistic', monthlyRevenueLowCents: 29000, monthlyRevenueHighCents: 52000, monthlyCostCents: 5600, timeToFirstRevenueDays: 30, confidence: 20, assumptions: ['DEMO DATA'], notes: 'Illustrative' },
          ],
          disclaimer: 'DEMO DATA: illustrative projections only. Not guarantees, and not derived from a real opportunity.',
        },
        engine: 'demo',
      }).returning({ id: strategies.id })
      result.strategies++

      await db
        .update(projects)
        .set({ strategyId: strategyRows[0]!.id })
        .where(eq(projects.id, projectId))

      for (const [taskIndex, title] of ['Validate demand with five prospects', 'Build v1 core workflow', 'Publish landing page', 'Launch to waitlist', 'Review conversion data'].entries()) {
        await db.insert(tasks).values({
          workspaceId,
          projectId,
          title,
          status: taskIndex < 3 ? 'done' : 'todo',
          priority: taskIndex < 2 ? 2 : 3,
          position: taskIndex,
          requiresApproval: taskIndex >= 3,
          finishedAt: taskIndex < 3 ? new Date() : null,
        })
        result.tasks++
      }

      for (const type of ['product_spec', 'landing_page', 'blog_post']) {
        await db
          .insert(contentAssets)
          .values({
            workspaceId,
            projectId,
            opportunityId,
            type,
            title: `DEMO DATA — ${type.replace('_', ' ')}`,
            slug: slugify(`demo-${type}-${index}`),
            summary: 'DEMO DATA: illustrative asset content.',
            body: `DEMO DATA\n\nThis asset was generated by demo mode. It is not real market research and must not be published.`,
            status: 'draft',
            engine: 'demo',
            demo: true,
            metadata: { demo: true },
          })
        result.assets++
      }

      // Demo revenue, clearly separated by the `demo` flag and `demo` provider.
      for (let month = 0; month < 3; month++) {
        const gross = Math.round((9000 + random() * 12000) / 100) * 100
        await db.insert(revenueTransactions).values({
          workspaceId,
          projectId,
          source: 'DEMO DATA',
          provider: 'demo',
          providerTransactionId: `demo_${workspaceId.slice(0, 8)}_${index}_${month}`,
          description: 'DEMO DATA: illustrative subscription revenue',
          grossCents: gross,
          feeCents: Math.round(gross * 0.029),
          netCents: gross - Math.round(gross * 0.029),
          currency: 'USD',
          status: 'confirmed',
          verification: 'manual',
          occurredAt: new Date(Date.now() - (75 - month * 25) * 86_400_000),
          demo: true,
          metadata: { demo: true },
        })
        result.revenue++
      }

      for (const [category, amount] of [['hosting', 1500], ['ai_api', 2400], ['domains', 1200]] as const) {
        await db.insert(expenses).values({
          workspaceId,
          projectId,
          category,
          description: `DEMO DATA: illustrative ${category} cost`,
          amountCents: amount,
          provider: 'demo',
          verification: 'manual',
          occurredAt: new Date(Date.now() - 20 * 86_400_000),
          demo: true,
          metadata: { demo: true },
        })
        result.expenses++
      }

      for (let day = 0; day < 30; day++) {
        const visitors = Math.round(20 + random() * 80)
        await db.insert(analyticsEvents).values({
          workspaceId,
          projectId,
          type: 'page_view',
          name: 'demo_landing_view',
          value: String(visitors),
          visitorId: `demo-${index}-${day}`,
          demo: true,
          occurredAt: new Date(Date.now() - day * 86_400_000),
          properties: { channel: day % 3 === 0 ? 'search' : day % 3 === 1 ? 'community' : 'direct', demo: true },
        })
        result.analyticsEvents++

        if (day % 5 === 0) {
          await db.insert(analyticsEvents).values({
            workspaceId,
            projectId,
            type: 'conversion',
            name: 'demo_signup',
            value: '1',
            demo: true,
            occurredAt: new Date(Date.now() - day * 86_400_000),
            properties: { channel: 'search', demo: true },
          })
          result.analyticsEvents++
        }
      }
    }
  }

  return result
}
