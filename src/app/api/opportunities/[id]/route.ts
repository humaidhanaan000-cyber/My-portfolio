/** GET/PATCH/DELETE /api/opportunities/:id */
import { z } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb, opportunities, opportunityScores, strategies, projects, opportunityCandidates } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'

export const dynamic = 'force-dynamic'

async function load(workspaceId: string, id: string) {
  const db = await getDb()
  const rows = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId), isNull(opportunities.deletedAt)))
    .limit(1)
  if (!rows[0]) throw new ApiError('not_found', 'Opportunity not found.')
  return rows[0]
}

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const opportunity = await load(ctx.session.workspaceId, ctx.params.id!)
  const [scores, strategyRows, projectRows, decisions] = await Promise.all([
    db.select().from(opportunityScores).where(eq(opportunityScores.opportunityId, opportunity.id)).orderBy(desc(opportunityScores.version)).limit(10),
    db.select().from(strategies).where(eq(strategies.opportunityId, opportunity.id)).orderBy(desc(strategies.version)).limit(5),
    db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projects).where(eq(projects.opportunityId, opportunity.id)),
    db.select().from(opportunityCandidates).where(eq(opportunityCandidates.opportunityId, opportunity.id)).orderBy(desc(opportunityCandidates.createdAt)).limit(20),
  ])
  return ok({ opportunity, latestScore: scores[0] ?? null, scores, strategies: strategyRows, projects: projectRows, decisions })
})

const patchSchema = z.object({
  title: z.string().min(5).max(200).optional(),
  description: z.string().min(10).max(8000).optional(),
  category: z.string().max(60).optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
  status: z.enum(['discovered', 'cleaned', 'scored', 'strategy_ready', 'approved', 'rejected', 'archived']).optional(),
})

export const PATCH = withApi(async (ctx) => {
  const db = await getDb()
  const opportunity = await load(ctx.session.workspaceId, ctx.params.id!)
  const input = await parseBody(ctx.request, patchSchema)
  const rows = await db
    .update(opportunities)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(opportunities.id, opportunity.id))
    .returning()
  return ok({ opportunity: rows[0] })
})

/** Soft delete (retained for audit; purgeable after the retention window). */
export const DELETE = withApi(async (ctx) => {
  const db = await getDb()
  const opportunity = await load(ctx.session.workspaceId, ctx.params.id!)
  await db.update(opportunities).set({ deletedAt: new Date(), status: 'archived', updatedAt: new Date() }).where(eq(opportunities.id, opportunity.id))
  return ok({ deleted: true, id: opportunity.id })
})
