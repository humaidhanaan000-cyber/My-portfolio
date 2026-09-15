/**
 * POST /api/auth/forgot-password
 * Always returns the same response, whether or not the account exists —
 * account enumeration protection.
 */
import { z } from 'zod'
import { ok, withPublicApi, parseBody } from '@/lib/api/http'
import { requestPasswordReset } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const schema = z.object({ email: z.string().email() })

export const POST = withPublicApi(
  async (ctx) => {
    const { email } = await parseBody(ctx.request, schema)
    await requestPasswordReset(email, ctx.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim())
    return ok({ submitted: true, message: 'If an account exists for that address, a reset link has been sent.' })
  },
  { rateLimit: { limit: 6, windowMs: 900_000, scope: 'forgot' } },
)
