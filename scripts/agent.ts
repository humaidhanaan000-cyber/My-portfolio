#!/usr/bin/env tsx
/**
 * `npm run agent` — start AIBA with its automation, in one command.
 *
 * What it starts depends on the database in use, because that decides whether
 * separate processes are safe:
 *
 *   PostgreSQL  →  web  +  worker  +  scheduler   (three processes, the
 *                  production shape: jobs and cron survive web restarts and can
 *                  be scaled independently)
 *   PGlite      →  web only, with ENABLE_INLINE_JOBS=true and
 *                  ENABLE_SCHEDULER=true        (one process owns the embedded
 *                  store; queued jobs and the cron loop run inside it)
 *
 * Options:
 *   --dev            run the Next dev server instead of a production build
 *   --no-web         don't start the web server (worker/scheduler only)
 *   --no-worker      don't start the worker process
 *   --no-scheduler   don't start the scheduler process / inline loop
 *
 * Log lines from each child are prefixed with its role so one terminal stays
 * readable. Ctrl-C stops every child.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import process from 'node:process'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)

const withWeb = !flag('no-web')
const withWorker = !flag('no-worker')
const withScheduler = !flag('no-scheduler')
const dev = flag('dev')

const databaseUrl = process.env.DATABASE_URL ?? 'pglite://./data/pgdata'
const pglite = databaseUrl.startsWith('pglite')
const port = process.env.PORT ?? '3000'

const colors: Record<string, string> = { web: '\u001b[36m', worker: '\u001b[35m', scheduler: '\u001b[33m', agent: '\u001b[32m' }
const reset = '\u001b[0m'
const say = (role: string, message: string) => console.log(`${colors[role] ?? ''}[${role}]${reset} ${message}`)

const children: { role: string; child: ChildProcess }[] = []
let shuttingDown = false

function start(role: string, command: string, commandArgs: string[], extraEnv: Record<string, string> = {}) {
  const child = spawn(command, commandArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  })
  children.push({ role, child })

  const forward = (chunk: Buffer) => {
    const text = chunk.toString()
    for (const line of text.split('\n')) if (line.trim().length > 0) say(role, line)
  }
  child.stdout?.on('data', forward)
  child.stderr?.on('data', forward)

  child.on('exit', (code, signal) => {
    const index = children.findIndex((entry) => entry.child === child)
    if (index >= 0) children.splice(index, 1)
    if (shuttingDown) return
    say(role, `exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`)
    // A dead web/worker/scheduler means the system is no longer autonomous: stop
    // everything rather than leave a half-running stack.
    if (role === 'web' || (pglite === false && (role === 'worker' || role === 'scheduler'))) {
      void shutdown('a required process exited')
    }
  })

  return child
}

async function shutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  say('agent', `stopping everything (${reason})`)
  for (const { child } of children) child.kill('SIGTERM')
  // The worker and scheduler force their own exit within their grace period; the
  // supervisor makes sure nothing survives at all (an orphaned process would keep
  // a private copy of the database in memory).
  const grace = Number(process.env.SHUTDOWN_GRACE_MS ?? 30_000)
  const deadline = Date.now() + grace
  while (children.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  for (const { child, role } of children) {
    say('agent', `${role} did not stop in time — killing it`)
    child.kill('SIGKILL')
  }
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

say('agent', `AIBA automation start-up — driver: ${pglite ? 'embedded PGlite' : 'PostgreSQL'}`)

if (pglite) {
  say('agent', 'Embedded database: the web process runs queued jobs and the cron loop itself.')
  say('agent', `Open http://localhost:${port} — dashboards at /dashboard, agent activity at /dashboard/agents.`)
  if (withWeb) {
    start(
      'web',
      'npx',
      dev ? ['next', 'dev', '-H', '0.0.0.0', '-p', port] : ['next', 'start', '-H', '0.0.0.0', '-p', port],
      { ENABLE_INLINE_JOBS: 'true', ENABLE_SCHEDULER: withScheduler ? 'true' : 'false' },
    )
  } else {
    say('agent', '--no-web given: nothing to run in embedded mode (the web process hosts the automation).')
    process.exit(1)
  }
} else {
  say('agent', 'PostgreSQL: separate web, worker and scheduler processes — automation continues without a browser.')
  if (withWeb) start('web', 'npx', dev ? ['next', 'dev', '-H', '0.0.0.0', '-p', port] : ['next', 'start', '-H', '0.0.0.0', '-p', port], { ENABLE_INLINE_JOBS: 'false' })
  if (withWorker) start('worker', 'npx', ['tsx', 'src/worker/queue-runner.ts'])
  if (withScheduler) start('scheduler', 'npx', ['tsx', 'src/worker/scheduler.ts'])
}
