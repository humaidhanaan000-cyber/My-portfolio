/**
 * GET  /api/opportunities — paginated, filtered, indexed opportunity list.
 * POST /api/opportunities — add an opportunity manually (the highest-trust source).
 */
import { z } from 'zod'
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { getDb, opportunities, opportunityScores, profiles } from '@/lib/db'
import { created, ok, paginationSchema, parseBody, withApi } from '@/lib/api/http'
import { fingerprint, truncate } from '@/lib/utils'
import { enqueue } from '@/lib/queue'
import { notify } from '@/lib/notifications'

export const dynamic = 'force-dynamic'

const CATEGORIES = [
  'underserved_market', 'saas_opportunity', 'affiliate_opportunity', 'digital_product', 'lead_generation',
  'public_business_request', 'freelance_opportunity', 'local_business', 'content_opportunity', 'partnership',
  'emerging_niche', 'useful_tool', 'other',
] as const

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const page = paginationSchema(25).parse(ctx.searchParams)
  const conditions = [eq(opportunities.workspaceId, ctx.session.workspaceId), isNull(opportunities.deletedAt)]

  const status = ctx.searchParams.getAll('status').flatMap((value) => value.split(','))
  if (status.length) conditions.push(inArray(opportunities.status, status))
  const categories = ctx.searchParams.getAll('category').flatMap((value) => value.split(','))
  if (categories.length) conditions.push(inArray(opportunities.category, categories))
  const sources = ctx.searchParams.getAll('source').flatMap((value) => value.split(','))
  if (sources.length) conditions.push(inArray(opportunities.sourceName, sources))
  const minScore = ctx.searchParams.get('minScore')
  const maxScore = ctx.searchParams.get('maxScore')
  const since = ctx.searchParams.get('since')
  const until = ctx.searchParams.get('until')
  if (since) conditions.push(gte(opportunities.discoveredAt, new Date(since)))
  if (until) conditions.push(lte(opportunities.discoveredAt, new Date(until)))
  const q = page.q
  if (q) conditions.push(sql`(${opportunities.title} ilike ${`%${q}%`} or ${opportunities.description} ilike ${`%${q}%`})`)
  const risk = ctx.searchParams.get('risk')
  if (risk) conditions.push(sql`coalesce((select risk from opportunity_scores where opportunity_id = ${opportunities.id} order by version desc limit 1), 50) >= ${Number(risk)}`)
  const cost = ctx.searchParams.get('cost')
  if (cost) conditions.push(sql`coalesce((select startup_cost from opportunity_scores where opportunity_id = ${opportunities.id} order by version desc limit 1), 50) >= ${Number(cost)}`)
  const monetization = ctx.searchParams.get('monetization')
  if (monetization) conditions.push(sql`coalesce((select monetization from opportunity_scores where opportunity_id = ${opportunities.id} order by version desc limit 1), 50) >= ${Number(monetization)}`)
  if (minScore) conditions.push(sql`coalesce((select final_score from opportunity_scores where opportunity_id = ${opportunities.id} order by version desc limit 1), 0) >= ${Number(minScore)}`)
  if (maxScore) conditions.push(sql`coalesce((select final_score from opportunity_scores where opportunity_id = ${opportunities.id} order by version desc limit 1), 100) <= ${Number(maxScore)}`)

  const where = and(...conditions)
  const scoreSubquery = sql<string>`coalesce((select final_score::text from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1), null)`

  const orderColumn =
    page.sort === 'score' ? sql`${scoreSubquery} desc nulls last`
    : page.sort === 'title' ? (page.order === 'asc' ? asc(opportunities.title) : desc(opportunities.title))
    : page.sort === 'discovered_at' ? (page.order === 'asc' ? asc(opportunities.discoveredAt) : desc(opportunities.discoveredAt))
    : (page.order === 'asc' ? asc(opportunities.createdAt) : desc(opportunities.createdAt))

  const [rows, totalRow] = await Promise.all([
    db
      .select({
        id: opportunities.id,
        title: opportunities.title,
        description: opportunities.description,
        url: opportunities.url,
        category: opportunities.category,
        sourceName: opportunities.sourceName,
        status: opportunities.status,
        tags: opportunities.tags,
        region: opportunities.region,
        discoveredAt: opportunities.discoveredAt,
        decision: opportunities.decision,
        relevance: opportunities.relevancyScore,
        spamScore: opportunities.spamScore,
        isDemo: opportunities.demo,
        score: sql<string | null>`(select final_score::text from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
        verdict: sql<string | null>`(select verdict from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
        confidence: sql<number | null>`(select confidence from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
        demand: sql<number | null>`(select demand from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
        competition: sql<number | null>`(select competition from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
        monetizationScore: sql<number | null>`(select monetization from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
        startupCost: sql<number | null>`(select startup_cost from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
        riskScore: sql<number | null>`(select risk from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
        automation: sql<number | null>`(select automation_potential from opportunity_scores s where s.opportunity_id = ${opportunities.id} order by s.version desc limit 1)`,
      })
      .from(opportunities)
      .where(where)
      .orderBy(orderColumn)
      .limit(page.limit)
      .offset(page.offset),
    db.select({ value: sql<string>`count(*)::text` }).from(opportunities).where(where),
  ])

  const total = Number(totalRow[0]?.value ?? 0)
  return ok(rows, {
    page: page.page,
    limit: page.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / page.limit)),
    hasMore: page.offset + rows.length < total,
  })
})

const createSchema = z.object({
  title: z.string().min(5).max(200),
  description: z.string().min(10).max(8000),
  url: z.string().url().optional().or(z.literal('')),
  category: z.enum(CATEGORIES).default('other'),
  tags: z.array(z.string().max(40)).max(10).default([]),
  region: z.string().max(80).optional(),
  analyzeNow: z.boolean().default(true),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const input = await parseBody(ctx.request, createSchema)
  const workspaceId = ctx.session.workspaceId

  const stamp = fingerprint(input.title, input.url ?? 'manual')
  const existing = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.fingerprint, stamp)))
    .limit(1)
  if (existing[0]) {
    return ok({ id: existing[0].id, duplicate: true, message: 'This opportunity is already in your database.' })
  }

  const rows = await db
    .insert(opportunities)
    .values({
      workspaceId,
      sourceName: 'manual',
      title: truncate(input.title, 200),
      description: truncate(input.description, 8000),
      url: input.url || null,
      category: input.category,
      tags: input.tags,
      region: input.region ?? null,
      fingerprint: stamp,
      status: 'cleaned',
      cleanedAt: new Date(),
      metadata: { addedBy: ctx.session.id },
    })
    .returning({ id: opportunities.id })

  const id = rows[0]!.id
  await notify({
    workspaceId,
    type: 'system',
    severity: 'info',
    title: 'Opportunity added manually',
    body: truncate(input.title, 120),
    link: `/dashboard/opportunities/${id}`,
    dedupeKey: `manual-opportunity:${id}`,
  })

  if (input.analyzeNow) {
    const profile = (await db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1))[0]
    const threshold = profile?.scoreThreshold ?? 70
    await enqueue(
      'agent.analysis',
      { opportunityIds: [id], batchSize: 1, useAi: true, autoStrategy: true },
      { queue: 'analysis', priority: 3, workspaceId, dedupeKey: `analysis:${id}` },
    )
    void threshold
  }

  return created({ id, duplicate: false, analysisQueued: input.analyzeNow })
})
