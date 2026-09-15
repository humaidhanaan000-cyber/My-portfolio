/**
 * Agent memory.
 *
 * Memory is summarised, typed, importance-weighted and **bounded**: entries carry
 * an expiry, low-importance entries are pruned on a schedule, and long histories
 * are compressed into `memory_summaries` rows. There is no unbounded transcript
 * store, so cost and context size stay predictable.
 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { getDb, agentMemory, memorySummaries } from '../db'
import { clamp, truncate, variance } from '../utils'

export type MemoryKind = 'insight' | 'decision' | 'preference' | 'pattern' | 'summary'

export type MemoryWrite = {
  workspaceId: string
  agentKey: string
  kind: MemoryKind
  key: string
  content: string
  importance?: number
  refType?: string
  refId?: string
  data?: Record<string, unknown>
  ttlDays?: number
}

/** Default retention per importance level (days). Higher importance lives longer. */
export const RETENTION_DAYS: Record<number, number> = { 1: 14, 2: 45, 3: 120, 4: 365, 5: 1095 }

export const MAX_MEMORY_ENTRIES_PER_AGENT = 500
export const MAX_CONTENT_LENGTH = 2000

export async function remember(input: MemoryWrite): Promise<{ id: string }> {
  const db = await getDb()
  const importance = clamp(Math.round(input.importance ?? 3), 1, 5)
  const ttl = input.ttlDays ?? RETENTION_DAYS[importance] ?? 120
  const expiresAt = new Date(Date.now() + ttl * 86_400_000)

  const rows = await db
    .insert(agentMemory)
    .values({
      workspaceId: input.workspaceId,
      agentKey: input.agentKey,
      kind: input.kind,
      key: input.key,
      content: truncate(input.content, MAX_CONTENT_LENGTH),
      importance,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      data: (input.data ?? {}) as Record<string, unknown>,
      expiresAt,
    })
    .returning({ id: agentMemory.id })

  await enforceBound(input.workspaceId, input.agentKey)
  return { id: rows[0]!.id }
}

/** Keep each agent's memory bounded by pruning the least important entries. */
export async function enforceBound(workspaceId: string, agentKey: string): Promise<number> {
  const db = await getDb()
  const countRows = await db
    .select({ value: sql<string>`count(*)::text` })
    .from(agentMemory)
    .where(and(eq(agentMemory.workspaceId, workspaceId), eq(agentMemory.agentKey, agentKey)))
  const count = Number(countRows[0]?.value ?? 0)
  if (count <= MAX_MEMORY_ENTRIES_PER_AGENT) return 0

  const excess = count - MAX_MEMORY_ENTRIES_PER_AGENT
  const removable = await db
    .select({ id: agentMemory.id })
    .from(agentMemory)
    .where(and(eq(agentMemory.workspaceId, workspaceId), eq(agentMemory.agentKey, agentKey)))
    .orderBy(agentMemory.importance, agentMemory.createdAt)
    .limit(excess)

  for (const row of removable) {
    await db.delete(agentMemory).where(eq(agentMemory.id, row.id))
  }
  return removable.length
}

export type MemoryQuery = {
  workspaceId: string
  agentKey?: string
  kinds?: MemoryKind[]
  minImportance?: number
  search?: string
  limit?: number
  includeExpired?: boolean
}

export async function recall(query: MemoryQuery): Promise<(typeof agentMemory.$inferSelect)[]> {
  const db = await getDb()
  const conditions = [eq(agentMemory.workspaceId, query.workspaceId)]
  if (query.agentKey) conditions.push(eq(agentMemory.agentKey, query.agentKey))
  if (query.minImportance) conditions.push(gte(agentMemory.importance, query.minImportance))
  if (!query.includeExpired) conditions.push(sql`(${agentMemory.expiresAt} is null or ${agentMemory.expiresAt} > now())`)
  if (query.kinds?.length) conditions.push(sql`${agentMemory.kind} = any(${sql.raw(`array['${query.kinds.join("','")}']`)})`)
  if (query.search) conditions.push(sql`${agentMemory.content} ilike ${`%${query.search}%`}`)

  return db
    .select()
    .from(agentMemory)
    .where(and(...conditions))
    .orderBy(desc(agentMemory.importance), desc(agentMemory.createdAt))
    .limit(Math.min(query.limit ?? 50, 200))
}

/**
 * Build the compact context block handed to an agent prompt. Only the highest
 * value, non-expired entries are included, and the total is length-capped.
 */
export async function memoryContext(workspaceId: string, agentKey: string, limit = 12, maxChars = 4000): Promise<string> {
  const entries = await recall({ workspaceId, agentKey, minImportance: 2, limit })
  if (entries.length === 0) return ''
  const lines: string[] = []
  let used = 0
  for (const entry of entries) {
    const line = `- [${entry.kind}] ${entry.content}`
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

/** Compress raw entries for a period into a single summary row. */
export async function summarise(input: {
  workspaceId: string
  scope: 'workspace' | 'category' | 'project'
  scopeKey?: string | null
  periodDays?: number
  useAi?: boolean
}): Promise<{ summary: string; entriesCompressed: number; metrics: Record<string, number> }> {
  const db = await getDb()
  const days = input.periodDays ?? 7
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - days * 86_400_000)

  const entries = await db
    .select()
    .from(agentMemory)
    .where(and(eq(agentMemory.workspaceId, input.workspaceId), gte(agentMemory.createdAt, periodStart)))
    .orderBy(desc(agentMemory.importance))
    .limit(300)

  const importance = entries.map((entry) => entry.importance)
  const metrics = {
    entries: entries.length,
    highImportance: entries.filter((entry) => entry.importance >= 4).length,
    meanImportance: importance.length ? Number((importance.reduce((a, b) => a + b, 0) / importance.length).toFixed(2)) : 0,
    importanceStddev: Number(variance(importance).stddev.toFixed(2)),
    agents: new Set(entries.map((entry) => entry.agentKey)).size,
  }

  const summary =
    entries.length === 0
      ? `No new agent memory in the last ${days} days.`
      : truncate(
          `Across ${metrics.agents} agent(s), ${entries.length} memory entries were recorded in the last ${days} days ` +
            `(${metrics.highImportance} of high importance). Dominant themes: ` +
            `${Array.from(new Set(entries.slice(0, 25).map((entry) => entry.kind))).join(', ')}. ` +
            `Top remembered item: ${entries[0]!.content}`,
          1500,
        )

  await db.insert(memorySummaries).values({
    workspaceId: input.workspaceId,
    scope: input.scope,
    scopeKey: input.scopeKey ?? null,
    periodStart,
    periodEnd,
    summary,
    metrics,
  })

  return { summary, entriesCompressed: entries.length, metrics }
}

/** Delete expired and over-age low-importance entries. Called by the scheduled maintenance job. */
export async function pruneMemory(workspaceId: string, retentionDays = 180): Promise<{ expired: number; aged: number }> {
  const db = await getDb()
  const expired = await db
    .delete(agentMemory)
    .where(and(eq(agentMemory.workspaceId, workspaceId), lt(agentMemory.expiresAt, new Date())))
    .returning({ id: agentMemory.id })

  const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
  const aged = await db
    .delete(agentMemory)
    .where(and(eq(agentMemory.workspaceId, workspaceId), lt(agentMemory.createdAt, cutoff), lt(agentMemory.importance, 4)))
    .returning({ id: agentMemory.id })

  return { expired: expired.length, aged: aged.length }
}

export async function memoryStats(workspaceId: string) {
  const db = await getDb()
  const [byAgent, byKind, totals] = await Promise.all([
    db
      .select({ agentKey: agentMemory.agentKey, value: sql<string>`count(*)::text`, avgImportance: sql<string>`coalesce(round(avg(${agentMemory.importance}), 2), 0)::text` })
      .from(agentMemory)
      .where(eq(agentMemory.workspaceId, workspaceId))
      .groupBy(agentMemory.agentKey),
    db
      .select({ kind: agentMemory.kind, value: sql<string>`count(*)::text` })
      .from(agentMemory)
      .where(eq(agentMemory.workspaceId, workspaceId))
      .groupBy(agentMemory.kind),
    db.select({ value: sql<string>`count(*)::text` }).from(agentMemory).where(eq(agentMemory.workspaceId, workspaceId)),
  ])
  const summaries = await db
    .select()
    .from(memorySummaries)
    .where(eq(memorySummaries.workspaceId, workspaceId))
    .orderBy(desc(memorySummaries.periodEnd))
    .limit(10)

  return {
    total: Number(totals[0]?.value ?? 0),
    boundPerAgent: MAX_MEMORY_ENTRIES_PER_AGENT,
    byAgent: byAgent.map((row) => ({ agentKey: row.agentKey, count: Number(row.value), avgImportance: Number(row.avgImportance) })),
    byKind: byKind.map((row) => ({ kind: row.kind, count: Number(row.value) })),
    summaries,
    retentionNote: 'Memory is summarised and retention-bounded; low-importance entries expire first.',
  }
}
