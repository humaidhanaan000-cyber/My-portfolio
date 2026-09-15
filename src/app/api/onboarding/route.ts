/**
 * Onboarding wizard state and submission.
 *
 * GET  returns the current answers and which step is next.
 * POST accepts a single step (or the whole wizard) and persists it. Nothing is
 * auto-enabled: the wizard ends with the operator explicitly choosing an
 * automation level, defaulting to "approval required".
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb, profiles, users, workspaces } from '@/lib/db'
import { ok, parseBody, withApi } from '@/lib/api/http'
import { AUTOMATION_LEVELS, RISK_TOLERANCES } from '@/lib/utils'

export const dynamic = 'force-dynamic'

const stepSchema = z.object({
  step: z.enum(['profile', 'risk', 'budget', 'monetization', 'automation', 'complete']),
  profile: z
    .object({
      legalName: z.string().max(160).optional(),
      country: z.string().max(60).optional(),
      currency: z.string().length(3).optional(),
      timezone: z.string().max(60).optional(),
      interests: z.array(z.string().max(60)).max(30).optional(),
      skills: z.array(z.string().max(60)).max(30).optional(),
      industries: z.array(z.string().max(60)).max(30).optional(),
      businessModels: z.array(z.string().max(60)).max(30).optional(),
    })
    .optional(),
  risk: z.object({ riskTolerance: z.enum(RISK_TOLERANCES as unknown as [string, ...string[]]) }).optional(),
  budget: z
    .object({
      dailyBudgetCents: z.number().int().min(0).max(1_000_000),
      monthlyBudgetCents: z.number().int().min(0).max(10_000_000),
      maxProjectBudgetCents: z.number().int().min(0).max(10_000_000),
      perAgentDailyLimitCents: z.number().int().min(0).max(1_000_000).optional(),
    })
    .optional(),
  monetization: z
    .object({
      monetizationPreferences: z.array(z.string().max(60)).max(20),
      scoreThreshold: z.number().int().min(0).max(100).optional(),
    })
    .optional(),
  automation: z
    .object({
      automationLevel: z.enum(AUTOMATION_LEVELS as unknown as [string, ...string[]]),
      notifyEmail: z.boolean().optional(),
      notifyBrowser: z.boolean().optional(),
      notifyTelegram: z.boolean().optional(),
    })
    .optional(),
})

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const [profile, user, workspace] = await Promise.all([
    db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1),
    db.select({ onboardedAt: users.onboardedAt, email: users.email, name: users.name }).from(users).where(eq(users.id, ctx.session.id)).limit(1),
    db.select({ demoMode: workspaces.demoMode, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
  ])

  const row = profile[0]
  const completed = Boolean(user[0]?.onboardedAt)
  const steps = [
    { key: 'profile', label: 'Your profile', done: Boolean(row?.country && row?.interests?.length) },
    { key: 'risk', label: 'Risk tolerance', done: Boolean(row?.riskTolerance) },
    { key: 'budget', label: 'Budget limits', done: Boolean(row && row.dailyBudgetCents >= 0 && row.monthlyBudgetCents >= 0) },
    { key: 'monetization', label: 'Monetization preferences', done: Boolean(row?.monetizationPreferences?.length) },
    { key: 'automation', label: 'Automation level', done: Boolean(row?.automationLevel) },
  ]

  return ok({
    completed,
    step: steps.find((entry) => !entry.done)?.key ?? 'complete',
    steps,
    profile: row ?? null,
    user: user[0] ?? null,
    workspace: workspace[0] ?? null,
    defaults: { automationLevel: row?.automationLevel ?? 'approval_required' },
  })
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, stepSchema)

  const patch: Record<string, unknown> = {}
  if (input.profile) Object.assign(patch, input.profile)
  if (input.risk) Object.assign(patch, input.risk)
  if (input.budget) Object.assign(patch, input.budget)
  if (input.monetization) Object.assign(patch, input.monetization)
  if (input.automation) Object.assign(patch, input.automation)

  const existing = (await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1))[0]
  if (existing) {
    if (Object.keys(patch).length) {
      await db.update(profiles).set({ ...patch, updatedAt: new Date() }).where(eq(profiles.id, existing.id))
    }
  } else {
    await db.insert(profiles).values({ workspaceId, userId: ctx.session.id, ...patch } as typeof profiles.$inferInsert)
  }

  // Budget limits chosen in the wizard become real per-scope guardrails at once.
  if (input.budget) {
    const { budgets } = await import('@/lib/db')
    const entries: { scope: string; period: string; limitCents: number }[] = [
      { scope: 'workspace', period: 'daily', limitCents: input.budget.dailyBudgetCents },
      { scope: 'workspace', period: 'monthly', limitCents: input.budget.monthlyBudgetCents },
      { scope: 'agent', period: 'daily', limitCents: input.budget.perAgentDailyLimitCents ?? input.budget.dailyBudgetCents },
    ]
    const existingBudgets = await db.select().from(budgets).where(eq(budgets.workspaceId, workspaceId))
    for (const entry of entries) {
      const match = existingBudgets.find((row) => row.scope === entry.scope && row.period === entry.period && (row.scopeKey === null || row.scopeKey === '*'))
      if (match) {
        await db.update(budgets).set({ limitCents: entry.limitCents, updatedAt: new Date() }).where(eq(budgets.id, match.id))
      } else {
        await db.insert(budgets).values({
          workspaceId,
          scope: entry.scope,
          scopeKey: entry.scope === 'agent' ? '*' : null,
          period: entry.period,
          limitCents: entry.limitCents,
          enabled: true,
        })
      }
    }
  }

  if (input.step === 'complete') {
    await db.update(users).set({ onboardedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, ctx.session.id))
  }

  const profile = (await db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1))[0]
  return ok({ saved: true, step: input.step, profile })
})
