/** GET latest score / POST rescore an opportunity synchronously. */
import { and, desc, eq } from 'drizzle-orm'
import { getDb, opportunities, opportunityScores, profiles } from '@/lib/db'
import { ApiError, created, ok, withApi } from '@/lib/api/http'
import { runAgentByKey } from '@/lib/agents/registry'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const opportunity = (
    await db.select().from(opportunities).where(and(eq(opportunities.id, ctx.params.id!), eq(opportunities.workspaceId, ctx.session.workspaceId))).limit(1)
  )[0]
  if (!opportunity) throw new ApiError('not_found', 'Opportunity not found.')
  const scores = await db.select().from(opportunityScores).where(eq(opportunityScores.opportunityId, opportunity.id)).orderBy(desc(opportunityScores.version)).limit(10)
  return ok({ latest: scores[0] ?? null, history: scores })
})

export const POST = withApi(
  async (ctx) => {
    const db = await getDb()
    const opportunity = (
      await db.select().from(opportunities).where(and(eq(opportunities.id, ctx.params.id!), eq(opportunities.workspaceId, ctx.session.workspaceId))).limit(1)
    )[0]
    if (!opportunity) throw new ApiError('not_found', 'Opportunity not found.')
    const profile = (await db.select().from(profiles).where(eq(profiles.workspaceId, ctx.session.workspaceId)).limit(1))[0]

    const outcome = await runAgentByKey(
      'analysis',
      { opportunityIds: [opportunity.id], batchSize: 1, useAi: true, rescore: true, autoStrategy: false },
      { workspaceId: ctx.session.workspaceId, triggeredBy: 'user', userId: ctx.session.id, approveImmediately: true },
    )
    if (outcome.status !== 'succeeded') {
      if (outcome.status === 'awaiting_approval') throw new ApiError('policy_blocked', outcome.policy.reason, { approvalId: outcome.approvalId })
      throw new ApiError('internal_error', outcome.error ?? 'Analysis failed.')
    }
    const latest = await db
      .select()
      .from(opportunityScores)
      .where(eq(opportunityScores.opportunityId, opportunity.id))
      .orderBy(desc(opportunityScores.version))
      .limit(1)
    return created({ score: latest[0] ?? null, summary: outcome.output?.summary, threshold: profile?.scoreThreshold ?? 70 })
  },
  { rateLimit: { limit: 30, windowMs: 60_000, scope: 'analyze' } },
)
