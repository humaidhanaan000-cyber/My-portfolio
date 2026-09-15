/**
 * AGENT 6 — CONTENT AGENT
 *
 * Produces original drafts: blog posts, social posts, email drafts, landing copy,
 * ad copy, product descriptions and video scripts. Everything lands as a DRAFT
 * asset — publishing is a separate, approval-gated action performed by the
 * Execution Agent against an integration the operator has authorised.
 * AIBA never publishes on its own and never spams.
 */
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getDb, contentAssets, projects, projectEvents, strategies } from '../../db'
import { slugify, truncate } from '../../utils'
import { contentPrompt } from '../../ai/prompts'
import { contentBundleSchema, type ContentBundleOutput } from '../../ai/schemas'
import { inspectContent, sanitizeClaims } from '../../compliance/policy'
import type { AgentDefinition, AgentContext, AgentOutput } from '../types'

export const contentInputSchema = z.object({
  projectId: z.string().uuid(),
  useAi: z.boolean().default(true),
  tone: z.string().max(80).default('clear, specific, no hype'),
  keywords: z.array(z.string()).default([]),
})
export type ContentInput = z.infer<typeof contentInputSchema>

export type ContentOutput = {
  projectId: string
  assets: { id: string; type: string; title: string; version: number }[]
  complianceFlags: string[]
  engine: 'heuristic' | 'heuristic+ai'
}

export const contentAgent: AgentDefinition<ContentInput, ContentOutput> = {
  key: 'content',
  name: 'Content Agent',
  description: 'Drafts blog posts, social posts, emails, ad copy, product descriptions and video scripts for approval.',
  category: 'creation',
  policyAction: 'generate_content',
  estimatedCostCents: 35,
  modelTier: 'standard',
  timeoutSeconds: 360,
  cadenceMinutes: 0,
  requiresWorkspace: true,
  inputSchema: contentInputSchema,

  async run(input, ctx): Promise<AgentOutput<ContentOutput>> {
    const db = await getDb()
    const project = (
      await db.select().from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, ctx.workspaceId))).limit(1)
    )[0]
    if (!project) throw new Error(`Project ${input.projectId} not found`)

    const strategy = project.strategyId
      ? (await db.select().from(strategies).where(eq(strategies.id, project.strategyId)).limit(1))[0]
      : undefined

    const audience = strategy?.targetCustomer ?? 'the primary customer segment for this project'
    const positioning = strategy?.solution ?? project.objective

    let bundle: ContentBundleOutput | null = null
    let engine: ContentOutput['engine'] = 'heuristic'
    let costCents = 0
    const warnings: string[] = []
    const notes: string[] = []

    if (input.useAi && ctx.ai.available) {
      const budget = await ctx.reserveSpend(20, `Content bundle: ${project.name.slice(0, 50)}`, project.id)
      if ('blocked' in budget) {
        warnings.push(budget.blocked)
      } else {
        try {
          const prompt = contentPrompt({
            projectName: project.name,
            positioning,
            audience,
            keywords: input.keywords,
            tone: input.tone,
          })
          bundle = await ctx.ai.generateJson(
            { system: prompt.system, prompt: prompt.prompt, tier: 'standard', maxTokens: 3200, temperature: 0.6, schemaName: 'content_bundle', workspaceId: ctx.workspaceId, agentKey: 'content' },
            contentBundleSchema,
          )
          engine = 'heuristic+ai'
          costCents = 20
        } catch (error) {
          warnings.push('AI content generation failed; deterministic drafts created instead.')
          ctx.logger.warn('AI content generation failed', { message: error instanceof Error ? error.message : String(error) })
        }
      }
    }

    if (!bundle) {
      bundle = heuristicContentBundle(project, strategy, input.tone)
      notes.push('Deterministic content drafts created (AI provider not required). These are starting points for you to edit.')
    }

    const assets: ContentOutput['assets'] = []
    const complianceFlags: string[] = []
    let sanitisedCount = 0

    const store = async (type: string, title: string, summary: string, body: string, metadata: Record<string, unknown> = {}) => {
      const inspection = inspectContent(`${title}\n${summary}\n${body}`)
      let finalTitle = title
      let finalSummary = summary
      let finalBody = body
      if (!inspection.clean) {
        const t = sanitizeClaims(title)
        const s = sanitizeClaims(summary)
        const b = sanitizeClaims(body)
        if (t.changed.length || s.changed.length || b.changed.length) {
          finalTitle = t.content
          finalSummary = s.content
          finalBody = b.content
          sanitisedCount++
          notes.push(`Rewrote non-compliant claims (${inspection.blockedPhrases.join(', ')}) in "${title}".`)
        } else {
          complianceFlags.push(`${title}: ${inspection.violations.join(', ')}`)
        }
      }

      const previous = await db
        .select({ id: contentAssets.id, version: contentAssets.version })
        .from(contentAssets)
        .where(and(eq(contentAssets.projectId, project.id), eq(contentAssets.type, type)))
        .orderBy(contentAssets.version)
        .limit(50)
      const latest = previous.length ? previous[previous.length - 1]! : null

      const rows = await db
        .insert(contentAssets)
        .values({
          workspaceId: ctx.workspaceId,
          projectId: project.id,
          opportunityId: project.opportunityId,
          type,
          title: truncate(finalTitle, 200),
          slug: slugify(finalTitle),
          summary: truncate(finalSummary, 600),
          body: finalBody,
          format: 'markdown',
          metadata,
          version: (latest?.version ?? 0) + 1,
          parentVersionId: latest?.id ?? null,
          status: 'draft',
          engine,
          provider: engine === 'heuristic+ai' ? ctx.ai.provider : null,
        })
        .returning({ id: contentAssets.id, version: contentAssets.version, type: contentAssets.type, title: contentAssets.title })

      const row = rows[0]!
      assets.push({ id: row.id, type: row.type, title: row.title, version: row.version })
    }

    await store('blog_post', bundle.blogPost.title, bundle.blogPost.excerpt, bundle.blogPost.body, {
      slug: bundle.blogPost.slug,
      wordCount: bundle.blogPost.body.split(/\s+/).length,
    })

    for (const post of bundle.socialPosts) {
      await store('social_post', `${post.platform.toUpperCase()} post`, truncate(post.body, 120), post.body, { platform: post.platform })
    }

    await store('email_draft', `Email: ${bundle.emailDraft.subject}`, bundle.emailDraft.preheader, bundle.emailDraft.body, {
      subject: bundle.emailDraft.subject,
      consentRequired: true,
    })

    await store('product_description', `Product description — ${project.name}`, truncate(bundle.productDescription, 200), bundle.productDescription)

    for (const ad of bundle.adCopy) {
      await store('ad_copy', `Ad copy — ${ad.channel}`, ad.headline, `**${ad.headline}**\n\n${ad.body}`, { channel: ad.channel })
    }

    await store(
      'video_script',
      `Video script — ${project.name}`,
      truncate(bundle.videoScript.hook, 120),
      [`## Hook (0-5s)`, bundle.videoScript.hook, '', '## Body', bundle.videoScript.body, '', '## CTA', bundle.videoScript.cta, '', `Duration: ~${bundle.videoScript.durationSeconds}s`].join('\n'),
      { durationSeconds: bundle.videoScript.durationSeconds },
    )

    await db.insert(projectEvents).values({
      workspaceId: ctx.workspaceId,
      projectId: project.id,
      type: 'content_generated',
      actor: 'content',
      message: `Created ${assets.length} content draft(s). Publishing requires your approval.`,
      data: { assets: assets.map((a) => a.type) },
    })

    if (assets.length > 0) {
      const { createApproval } = await import('../../approvals')
      await createApproval({
        workspaceId: ctx.workspaceId,
        actionType: 'publish_content',
        title: `Review and publish content for "${project.name}"`,
        reason: `${assets.length} content draft(s) are ready. Publishing to a public channel is irreversible and requires your review.`,
        expectedCostCents: 0,
        potentialBenefit: 'Publishing is the step that creates organic discovery for the project. Nothing is published until you approve.',
        risk: 'medium',
        payload: { projectId: project.id, assetIds: assets.map((a) => a.id) },
        projectId: project.id,
        requestedByAgent: 'content',
        dedupeKey: `publish:${project.id}:${assets.length}`,
      })
    }

    return {
      data: { projectId: project.id, assets, complianceFlags, engine },
      summary: `Drafted ${assets.length} content asset(s) for "${project.name}". All remain drafts pending your approval.`,
      notes,
      warnings: [...warnings, ...(complianceFlags.length ? [`${complianceFlags.length} asset(s) flagged for review`] : [])],
      costCents,
      provider: engine === 'heuristic+ai' ? ctx.ai.provider : undefined,
      metrics: { assets: assets.length, sanitised: sanitisedCount, flagged: complianceFlags.length },
    }
  },
}

function heuristicContentBundle(
  project: typeof projects.$inferSelect,
  strategy: typeof strategies.$inferSelect | undefined,
  tone: string,
): ContentBundleOutput {
  const audience = strategy?.targetCustomer ?? 'the people affected by this problem'
  const problem = strategy?.problem ?? project.objective
  const solution = strategy?.solution ?? project.objective
  const name = project.name

  return {
    blogPost: {
      title: `The real cost of doing this manually: ${truncate(name, 70)}`,
      slug: slugify(`the-real-cost-of-${name}`),
      excerpt: `A practical breakdown of the manual process behind ${truncate(name, 60)}, what it costs in hours, and where automation genuinely helps.`,
      body: [
        `## Who this is for`,
        '',
        audience,
        '',
        `## The problem in plain terms`,
        '',
        truncate(problem, 600),
        '',
        `## What the manual approach actually costs`,
        '',
        'Work through your own numbers: hours per week spent on the task, multiplied by your effective hourly value, plus the cost of errors. For most teams the total is larger than they expect. Write your figure down before reading further — this article deliberately does not supply invented statistics.',
        '',
        `## Where automation helps (and where it does not)`,
        '',
        `Automation reliably removes repetition, formatting and data movement. It does not remove judgement, customer relationships or the need to validate demand. ${truncate(solution, 300)}`,
        '',
        `## A four-week plan`,
        '',
        '1. Week 1 — measure the current process and talk to five people who feel the problem.',
        '2. Week 2 — build the smallest version that removes the most repetitive step.',
        '3. Week 3 — put it in front of three real users and watch them use it.',
        '4. Week 4 — decide honestly whether to continue, change direction, or stop.',
        '',
        '## Honest expectations',
        '',
        'No tool guarantees revenue. This plan produces information you can act on; the outcome depends on demand, execution and the market.',
      ].join('\n'),
    },
    socialPosts: [
      {
        platform: 'linkedin',
        body: `Most people doing "${truncate(name, 60)}" manually are not short of effort — they are short of a repeatable process.\n\nWe mapped the workflow, removed the repetitive steps, and kept the judgement calls human. Happy to share the template we used.`,
      },
      {
        platform: 'x',
        body: `Manual process → measured time → removed the repetition.\n\nStill human where it matters: demand validation and customer conversations.`,
      },
    ],
    emailDraft: {
      subject: `About ${truncate(name, 60)}`,
      preheader: 'A short, specific note — no pitch deck.',
      body: `Hi,\n\nI noticed you are dealing with ${truncate(problem, 140)}.\n\nWe built something narrow that handles the repetitive part and leaves the judgement calls to you. It takes about ten minutes to see whether it fits: ${'{{link}}'}\n\nIf it is not relevant, a one-line reply saying so is genuinely useful to me.\n\nThanks,\n{{sender}}`,
    },
    productDescription: `${name} removes the repetitive work behind ${truncate(problem, 120)}. Setup takes minutes, the output is exportable, and pricing is published openly. It is a tool for a specific job — not a promise of passive income.`,
    adCopy: [
      { channel: 'search', headline: `Stop doing this manually`, body: `Automate the repetitive part of ${truncate(name, 40)}. Free to try.` },
      { channel: 'social', headline: `${truncate(name, 32)} in 10 minutes`, body: `Built for ${truncate(audience, 60)}. See the workflow before you sign up.` },
    ],
    videoScript: {
      hook: `If you are still doing ${truncate(name, 50)} by hand every week, this takes ninety seconds.`,
      body: `Show the manual process on screen, then the same task through the product. Keep the numbers real — no invented savings. End by showing what the output looks like.`,
      cta: 'Link in the description to try it free.',
      durationSeconds: 90,
    },
  }
}
