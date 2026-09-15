/** POST /api/billing/checkout — start a provider checkout for a plan change. */
import { z } from 'zod'
import { ok, parseBody, withApi, ApiError } from '@/lib/api/http'
import { PaymentError, createCheckout } from '@/lib/payments'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

const schema = z.object({
  planKey: z.string().min(1).max(40),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
})

export const POST = withApi(
  async (ctx) => {
    const input = await parseBody(ctx.request, schema)
    try {
      const result = await createCheckout({
        workspaceId: ctx.session.workspaceId,
        planKey: input.planKey,
        interval: input.interval,
        customerEmail: ctx.session.email,
        successUrl: `${env.APP_URL}/dashboard/billing?status=success`,
        cancelUrl: `${env.APP_URL}/dashboard/billing?status=cancelled`,
      })
      return ok(result)
    } catch (error) {
      if (error instanceof PaymentError) {
        throw new ApiError(error.code === 'not_configured' ? 'not_configured' : 'validation_error', error.message, error.details)
      }
      throw error
    }
  },
  { rateLimit: { limit: 10, windowMs: 60_000, scope: 'checkout' } },
)
