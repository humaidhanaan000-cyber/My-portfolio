/**
 * Scheduler claim semantics.
 *
 * These assertions protect the property that decides whether agents run the
 * right number of times: a due schedule is claimed once, not once per tick, and
 * a schedule that cannot be re-armed is reported instead of silently stopping.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { claimDueSchedules, rearmStalledSchedules } from '@/lib/scheduler/claim'
import { describeCron, nextCronRun, parseCron } from '@/lib/scheduler/cron'
import { getDb, schedules } from '@/lib/db'
import { createWorkspaceFixture } from './helpers'

let workspaceId = ''

async function insertSchedule(input: { cron: string; nextRunAt: Date | null; key: string; enabled?: boolean }) {
  const db = await getDb()
  const [row] = await db
    .insert(schedules)
    .values({
      key: `${input.key}-${Math.random().toString(36).slice(2, 8)}`,
      name: `Test schedule ${input.key}`,
      cron: input.cron,
      jobName: 'maintenance.cleanup',
      workspaceId,
      enabled: input.enabled ?? true,
      system: false,
      nextRunAt: input.nextRunAt,
    })
    .returning({ id: schedules.id, key: schedules.key })
  return row
}

beforeAll(async () => {
  const fixture = await createWorkspaceFixture()
  workspaceId = fixture.workspaceId
  const db = await getDb()
  // Start from a clean slate. `schedules` is derived system configuration: the
  // application always re-creates the defaults per workspace, and other suites
  // insert whatever they need, so clearing the whole table here keeps this suite
  // independent of previous runs (each run creates a fresh workspace).
  await db.delete(schedules)
})

describe('cron parsing', () => {
  it('accepts the cadences the product promises', () => {
    for (const expression of ['*/15 * * * *', '0 * * * *', '0 */6 * * *', '0 8 * * *', '0 9 * * 1']) {
      expect(() => parseCron(expression)).not.toThrow()
      expect(nextCronRun(expression, new Date('2026-03-01T00:07:00Z')).getTime()).toBeGreaterThan(
        new Date('2026-03-01T00:07:00Z').getTime(),
      )
    }
    expect(describeCron('*/15 * * * *')).toMatch(/15/)
  })

  it('rejects impossible expressions instead of silently never firing', () => {
    for (const expression of ['', '* * *', '61 * * * *', '0 0 * * 9']) {
      expect(() => parseCron(expression)).toThrow()
    }
  })
})

describe('claiming due schedules', () => {
  it('claims each due schedule exactly once and re-arms it', async () => {
    const now = new Date()
    const past = new Date(now.getTime() - 5 * 60_000)
    const future = new Date(now.getTime() + 60 * 60_000)

    const first = await insertSchedule({ key: 'due-a', cron: '*/15 * * * *', nextRunAt: past })
    const second = await insertSchedule({ key: 'due-b', cron: '0 * * * *', nextRunAt: past })
    const notYet = await insertSchedule({ key: 'future', cron: '0 * * * *', nextRunAt: future })
    await insertSchedule({ key: 'disabled', cron: '0 * * * *', nextRunAt: past, enabled: false })

    const rowCountAfterInsert = Number(
      (await (await getDb()).select({ n: sql<string>`count(*)::text` }).from(schedules).where(eq(schedules.workspaceId, workspaceId)))[0].n,
    )

    const claimed = await claimDueSchedules(25, now)
    const keys = claimed.map((row) => row.id)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    expect(claimed.map((row) => row.id)).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(claimed.some((row) => row.id === notYet.id)).toBe(false)

    for (const row of claimed) {
      expect(row.nextRunAt).toBeInstanceOf(Date)
      expect(row.nextRunAt!.getTime()).toBeGreaterThan(now.getTime())
    }

    // Second tick: nothing is due again — this is what stops a schedule from
    // queueing the same job on every tick.
    const repeat = await claimDueSchedules(25, now)
    expect(repeat).toHaveLength(0)

    // Claiming must never remove or duplicate schedule rows.
    const db = await getDb()
    const counted = await db.select({ n: sql<string>`count(*)::text` }).from(schedules).where(eq(schedules.workspaceId, workspaceId))
    expect(Number(counted[0].n)).toBe(rowCountAfterInsert)

    const rows = await db
      .select({ id: schedules.id, nextRunAt: schedules.nextRunAt, lastRunAt: schedules.lastRunAt, status: schedules.lastStatus })
      .from(schedules)
      .where(eq(schedules.workspaceId, workspaceId))
    for (const id of keys) {
      const row = rows.find((candidate) => candidate.id === id)
      expect(row?.nextRunAt).toBeInstanceOf(Date)
      expect(row?.nextRunAt!.getTime()).toBeGreaterThan(now.getTime())
      expect(row?.status).toBe('queued')
    }
  })

  it('limits how many schedules a single tick may claim', async () => {
    const now = new Date()
    const past = new Date(now.getTime() - 60_000)
    for (let index = 0; index < 4; index++) {
      await insertSchedule({ key: `burst-${index}`, cron: '*/5 * * * *', nextRunAt: past })
    }
    const claimed = await claimDueSchedules(2, now)
    expect(claimed).toHaveLength(2)
  })

  it('parks a schedule with an unusable cron expression instead of stalling the tick', async () => {
    const now = new Date()
    const row = await insertSchedule({ key: 'broken', cron: 'not-a-cron', nextRunAt: new Date(now.getTime() - 60_000) })
    const claimed = await claimDueSchedules(25, now)
    const broken = claimed.find((candidate) => candidate.id === row.id)
    expect(broken).toBeDefined()
    expect(broken!.nextRunAt).toBeNull()

    const db = await getDb()
    const [persisted] = await db.select({ nextRunAt: schedules.nextRunAt }).from(schedules).where(eq(schedules.id, row.id))
    // Parked in the future: it will be retried in an hour, not on every tick.
    expect(persisted.nextRunAt).toBeInstanceOf(Date)
    expect(persisted.nextRunAt!.getTime()).toBeGreaterThan(now.getTime())
  })

  it('re-arms schedules whose next run time went missing', async () => {
    const stalled = await insertSchedule({ key: 'stalled', cron: '0 */3 * * *', nextRunAt: null })
    const db = await getDb()
    const before = await db
      .select({ id: schedules.id })
      .from(schedules)
      .where(and(eq(schedules.workspaceId, workspaceId), isNull(schedules.nextRunAt)))
    expect(before.some((row) => row.id === stalled.id)).toBe(true)

    const repaired = await rearmStalledSchedules(new Date())
    expect(repaired).toBeGreaterThan(0)

    const [after] = await db.select({ nextRunAt: schedules.nextRunAt, status: schedules.lastStatus }).from(schedules).where(eq(schedules.id, stalled.id))
    expect(after.nextRunAt).toBeInstanceOf(Date)
    expect(after.status).toBe('rearmed')
    const remaining = await db
      .select({ n: sql<string>`count(*)::text` })
      .from(schedules)
      .where(and(eq(schedules.workspaceId, workspaceId), isNull(schedules.nextRunAt)))
    expect(Number(remaining[0].n)).toBe(0)
  })
})
