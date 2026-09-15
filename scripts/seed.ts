#!/usr/bin/env tsx
/**
 * Seed the platform: plans, agents, default sources, schedules, pricing and the
 * first administrator account.
 *
 * Idempotent: safe to run on every deploy.
 *   npm run db:seed
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run db:seed
 */
import { and, eq, sql } from 'drizzle-orm'
import { closeDb, getDb, agents, plans, profiles, settings, users, workspaces, memberships } from '../src/lib/db'
import { env } from '../src/lib/env'
import { AGENTS, AGENT_ORDER } from '../src/lib/agents/registry'
import { seedDefaultSchedules } from '../src/lib/scheduler/defaults'
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/lib/security/password'

import { randomToken } from '../src/lib/security/crypto'
import { bootstrapWorkspace } from '../src/lib/auth'
import { seedPlanCatalogue } from '../src/lib/plans/catalogue'

async function seedPlans() {
  const count = await seedPlanCatalogue()
  console.log(`[seed] ${count} plan(s) upserted`)
}

async function seedAgents() {
  const db = await getDb()
  for (const key of AGENT_ORDER) {
    const agent = AGENTS[key]
    const existing = await db.select({ id: agents.id }).from(agents).where(eq(agents.key, key)).limit(1)
    if (existing[0]) {
      await db
        .update(agents)
        .set({ name: agent.name, description: agent.description, category: agent.category, modelTier: agent.modelTier, timeoutSeconds: agent.timeoutSeconds, updatedAt: new Date() })
        .where(eq(agents.id, existing[0].id))
    } else {
      await db.insert(agents).values({
        key,
        name: agent.name,
        description: agent.description,
        category: agent.category,
        modelTier: agent.modelTier,
        timeoutSeconds: agent.timeoutSeconds,
      })
    }
  }
  console.log(`[seed] ${AGENT_ORDER.length} agent(s) registered`)
}

async function seedPlatformSettings() {
  const db = await getDb()
  const values: { key: string; value: unknown }[] = [
    { key: 'pricing.currency', value: 'USD' },
    { key: 'pricing.public', value: true },
    { key: 'platform.name', value: 'AIBA' },
    { key: 'platform.tagline', value: 'Autonomous Internet Business Agent' },
    {
      key: 'compliance.disclaimer',
      value:
        'All financial figures produced by AIBA are estimates or projections. Nothing in this platform guarantees income or profit. AIBA never performs unauthorised access, account creation, spam, automated publishing without approval, financial trading or cryptocurrency mining.',
    },
    { key: 'features.demoMode', value: env.DEMO_MODE_ENABLED },
  ]
  for (const item of values) {
    const existing = await db
      .select({ id: settings.id })
      .from(settings)
      .where(and(sql`${settings.workspaceId} is null`, eq(settings.key, item.key)))
      .limit(1)
    if (existing[0]) {
      await db.update(settings).set({ value: item.value, updatedAt: new Date() }).where(eq(settings.id, existing[0].id))
    } else {
      await db.insert(settings).values({ workspaceId: null, key: item.key, value: item.value })
    }
  }
  console.log(`[seed] ${values.length} platform setting(s) upserted`)
}

async function ensureAdmin(): Promise<{ email: string; password?: string; created: boolean } | null> {
  const db = await getDb()
  const email = (process.env.ADMIN_EMAIL ?? env.APP_URL.includes('localhost') ? process.env.ADMIN_EMAIL ?? 'admin@aiba.local' : process.env.ADMIN_EMAIL ?? 'admin@aiba.local').toLowerCase()
  const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1)

  if (existingUser[0]) {
    if (existingUser[0].role !== 'admin') {
      await db.update(users).set({ role: 'admin', updatedAt: new Date() }).where(eq(users.id, existingUser[0].id))
    }
    await ensureWorkspaceFor(existingUser[0].id, existingUser[0].name)
    return { email, created: false }
  }

  const generated = process.env.ADMIN_PASSWORD ?? randomToken(12)
  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  const passwordHash = await hashPassword(generated)
  const inserted = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      name: process.env.ADMIN_NAME ?? 'AIBA Administrator',
      role: 'admin',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id })

  const userId = inserted[0]!.id
  const workspaceId = await ensureWorkspaceFor(userId, process.env.ADMIN_NAME ?? 'AIBA Administrator')
  await db.update(profiles).set({ automationLevel: 'approval_required' }).where(eq(profiles.workspaceId, workspaceId))

  return { email, password: process.env.ADMIN_PASSWORD ? undefined : generated, created: true }
}

async function ensureWorkspaceFor(userId: string, name: string): Promise<string> {
  const db = await getDb()
  const membership = await db
    .select({ workspaceId: memberships.workspaceId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1)
  if (membership[0]) return membership[0].workspaceId

  const slug = `workspace-${userId.slice(0, 8)}`
  const rows = await db
    .insert(workspaces)
    .values({ name: `${name.split(' ')[0]}'s workspace`, slug, ownerId: userId, planKey: 'business' })
    .returning({ id: workspaces.id })
  const workspaceId = rows[0]!.id
  await db.insert(memberships).values({ workspaceId, userId, role: 'owner' })
  await db.insert(profiles).values({ workspaceId, userId, legalName: name })
  await bootstrapWorkspace(workspaceId)
  return workspaceId
}

async function main() {
  console.log('[seed] starting')
  await seedPlans()
  await seedAgents()
  await seedPlatformSettings()

  const admin = await ensureAdmin()
  if (admin) {
    if (admin.created && admin.password) {
      console.log('')
      console.log('  ┌──────────────────────────────────────────────────────────────┐')
      console.log('  │  FIRST ADMIN ACCOUNT CREATED — store this password now        │')
      console.log('  ├──────────────────────────────────────────────────────────────┤')
      console.log(`  │  Email:    ${admin.email.padEnd(50)}│`)
      console.log(`  │  Password: ${admin.password.padEnd(50)}│`)
      console.log('  │  Change it after first sign-in (Settings → Security).         │')
      console.log('  └──────────────────────────────────────────────────────────────┘')
      console.log('')
    } else {
      console.log(`[seed] admin account ready: ${admin.email}`)
    }
  }

  console.log('[seed] complete')
  await closeDb()
}

main().catch(async (error) => {
  console.error('[seed] fatal:', error)
  await closeDb().catch(() => undefined)
  process.exit(1)
})
