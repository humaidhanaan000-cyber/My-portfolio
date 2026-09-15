/**
 * GET   /api/users — the signed-in user's profile and workspace preferences.
 * PATCH /api/users — update profile, budgets, automation level and channels.
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb, profiles, users, workspaces } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'
import { ALLOWED_CURRENCIES, AUTOMATION_LEVELS, RISK_TOLERANCES } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const [user, profile, workspace] = await Promise.all([
    db.select().from(users).where(eq(users.id, ctx.session.id)).limit(1),
    db.select().from(profiles).where(eq(profiles.workspaceId, ctx.session.workspaceId)).limit(1),
    db.select().from(workspaces).where(eq(workspaces.id, ctx.session.workspaceId)).limit(1),
  ])
  if (!user[0]) throw new ApiError('not_found', 'User not found.')
  const { passwordHash, ...safeUser } = user[0]
  void passwordHash
  return ok({ user: safeUser, profile: profile[0] ?? null, workspace: workspace[0] ?? null })
})

const schema = z.object({
  name: z.string().min(2).max(120).optional(),
  timezone: z.string().max(60).optional(),
  currency: z.enum(ALLOWED_CURRENCIES as unknown as [string, ...string[]]).optional(),
  country: z.string().max(60).optional(),
  legalName: z.string().max(160).nullable().optional(),
  riskTolerance: z.enum(RISK_TOLERANCES as unknown as [string, ...string[]]).optional(),
  automationLevel: z.enum(AUTOMATION_LEVELS as unknown as [string, ...string[]]).optional(),
  interests: z.array(z.string().max(60)).max(30).optional(),
  skills: z.array(z.string().max(60)).max(30).optional(),
  industries: z.array(z.string().max(60)).max(30).optional(),
  businessModels: z.array(z.string().max(60)).max(30).optional(),
  monetizationPreferences: z.array(z.string().max(60)).max(30).optional(),
  dailyBudgetCents: z.number().int().min(0).max(1_000_000).optional(),
  monthlyBudgetCents: z.number().int().min(0).max(10_000_000).optional(),
  maxProjectBudgetCents: z.number().int().min(0).max(10_000_000).optional(),
  perAgentDailyLimitCents: z.number().int().min(0).max(1_000_000).optional(),
  scoreThreshold: z.number().int().min(0).max(100).optional(),
  maxOperatingCostCentsMonth: z.number().int().min(0).max(10_000_000).optional(),
  minTimeToRevenueDays: z.number().int().min(0).max(3650).optional(),
  notifyEmail: z.boolean().optional(),
  notifyBrowser: z.boolean().optional(),
  notifyTelegram: z.boolean().optional(),
  telegramChatId: z.string().max(60).nullable().optional(),
  onboarded: z.boolean().optional(),
})

export const PATCH = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, schema)

  if (input.name) {
    await db.update(users).set({ name: input.name, updatedAt: new Date() }).where(eq(users.id, ctx.session.id))
  }

  const { name, ...profilePatch } = input
  void name

  let profile = (await db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1))[0]
  if (!profile) {
    const inserted = await db
      .insert(profiles)
      .values({ workspaceId, userId: ctx.session.id, ...profilePatch } as typeof profiles.$inferInsert)
      .returning()
    profile = inserted[0]!
  } else if (Object.keys(profilePatch).length > 0) {
    const updated = await db
      .update(profiles)
      .set({ ...profilePatch, updatedAt: new Date() } as Partial<typeof profiles.$inferInsert>)
      .where(eq(profiles.id, profile.id))
      .returning()
    profile = updated[0]!
  }

  // Email verification is a separate, explicit flow — never toggled here.
  if (input.onboarded) {
    await db.update(users).set({ onboardedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, ctx.session.id))
  }

  return ok({ profile })
})
