#!/usr/bin/env tsx
/**
 * Generate (or clear) demo data for a workspace.
 *
 *   npm run demo:seed                       # default workspace, seed
 *   npm run demo:seed -- --clear            # remove demo rows only
 *   WORKSPACE=acme npm run demo:seed -- --force
 *
 * Safety: this script refuses to run unless DEMO_MODE_ENABLED=true and the
 * target workspace exists. Every row it writes carries the demo flag, so demo
 * data can never be added to real revenue, real expenses or real project
 * figures — and `--clear` only ever deletes rows that are flagged as demo.
 */
import { eq, sql } from 'drizzle-orm'
import { closeDb, getDb, memberships, users, workspaces } from '../src/lib/db'
import { env } from '../src/lib/env'
import { clearDemoData, seedWorkspaceDemoData } from '../src/lib/demo/seed'
import { formatMoney } from '../src/lib/utils'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve `--workspace <id|slug|email>`.
 *
 * The id form is only queried when the reference really looks like a UUID:
 * comparing a uuid column with an email makes PostgreSQL reject the whole query,
 * which used to surface as an opaque "Failed query" error.
 */
async function resolveWorkspace(reference?: string): Promise<{ id: string; name: string }> {
  const db = await getDb()
  if (reference) {
    if (UUID.test(reference)) {
      const byId = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, reference)).limit(1)
      if (byId[0]) return byId[0]
    }
    const bySlug = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.slug, reference)).limit(1)
    if (bySlug[0]) return bySlug[0]
    const byEmail = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(users.email, reference.toLowerCase()))
      .limit(1)
    if (byEmail[0]) return byEmail[0]
    throw new Error(`No workspace matches "${reference}". Pass a workspace id, slug or account email.`)
  }

  const rows = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).orderBy(workspaces.createdAt).limit(2)
  if (rows.length === 0) throw new Error('No workspace exists. Run `npm run db:seed` first, then register an account.')
  if (rows.length > 1) throw new Error('More than one workspace exists — pass --workspace <id|slug>.')
  return rows[0]!
}

async function demoSummary(workspaceId: string) {
  const db = await getDb()
  const result = await db.execute(sql`
    select
      (select count(*) from opportunities where workspace_id = ${workspaceId} and demo = true) as opportunities,
      (select count(*) from projects where workspace_id = ${workspaceId} and demo = true) as projects,
      (select coalesce(sum(net_cents), 0) from revenue_transactions where workspace_id = ${workspaceId} and demo = true) as revenue_cents,
      (select coalesce(sum(amount_cents), 0) from expenses where workspace_id = ${workspaceId} and demo = true) as expense_cents,
      (select count(*) from content_assets where workspace_id = ${workspaceId} and demo = true) as assets
  `)
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])
  const row = (rows[0] ?? {}) as Record<string, string | number>
  console.log('[demo] current demo rows')
  console.log(`  opportunities      ${row.opportunities ?? 0}`)
  console.log(`  projects           ${row.projects ?? 0}`)
  console.log(`  content assets     ${row.assets ?? 0}`)
  console.log(`  demo revenue       ${formatMoney(Number(row.revenue_cents ?? 0))}`)
  console.log(`  demo expenses      ${formatMoney(Number(row.expense_cents ?? 0))}`)
  console.log('  (demo rows are excluded from every real figure by default)')
}

async function main() {
  const args = process.argv.slice(2)
  const clear = args.includes('--clear')
  const force = args.includes('--force')
  const workspaceFlagIndex = args.indexOf('--workspace')
  const reference = workspaceFlagIndex >= 0 ? args[workspaceFlagIndex + 1] : process.env.WORKSPACE

  if (!env.DEMO_MODE_ENABLED) {
    console.error('[demo] refused: DEMO_MODE_ENABLED=false on this deployment. Demo data cannot be generated or cleared.')
    process.exitCode = 1
    return
  }

  if (env.NODE_ENV === 'production' && !args.includes('--i-know-this-is-production')) {
    console.error('[demo] refusal: this looks like production. Re-run with --i-know-this-is-production to continue, or set DEMO_MODE_ENABLED=false.')
    process.exitCode = 1
    return
  }

  const workspace = await resolveWorkspace(reference)
  console.log(`[demo] target workspace: ${workspace.name} (${workspace.id})`)

  if (clear) {
    await clearDemoData(workspace.id)
    console.log('[demo] demo rows removed. Real revenue, expenses, projects and opportunities were not touched.')
    await demoSummary(workspace.id)
    return
  }

  const result = await seedWorkspaceDemoData(workspace.id, { force })
  console.log('[demo] generated:')
  for (const [key, value] of Object.entries(result)) console.log(`  ${String(key).padEnd(18)} ${value}`)
  console.log('\nAll generated rows are marked DEMO DATA.')
  console.log('These figures are illustrative only — they are not income, not a forecast, and never mixed with real revenue.')
  await demoSummary(workspace.id)
}

main()
  .catch((error: unknown) => {
    console.error(`[demo] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDb()
  })
