/**
 * Migration runner.
 *
 * - Reads the drizzle-kit journal (`drizzle/meta/_journal.json`) so the SQL is
 *   generated from `schema.ts` by `npm run db:generate` and never hand-drifted.
 * - Records every attempt in `drizzle_migrations` with a checksum, so a mutated
 *   already-applied file is detected instead of silently ignored.
 * - Each migration runs inside a transaction on PostgreSQL. PGlite runs the file
 *   through `exec()`, which is itself atomic per statement batch.
 * - `-- +rollback` / `-- +end-rollback` blocks inside a migration file define the
 *   down-migration used by `npm run db:migrate -- --rollback`.
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { getDb, rawExec, extractRows, databaseDriver } from './index'

export type MigrationEntry = {
  idx: number
  tag: string
  when: number
  file: string
  sql: string
  rollbackSql: string | null
  checksum: string
}

export type MigrationRecord = {
  id: string
  name: string
  checksum: string
  applied_at: string
  execution_ms: number
  status: string
  error: string | null
}

const MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle')

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationEntry[] {
  const journalPath = path.join(dir, 'meta', '_journal.json')
  if (!existsSync(journalPath)) {
    throw new Error(`Migration journal missing at ${journalPath}. Run "npm run db:generate".`)
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string; when: number }[]
  }

  return journal.entries
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => {
      const file = path.join(dir, `${entry.tag}.sql`)
      if (!existsSync(file)) throw new Error(`Migration SQL missing: ${file}`)
      const raw = readFileSync(file, 'utf8')
      const { up, down } = splitRollback(raw)
      return {
        idx: entry.idx,
        tag: entry.tag,
        when: entry.when,
        file: `${entry.tag}.sql`,
        // drizzle-kit separates statements with this marker; `exec`/simple query
        // handle multi-statement strings, but keeping the semicolons is required.
        sql: up.replaceAll('--> statement-breakpoint', ';'),
        rollbackSql: down ? down.replaceAll('--> statement-breakpoint', ';') : null,
        checksum: hash(up),
      }
    })
}

function splitRollback(sql: string): { up: string; down: string | null } {
  const startMarker = '-- +rollback'
  const endMarker = '-- +end-rollback'
  const start = sql.indexOf(startMarker)
  if (start === -1) return { up: sql, down: null }
  const end = sql.indexOf(endMarker)
  const up = sql.slice(0, start)
  const down = end === -1 ? sql.slice(start + startMarker.length) : sql.slice(start + startMarker.length, end)
  return { up, down }
}

async function ensureMigrationsTable(): Promise<void> {
  const db = await getDb()
  await db.execute(`
    create table if not exists drizzle_migrations (
      id uuid primary key default gen_random_uuid(),
      idx integer not null,
      name text not null,
      checksum text not null,
      started_at timestamptz not null default now(),
      applied_at timestamptz,
      execution_ms integer,
      status text not null default 'pending',
      error text
    )
  `)
}

export async function appliedMigrations(): Promise<MigrationRecord[]> {
  await ensureMigrationsTable()
  const db = await getDb()
  const result = await db.execute(`
    select id, name, checksum, coalesce(applied_at, started_at) as applied_at,
           coalesce(execution_ms, 0) as execution_ms, status, error
    from drizzle_migrations
    order by idx asc
  `)
  return extractRows<MigrationRecord>(result)
}

export type MigrateResult = {
  applied: string[]
  skipped: string[]
  errors: { name: string; error: string }[]
  driver: string
}

export async function migrate(options: { dryRun?: boolean; rollbackAll?: boolean } = {}): Promise<MigrateResult> {
  const driver = databaseDriver()
  const migrations = loadMigrations()
  await ensureMigrationsTable()
  const existing = await appliedMigrations()
  const appliedByName = new Map(existing.filter((m) => m.status === 'applied').map((m) => [m.name, m]))

  const result: MigrateResult = { applied: [], skipped: [], errors: [], driver }

  if (options.rollbackAll) {
    for (const migration of [...migrations].reverse()) {
      const record = appliedByName.get(migration.file)
      if (!record) continue
      if (!migration.rollbackSql) {
        result.errors.push({ name: migration.file, error: 'no rollback block defined' })
        continue
      }
      if (options.dryRun) {
        result.applied.push(`rollback:${migration.file}`)
        continue
      }
      const db = await getDb()
      const started = Date.now()
      try {
        await rawExec(migration.rollbackSql)
        await db.execute(`
          delete from drizzle_migrations where name = '${migration.file}'
        `)
        result.applied.push(`rollback:${migration.file} (${Date.now() - started}ms)`)
      } catch (error) {
        result.errors.push({
          name: migration.file,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return result
  }

  for (const migration of migrations) {
    const record = appliedByName.get(migration.file)
    if (record) {
      if (record.checksum !== migration.checksum) {
        result.errors.push({
          name: migration.file,
          error: `checksum drift detected (applied ${record.checksum}, file ${migration.checksum}). Create a new migration instead of editing an applied one.`,
        })
      } else {
        result.skipped.push(migration.file)
      }
      continue
    }

    if (options.dryRun) {
      result.applied.push(`dry-run:${migration.file}`)
      continue
    }

    const db = await getDb()
    const started = Date.now()
    await db.execute(`
      insert into drizzle_migrations (idx, name, checksum, status)
      values (${migration.idx}, '${migration.file}', '${migration.checksum}', 'running')
      on conflict do nothing
    `)
    try {
      // Wrap the whole file in a transaction where the driver supports it, so a
      // half-applied schema change can never be left behind.
      await rawExec(`begin;\n${migration.sql}\ncommit;`)
      await db.execute(`
        update drizzle_migrations
        set status = 'applied', applied_at = now(), execution_ms = ${Date.now() - started}, error = null
        where name = '${migration.file}'
      `)
      result.applied.push(`${migration.file} (${Date.now() - started}ms)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await db.execute(`
        update drizzle_migrations
        set status = 'failed', error = ${sqlLiteral(message)}, execution_ms = ${Date.now() - started}
        where name = '${migration.file}'
      `)
      result.errors.push({ name: migration.file, error: message })
      break
    }
  }

  return result
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function migrationStatus(): { pending: string[]; applied: string[] } {
  return { pending: [], applied: [] }
}
