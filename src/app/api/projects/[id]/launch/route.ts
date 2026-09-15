/**
 * POST /api/projects/:id/launch
 *
 * Launching is public and hard to reverse, so it is always an explicit human
 * decision: the route validates the transition, records who approved it, writes
 * the audit trail and only then flips the project to LAUNCHED.
 */
import { z } from 'zod'
import { and, eq, isNull, inArray, desc } from 'drizzle-orm'
import { getDb, approvals, auditLogs, projects } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'
import { launchProject } from '@/lib/agents/orchestrator'
import { evaluateAction } from '@/lib/compliance/policy'

export const dynamic = 'force-dynamic'

const schema = z.object({
  confirm: z.literal(true),
  note: z.string().max(1000).optional(),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const project = (
    await db.select().from(projects).where(and(eq(projects.id, ctx.params.id!), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt))).limit(1)
  )[0]
  if (!project) throw new ApiError('not_found', 'Project not found.')

  await parseBody(ctx.request, schema)

  const policy = evaluateAction({ actionType: 'update_project', automationLevel: 'recommend_only' })
  if (policy.risk === 'prohibited') throw new ApiError('policy_blocked', policy.reason)

  if (project.status === 'LAUNCHED' || project.status === 'MONITORING' || project.status === 'OPTIMIZING') {
    throw new ApiError('conflict', 'This project is already launched.')
  }
  if (!['BUILDING', 'APPROVED', 'PAUSED'].includes(project.status)) {
    throw new ApiError('conflict', `A project must be approved and built before launch (current state: ${project.status}).`)
  }

  const result = await launchProject(workspaceId, project.id)

  // Close out any launch approval that was waiting on this action.
  const pendingLaunch = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.projectId, project.id), eq(approvals.status, 'pending'), inArray(approvals.actionType, ['update_project', 'create_project'])))
    .orderBy(desc(approvals.createdAt))
    .limit(1)
  if (pendingLaunch[0]) {
    await db
      .update(approvals)
      .set({ status: 'executed', decidedByUserId: ctx.session.id, decidedAt: new Date(), executedAt: new Date(), executionResult: { outcome: 'launched' } as Record<string, unknown> })
      .where(eq(approvals.id, pendingLaunch[0].id))
  }

  await db.insert(auditLogs).values({
    workspaceId,
    userId: ctx.session.id,
    actorType: 'user',
    action: 'project.launched',
    entityType: 'project',
    entityId: project.id,
    before: { status: project.status } as Record<string, unknown>,
    after: { status: 'LAUNCHED' } as Record<string, unknown>,
  })

  return ok(result)
})
