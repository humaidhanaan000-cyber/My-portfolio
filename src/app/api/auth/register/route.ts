/** POST /api/auth/register — create a user, workspace and session. */
import { z } from 'zod'
import { created, withPublicApi, parseBody, ApiError } from '@/lib/api/http'
import { registerUser, createSession } from '@/lib/auth'
import { checkPasswordStrength, MIN_PASSWORD_LENGTH } from '@/lib/security/password'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

const schema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  workspaceName: z.string().min(2).max(120).optional(),
})

export const POST = withPublicApi(
  async (ctx) => {
    const input = await parseBody(ctx.request, schema)
    const strength = checkPasswordStrength(input.password)
    if (!strength.ok) {
      throw new ApiError('validation_error', `Password is too weak. Requirements: ${strength.problems.join(', ')}.`)
    }

    const result = await registerUser({
      email: input.email,
      password: input.password,
      name: input.name,
      workspaceName: input.workspaceName,
      ip: ctx.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
      userAgent: ctx.request.headers.get('user-agent') ?? undefined,
    })

    const session = await createSession(result.userId, undefined, ctx.request.headers.get('user-agent') ?? undefined)

    return created({
      user: session,
      emailVerificationRequired: env.REQUIRE_EMAIL_VERIFICATION,
      nextStep: session.onboarded ? '/dashboard' : '/onboarding',
    })
  },
  { rateLimit: { limit: 8, windowMs: 3_600_000, scope: 'register' } },
)
