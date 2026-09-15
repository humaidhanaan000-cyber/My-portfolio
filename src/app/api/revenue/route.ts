/**
 * GET  /api/revenue — financial overview plus the transaction ledger.
 * POST /api/revenue — record a revenue transaction.
 *
 * Trust model: only `verified_integration` rows count as confirmed revenue.
 * `manual` rows are the operator's own entries and are labelled as such, and
 * demo rows (provider `demo`) are stored with `demo = true` so that demo data
 * can never be added to real revenue.
 */
import { z } from 'zod'
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { getDb, revenueTransactions } from '@/lib/db'
import { ApiError, created, ok, paginationSchema, parseBody, withApi } from '@/lib/api/http'
import { financialOverview, recalculateProjectFinancials } from '@/lib/analytics'
import { notify } from '@/lib/notifications'
import { formatMoney, truncate } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const page = paginationSchema(25).parse(ctx.searchParams)
  const days = Number(ctx.searchParams.get('days') ?? 30)
  const demoOnly = ctx.searchParams.get('demo') === 'true'

  const conditions = [eq(revenueTransactions.workspaceId, workspaceId)]
  conditions.push(eq(revenueTransactions.demo, demoOnly))
  const projectId = ctx.searchParams.get('projectId')
  if (projectId) conditions.push(eq(revenueTransactions.projectId, projectId))
  const from = ctx.searchParams.get('from')
  const to = ctx.searchParams.get('to')
  if (from) conditions.push(gte(revenueTransactions.occurredAt, new Date(from)))
  if (to) conditions.push(lte(revenueTransactions.occurredAt, new Date(to)))
  const verification = ctx.searchParams.getAll('verification')
  if (verification.length) conditions.push(sql`${revenueTransactions.verification} = any(${sql.raw(`array['${verification.join("','")}']`)})`)

  const [overview, rows, totalRow] = await Promise.all([
    financialOverview(workspaceId, undefined, days),
    db.select().from(revenueTransactions).where(and(...conditions)).orderBy(desc(revenueTransactions.occurredAt)).limit(page.limit).offset(page.offset),
    db.select({ value: sql<string>`count(*)::text` }).from(revenueTransactions).where(and(...conditions)),
  ])

  const total = Number(totalRow[0]?.value ?? 0)
  return ok(
    { overview, transactions: rows, demoFilter: demoOnly },
    { page: page.page, limit: page.limit, total, totalPages: Math.max(1, Math.ceil(total / page.limit)) },
  )
})

const schema = z.object({
  projectId: z.string().uuid().optional(),
  grossCents: z.number().int().min(0).max(1_000_000_00),
  feeCents: z.number().int().min(0).default(0),
  description: z.string().min(2).max(500),
  source: z.string().max(80).default('manual'),
  provider: z.string().max(80).optional(),
  providerTransactionId: z.string().max(200).optional(),
  currency: z.string().length(3).default('USD'),
  occurredAt: z.string().datetime().optional(),
  reference: z.string().max(300).optional(),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, schema)
  if (input.feeCents > input.grossCents) throw new ApiError('validation_error', 'Processing fees cannot exceed gross revenue.')

  const net = input.grossCents - input.feeCents
  const rows = await db
    .insert(revenueTransactions)
    .values({
      workspaceId,
      projectId: input.projectId ?? null,
      source: input.source,
      provider: input.provider ?? 'manual',
      providerTransactionId: input.providerTransactionId ?? null,
      description: truncate(input.description, 500),
      grossCents: input.grossCents,
      feeCents: input.feeCents,
      netCents: net,
      currency: input.currency,
      status: 'confirmed',
      verification: 'manual',
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      recordedByUserId: ctx.session.id,
      metadata: { reference: input.reference ?? null, enteredBy: ctx.session.email },
      demo: false,
    })
    .returning()

  if (input.projectId) await recalculateProjectFinancials(input.projectId)

  await notify({
    workspaceId,
    type: 'revenue_recorded',
    severity: 'success',
    title: `Revenue recorded: ${formatMoney(net, input.currency)} net`,
    body: `${input.description} — recorded manually, verified after reconciliation.`,
    link: '/dashboard/revenue',
    dedupeKey: `revenue:${rows[0]!.id}`,
  })

  return created({ transaction: rows[0], note: 'Manually recorded revenue. It is not counted as verified integration revenue until a provider webhook confirms it.' })
})
