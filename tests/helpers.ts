/**
 * Shared fixtures for the test suite.
 *
 * `createWorkspaceFixture()` registers a real user through the same code path
 * the registration endpoint uses — hashing, workspace creation, agent registry,
 * default sources, schedules and the starter workflow all happen for real. No
 * rows are inserted by hand unless a test is specifically about raw storage.
 */
import { eq } from 'drizzle-orm'
import { registerUser } from '../src/lib/auth'
import { getDb, profiles, projects, workspaces } from '../src/lib/db'

let counter = 0

export type Fixture = {
  userId: string
  workspaceId: string
  email: string
  password: string
}

export type ProfileOverrides = Partial<{
  automationLevel: string
  riskTolerance: string
  dailyBudgetCents: number
  monthlyBudgetCents: number
  maxProjectBudgetCents: number
  perAgentDailyLimitCents: number
}>

export async function createWorkspaceFixture(overrides: ProfileOverrides = {}): Promise<Fixture> {
  counter += 1
  const stamp = `${Date.now()}-${counter}`
  const email = `operator+${stamp}@example.test`
  const password = `Fixture-password-${stamp}`

  const registered = await registerUser({
    email,
    password,
    name: `Operator ${counter}`,
    // Distinct source address per fixture keeps the per-IP registration limit
    // out of the way without disabling rate limiting.
    ip: `10.0.${Math.floor(counter / 250)}.${counter % 250}`,
  })

  if (Object.keys(overrides).length > 0) {
    const db = await getDb()
    await db
      .update(profiles)
      .set({ ...overrides, updatedAt: new Date() } as Partial<typeof profiles.$inferInsert>)
      .where(eq(profiles.workspaceId, registered.workspaceId))
  }

  return { userId: registered.userId, workspaceId: registered.workspaceId, email, password }
}

/** A project row inside the fixture workspace, used by budget and workflow tests. */
export async function createProject(fixture: Fixture, overrides: Partial<typeof projects.$inferInsert> = {}) {
  counter += 1
  const db = await getDb()
  const rows = await db
    .insert(projects)
    .values({
      workspaceId: fixture.workspaceId,
      name: overrides.name ?? `Fixture project ${counter}`,
      slug: overrides.slug ?? `fixture-project-${Date.now()}-${counter}`,
      status: 'approved',
      ...overrides,
    } as typeof projects.$inferInsert)
    .returning()
  return rows[0]!
}

export async function workspaceRow(workspaceId: string) {
  const db = await getDb()
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  return rows[0]!
}
