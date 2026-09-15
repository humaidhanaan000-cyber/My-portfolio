/**
 * Claiming and re-arming of due schedules.
 *
 * Kept in its own module (rather than inside the scheduler process) so the
 * behaviour that decides *when agents run* can be tested directly. The scheduler
 * process, a CLI smoke check and the test-suite all call the same code.
 *
 * Guarantees:
 *   - a due schedule is claimed exactly once per due moment, even with several
 *     schedulers ticking concurrently (`for update skip locked` inside one
 *     statement, never a per-row loop);
 *   - `next_run_at` is advanced in the same transaction as the claim, so a crash
 *     between "claim" and "re-arm" can never leave a schedule marked as due and
 *     firing on every tick;
 *   - a schedule whose cron cannot be parsed is parked for one hour and reported
 *     instead of silently stopping.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { extractRows, getDb, schedules } from '../db'
import { nextCronRun } from './cron'
import { createLogger } from '../observability/logger'

const log = createLogger({ component: 'scheduler', module: 'claim' })

/** How long a schedule is parked when its cron expression cannot be parsed. */
const PARKED_MS = 60 * 60 * 1000

export type DueSchedule = {
  id: string
  key: string
  name: string
  cron: string
  jobName: string
  payload: Record<string, unknown>
  workspaceId: string | null
  /** The next occurrence, or null when the cron expression is unusable. */
  nextRunAt: Date | null
}

type ClaimRow = {
  id: string
  key: string
  name: string
  cron: string
  job_name: string
  payload: Record<string, unknown> | null
  workspace_id: string | null
}

/**
 * Claim up to `limit` due schedules and advance their next run time.
 *
 * The claim is a single statement so two schedulers cannot claim the same row,
 * and the advance happens before the caller dispatches anything: worst case a
 * claimed job is lost because the process died mid-dispatch, never duplicated
 * on every following tick.
 */
export async function claimDueSchedules(limit = 25, now: Date = new Date()): Promise<DueSchedule[]> {
  const db = await getDb()
  const parkedUntil = new Date(now.getTime() + PARKED_MS)

  const claimed = extractRows<ClaimRow>(await db.execute(sql`
    with due as (
      select id from schedules
      where enabled = true and next_run_at is not null and next_run_at <= ${now.toISOString()}
      order by next_run_at asc, key asc
      limit ${limit}
      for update skip locked
    )
    update schedules s set
      last_run_at = s.next_run_at,
      next_run_at = ${parkedUntil.toISOString()},
      last_status = 'queued',
      last_error = null,
      updated_at = now()
    from due
    where s.id = due.id
    returning s.id, s.key, s.name, s.cron, s.job_name, s.payload, s.workspace_id
  `))

  const result: DueSchedule[] = []
  for (const row of claimed) {
    let next: Date | null = null
    try {
      next = nextCronRun(row.cron, now)
    } catch (error) {
      log.error('invalid cron expression — schedule parked for one hour', error, { key: row.key, cron: row.cron })
    }
    if (next) {
      // Replace the one-hour placeholder with the real next occurrence.
      await db.update(schedules).set({ nextRunAt: next, updatedAt: new Date() }).where(eq(schedules.id, row.id))
    }
    result.push({
      id: row.id,
      key: row.key,
      name: row.name,
      cron: row.cron,
      jobName: row.job_name,
      payload: row.payload ?? {},
      workspaceId: row.workspace_id,
      nextRunAt: next,
    })
  }

  if (result.length > 0) log.debug('schedules claimed', { claimed: result.length })
  return result
}

/**
 * Repair schedules without a next run time: crash between claim and re-arm,
 * a restored backup, or a row edited by hand. Without this they would never fire
 * again. Returns how many rows were repaired.
 */
export async function rearmStalledSchedules(now: Date = new Date()): Promise<number> {
  const db = await getDb()
  const stalled = await db
    .select({ id: schedules.id, key: schedules.key, cron: schedules.cron })
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNull(schedules.nextRunAt)))

  let repaired = 0
  let invalid = 0
  for (const row of stalled) {
    try {
      const next = nextCronRun(row.cron, now)
      await db
        .update(schedules)
        .set({ nextRunAt: next, lastStatus: 'rearmed', lastError: null, updatedAt: new Date() })
        .where(eq(schedules.id, row.id))
      repaired++
    } catch (error) {
      invalid++
      await db
        .update(schedules)
        .set({
          lastStatus: 'error',
          lastError: `Cannot parse cron expression "${row.cron}" — schedule disabled until it is fixed.`,
          updatedAt: new Date(),
        })
        .where(eq(schedules.id, row.id))
      log.error('cannot re-arm schedule with an invalid cron expression', error, { key: row.key, cron: row.cron })
    }
  }
  if (repaired > 0) log.warn('re-armed schedules with a missing next run time', { repaired })
  if (invalid > 0) log.error('schedules with an unusable cron expression', undefined, { invalid })
  return repaired
}
