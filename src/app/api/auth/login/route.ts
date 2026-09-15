/** POST /api/auth/login */
import { z } from 'zod'
import { ok, withPublicApi, parseBody } from '@/lib/api/http'
import { authenticate, AuthError } from '@/lib/auth'
import { fail } from '@/lib/api/http'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

const schema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) })

export const POST = withPublicApi(
  async (ctx) => {
    const input = await parseBody(ctx.request, schema)
    try {
      const session = await authenticate({
        email: input.email,
        password: input.password,
        ip: ctx.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
        userAgent: ctx.request.headers.get('user-agent') ?? undefined,
      })
      return ok({ user: session, nextStep: session.onboarded ? '/dashboard' : '/onboarding' })
    } catch (error) {
      if (error instanceof AuthError) {
        const code = error.code === 'rate_limited' ? 'rate_limited' : error.code === 'locked' ? 'forbidden' : 'unauthorized'
        return fail(code, error.message)
      }
      throw error
    }
  },
  { rateLimit: { limit: env.RATE_LIMIT_MAX_AUTH * 3, windowMs: 300_000, scope: 'login' } },
)
