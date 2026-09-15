/**
 * GET /api/billing/plans — public pricing.
 *
 * Prices are read from the `plans` table (admin-configurable) and never hardcoded
 * here or in the UI. `currency` and prices come straight from the database.
 */
import { z } from 'zod'
import { ok, parseBody, withApi } from '@/lib/api/http'
import { listPlans, paymentStatus, updatePlan } from '@/lib/payments'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [plans, payments] = await Promise.all([listPlans(), Promise.resolve(paymentStatus())])
  return ok({
    plans: plans.map((plan) => ({
      ...plan,
      priceMonthly: plan.priceMonthlyCents === 0 ? 'Free' : (plan.priceMonthlyCents / 100).toFixed(2),
      priceYearly: plan.priceYearlyCents === 0 ? 'Free' : (plan.priceYearlyCents / 100).toFixed(2),
      priceNote: 'Prices are configured by the deployment administrator and may change.',
    })),
    provider: payments,
  })
}

/**
 * PATCH /api/billing/plans — administrator-only price and catalogue edits.
 *
 * Prices are configuration, not code: this is how a deployment changes what it
 * charges without a redeploy. Every change is written to `payment_events` with
 * the acting user id, so a price change is always attributable.
 */
const patchSchema = z.object({
  key: z.string().min(1).max(40),
  priceMonthlyCents: z.number().int().min(0).max(10_000_000).optional(),
  priceYearlyCents: z.number().int().min(0).max(100_000_000).optional(),
  name: z.string().min(1).max(80).optional(),
  tagline: z.string().max(300).optional(),
  features: z.array(z.string().max(200)).max(30).optional(),
  isPublic: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
})

export const PATCH = withApi(
  async (ctx) => {
    const input = await parseBody(ctx.request, patchSchema)
    const { key, ...patch } = input
    const plan = await updatePlan(key, patch, ctx.session.id)
    return ok({ plan, note: 'Price changes take effect immediately and are recorded in the audit trail.' })
  },
  { admin: true, rateLimit: { limit: 20, windowMs: 60_000, scope: 'billing-plans' } },
)
