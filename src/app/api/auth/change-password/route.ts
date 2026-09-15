/** POST /api/auth/change-password — requires the current password. */
import { z } from 'zod'
import { ok, withApi, parseBody, ApiError } from '@/lib/api/http'
import { changePassword, revokeAllSessions, createSession } from '@/lib/auth'
import { checkPasswordStrength, MIN_PASSWORD_LENGTH } from '@/lib/security/password'

export const dynamic = 'force-dynamic'

const schema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(200),
})

export const POST = withApi(
  async (ctx) => {
    const input = await parseBody(ctx.request, schema)
    const strength = checkPasswordStrength(input.newPassword)
    if (!strength.ok) throw new ApiError('validation_error', `Password is too weak. Requirements: ${strength.problems.join(', ')}.`)
    const changed = await changePassword(ctx.session.id, input.currentPassword, input.newPassword)
    if (!changed) throw new ApiError('forbidden', 'The current password is incorrect.')
    await revokeAllSessions(ctx.session.id)
    await createSession(ctx.session.id, undefined, ctx.request.headers.get('user-agent') ?? undefined)
    return ok({ changed: true })
  },
  { rateLimit: { limit: 10, windowMs: 900_000, scope: 'change-password' } },
)
