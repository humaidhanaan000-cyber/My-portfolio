/**
 * Database engine.
 *
 * Two interchangeable drivers behind one Drizzle interface:
 *
 *   DATABASE_URL=postgres://...   → node-postgres pool   (production, docker-compose)
 *   DATABASE_URL=pglite://./data  → embedded PGlite      (zero-config local + preview)
 *
 * Both are PostgreSQL, both run the same SQL migrations, and both expose the
 * same `PgDatabase` surface, so no application code branches on the driver.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from './schema'
import { env, isProduction } from '../env'

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>

type GlobalCache = {
  db?: Database
  raw?: unknown
  initPromise?: Promise<Database>
  driver?: 'postgres' | 'pglite'
}

const globalForDb = globalThis as unknown as { __aibaDb?: GlobalCache }
const cache: GlobalCache = (globalForDb.__aibaDb ??= {})

export function databaseDriver(): 'postgres' | 'pglite' {
  return env.DATABASE_URL.startsWith('pglite') ? 'pglite' : 'postgres'
}

function pgliteDirFromUrl(url: string): string {
  const withoutScheme = url.replace(/^pglite:\/\//, '')
  const dir = withoutScheme === '' ? './data/pgdata' : withoutScheme
  return path.resolve(path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir))
}

async function initDb(): Promise<Database> {
  if (databaseDriver() === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite')
    const { drizzle } = await import('drizzle-orm/pglite')
    const dir = pgliteDirFromUrl(env.DATABASE_URL)
    mkdirSync(dir, { recursive: true })
    const client = new PGlite({ dataDir: dir })
    await client.waitReady
    cache.raw = client
    cache.driver = 'pglite'
    return drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database
  }

  const { Pool } = await import('pg')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
  pool.on('error', (err) => {
    console.error('[db] unexpected idle client error', err.message)
  })
  cache.raw = pool
  cache.driver = 'postgres'
  return drizzle(pool, { schema, casing: 'snake_case' }) as unknown as Database
}

/** Lazily-initialised singleton. Safe to call from any route handler or worker. */
export async function getDb(): Promise<Database> {
  if (cache.db) return cache.db
  cache.initPromise ??= initDb().then((db) => {
    cache.db = db
    return db
  })
  return cache.initPromise
}

/**
 * Drizzle instance for call sites that can `await` once at module scope, e.g.
 * agent definitions. Kept for ergonomics — it is the same singleton.
 */
export const db = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    if (cache.db) return Reflect.get(cache.db as object, prop, receiver)
    throw new Error(
      `[db] Database not initialised. Call await getDb() before accessing db.${String(prop)}`,
    )
  },
}) as Database

export async function closeDb(): Promise<void> {
  const raw = cache.raw as { close?: () => Promise<void>; end?: () => Promise<void> } | undefined
  if (raw?.close) await raw.close()
  else if (raw?.end) await raw.end()
  cache.db = undefined
  cache.initPromise = undefined
  cache.raw = undefined
}

export type DbHealth = {
  driver: 'postgres' | 'pglite'
  ok: boolean
  latencyMs: number
  error?: string
  serverVersion?: string
  migrationsApplied?: number
}

export async function checkDatabaseHealth(): Promise<DbHealth> {
  const started = Date.now()
  const driver = databaseDriver()
  try {
    const database = await getDb()
    const result = await database.execute<{ version: string }>(sql`select version() as version`)
    const rows = extractRows<{ version: string }>(result)
    let migrationsApplied: number | undefined
    try {
      const m = await database.execute<{ count: string }>(
        sql`select count(*)::text as count from drizzle_migrations where status = 'applied'`,
      )
      migrationsApplied = Number(extractRows<{ count: string }>(m)[0]?.count ?? 0)
    } catch {
      migrationsApplied = undefined
    }
    return {
      driver,
      ok: true,
      latencyMs: Date.now() - started,
      serverVersion: String(rows[0]?.version ?? '').split(' ').slice(0, 2).join(' '),
      migrationsApplied,
    }
  } catch (error) {
    return {
      driver,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Drizzle's `execute()` return shape differs between drivers (`{rows}` for
 * node-postgres, a bare array for PGlite). Normalise it.
 */
export function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object' && 'rows' in result) {
    return ((result as { rows: unknown[] }).rows ?? []) as T[]
  }
  return []
}

export { schema }
export * from './schema'

/**
 * Multi-process guard.
 *
 * The embedded PGlite driver keeps its pages in the memory of the process that
 * opened it and writes them to a directory. Two long-running processes sharing
 * that directory therefore see different data, and concurrent writes can corrupt
 * the store. The web process alone is fine (jobs run inline when
 * ENABLE_INLINE_JOBS is true), but standalone worker/scheduler processes must use
 * PostgreSQL. Returns a human-readable reason when that rule is violated.
 */
export function multiProcessDriverProblem(role: string): string | null {
  if (databaseDriver() !== 'pglite') return null
  if (process.env.ALLOW_PGLITE_MULTI_PROCESS === 'true') return null
  return [
    `${role} cannot run against the embedded PGlite driver (DATABASE_URL=${env.DATABASE_URL}).`,
    'PGlite keeps its data in the memory of a single process: separate worker/scheduler',
    'processes would see stale data and risk corrupting the store.',
    'Use PostgreSQL for a always-on worker:  DATABASE_URL=postgres://user:pass@host:5432/aiba',
    'Or keep everything in one process: run the web app with ENABLE_INLINE_JOBS=true',
    '(queued jobs execute inside the web process) and trigger runs with the CLI:',
    '  npm run cli -- run research      # one agent now',
    '  npm run cli -- cycle             # full discover → score → strategy loop',
    'Override only for throwaway experiments: ALLOW_PGLITE_MULTI_PROCESS=true',
  ].join('\n  ')
}

/** Prevent accidental use of the PGlite/SQLite-style file driver in production. */
if (isProduction && databaseDriver() === 'pglite') {
  console.warn(
    '[db] PGlite driver in production: fine for single-node/self-hosted, but set DATABASE_URL to PostgreSQL for scale-out.',
  )
}

/**
 * Raw driver handle. Used only by the migration runner and health probes, where
 * multi-statement SQL / driver-specific APIs are required.
 */
export async function getRawClient(): Promise<unknown> {
  await getDb()
  return cache.raw
}

/** Execute one-or-more SQL statements using the simple protocol (no params). */
export async function rawExec(sqlText: string): Promise<void> {
  const raw = await getRawClient() as any
  if (cache.driver === 'pglite') {
    await raw.exec(sqlText)
    return
  }
  await raw.query(sqlText)
}
