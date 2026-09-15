/**
 * GET  /api/expenses — expense ledger with category filters.
 * POST /api/expenses — record an expense (budget-guarded).
 */
import { z } from 'zod'
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { getDb, expenses } from '@/lib/db'
import { ApiError, created, ok, paginationSchema, parseBody, withApi } from '@/lib/api/http'
import { recalculateProjectFinancials } from '@/lib/analytics'
import { EXPENSE_CATEGORIES } from '@/lib/expenses/categories'
import { notify } from '@/lib/notifications'
import { truncate } from '@/lib/utils'

export const dynamic = 'force-dynamic'


export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const page = paginationSchema(25).parse(ctx.searchParams)
  const conditions = [eq(expenses.workspaceId, ctx.session.workspaceId)]
  conditions.push(eq(expenses.demo, ctx.searchParams.get('demo') === 'true'))
  const categories = ctx.searchParams.getAll('category').flatMap((value) => value.split(','))
  if (categories.length) conditions.push(sql`${expenses.category} = any(${sql.raw(`array['${categories.join("','")}']`)})`)
  if (ctx.searchParams.get('projectId')) conditions.push(eq(expenses.projectId, ctx.searchParams.get('projectId')!))
  const from = ctx.searchParams.get('from')
  const to = ctx.searchParams.get('to')
  if (from) conditions.push(gte(expenses.occurredAt, new Date(from)))
  if (to) conditions.push(lte(expenses.occurredAt, new Date(to)))

  const where = and(...conditions)
  const [rows, totalRow, byCategory, total] = await Promise.all([
    db.select().from(expenses).where(where).orderBy(desc(expenses.occurredAt)).limit(page.limit).offset(page.offset),
    db.select({ value: sql<string>`count(*)::text` }).from(expenses).where(where),
    db
      .select({ category: expenses.category, value: sql<string>`coalesce(sum(${expenses.amountCents}), 0)::text`, count: sql<string>`count(*)::text` })
      .from(expenses)
      .where(where)
      .groupBy(expenses.category),
    db.select({ value: sql<string>`coalesce(sum(${expenses.amountCents}), 0)::text` }).from(expenses).where(where),
  ])

  const count = Number(totalRow[0]?.value ?? 0)
  return ok(
    {
      expenses: rows,
      byCategory: byCategory.map((row) => ({ category: row.category, totalCents: Number(row.value), count: Number(row.count) })),
      totalCents: Number(total[0]?.value ?? 0),
    },
    { page: page.page, limit: page.limit, total: count, totalPages: Math.max(1, Math.ceil(count / page.limit)) },
  )
})

const schema = z.object({
  projectId: z.string().uuid().optional(),
  category: z.enum(EXPENSE_CATEGORIES).default('other'),
  description: z.string().min(2).max(500),
  amountCents: z.number().int().min(0).max(1_000_000_00),
  provider: z.string().max(80).optional(),
  occurredAt: z.string().datetime().optional(),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, schema)

  const rows = await db
    .insert(expenses)
    .values({
      workspaceId,
      projectId: input.projectId ?? null,
      category: input.category,
      description: truncate(input.description, 500),
      amountCents: input.amountCents,
      currency: 'USD',
      provider: input.provider ?? 'manual',
      verification: 'manual',
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      recordedByUserId: ctx.session.id,
      metadata: { enteredBy: ctx.session.email },
      demo: false,
    })
    .returning()

  if (!rows[0]) throw new ApiError('internal_error', 'Failed to record the expense.')
  if (input.projectId) await recalculateProjectFinancials(input.projectId)

  await notify({
    workspaceId,
    type: 'expense_recorded',
    severity: 'info',
    title: `Expense recorded: ${(input.amountCents / 100).toFixed(2)} USD`,
    body: `${input.category} — ${input.description}`,
    link: '/dashboard/expenses',
    dedupeKey: `expense:${rows[0].id}`,
  })

  return created({ expense: rows[0] })
})
