/** GET /api/agents/runs — agent run history with cost, tokens and timing. */
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb, agentRuns, agentMemory } from '@/lib/db'
import { ok, paginationSchema, withApi } from '@/lib/api/http'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const page = paginationSchema(30).parse(ctx.searchParams)
  const conditions = [eq(agentRuns.workspaceId, ctx.session.workspaceId)]
  const keys = ctx.searchParams.getAll('agent').flatMap((value) => value.split(',')).filter(Boolean)
  if (keys.length) conditions.push(sql`${agentRuns.agentKey} = any(${sql.raw(`array['${keys.join("','")}']`)})`)
  const statuses = ctx.searchParams.getAll('status').flatMap((value) => value.split(',')).filter(Boolean)
  if (statuses.length) conditions.push(sql`${agentRuns.status} = any(${sql.raw(`array['${statuses.join("','")}']`)})`)
  if (ctx.searchParams.get('since')) conditions.push(gte(agentRuns.startedAt, new Date(ctx.searchParams.get('since')!)))

  const where = and(...conditions)
  const [runs, totalRow, memory] = await Promise.all([
    db.select().from(agentRuns).where(where).orderBy(desc(agentRuns.startedAt)).limit(page.limit).offset(page.offset),
    db.select({ value: sql<string>`count(*)::text` }).from(agentRuns).where(where),
    db
      .select({ id: agentMemory.id, agentKey: agentMemory.agentKey, kind: agentMemory.kind, key: agentMemory.key, content: agentMemory.content, importance: agentMemory.importance, createdAt: agentMemory.createdAt, expiresAt: agentMemory.expiresAt })
      .from(agentMemory)
      .where(eq(agentMemory.workspaceId, ctx.session.workspaceId))
      .orderBy(desc(agentMemory.createdAt))
      .limit(50),
  ])

  const total = Number(totalRow[0]?.value ?? 0)
  return ok({ runs, memory }, { page: page.page, limit: page.limit, total, totalPages: Math.max(1, Math.ceil(total / page.limit)) })
})
