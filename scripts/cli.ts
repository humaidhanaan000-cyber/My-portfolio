#!/usr/bin/env tsx
/**
 * AIBA operator CLI.
 *
 * The same operations the dashboard performs, available from a terminal or a
 * cron entry on a server without a browser. Every command goes through the real
 * libraries — policy checks, budget guardrails, approvals and audit logging all
 * still apply. Nothing here bypasses the application's rules.
 *
 *   npm run cli -- help
 *   npm run cli -- status
 *   npm run cli -- agents
 *   npm run cli -- cycle --workspace <id|email> [--no-ai]
 *   npm run cli -- opportunities --workspace <id|email> --min-score 70
 *   npm run cli -- approvals --workspace <id|email> pending
 *   npm run cli -- decide <approvalId> approve|reject [--note "..."]
 *   npm run cli -- budget --workspace <id|email>
 *   npm run cli -- report --workspace <id|email> daily|weekly [--no-ai]
 *   npm run cli -- run <agentKey> --workspace <id|email>
 *   npm run cli -- workflow --workspace <id|email> [--dry-run]
 *   npm run cli -- demo --workspace <id|email> seed|clear
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { closeDb, databaseDriver, getDb, memberships, opportunities, users, workspaces } from '../src/lib/db'
import { env } from '../src/lib/env'
import { AGENT_LABELS } from '../src/lib/agents/labels'
import { AGENT_ORDER } from '../src/lib/agents/registry'
import { runAgentByKey } from '../src/lib/agents/registry'
import { runFullCycle, systemStatus } from '../src/lib/agents/orchestrator'
import { listApprovals, decideApproval, approvalStats } from '../src/lib/approvals'
import { evaluateBudget, budgetSnapshot } from '../src/lib/budget'
import { generateAndStoreReport, latestReport } from '../src/lib/reports'
import { clearDemoData, seedWorkspaceDemoData } from '../src/lib/demo/seed'
import { defaultWorkflowDefinition } from '../src/lib/workflows/defaults'
import { executeWorkflow } from '../src/lib/workflows/engine'
import { formatMoney, relativeTime } from '../src/lib/utils'

type Flags = Record<string, string | boolean>

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const [command = 'help', ...rest] = argv
  const positional: string[] = []
  const flags: Flags = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = rest[index + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        index += 1
      } else {
        flags[key] = true
      }
    } else {
      positional.push(token)
    }
  }
  return { command, positional, flags }
}

/**
 * Resolve a workspace from an id, slug or the email of a member. Accepting an
 * email is what makes the CLI usable on a fresh server where ids are unknown.
 */
async function resolveWorkspace(reference: string | undefined): Promise<{ id: string; name: string; planKey: string }> {
  const db = await getDb()
  if (!reference) {
    const rows = await db.select({ id: workspaces.id, name: workspaces.name, planKey: workspaces.planKey }).from(workspaces).orderBy(workspaces.createdAt).limit(2)
    if (rows.length === 0) throw new Error('No workspace exists yet. Run `npm run db:seed` first.')
    if (rows.length > 1) throw new Error('More than one workspace exists — pass --workspace <id|slug|email>.')
    return rows[0]!
  }

  // Only look up by id when the reference actually looks like a UUID —
  // comparing a uuid column to an email makes PostgreSQL raise a cast error.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference)) {
    const byId = await db
      .select({ id: workspaces.id, name: workspaces.name, planKey: workspaces.planKey })
      .from(workspaces)
      .where(eq(workspaces.id, reference))
      .limit(1)
    if (byId[0]) return byId[0]
  }

  const bySlug = await db
    .select({ id: workspaces.id, name: workspaces.name, planKey: workspaces.planKey })
    .from(workspaces)
    .where(eq(workspaces.slug, reference))
    .limit(1)
  if (bySlug[0]) return bySlug[0]

  const byEmail = await db
    .select({ id: workspaces.id, name: workspaces.name, planKey: workspaces.planKey })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(users.email, reference.toLowerCase()))
    .limit(1)
  if (byEmail[0]) return byEmail[0]

  throw new Error(`No workspace matches "${reference}".`)
}

/* --------------------------------------------------------------- commands */

async function commandStatus(flags: Flags) {
  const workspace = await resolveWorkspace(flags.workspace as string | undefined)
  const status = await systemStatus(workspace.id)
  console.log(`Workspace   ${workspace.name} (${workspace.planKey})`)
  console.log(`Status      ${status.status}`)
  console.log(`Agents      ${status.agentsActive}/${status.agentsTotal} active`)
  console.log(`Uptime      ${Math.round(status.uptimeSeconds / 60)} min`)
  console.log(`Database    ${status.database.ok ? 'ok' : 'unreachable'} (${status.database.latencyMs} ms, ${status.database.driver})`)
  console.log(`Queue       ${status.queue.queued} queued · ${status.queue.running} running · ${status.queue.failed} failed`)
  console.log(`AI          ${status.ai.configured ? status.ai.provider : 'not configured'}`)
  console.log(`Current     ${status.currentTask ?? 'idle'}`)
  console.log(`Next        ${status.nextScheduledTask ? `${status.nextScheduledTask.name} at ${status.nextScheduledTask.runAt}` : 'nothing scheduled'}`)
}

async function commandAgents() {
  const db = await getDb()
  const rows = await db.execute(sql`
    select a.key, a.enabled, a.status, a.success_count, a.failure_count,
           (select count(*) from agent_runs r where r.agent_key = a.key and r.started_at > now() - interval '24 hours') as runs_24h
    from agents a
    order by a.key
  `)
  const list = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[])
  console.log('KEY         ENABLED  STATUS    OK/FAIL   RUNS 24H')
  for (const raw of list as { key: string; enabled: boolean; status: string; success_count: number; failure_count: number; runs_24h: number | string }[]) {
    console.log(
      `${String(raw.key).padEnd(11)} ${String(raw.enabled).padEnd(8)} ${String(raw.status).padEnd(9)} ${`${raw.success_count}/${raw.failure_count}`.padEnd(9)} ${raw.runs_24h}`,
    )
  }
  console.log(`\n${AGENT_ORDER.length} agent definitions: ${AGENT_ORDER.map((key) => AGENT_LABELS[key] ?? key).join(', ')}`)
}

async function commandCycle(flags: Flags) {
  const workspace = await resolveWorkspace(flags.workspace as string | undefined)
  const useAi = flags['no-ai'] ? false : true
  console.log(`[cli] running the discovery → strategy cycle for ${workspace.name} (useAi=${useAi})`)
  const result = await runFullCycle(workspace.id, { useAi })
  console.log(
    `[cli] discovered ${result.opportunitiesDiscovered}, scored ${result.opportunitiesScored}, strategies ${result.strategiesCreated}, approvals ${result.approvalsCreated}, builds ${result.builds} in ${result.durationMs} ms`,
  )
  for (const stage of result.stages) {
    console.log(`  ${stage.stage.padEnd(16)} ${stage.status.padEnd(18)} ${stage.summary ?? stage.detail ?? ''}`)
  }
}

async function commandOpportunities(flags: Flags) {
  const workspace = await resolveWorkspace(flags.workspace as string | undefined)
  const db = await getDb()
  const minScore = Number(flags['min-score'] ?? 0)
  const limit = Math.min(50, Number(flags.limit ?? 20))

  // The authoritative score lives in `opportunity_scores` (each re-score is a
  // new row), so the CLI reads the latest score per opportunity rather than a
  // denormalised column that could drift.
  const result = await db.execute(sql`
    select o.id, o.title, o.category, o.status, o.created_at,
           coalesce(max(s.final_score), 0) as score
    from opportunities o
    left join opportunity_scores s on s.opportunity_id = o.id
    where o.workspace_id = ${workspace.id} and o.deleted_at is null
    group by o.id, o.title, o.category, o.status, o.created_at
    having coalesce(max(s.final_score), 0) >= ${minScore}
    order by score desc
    limit ${limit}
  `)
  const rows = ((result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])) as {
    id: string
    title: string
    category: string
    status: string
    created_at: string | Date
    score: string | number
  }[]

  if (rows.length === 0) {
    console.log('[cli] no opportunities matched. Run `npm run cli -- cycle` first.')
    return
  }
  for (const row of rows) {
    console.log(
      `${Number(row.score).toFixed(1).padStart(5)}  ${row.status.padEnd(14)} ${row.category.padEnd(16)} ${String(row.title).slice(0, 48)}  ${relativeTime(row.created_at)}`,
    )
  }
  console.log(`\n${rows.length} row(s). Scores are research estimates, not income forecasts.`)
}

async function commandApprovals(flags: Flags, positional: string[]) {
  const workspace = await resolveWorkspace(flags.workspace as string | undefined)
  const status = (positional[0] ?? 'pending') as 'pending' | 'approved' | 'rejected' | 'deferred' | 'executed' | 'failed' | 'expired'
  const rows = await listApprovals(workspace.id, { status: [status], limit: 25 })
  const stats = await approvalStats(workspace.id)

  if (rows.length === 0) {
    console.log(`[cli] no ${status} approvals.`)
  }
  for (const row of rows) {
    console.log(`${row.id}  ${String(row.risk).padEnd(6)} ${String(row.actionType).padEnd(22)} ${row.title.slice(0, 44)}  cost ${formatMoney(row.expectedCostCents ?? 0)}`)
  }
  console.log(
    `\nstats: pending ${stats.pending} (${formatMoney(stats.pendingCostCents)} of expected cost) · approved today ${stats.approvedToday} · rejected today ${stats.rejectedToday} · deferred ${stats.deferred} · failed ${stats.failed}`,
  )
}

async function commandDecide(positional: string[], flags: Flags) {
  const approvalId = positional[0]
  const decision = positional[1]
  if (!approvalId || !decision || !['approve', 'reject', 'defer'].includes(decision)) {
    throw new Error('Usage: npm run cli -- decide <approvalId> approve|reject|defer [--note "..."] [--workspace <ref>]')
  }
  const workspace = await resolveWorkspace(flags.workspace as string | undefined)
  const db = await getDb()
  const owner = (
    await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.workspaceId, workspace.id))
      .limit(1)
  )[0]

  const result = await decideApproval({
    workspaceId: workspace.id,
    approvalId,
    userId: owner?.userId ?? null,
    decision: decision as 'approve' | 'reject' | 'defer',
    note: (flags.note as string) ?? `Decided from the operator CLI (${decision}).`,
  })

  if (!result.ok) {
    console.error(`[cli] decision refused: ${result.error ?? 'unknown reason'} (status: ${result.status})`)
    process.exitCode = 1
    return
  }
  console.log(`[cli] ${decision}d ${approvalId} → status ${result.status}${result.executionQueued ? ' (execution queued)' : ''}`)
  if (result.requiresSeparateAuthorization) {
    console.log('[cli] this action must be carried out by you — AIBA recorded your authorisation instead of performing it.')
  }
}

async function commandBudget(flags: Flags) {
  const workspace = await resolveWorkspace(flags.workspace as string | undefined)
  const snapshot = await budgetSnapshot(workspace.id)
  const preview = await evaluateBudget({ workspaceId: workspace.id, amountCents: 100, description: 'CLI budget probe' })

  console.log(`Currency          ${snapshot.currency}`)
  console.log(`Today             ${formatMoney(snapshot.daily.spentCents)} of ${snapshot.daily.limitCents > 0 ? formatMoney(snapshot.daily.limitCents) : 'no limit set'} (${snapshot.daily.percentUsed.toFixed(0)}%)`)
  console.log(`This month        ${formatMoney(snapshot.monthly.spentCents)} of ${snapshot.monthly.limitCents > 0 ? formatMoney(snapshot.monthly.limitCents) : 'no limit set'} (${snapshot.monthly.percentUsed.toFixed(0)}%)`)
  console.log(`Per project max   ${formatMoney(snapshot.projectMaxCents)}`)
  console.log(`Per agent / day   ${formatMoney(snapshot.agentDailyLimitCents)}`)
  console.log(`Resets            daily ${relativeTime(snapshot.daily.resetsAt)} · monthly ${relativeTime(snapshot.monthly.resetsAt)}`)
  console.log(`\nProbe (100¢):     ${preview.allowed ? 'allowed' : 'blocked'} — ${preview.reason}`)
  for (const alert of snapshot.alerting) console.log(`  [${alert.level}] ${alert.message ?? ''}`)
}

async function commandReport(positional: string[], flags: Flags) {
  const workspace = await resolveWorkspace(flags.workspace as string | undefined)
  const period = (positional[0] ?? 'daily') as 'daily' | 'weekly'
  if (!['daily', 'weekly'].includes(period)) throw new Error('Period must be daily or weekly.')

  const existing = await latestReport(workspace.id, period)
  if (existing && !flags.force) {
    console.log(`[cli] latest ${period} report from ${relativeTime(existing.createdAt)}:`)
    console.log(existing.summary)
  }

  const report = await generateAndStoreReport(workspace.id, period, { useAi: !flags['no-ai'] })
  console.log(`\n${report.data.summary}\n`)
  for (const recommendation of report.data.recommendations.slice(0, 8)) console.log(`  • ${recommendation}`)
  console.log('\nReport stored. Projections inside a report are labelled as estimates.')
}

async function commandRun(positional: string[], flags: Flags) {
  const agentKey = positional[0]
  if (!agentKey) throw new Error('Usage: npm run cli -- run <agentKey> [--workspace <ref>]')
  const workspace = await resolveWorkspace(flags.workspace as string | undefined)
  const input = flags.input ? (JSON.parse(String(flags.input)) as Record<string, unknown>) : {}
  const result = await runAgentByKey(agentKey, input, { workspaceId: workspace.id, triggeredBy: 'manual' })
  console.log(JSON.stringify(result, null, 2))
}

async function commandWorkflow(flags: Flags) {
  const workspace = await resolveWorkspace(flags.workspace as string | undefined)
  const definition = defaultWorkflowDefinition()
  const result = await executeWorkflow(workspace.id, definition, {
    workspaceId: workspace.id,
    trigger: 'manual',
    useAi: !flags['dry-run'],
  })
  console.log(`[cli] run ${result.runId} → ${result.status} in ${result.durationMs} ms`)
  for (const step of result.steps) {
    console.log(`  ${step.status.padEnd(18)} ${step.label.padEnd(38)} ${step.summary ?? step.error ?? ''}`)
  }
  if (result.status === 'awaiting_approval') {
    console.log('\nThe run stopped at an approval gate. Review it with `npm run cli -- approvals`.')
  }
}

async function commandDemo(positional: string[], flags: Flags) {
  const workspace = await resolveWorkspace(flags.workspace as string | undefined)
  if (!env.DEMO_MODE_ENABLED) throw new Error('DEMO_MODE_ENABLED=false — demo data is disabled on this deployment.')
  const action = positional[0] ?? 'seed'

  if (action === 'clear') {
    await clearDemoData(workspace.id)
    console.log('[cli] demo rows removed. Real revenue, expenses and projects were not touched.')
    return
  }

  const result = await seedWorkspaceDemoData(workspace.id, { force: Boolean(flags.force) })
  console.log(`[cli] demo data written for ${workspace.name}:`)
  for (const [key, value] of Object.entries(result)) console.log(`  ${String(key).padEnd(16)} ${value}`)
  console.log('\nEvery generated row carries the demo flag and is labelled DEMO DATA in the interface.')
}

function commandHelp() {
  console.log(`AIBA operator CLI

Usage: npm run cli -- <command> [options]

Commands
  status                                   System, queue, agent and AI status
  agents                                   Agent roster with 24-hour run counts
  cycle        [--no-ai] [--workspace]     Run discovery → clean → score → strategy
  opportunities [--min-score N] [--limit N] List scored opportunities
  approvals    [status] [--workspace]      List approval requests
  decide       <id> approve|reject|defer   Record a decision (policy re-checked)
  budget       [--workspace]               Budget snapshot and a spend probe
  report       [daily|weekly] [--force]    Generate a report from recorded data
  run          <agentKey> [--input '{...}'] Run one agent now
  workflow     [--dry-run]                 Execute the default workflow graph
  demo         seed|clear [--force]        Generate or remove demo data
  help                                     This message

Options
  --workspace <id|slug|email>   Target workspace (required when several exist)
  --no-ai                       Skip model calls and use deterministic logic
  --force                       Overwrite / regenerate
  --note "..."                  Note recorded with an approval decision

Environment: DATABASE_URL=${env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}  BUDGET_ENFORCEMENT=${env.BUDGET_ENFORCEMENT}  DEMO_MODE_ENABLED=${env.DEMO_MODE_ENABLED}`)
}

/**
 * Warn when the CLI is pointed at the same embedded PGlite directory a running
 * web server already has open. Each process holds its own copy of that store, so
 * the dashboard would not see CLI writes and concurrent writes risk corruption.
 * PostgreSQL has no such limitation — this guard exists only for the pglite path.
 */
async function warnIfAppIsRunning(): Promise<void> {
  if (databaseDriver() !== 'pglite') return
  if (process.env.ALLOW_PGLITE_MULTI_PROCESS === 'true') return
  const port = Number(process.env.PORT ?? 3000)
  const reachable = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(600) })
    .then((response) => response.ok)
    .catch(() => false)
  if (!reachable) return
  console.warn(
    [
      '',
      `  Heads-up: the AIBA web app is running on http://127.0.0.1:${port} and the database is the embedded`,
      '  PGlite driver. Each process keeps its own copy of that store, so changes made here will not',
      '  appear in the dashboard until it restarts (and concurrent writes can corrupt the store).',
      '',
      '  Cleanest options:',
      `    - trigger the run in the running app instead: POST /api/agents/<key>/run`,
      '      or the Agents page in the dashboard;',
      '    - stop the web app, then run this command;',
      '    - point DATABASE_URL at PostgreSQL for real concurrent use.',
      '',
    ].join('\n'),
  )
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2))
  if (command !== 'help') await warnIfAppIsRunning()
  switch (command) {
    case 'status':
      await commandStatus(flags)
      break
    case 'agents':
      await commandAgents()
      break
    case 'cycle':
      await commandCycle(flags)
      break
    case 'opportunities':
      await commandOpportunities(flags)
      break
    case 'approvals':
      await commandApprovals(flags, positional)
      break
    case 'decide':
      await commandDecide(positional, flags)
      break
    case 'budget':
      await commandBudget(flags)
      break
    case 'report':
      await commandReport(positional, flags)
      break
    case 'run':
      await commandRun(positional, flags)
      break
    case 'workflow':
      await commandWorkflow(flags)
      break
    case 'demo':
      await commandDemo(positional, flags)
      break
    case 'help':
    default:
      commandHelp()
  }
}

main()
  .catch((error: unknown) => {
    console.error(`[cli] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDb()
  })
