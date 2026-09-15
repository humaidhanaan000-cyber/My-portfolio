/** Task management for a project. */
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { getDb, projects, tasks } from '@/lib/db'
import { ApiError, created, ok, parseBody, withApi } from '@/lib/api/http'

export const dynamic = 'force-dynamic'

async function assertProject(workspaceId: string, projectId: string) {
  const db = await getDb()
  const rows = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId))).limit(1)
  if (!rows[0]) throw new ApiError('not_found', 'Project not found.')
}

export const GET = withApi(async (ctx) => {
  await assertProject(ctx.session.workspaceId, ctx.params.id!)
  const db = await getDb()
  const rows = await db.select().from(tasks).where(eq(tasks.projectId, ctx.params.id!)).orderBy(asc(tasks.position))
  return ok(rows)
})

const createSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).default(''),
  priority: z.number().int().min(1).max(5).default(3),
  assigneeAgentKey: z.string().max(40).nullable().default(null),
  requiresApproval: z.boolean().default(false),
  estimatedCostCents: z.number().int().min(0).default(0),
})

export const POST = withApi(async (ctx) => {
  await assertProject(ctx.session.workspaceId, ctx.params.id!)
  const db = await getDb()
  const input = await parseBody(ctx.request, createSchema)
  const existing = await db.select({ position: tasks.position }).from(tasks).where(eq(tasks.projectId, ctx.params.id!))
  const rows = await db
    .insert(tasks)
    .values({
      workspaceId: ctx.session.workspaceId,
      projectId: ctx.params.id!,
      ...input,
      position: existing.length,
    })
    .returning()
  return created(rows[0])
})

const patchSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'failed', 'cancelled']).optional(),
  title: z.string().min(3).max(200).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  lastError: z.string().max(1000).nullable().optional(),
})

export const PATCH = withApi(async (ctx) => {
  await assertProject(ctx.session.workspaceId, ctx.params.id!)
  const db = await getDb()
  const input = await parseBody(ctx.request, patchSchema)
  const { taskId, ...patch } = input
  const rows = await db
    .update(tasks)
    .set({
      ...patch,
      ...(patch.status === 'in_progress' ? { startedAt: new Date() } : {}),
      ...(patch.status === 'done' || patch.status === 'failed' ? { finishedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.params.id!)))
    .returning()
  if (!rows[0]) throw new ApiError('not_found', 'Task not found.')
  return ok({ task: rows[0] })
})
