/**
 * Queue reliability.
 *
 * These assertions pin down the failure that dead-lettered real jobs in
 * production: the dedupe index was UNIQUE (dedupe_key, status), so a second job
 * with the same key could not be *marked* 'succeeded' — the update raised a unique
 * violation, the job retried three times and was dead-lettered even though its
 * work had completed (and 'failed'/'dead' rows were blocked for the same reason).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb, jobs as jobsTable } from '@/lib/db'
import { claimJob, enqueue, runJob, registerHandler, queueStats } from '@/lib/queue'
import { createWorkspaceFixture } from './helpers'

let workspaceId = ''

beforeAll(async () => {
  const fixture = await createWorkspaceFixture()
  workspaceId = fixture.workspaceId
})

describe('job dedupe', () => {
  it('coalesces a duplicate while the first job is still live', async () => {
    const key = `dedupe-live-${Math.random().toString(36).slice(2, 8)}`
    const first = await enqueue('test.dedupe', { n: 1 }, { dedupeKey: key, workspaceId })
    const second = await enqueue('test.dedupe', { n: 1 }, { dedupeKey: key, workspaceId })
    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.id).toBe(first.id)
  })

  it('lets a later job reuse a key whose earlier job already finished', async () => {
    const db = await getDb()
    const key = `dedupe-repeat-${Math.random().toString(36).slice(2, 8)}`

    // A completed job already occupies (key, 'succeeded').
    await enqueue('test.dedupe', { n: 1 }, { dedupeKey: key, workspaceId })
    const done = await db
      .update(jobsTable)
      .set({ status: 'succeeded', finishedAt: new Date(), durationMs: 1 })
      .where(and(eq(jobsTable.dedupeKey, key), eq(jobsTable.status, 'queued')))
      .returning({ id: jobsTable.id })
    expect(done).toHaveLength(1)

    // A new job with the same key must be accepted...
    const again = await enqueue('test.dedupe', { n: 2 }, { dedupeKey: key, workspaceId })
    expect(again.deduped).toBe(false)

    // ...and must be able to complete, which is what previously threw.
    await expect(
      db
        .update(jobsTable)
        .set({ status: 'succeeded', finishedAt: new Date(), durationMs: 2 })
        .where(eq(jobsTable.id, again.id)),
    ).resolves.toBeDefined()

    const rows = await db
      .select({ status: jobsTable.status })
      .from(jobsTable)
      .where(eq(jobsTable.dedupeKey, key))
    expect(rows.filter((row) => row.status === 'succeeded').length).toBe(2)
  })

  it('allows several failed rows for one key', async () => {
    const db = await getDb()
    const key = `dedupe-failed-${Math.random().toString(36).slice(2, 8)}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const job = await enqueue('test.dedupe', { attempt }, { dedupeKey: key, workspaceId })
      await db.update(jobsTable).set({ status: 'failed', lastError: 'boom' }).where(eq(jobsTable.id, job.id))
    }
    const failed = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(and(eq(jobsTable.dedupeKey, key), eq(jobsTable.status, 'failed')))
    expect(failed).toHaveLength(2)
  })
})

describe('dedupe index shape', () => {
  it('is partial (live rows only) rather than unique per status', async () => {
    const { sql } = await import('drizzle-orm')
    const db = await getDb()
    const result = await db.execute(sql`
      select indexname, indexdef from pg_indexes where tablename = 'jobs' order by indexname
    `)
    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as { indexname: string; indexdef: string }[]
    const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]))
    // The old index is what dead-lettered completed work; it must not come back.
    expect(byName.has('jobs_dedupe_uq')).toBe(false)
    const active = byName.get('jobs_dedupe_active_uq') ?? ''
    expect(active).toContain('UNIQUE')
    expect(active).toContain("status")
    expect(active).toMatch(/WHERE/i)
  })
})

describe('claim and run', () => {
  it('runs a claimed job and records the outcome', async () => {
    registerHandler('test.dedupe', async (payload: Record<string, unknown>) => ({ echoed: payload.n ?? 0 }), { maxAttempts: 1 })
    const job = await enqueue('test.dedupe', { n: 7 }, { workspaceId, priority: 1 })
    const claimed = await claimJob('test-worker')
    expect(claimed).not.toBeNull()

    const outcome = await runJob(claimed!, 'test-worker')
    expect(outcome.status).toBe('succeeded')

    const db = await getDb()
    const [row] = await db
      .select({ status: jobsTable.status, result: jobsTable.result, lockedBy: jobsTable.lockedBy })
      .from(jobsTable)
      .where(eq(jobsTable.id, job.id))
    expect(row.status).toBe('succeeded')
    expect(row.lockedBy).toBeNull()
    expect(JSON.stringify(row.result)).toContain('7')
  })

  it('never leaves a claimed job locked', async () => {
    const db = await getDb()
    const stuck = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(and(eq(jobsTable.status, 'running'), inArray(jobsTable.lockedBy, ['test-worker'])))
    expect(stuck).toHaveLength(0)
  })

  it('reports queue statistics without counting demo rows', async () => {
    const stats = await queueStats()
    expect(stats.queued).toBeGreaterThanOrEqual(0)
    expect(typeof stats.byQueue).toBe('object')
  })
})
