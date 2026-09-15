/**
 * Test environment bootstrap.
 *
 * Points the app at an embedded PGlite database under `data/pgdata-test`,
 * applies the real migration file, and seeds the plan catalogue. Nothing here
 * mocks the application logic — the tests exercise the same code paths the
 * server uses.
 */
import { beforeAll } from 'vitest'
import { rmSync } from 'node:fs'

const TEST_DB_DIR = './data/pgdata-test'

const env = process.env as Record<string, string>

env.NODE_ENV = 'test'
env.DATABASE_URL = `pglite://${TEST_DB_DIR}`
env.AUTH_SECRET = 'test-secret-not-used-in-production-0123456789'
env.APP_URL = 'http://127.0.0.1:3000'
env.APP_NAME = 'AIBA'
env.SERVICE_VERSION = 'test'
env.DEMO_MODE_ENABLED = 'true'
env.PAYMENT_PROVIDER = 'stripe'
env.STRIPE_SECRET_KEY = 'sk_test_fixture'
env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests'
env.STRIPE_PRICE_PRO = 'price_test_pro'
env.STRIPE_PRICE_BUSINESS = 'price_test_business'
env.EMAIL_PROVIDER = 'console'
env.STORAGE_DRIVER = 'local'
env.SOURCE_ALLOW_NETWORK = 'false'
env.BUDGET_ENFORCEMENT = 'true'
env.ENABLE_INLINE_JOBS = 'true'
env.LOG_LEVEL = 'error'
env.REQUIRE_EMAIL_VERIFICATION = 'false'
env.ALLOW_REGISTRATION = 'true'

let prepared = false

beforeAll(async () => {
  if (prepared) return
  prepared = true

  const { migrate } = await import('../src/lib/db/migrate')
  const { seedPlanCatalogue } = await import('../src/lib/plans/catalogue')

  // A previous run may have left a partially migrated directory behind.
  try {
    const { appliedMigrations } = await import('../src/lib/db/migrate')
    await appliedMigrations()
  } catch {
    rmSync(TEST_DB_DIR, { recursive: true, force: true })
  }

  await migrate()
  await seedPlanCatalogue()
})

export { TEST_DB_DIR }
