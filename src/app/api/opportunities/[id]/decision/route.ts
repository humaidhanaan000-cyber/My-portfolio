/**
 * POST /api/opportunities/:id/decision — approve, reject or archive.
 * Every decision writes an audit record and an opportunity_decisions row.
 */
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { getDb, auditLogs, opportunities, opportunityCandidates, opportunityScores } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'
import { notify } from '@/lib/notifications'
import { enqueue } from '@/lib/queue'

export const dynamic = 'force-dynamic'

const schema = z.object({
  decision: z.enum(['approve', 'reject', 'archive']),
  note: z.string().max(1000).optional(),
  createStrategy: z.boolean().default(false),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const opportunity = (
    await db.select().from(opportunities).where(and(eq(opportunities.id, ctx.params.id!), eq(opportunities.workspaceId, workspaceId))).limit(1)
  )[0]
  if (!opportunity) throw new ApiError('not_found', 'Opportunity not found.')

  const input = await parseBody(ctx.request, schema)
  const status = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'archived'
  const latestScore = (
    await db.select({ finalScore: opportunityScores.finalScore }).from(opportunityScores).where(eq(opportunityScores.opportunityId, opportunity.id)).orderBy(desc(opportunityScores.version)).limit(1)
  )[0]

  await db
    .update(opportunities)
    .set({
      status,
      decision: input.decision === 'archive' ? 'archived' : input.decision === 'approve' ? 'approved' : 'rejected',
      decisionNote: input.note ?? null,
      decidedByUserId: ctx.session.id,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(opportunities.id, opportunity.id))

  await db.insert(opportunityCandidates).values({
    workspaceId,
    opportunityId: opportunity.id,
    decision: input.decision,
    reason: input.note ?? '',
    actor: ctx.session.email,
    scoreAtDecision: latestScore?.finalScore ?? null,
  })

  await db.insert(auditLogs).values({
    workspaceId,
    userId: ctx.session.id,
    actorType: 'user',
    action: `opportunity.${input.decision}`,
    entityType: 'opportunity',
    entityId: opportunity.id,
    before: { status: opportunity.status } as Record<string, unknown>,
    after: { status, note: input.note ?? null } as Record<string, unknown>,
  })

  let strategyQueued = false
  if (input.decision === 'approve' && input.createStrategy) {
    await enqueue(
      'agent.strategy',
      { opportunityIds: [opportunity.id], useAi: true, createProject: true, requestApproval: true },
      { queue: 'analysis', priority: 2, workspaceId, dedupeKey: `strategy:${opportunity.id}` },
    )
    strategyQueued = true
  }

  await notify({
    workspaceId,
    type: 'system',
    severity: input.decision === 'approve' ? 'success' : 'info',
    title: `Opportunity ${input.decision}d`,
    body: opportunity.title.slice(0, 160),
    link: `/dashboard/opportunities/${opportunity.id}`,
    userId: ctx.session.id,
    dedupeKey: `opp-decision:${opportunity.id}:${input.decision}`,
  })

  return ok({ id: opportunity.id, status, strategyQueued, scoreAtDecision: latestScore?.finalScore ?? null })
})
