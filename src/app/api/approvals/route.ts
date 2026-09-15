/**
 * GET /api/approvals — the approval centre queue with counts per status.
 * Approvals are the human gate in front of every risky, paid or irreversible
 * action. Nothing executes without a row here being approved by a user.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb, approvals, projects } from '@/lib/db'
import { ok, paginationSchema, withApi } from '@/lib/api/http'
import { approvalStats } from '@/lib/approvals'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const page = paginationSchema(25).parse(ctx.searchParams)
  const conditions = [eq(approvals.workspaceId, ctx.session.workspaceId)]

  const statuses = ctx.searchParams.getAll('status').flatMap((value) => value.split(',')).filter(Boolean)
  conditions.push(inArray(approvals.status, statuses.length ? statuses : ['pending']))
  const risk = ctx.searchParams.getAll('risk').flatMap((value) => value.split(',')).filter(Boolean)
  if (risk.length) conditions.push(inArray(approvals.risk, risk))
  if (page.q) conditions.push(sql`(${approvals.title} ilike ${`%${page.q}%`} or ${approvals.reason} ilike ${`%${page.q}%`})`)
  const projectId = ctx.searchParams.get('projectId')
  if (projectId) conditions.push(eq(approvals.projectId, projectId))

  const where = and(...conditions)
  const [rows, totalRow, stats] = await Promise.all([
    db
      .select({
        id: approvals.id,
        title: approvals.title,
        actionType: approvals.actionType,
        reason: approvals.reason,
        expectedCostCents: approvals.expectedCostCents,
        potentialBenefit: approvals.potentialBenefit,
        risk: approvals.risk,
        payload: approvals.payload,
        status: approvals.status,
        requestedByAgent: approvals.requestedByAgent,
        decidedByUserId: approvals.decidedByUserId,
        decidedAt: approvals.decidedAt,
        decisionNote: approvals.decisionNote,
        executionResult: approvals.executionResult,
        executionError: approvals.executionError,
        expiresAt: approvals.expiresAt,
        createdAt: approvals.createdAt,
        projectId: approvals.projectId,
        projectName: projects.name,
        projectStatus: projects.status,
        demo: projects.demo,
      })
      .from(approvals)
      .leftJoin(projects, eq(projects.id, approvals.projectId))
      .where(where)
      .orderBy(desc(approvals.createdAt))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ value: sql<string>`count(*)::text` }).from(approvals).where(where),
    approvalStats(ctx.session.workspaceId),
  ])

  const total = Number(totalRow[0]?.value ?? 0)
  return ok(rows, {
    page: page.page,
    limit: page.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / page.limit)),
    stats,
  })
})
