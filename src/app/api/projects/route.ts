/** GET /api/projects (paginated) — POST /api/projects (create directly from an approved opportunity). */
import { z } from 'zod'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb, projects, opportunities, strategies, projectEvents } from '@/lib/db'
import { created, ok, paginationSchema, parseBody, withApi } from '@/lib/api/http'
import { slugify } from '@/lib/utils'
import { PROJECT_STATUSES } from '@/lib/projects/status'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const page = paginationSchema(20).parse(ctx.searchParams)
  const conditions = [eq(projects.workspaceId, ctx.session.workspaceId), isNull(projects.deletedAt)]
  const statuses = ctx.searchParams.getAll('status').flatMap((value) => value.split(','))
  if (statuses.length) conditions.push(inArray(projects.status, statuses))
  if (page.q) conditions.push(sql`(${projects.name} ilike ${`%${page.q}%`} or ${projects.objective} ilike ${`%${page.q}%`})`)
  if (ctx.searchParams.get('demo') === 'false') conditions.push(eq(projects.demo, false))
  if (ctx.searchParams.get('demo') === 'true') conditions.push(eq(projects.demo, true))

  const where = and(...conditions)
  const [rows, totalRow] = await Promise.all([
    db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        status: projects.status,
        objective: projects.objective,
        businessModel: projects.businessModel,
        progress: projects.progress,
        budgetCents: projects.budgetCents,
        spentCents: projects.spentCents,
        revenueCents: projects.revenueCents,
        profitCents: projects.profitCents,
        launchedAt: projects.launchedAt,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        metrics: projects.metrics,
        demo: projects.demo,
        taskCount: sql<string>`(select count(*)::text from tasks t where t.project_id = ${projects.id})`,
        openTasks: sql<string>`(select count(*)::text from tasks t where t.project_id = ${projects.id} and t.status in ('todo','in_progress','blocked'))`,
        pendingApprovals: sql<string>`(select count(*)::text from approvals a where a.project_id = ${projects.id} and a.status = 'pending')`,
      })
      .from(projects)
      .where(where)
      .orderBy(page.order === 'asc' ? projects.createdAt : desc(projects.createdAt))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ value: sql<string>`count(*)::text` }).from(projects).where(where),
  ])

  const total = Number(totalRow[0]?.value ?? 0)
  return ok(
    rows.map((row) => ({
      ...row,
      taskCount: Number(row.taskCount),
      openTasks: Number(row.openTasks),
      pendingApprovals: Number(row.pendingApprovals),
    })),
    { page: page.page, limit: page.limit, total, totalPages: Math.max(1, Math.ceil(total / page.limit)) },
  )
})

const createSchema = z.object({
  opportunityId: z.string().uuid().optional(),
  name: z.string().min(3).max(160),
  objective: z.string().min(10).max(2000),
  businessModel: z.string().max(200).default(''),
  revenueModel: z.string().max(200).default(''),
  budgetCents: z.number().int().min(0).max(100_000_00).default(0),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, createSchema)

  const baseSlug = slugify(input.name)
  const existing = await db.select({ slug: projects.slug }).from(projects).where(eq(projects.workspaceId, workspaceId))
  const taken = new Set(existing.map((row) => row.slug))
  let slug = baseSlug
  let attempt = 2
  while (taken.has(slug)) slug = `${baseSlug}-${attempt++}`

  let strategyId: string | null = null
  if (input.opportunityId) {
    const opportunity = (
      await db.select().from(opportunities).where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, workspaceId))).limit(1)
    )[0]
    if (!opportunity) throw new (await import('@/lib/api/http')).ApiError('not_found', 'Opportunity not found.')
    const strategy = (await db.select().from(strategies).where(eq(strategies.opportunityId, opportunity.id)).orderBy(desc(strategies.version)).limit(1))[0]
    strategyId = strategy?.id ?? null
  }

  const rows = await db
    .insert(projects)
    .values({
      workspaceId,
      opportunityId: input.opportunityId ?? null,
      strategyId,
      name: input.name,
      slug,
      objective: input.objective,
      status: 'STRATEGY_READY',
      businessModel: input.businessModel,
      revenueModel: input.revenueModel,
      budgetCents: input.budgetCents,
      progress: 5,
      metrics: { projectionsLabel: 'estimate' },
    })
    .returning({ id: projects.id, name: projects.name })

  await db.insert(projectEvents).values({
    workspaceId,
    projectId: rows[0]!.id,
    type: 'created',
    actor: ctx.session.email,
    message: 'Project created manually. All projected figures remain estimates until verified by real data.',
  })

  return created(rows[0])
})

