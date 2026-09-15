#!/usr/bin/env tsx
/** Apply database migrations: npm run db:migrate [-- --rollback] [-- --dry-run] */
import { migrate, appliedMigrations } from '../src/lib/db/migrate'
import { closeDb, databaseDriver } from '../src/lib/db'
import { env } from '../src/lib/env'

async function main() {
  const args = process.argv.slice(2)
  const rollback = args.includes('--rollback')
  const dryRun = args.includes('--dry-run')

  console.log(`[migrate] driver=${databaseDriver()} database=${env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}${dryRun ? ' (dry run)' : ''}`)

  const result = await migrate({ dryRun, rollbackAll: rollback })
  if (rollback) {
    console.log(`[migrate] rolled back: ${result.applied.length ? result.applied.join(', ') : 'nothing'}`)
  } else {
    if (result.applied.length) console.log(`[migrate] applied: ${result.applied.join(', ')}`)
    if (result.skipped.length) console.log(`[migrate] already applied: ${result.skipped.join(', ')}`)
  }
  if (result.errors.length) {
    for (const error of result.errors) console.error(`[migrate] ERROR ${error.name}: ${error.error}`)
    await closeDb()
    process.exit(1)
  }

  const records = await appliedMigrations()
  console.log(`[migrate] ${records.filter((r) => r.status === 'applied').length} migration(s) recorded as applied.`)
  if (records.some((r) => r.status === 'failed')) {
    console.error('[migrate] some migrations are in a failed state — inspect drizzle_migrations.')
    await closeDb()
    process.exit(1)
  }
  await closeDb()
}

main().catch(async (error) => {
  console.error('[migrate] fatal:', error instanceof Error ? error.message : error)
  await closeDb().catch(() => undefined)
  process.exit(1)
})
