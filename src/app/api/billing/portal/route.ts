/** POST /api/billing/portal — open the provider's billing portal. */
import { z } from 'zod'
import { ok, parseBody, withApi, ApiError } from '@/lib/api/http'
import { PaymentError, createPortalSession } from '@/lib/payments'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

const schema = z.object({ returnUrl: z.string().url().max(500).optional() })

export const POST = withApi(async (ctx) => {
  const input = await parseBody(ctx.request, schema)
  try {
    const result = await createPortalSession(ctx.session.workspaceId, input.returnUrl ?? `${env.APP_URL}/dashboard/billing`)
    return ok(result)
  } catch (error) {
    if (error instanceof PaymentError) throw new ApiError('not_configured', error.message)
    throw error
  }
})
