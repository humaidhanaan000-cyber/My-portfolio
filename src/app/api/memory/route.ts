/** GET /api/memory — agent memory contents, stats and summaries. POST — pin or forget an entry. */
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getDb, agentMemory } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'
import { memoryStats, recall, summarise, type MemoryKind } from '@/lib/memory'

const MEMORY_KINDS: MemoryKind[] = ['insight', 'decision', 'preference', 'pattern', 'summary']

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const workspaceId = ctx.session.workspaceId
  const agentKey = ctx.searchParams.get('agent') ?? undefined
  const search = ctx.searchParams.get('q') ?? undefined
  const limit = Math.min(200, Math.max(1, Number(ctx.searchParams.get('limit') ?? 60)))
  // `kind` is a comma-separated filter (insight,decision,…) so the memory screen
  // can show decision memory separately from patterns and summaries.
  const kinds = (ctx.searchParams.get('kind') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is MemoryKind => (MEMORY_KINDS as string[]).includes(value))
  const [entries, stats] = await Promise.all([
    recall({ workspaceId, agentKey, search, limit, ...(kinds.length ? { kinds } : {}) }),
    memoryStats(workspaceId),
  ])
  return ok({ entries, stats })
})

const schema = z.object({
  action: z.enum(['forget', 'promote', 'summarise']),
  id: z.string().uuid().optional(),
  agentKey: z.string().max(40).optional(),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const input = await parseBody(ctx.request, schema)

  if (input.action === 'summarise') {
    const result = await summarise({ workspaceId: ctx.session.workspaceId, scope: 'workspace', periodDays: 7 })
    return ok(result)
  }

  if (!input.id) throw new ApiError('validation_error', 'An entry id is required.')
  const entry = (
    await db
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.id, input.id), eq(agentMemory.workspaceId, ctx.session.workspaceId)))
      .limit(1)
  )[0]
  if (!entry) throw new ApiError('not_found', 'Memory entry not found.')

  if (input.action === 'forget') {
    await db.delete(agentMemory).where(eq(agentMemory.id, entry.id))
    return ok({ forgotten: true })
  }

  const rows = await db.update(agentMemory).set({ importance: 5 }).where(eq(agentMemory.id, entry.id)).returning()
  return ok({ entry: rows[0], note: 'Pinned at the highest importance; it will be retained longest.' })
})
