#!/usr/bin/env tsx
/**
 * Reset the local database and re-apply migrations.
 *
 *   npm run db:reset                 # ask for confirmation, then reset
 *   npm run db:reset -- --yes        # non-interactive (CI)
 *   npm run db:reset -- --yes --seed # reset, migrate, seed plans + admin
 *
 * This drops every table in the configured database and rebuilds the schema
 * from `drizzle/0000_init.sql`. It is a *local* development convenience: it
 * refuses to run against a non-local database host unless
 * `--i-know-what-i-am-doing` is supplied, because there is no undo.
 *
 * Production databases are restored from a backup instead — see
 * docs/DEPLOYMENT.md (backup and restore).
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { sql } from 'drizzle-orm'
import { closeDb, databaseDriver, getDb } from '../src/lib/db'
import { env } from '../src/lib/env'
import { migrate, appliedMigrations } from '../src/lib/db/migrate'

function isLocalTarget(): boolean {
  if (databaseDriver() === 'pglite') return true
  try {
    const url = new URL(env.DATABASE_URL)
    return ['localhost', '127.0.0.1', '::1', 'db', 'postgres', 'database'].includes(url.hostname)
  } catch {
    return false
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY) return false
  const rl = createInterface({ input: stdin, output: stdout })
  const answer = await rl.question(`${question} Type "yes" to continue: `)
  rl.close()
  return answer.trim().toLowerCase() === 'yes'
}

async function main() {
  const args = process.argv.slice(2)
  const assumeYes = args.includes('--yes')
  const seedAfter = args.includes('--seed')
  const redacted = env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')

  console.log(`[reset] driver=${databaseDriver()} database=${redacted}`)
  console.log('[reset] this will DROP every table in that database. There is no undo.')

  if (!isLocalTarget() && !args.includes('--i-know-what-i-am-doing')) {
    console.error('[reset] refused: the database host is not local. To restore a production database, use the backup/restore procedure in docs/DEPLOYMENT.md.')
    process.exitCode = 1
    return
  }

  if (!assumeYes) {
    const ok = await confirm('Reset the database now?')
    if (!ok) {
      console.log('[reset] cancelled — nothing was changed.')
      return
    }
  }

  const db = await getDb()
  console.log('[reset] dropping schemas public and drizzle…')
  await db.execute(sql`drop schema if exists public cascade`)
  await db.execute(sql`create schema public`)
  await db.execute(sql`drop schema if exists drizzle cascade`)

  console.log('[reset] re-applying migrations…')
  const result = await migrate()
  console.log(`[reset] applied: ${result.applied.join(', ') || 'nothing'}`)
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[reset] ERROR ${error.name}: ${error.error}`)
    process.exitCode = 1
    return
  }

  const records = await appliedMigrations()
  console.log(`[reset] ${records.filter((record) => record.status === 'applied').length} migration(s) recorded.`)

  if (seedAfter) {
    console.log('[reset] seeding plans, agents, sources, schedules and the administrator account…')
    const { spawnSync } = await import('node:child_process')
    const child = spawnSync('npx', ['tsx', 'scripts/seed.ts'], { stdio: 'inherit' })
    if (child.status !== 0) {
      console.error('[reset] seeding failed — the database is empty but migrated.')
      process.exitCode = child.status ?? 1
      return
    }
  } else {
    console.log('[reset] next: `npm run db:seed` to create plans, agents and the first administrator account.')
  }

  console.log('[reset] database is empty and up to date.')
}

main()
  .catch((error: unknown) => {
    console.error(`[reset] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDb()
  })
