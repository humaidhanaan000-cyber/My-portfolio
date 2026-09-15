/** GET /api/projects/:id/export — Markdown bundle of the project's approved assets. */
import { and, eq } from 'drizzle-orm'
import { getDb, projects } from '@/lib/db'
import { ApiError, ok, withApi } from '@/lib/api/http'
import { exportProjectAssets } from '@/lib/integrations'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const project = (
    await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, ctx.params.id!), eq(projects.workspaceId, ctx.session.workspaceId))).limit(1)
  )[0]
  if (!project) throw new ApiError('not_found', 'Project not found.')
  const result = await exportProjectAssets(ctx.session.workspaceId, project.id)
  return ok({ markdown: result.markdown, assetCount: result.count })
})
