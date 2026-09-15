/** GET /api/projects/:id — full project detail. PATCH — validated state transition. */
import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb, auditLogs, projects, projectEvents } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'
import { projectDetail } from '@/lib/analytics'
import { PROJECT_STATUSES, canTransition, STATUS_LABELS } from '@/lib/projects/status'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const detail = await projectDetail(ctx.session.workspaceId, ctx.params.id!)
  if (!detail) throw new ApiError('not_found', 'Project not found.')
  return ok(detail)
})

const patchSchema = z.object({
  status: z.enum(PROJECT_STATUSES).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  budgetCents: z.number().int().min(0).optional(),
  objective: z.string().min(10).max(2000).optional(),
  businessModel: z.string().max(200).optional(),
  revenueModel: z.string().max(200).optional(),
  automationLevel: z.enum(['recommend_only', 'approval_required', 'autonomous_low_risk']).optional(),
  failureReason: z.string().max(1000).optional(),
})

export const PATCH = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const project = (
    await db.select().from(projects).where(and(eq(projects.id, ctx.params.id!), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt))).limit(1)
  )[0]
  if (!project) throw new ApiError('not_found', 'Project not found.')

  const input = await parseBody(ctx.request, patchSchema)

  if (input.status && input.status !== project.status) {
    if (!canTransition(project.status, input.status)) {
      throw new ApiError('conflict', `Cannot move a project from ${STATUS_LABELS[project.status] ?? project.status} to ${STATUS_LABELS[input.status] ?? input.status}.`)
    }
    if (input.status === 'LAUNCHED') {
      throw new ApiError('policy_blocked', 'Launching is a public, hard-to-reverse step. Use POST /api/projects/:id/launch, which records the approval and audit trail.')
    }
  }

  const patch: Record<string, unknown> = { ...input, updatedAt: new Date() }
  if (input.status === 'PAUSED') patch.pausedAt = new Date()
  if (input.status === 'COMPLETED') patch.completedAt = new Date()

  const rows = await db.update(projects).set(patch).where(eq(projects.id, project.id)).returning()

  await db.insert(projectEvents).values({
    workspaceId,
    projectId: project.id,
    type: 'updated',
    actor: ctx.session.email,
    message: input.status
      ? `Status moved from ${STATUS_LABELS[project.status] ?? project.status} to ${STATUS_LABELS[input.status] ?? input.status}.`
      : 'Project details updated.',
    data: input as Record<string, unknown>,
  })

  await db.insert(auditLogs).values({
    workspaceId,
    userId: ctx.session.id,
    actorType: 'user',
    action: 'project.updated',
    entityType: 'project',
    entityId: project.id,
    before: { status: project.status, budgetCents: project.budgetCents } as Record<string, unknown>,
    after: input as Record<string, unknown>,
  })

  return ok({ project: rows[0] })
})

export const DELETE = withApi(async (ctx) => {
  const db = await getDb()
  const project = (
    await db.select().from(projects).where(and(eq(projects.id, ctx.params.id!), eq(projects.workspaceId, ctx.session.workspaceId))).limit(1)
  )[0]
  if (!project) throw new ApiError('not_found', 'Project not found.')
  await db.update(projects).set({ deletedAt: new Date(), status: 'COMPLETED', updatedAt: new Date() }).where(eq(projects.id, project.id))
  return ok({ deleted: true })
})
