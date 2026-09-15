/** POST /api/auth/reset-password */
import { z } from 'zod'
import { ok, withPublicApi, parseBody, ApiError } from '@/lib/api/http'
import { resetPassword } from '@/lib/auth'
import { checkPasswordStrength, MIN_PASSWORD_LENGTH } from '@/lib/security/password'

export const dynamic = 'force-dynamic'

const schema = z.object({ token: z.string().min(10).max(300), password: z.string().min(MIN_PASSWORD_LENGTH).max(200) })

export const POST = withPublicApi(
  async (ctx) => {
    const input = await parseBody(ctx.request, schema)
    const strength = checkPasswordStrength(input.password)
    if (!strength.ok) throw new ApiError('validation_error', `Password is too weak. Requirements: ${strength.problems.join(', ')}.`)
    const success = await resetPassword(input.token, input.password)
    if (!success) throw new ApiError('validation_error', 'This reset link is invalid or has expired. Request a new one.')
    return ok({ reset: true, message: 'Password updated. All other sessions have been signed out.' })
  },
  { rateLimit: { limit: 10, windowMs: 900_000, scope: 'reset' } },
)
