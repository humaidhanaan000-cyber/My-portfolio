/**
 * Budget guardrails.
 *
 * GET returns every hard limit with live usage so the UI can show how much
 * headroom is left. PATCH changes limits — AIBA can never raise its own limits,
 * only the operator can.
 */
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getDb, budgets, profiles, workspaces } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'
import { budgetSnapshot } from '@/lib/budget'
import { formatMoney } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const [snapshot, rows, profile, workspace] = await Promise.all([
    budgetSnapshot(workspaceId),
    db.select().from(budgets).where(eq(budgets.workspaceId, workspaceId)),
    db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1),
    db.select({ planKey: workspaces.planKey, demoMode: workspaces.demoMode }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
  ])
  return ok({
    snapshot,
    rows: rows.map((row) => ({ ...row, limitMoney: formatMoney(row.limitCents) })),
    profile: profile[0]
      ? {
          dailyBudgetCents: profile[0].dailyBudgetCents,
          monthlyBudgetCents: profile[0].monthlyBudgetCents,
          maxProjectBudgetCents: profile[0].maxProjectBudgetCents,
          perAgentDailyLimitCents: profile[0].perAgentDailyLimitCents,
        }
      : null,
    planKey: workspace[0]?.planKey ?? 'free',
  })
})

const schema = z.object({
  dailyBudgetCents: z.number().int().min(0).max(10_000_00).optional(),
  monthlyBudgetCents: z.number().int().min(0).max(100_000_00).optional(),
  maxProjectBudgetCents: z.number().int().min(0).max(100_000_00).optional(),
  perAgentDailyLimitCents: z.number().int().min(0).max(100_000_00).optional(),
  /** Requires an explicit acknowledgement: hard limits are never bypassed. */
  acknowledgeHardLimits: z.literal(true),
})

export const PATCH = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const { acknowledgeHardLimits, ...limits } = await parseBody(ctx.request, schema)
  void acknowledgeHardLimits

  const profile = (await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1))[0]
  if (!profile) throw new ApiError('not_found', 'Profile not found. Complete onboarding first.')
  if (Object.keys(limits).length === 0) throw new ApiError('validation_error', 'No limits supplied.')

  const rows = await db.update(profiles).set({ ...limits, updatedAt: new Date() }).where(eq(profiles.id, profile.id)).returning()

  // Keep the per-scope budget rows in sync so every spend check reads one truth.
  const upserts: { scope: string; scopeKey: string | null; period: string; limitCents: number }[] = []
  if (limits.dailyBudgetCents !== undefined) upserts.push({ scope: 'workspace', scopeKey: null, period: 'daily', limitCents: limits.dailyBudgetCents })
  if (limits.monthlyBudgetCents !== undefined) upserts.push({ scope: 'workspace', scopeKey: null, period: 'monthly', limitCents: limits.monthlyBudgetCents })
  if (limits.perAgentDailyLimitCents !== undefined) upserts.push({ scope: 'agent', scopeKey: '*', period: 'daily', limitCents: limits.perAgentDailyLimitCents })

  for (const entry of upserts) {
    const existing = await db
      .select({ id: budgets.id })
      .from(budgets)
      .where(and(eq(budgets.workspaceId, workspaceId), eq(budgets.scope, entry.scope), eq(budgets.period, entry.period), entry.scopeKey ? eq(budgets.scopeKey, entry.scopeKey) : eq(budgets.scope, entry.scope)))
      .limit(1)
    if (existing[0]) {
      await db.update(budgets).set({ limitCents: entry.limitCents, updatedAt: new Date() }).where(eq(budgets.id, existing[0].id))
    } else {
      await db.insert(budgets).values({ workspaceId, scope: entry.scope, scopeKey: entry.scopeKey, period: entry.period, limitCents: entry.limitCents, enabled: true })
    }
  }

  return ok({ profile: rows[0], snapshot: await budgetSnapshot(workspaceId), message: 'Limits updated. They apply to the very next paid action.' })
})
