/** Content assets for a project: list, create, update status. */
import { z } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb, contentAssets, projects } from '@/lib/db'
import { ApiError, created, ok, parseBody, withApi } from '@/lib/api/http'
import { inspectContent } from '@/lib/compliance/policy'
import { slugify } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const rows = await db
    .select()
    .from(contentAssets)
    .where(and(eq(contentAssets.projectId, ctx.params.id!), eq(contentAssets.workspaceId, ctx.session.workspaceId), isNull(contentAssets.deletedAt)))
    .orderBy(desc(contentAssets.createdAt))
    .limit(200)
  return ok(
    rows.map((row) => ({
      ...row,
      compliance: inspectContent(`${row.title} ${row.summary} ${row.body}`),
    })),
  )
})

const createSchema = z.object({
  type: z.enum(['product_spec', 'landing_page', 'faq', 'documentation', 'onboarding', 'marketing', 'seo_metadata', 'blog_post', 'social_post', 'email_draft', 'ad_copy', 'product_description', 'video_script']),
  title: z.string().min(3).max(200),
  summary: z.string().max(600).default(''),
  body: z.string().min(1).max(200_000),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const project = (
    await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, ctx.params.id!), eq(projects.workspaceId, workspaceId))).limit(1)
  )[0]
  if (!project) throw new ApiError('not_found', 'Project not found.')

  const input = await parseBody(ctx.request, createSchema)
  const inspection = inspectContent(`${input.title} ${input.summary} ${input.body}`)
  if (!inspection.clean) {
    throw new ApiError('policy_blocked', `Content contains claims AIBA will not publish: ${inspection.violations.join('; ')}`, {
      violations: inspection.violations,
      phrases: inspection.blockedPhrases,
    })
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
      workspaceId,
      projectId: project.id,
      type: input.type,
      title: input.title,
      slug: slugify(input.title),
      summary: input.summary,
      body: input.body,
      version: (previous[0]?.version ?? 0) + 1,
      parentVersionId: previous[0]?.id ?? null,
      status: 'draft',
      engine: 'manual',
    })
    .returning()

  return created(rows[0])
})

const patchSchema = z.object({
  assetId: z.string().uuid(),
  title: z.string().min(3).max(200).optional(),
  summary: z.string().max(600).optional(),
  body: z.string().max(200_000).optional(),
  status: z.enum(['draft', 'in_review', 'approved', 'archived']).optional(),
})

export const PATCH = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, patchSchema)
  const asset = (
    await db.select().from(contentAssets).where(and(eq(contentAssets.id, input.assetId), eq(contentAssets.workspaceId, workspaceId))).limit(1)
  )[0]
  if (!asset) throw new ApiError('not_found', 'Asset not found.')

  const inspection = inspectContent(`${input.title ?? asset.title} ${input.summary ?? asset.summary} ${input.body ?? asset.body}`)
  if (!inspection.clean) {
    throw new ApiError('policy_blocked', `Save rejected: the content contains claims AIBA will not publish (${inspection.violations.join('; ')}).`, {
      violations: inspection.violations,
    })
  }

  const rows = await db
    .update(contentAssets)
    .set({ ...input, assetId: undefined, updatedAt: new Date() } as Record<string, unknown>)
    .where(eq(contentAssets.id, asset.id))
    .returning()
  return ok({ asset: rows[0], compliance: inspection })
})

export const DELETE = withApi(async (ctx) => {
  const db = await getDb()
  const assetId = ctx.searchParams.get('assetId')
  if (!assetId) throw new ApiError('validation_error', 'assetId query parameter is required.')
  const rows = await db
    .update(contentAssets)
    .set({ deletedAt: new Date(), status: 'archived', updatedAt: new Date() })
    .where(and(eq(contentAssets.id, assetId), eq(contentAssets.workspaceId, ctx.session.workspaceId)))
    .returning({ id: contentAssets.id })
  if (!rows[0]) throw new ApiError('not_found', 'Asset not found.')
  return ok({ deleted: true })
})
