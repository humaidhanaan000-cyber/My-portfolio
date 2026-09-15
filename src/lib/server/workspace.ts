/**
 * Server-side workspace helpers for pages.
 *
 * These run inside server components, read only from the workspace named by the
 * session, and return plain serialisable data — no secrets, no client imports.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { getDb, projects } from '../db'

export type ProjectOption = { id: string; name: string }

/** Projects a form can attach money to (archived rows excluded). */
export async function loadProjectOptions(workspaceId: string): Promise<ProjectOption[]> {
  const db = await getDb()
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
    .orderBy(projects.name)
    .limit(200)
  return rows
}
