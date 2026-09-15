/**
 * AGENT 5 — PRODUCT CREATION AGENT
 *
 * Turns an approved strategy into versioned, ready-to-ship assets: product
 * specification, landing page, product copy, FAQ, documentation, onboarding
 * sequence, marketing assets and SEO metadata. Everything is stored as a
 * versioned content asset so the operator can diff versions and roll back.
 */
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { getDb, contentAssets, projects, projectEvents, strategies } from '../../db'
import { slugify, truncate } from '../../utils'
import { productPrompt, landingPagePrompt } from '../../ai/prompts'
import { landingPageSchema, productSpecSchema, type LandingPageOutput, type ProductSpecOutput } from '../../ai/schemas'
import { inspectContent, sanitizeClaims } from '../../compliance/policy'
import { scoreOpportunityFallbackCategory } from '../heuristics'
import type { AgentDefinition, AgentContext, AgentOutput } from '../types'

export const productInputSchema = z.object({
  projectId: z.string().uuid(),
  useAi: z.boolean().default(true),
  assetTypes: z
    .array(z.enum(['product_spec', 'landing_page', 'faq', 'documentation', 'onboarding', 'marketing', 'seo_metadata']))
    .default(['product_spec', 'landing_page', 'faq', 'documentation', 'onboarding', 'marketing', 'seo_metadata']),
})
export type ProductInput = z.infer<typeof productInputSchema>

export type ProductOutput = {
  projectId: string
  assets: { id: string; type: string; title: string; version: number; status: string }[]
  compliance: { flagged: string[]; sanitised: number }
  engine: 'heuristic' | 'heuristic+ai'
}

export const productAgent: AgentDefinition<ProductInput, ProductOutput> = {
  key: 'product',
  name: 'Product Creation Agent',
  description: 'Generates the product specification, landing page, FAQ, docs, onboarding and SEO metadata as versioned assets.',
  category: 'creation',
  policyAction: 'generate_product_spec',
  estimatedCostCents: 45,
  modelTier: 'standard',
  timeoutSeconds: 420,
  cadenceMinutes: 0,
  requiresWorkspace: true,
  inputSchema: productInputSchema,

  async run(input, ctx): Promise<AgentOutput<ProductOutput>> {
    const db = await getDb()
    const project = (
      await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, ctx.workspaceId)))
        .limit(1)
    )[0]
    if (!project) throw new Error(`Project ${input.projectId} not found in this workspace`)

    const strategy = project.strategyId
      ? (await db.select().from(strategies).where(eq(strategies.id, project.strategyId)).limit(1))[0]
      : undefined

    const blueprint = scoreOpportunityFallbackCategory(
      // reuse the category blueprint through the linked opportunity if present
      await categoryForProject(project.opportunityId),
    )

    const notes: string[] = []
    const warnings: string[] = []
    const flagged: string[] = []
    let sanitised = 0
    let engine: ProductOutput['engine'] = 'heuristic'
    let costCents = 0

    let spec: ProductSpecOutput | null = null
    let landing: LandingPageOutput | null = null

    if (input.useAi && ctx.ai.available) {
      const budget = await ctx.reserveSpend(20, `Product assets: ${project.name.slice(0, 50)}`, project.id)
      if ('blocked' in budget) {
        warnings.push(budget.blocked)
      } else {
        try {
          const prompt = productPrompt({
            title: project.name,
            problem: project.objective,
            solution: strategy?.solution ?? project.objective,
            targetCustomer: strategy?.targetCustomer ?? blueprint.customer,
            currency: 'USD',
          })
          spec = await ctx.ai.generateJson(
            { system: prompt.system, prompt: prompt.prompt, tier: 'standard', maxTokens: 2200, schemaName: 'product_spec', workspaceId: ctx.workspaceId, agentKey: 'product' },
            productSpecSchema,
          )
          costCents += 20

          if (input.assetTypes.includes('landing_page')) {
            const landingPrompt = landingPagePrompt({
              title: spec.name,
              positioning: spec.positioning,
              valueProps: spec.valuePropositions,
              targetCustomer: spec.targetSegments.join('; '),
              cta: 'Start now',
            })
            landing = await ctx.ai.generateJson(
              { system: landingPrompt.system, prompt: landingPrompt.prompt, tier: 'standard', maxTokens: 2200, schemaName: 'landing_page', workspaceId: ctx.workspaceId, agentKey: 'product' },
              landingPageSchema,
            )
            costCents += 20
          }
          engine = 'heuristic+ai'
        } catch (error) {
          warnings.push('AI product generation failed; deterministic specification generated instead.')
          ctx.logger.warn('AI product generation failed', { message: error instanceof Error ? error.message : String(error) })
        }
      }
    }

    if (!spec) {
      spec = heuristicProductSpec(project, strategy, blueprint)
      notes.push('Deterministic product specification generated (AI provider not required).')
    }

    const assets: ProductOutput['assets'] = []
    const addAsset = async (input: {
      type: string
      title: string
      summary: string
      body: string
      metadata?: Record<string, unknown>
      status?: string
    }) => {
      const inspection = inspectContent(`${input.title}\n${input.summary}\n${input.body}`)
      let body = input.body
      let summary = input.summary
      let title = input.title
      if (!inspection.clean) {
        const sanitisedBody = sanitizeClaims(body)
        const sanitisedSummary = sanitizeClaims(summary)
        const sanitisedTitle = sanitizeClaims(title)
        if (sanitisedBody.changed.length || sanitisedSummary.changed.length || sanitisedTitle.changed.length) {
          body = sanitisedBody.content
          summary = sanitisedSummary.content
          title = sanitisedTitle.content
          sanitised++
          notes.push(`Rewrote ${inspection.blockedPhrases.join(', ')} into compliant language in "${input.title}".`)
        } else {
          flagged.push(`${input.title}: ${inspection.violations.join(', ')}`)
        }
      }

      const previous = await db
        .select({ id: contentAssets.id, version: contentAssets.version })
        .from(contentAssets)
        .where(and(eq(contentAssets.projectId, project.id), eq(contentAssets.type, input.type)))
        .orderBy(desc(contentAssets.version))
        .limit(1)

      const rows = await db
        .insert(contentAssets)
        .values({
          workspaceId: ctx.workspaceId,
          projectId: project.id,
          opportunityId: project.opportunityId,
          type: input.type,
          title: truncate(title, 200),
          slug: slugify(title),
          summary: truncate(summary, 600),
          body,
          format: input.type === 'landing_page' ? 'json' : 'markdown',
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
          version: (previous[0]?.version ?? 0) + 1,
          parentVersionId: previous[0]?.id ?? null,
          status: input.status ?? 'draft',
          engine,
          provider: engine === 'heuristic+ai' ? ctx.ai.provider : null,
          model: engine === 'heuristic+ai' ? 'standard' : null,
        })
        .returning({ id: contentAssets.id, version: contentAssets.version, type: contentAssets.type, title: contentAssets.title, status: contentAssets.status })

      const row = rows[0]!
      assets.push({ id: row.id, type: row.type, title: row.title, version: row.version, status: row.status })
      return row.id
    }

    if (input.assetTypes.includes('product_spec')) {
      await addAsset({
        type: 'product_spec',
        title: `${spec.name} — Product Specification`,
        summary: spec.positioning,
        body: renderSpecMarkdown(spec),
        metadata: {
          valuePropositions: spec.valuePropositions,
          pricing: spec.pricing,
          openQuestions: spec.openQuestions,
          projectionsLabel: 'estimate',
        },
      })
    }

    if (input.assetTypes.includes('landing_page')) {
      const page = landing ?? heuristicLandingPage(project, spec)
      await addAsset({
        type: 'landing_page',
        title: page.seo.title,
        summary: page.subheadline,
        body: JSON.stringify(page, null, 2),
        metadata: { seo: page.seo, cta: page.cta, faqCount: page.faq.length },
      })
      if (input.assetTypes.includes('seo_metadata')) {
        await addAsset({
          type: 'seo_metadata',
          title: `SEO metadata — ${page.seo.title}`,
          summary: page.seo.description,
          body: [
            `title: ${page.seo.title}`,
            `description: ${page.seo.description}`,
            `slug: ${page.seo.slug}`,
            `keywords: ${page.seo.keywords.join(', ')}`,
            '',
            'Structured data (schema.org/Product):',
            JSON.stringify(
              {
                '@context': 'https://schema.org',
                '@type': 'Product',
                name: spec.name,
                description: page.seo.description,
                offers: spec.pricing.map((tier) => ({ '@type': 'Offer', name: tier.tier, price: (tier.priceCents / 100).toFixed(2), priceCurrency: 'USD' })),
              },
              null,
              2,
            ),
          ].join('\n'),
          metadata: { keywords: page.seo.keywords },
        })
      }
      if (input.assetTypes.includes('faq')) {
        await addAsset({
          type: 'faq',
          title: `FAQ — ${spec.name}`,
          summary: `${page.faq.length} questions`,
          body: page.faq.map((item) => `### ${item.question}\n\n${item.answer}`).join('\n\n'),
          metadata: { questions: page.faq.map((f) => f.question) },
        })
      }
      if (input.assetTypes.includes('marketing')) {
        await addAsset({
          type: 'marketing',
          title: `Marketing assets — ${spec.name}`,
          summary: 'Positioning, value propositions and channel plan',
          body: [
            `## Positioning\n\n${spec.positioning}`,
            `## Value propositions\n\n${spec.valuePropositions.map((v) => `- ${v}`).join('\n')}`,
            `## Differentiators\n\n${spec.differentiators.map((v) => `- ${v}`).join('\n') || '- To be defined with customers'}`,
            `## Channels\n\n- Search: target the exact problem phrasing\n- Communities: answer questions where the audience already gathers\n- Email: waitlist → launch sequence`,
            `## Honest framing notes\n\nAll performance figures in this document are estimates. Do not publish guarantees of income or results.`,
          ].join('\n\n'),
          metadata: { valuePropositions: spec.valuePropositions },
        })
      }
    }

    if (input.assetTypes.includes('documentation')) {
      await addAsset({
        type: 'documentation',
        title: `${spec.name} — Documentation`,
        summary: 'Getting started, core workflows and troubleshooting',
        body: renderDocsMarkdown(spec),
      })
    }

    if (input.assetTypes.includes('onboarding')) {
      await addAsset({
        type: 'onboarding',
        title: `${spec.name} — Onboarding sequence`,
        summary: 'Four-message onboarding flow',
        body: renderOnboardingMarkdown(spec),
      })
    }

    await db.insert(projectEvents).values({
      workspaceId: ctx.workspaceId,
      projectId: project.id,
      type: 'assets_generated',
      actor: 'product',
      message: `Generated ${assets.length} asset(s): ${assets.map((a) => a.type).join(', ')}.`,
      data: { assets },
    })

    const projectTasks = await db.select().from(tasksTable).where(and(eq(tasksTable.projectId, project.id), eq(tasksTable.status, 'todo'))).limit(50)
    for (const task of projectTasks) {
      if (/landing page|product specification|spec|copy/i.test(task.title)) {
        await db.update(tasksTable).set({ status: 'done', finishedAt: new Date(), result: { assetIds: assets.map((a) => a.id) } }).where(eq(tasksTable.id, task.id))
      }
    }

    const doneTasks = await countTasks(project.id)
    const progress = doneTasks.total ? Math.round((doneTasks.done / doneTasks.total) * 100) : project.progress
    await db
      .update(projects)
      .set({ progress: Math.max(project.progress, progress), updatedAt: new Date() })
      .where(eq(projects.id, project.id))

    return {
      data: { projectId: project.id, assets, compliance: { flagged, sanitised }, engine },
      summary: `Generated ${assets.length} product asset(s) for "${project.name}" (${engine}).`,
      notes,
      warnings: [
        ...warnings,
        ...(flagged.length ? [`${flagged.length} asset(s) contain language needing review: ${flagged.join('; ')}`] : []),
      ],
      costCents,
      provider: engine === 'heuristic+ai' ? ctx.ai.provider : undefined,
      model: engine === 'heuristic+ai' ? 'standard' : undefined,
      metrics: { assets: assets.length, sanitised, flagged: flagged.length },
    }
  },
}

import { tasks as tasksTable } from '../../db'

async function categoryForProject(opportunityId: string | null): Promise<string> {
  if (!opportunityId) return 'other'
  const db = await getDb()
  const { opportunities } = await import('../../db')
  const rows = await db.select({ category: opportunities.category }).from(opportunities).where(eq(opportunities.id, opportunityId)).limit(1)
  return rows[0]?.category ?? 'other'
}

async function countTasks(projectId: string): Promise<{ total: number; done: number }> {
  const db = await getDb()
  const rows = await db.select({ status: tasksTable.status }).from(tasksTable).where(eq(tasksTable.projectId, projectId))
  return { total: rows.length, done: rows.filter((r) => r.status === 'done').length }
}

function heuristicProductSpec(
  project: typeof projects.$inferSelect,
  strategy: typeof strategies.$inferSelect | undefined,
  blueprint: ReturnType<typeof scoreOpportunityFallbackCategory>,
): ProductSpecOutput {
  return {
    name: project.name.slice(0, 90),
    positioning: strategy?.solution
      ? truncate(strategy.solution, 400)
      : `A focused solution for "${truncate(project.objective, 200)}" delivered as a self-serve product.`,
    valuePropositions: [
      'Solves one clearly-scoped problem end to end',
      'No setup complexity — usable within minutes of signup',
      'Priced below the cost of the manual alternative it replaces',
      'Exports your data at any time; no lock-in',
    ],
    features: [
      { name: 'Onboarding wizard', description: 'Three-step setup that produces a first useful result immediately.', priority: 'must' as const },
      { name: 'Core workflow', description: `Executes the primary task: ${truncate(project.objective, 160)}`, priority: 'must' as const },
      { name: 'Saved outputs', description: 'Persists results so they can be revisited and shared.', priority: 'must' as const },
      { name: 'Usage metering', description: 'Tracks consumption so pricing tiers are enforceable.', priority: 'should' as const },
      { name: 'Export & integrations', description: 'CSV export plus one integration with the most-used adjacent tool.', priority: 'should' as const },
      { name: 'Team seats', description: 'Invite collaborators with role-based access.', priority: 'could' as const },
    ],
    pricing: [
      { tier: 'Free', priceCents: 0, includes: ['Limited monthly usage', 'Core workflow', 'Community support'] },
      { tier: 'Standard', priceCents: blueprint.pricePointCents, includes: ['Higher usage limits', 'Saved history', 'Email support'] },
      { tier: 'Pro', priceCents: blueprint.pricePointCents * 4, includes: ['Full usage limits', 'Integrations', 'Priority support'] },
    ],
    targetSegments: [blueprint.customer],
    differentiators: ['Narrow scope', 'Faster setup than generalist tools', 'Transparent pricing'],
    openQuestions: [
      'Will the target segment pay this price? Validate with five prospects before building.',
      'Which single channel produces the first ten customers?',
      'What is the real monthly infrastructure cost at expected usage?',
    ],
  }
}

function heuristicLandingPage(project: typeof projects.$inferSelect, spec: ProductSpecOutput): LandingPageOutput {
  const name = spec.name
  const primaryBenefit = spec.valuePropositions[0] ?? 'A faster way to get the job done'
  return {
    headline: `${name} — ${truncate(primaryBenefit, 80)}`,
    subheadline: truncate(spec.positioning, 220),
    sections: [
      {
        heading: 'The problem',
        body: truncate(project.objective, 400),
        bullets: ['Current tools are built for someone else\'s workflow', 'The manual alternative costs hours every week', 'Generic platforms require heavy configuration'],
      },
      {
        heading: 'How it works',
        body: 'Three steps: connect your input, run the workflow, export or share the result.',
        bullets: ['Step 1 — bring your existing data', 'Step 2 — run the workflow', 'Step 3 — act on the output'],
      },
      {
        heading: 'What it is not',
        body: 'This is not a passive-income product and it does not promise guaranteed results. It is a tool that removes a specific, repetitive task.',
        bullets: [],
      },
    ],
    faq: [
      { question: 'How long does setup take?', answer: 'Under ten minutes; no technical knowledge required.' },
      { question: 'Is there a free plan?', answer: 'Yes — limited usage, no card required.' },
      { question: 'Can I export my data?', answer: 'Yes, at any time, in standard formats.' },
      { question: 'What results should I expect?', answer: 'Results depend on your inputs and effort. We publish measured averages once we have enough data, and we never guarantee outcomes.' },
    ],
    cta: { primary: 'Start free', secondary: 'See how it works' },
    seo: {
      title: truncate(`${name} — ${spec.valuePropositions[0] ?? 'Simple solution'}`, 65),
      description: truncate(`${spec.positioning} Start free.`, 175),
      keywords: [name.toLowerCase(), ...spec.targetSegments[0]!.toLowerCase().split(/\s+/).slice(0, 5)],
      slug: slugify(name),
    },
  }
}

function renderSpecMarkdown(spec: ProductSpecOutput): string {
  return [
    `# ${spec.name}`,
    '',
    `## Positioning`,
    '',
    spec.positioning,
    '',
    `## Value propositions`,
    '',
    spec.valuePropositions.map((v) => `- ${v}`).join('\n'),
    '',
    `## Target segments`,
    '',
    spec.targetSegments.map((s) => `- ${s}`).join('\n'),
    '',
    `## Features`,
    '',
    '| Feature | Priority | Description |',
    '| --- | --- | --- |',
    spec.features.map((f) => `| ${f.name} | ${f.priority} | ${f.description} |`).join('\n'),
    '',
    `## Pricing (estimates — validate before launch)`,
    '',
    '| Tier | Price | Includes |',
    '| --- | --- | --- |',
    spec.pricing.map((t) => `| ${t.tier} | $${(t.priceCents / 100).toFixed(2)} | ${t.includes.join('; ')} |`).join('\n'),
    '',
    `## Differentiators`,
    '',
    spec.differentiators.map((d) => `- ${d}`).join('\n') || '- To be validated',
    '',
    `## Open questions`,
    '',
    spec.openQuestions.map((q) => `- ${q}`).join('\n'),
    '',
    '> All financial figures in this specification are estimates, not guarantees.',
  ].join('\n')
}

function renderDocsMarkdown(spec: ProductSpecOutput): string {
  return [
    `# ${spec.name} documentation`,
    '',
    '## Getting started',
    '',
    '1. Create an account.',
    '2. Complete the three-step setup wizard.',
    '3. Run the core workflow on a sample input.',
    '4. Review the output and connect a data source.',
    '',
    '## Core workflow',
    '',
    spec.features.find((f) => f.priority === 'must')?.description ?? 'Run the primary workflow.',
    '',
    '## Limits and quotas',
    '',
    '| Tier | Limit |',
    '| --- | --- |',
    spec.pricing.map((t) => `| ${t.tier} | ${t.includes[0] ?? 'Standard limits'} |`).join('\n'),
    '',
    '## Troubleshooting',
    '',
    '| Symptom | Likely cause | Resolution |',
    '| --- | --- | --- |',
    '| Workflow returns no output | Input format unsupported | Check the supported formats section |',
    '| Slow processing | Large input payload | Split the input or upgrade the plan |',
    '| Cannot export | Browser blocking downloads | Allow downloads for this domain |',
    '',
    '## Support',
    '',
    'Email support is included on paid tiers with a two-business-day target response time.',
  ].join('\n')
}

function renderOnboardingMarkdown(spec: ProductSpecOutput): string {
  return [
    `# ${spec.name} — onboarding sequence`,
    '',
    '## 1. Welcome (immediately after signup)',
    '',
    `Subject: Welcome to ${spec.name}`,
    '',
    'Body: Confirm the account, state the one outcome the product delivers, and link directly to the setup wizard.',
    '',
    '## 2. First result (day 1, only if setup incomplete)',
    '',
    'Subject: Finish setup in two minutes',
    '',
    'Body: Explain what remains, with a single call to action.',
    '',
    '## 3. Value reinforcement (day 2, after first successful run)',
    '',
    'Subject: You ran your first workflow — here is what usually comes next',
    '',
    'Body: Show the second most common workflow and how to reach it.',
    '',
    '## 4. Upgrade prompt (day 5, only after hitting a free-tier limit)',
    '',
    'Subject: You have used most of your free monthly runs',
    '',
    'Body: Explain the paid tier honestly, including what it does not include.',
    '',
    '> No dark patterns: every email is transactional or consent-based, and unsubscribe is one click.',
  ].join('\n')
}

export { desc }
