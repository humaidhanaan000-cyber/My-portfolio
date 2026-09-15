/** POST /api/opportunities/:id/strategy — generate (or regenerate) the business strategy. */
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { getDb, opportunities, strategies } from '@/lib/db'
import { ApiError, created, ok, parseBody, withApi } from '@/lib/api/http'
import { runAgentByKey } from '@/lib/agents/registry'

export const dynamic = 'force-dynamic'

const schema = z.object({
  useAi: z.boolean().default(true),
  createProject: z.boolean().default(true),
  requestApproval: z.boolean().default(true),
})

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const rows = await db.select().from(strategies).where(eq(strategies.opportunityId, ctx.params.id!)).orderBy(desc(strategies.version)).limit(10)
  return ok(rows)
})

export const POST = withApi(
  async (ctx) => {
    const db = await getDb()
    const workspaceId = ctx.session.workspaceId
    const opportunity = (
      await db.select().from(opportunities).where(and(eq(opportunities.id, ctx.params.id!), eq(opportunities.workspaceId, workspaceId))).limit(1)
    )[0]
    if (!opportunity) throw new ApiError('not_found', 'Opportunity not found.')

    const input = await parseBody(ctx.request, schema)
    const outcome = await runAgentByKey('strategy', { opportunityIds: [opportunity.id], ...input }, {
      workspaceId,
      triggeredBy: 'user',
      userId: ctx.session.id,
      approveImmediately: true,
    })
    if (outcome.status !== 'succeeded') {
      throw new ApiError('internal_error', outcome.error ?? 'Strategy generation failed.')
    }
    const data = outcome.output!.data as { strategies: { id: string; projectId?: string; approvalId?: string }[] }
    const created_ = data.strategies[0]
    return created({
      strategyId: created_?.id,
      projectId: created_?.projectId,
      approvalId: created_?.approvalId,
      summary: outcome.output!.summary,
      notes: outcome.output!.notes ?? [],
    })
  },
  { rateLimit: { limit: 20, windowMs: 60_000, scope: 'strategy' } },
)
