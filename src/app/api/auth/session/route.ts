/** GET /api/auth/session — the signed-in user's context; DELETE signs out. */
import { z } from 'zod'
import { ok, withApi, withPublicApi, parseBody, ApiError } from '@/lib/api/http'
import { getSession, destroySession, verifyCsrf } from '@/lib/auth'
import { publicConfig } from '@/lib/env'

export const dynamic = 'force-dynamic'

export const GET = withPublicApi(async () => {
  const session = await getSession()
  return ok({ authenticated: Boolean(session), user: session, config: publicConfig() })
})

export const DELETE = withPublicApi(async (ctx) => {
  if (!(await verifyCsrf(ctx.request))) throw new ApiError('forbidden', 'CSRF validation failed.')
  await destroySession()
  return ok({ signedOut: true })
}, { rateLimit: { limit: 30, windowMs: 60_000, scope: 'logout' } })

export const PATCH = withApi(async (ctx) => {
  const body = await parseBody(ctx.request, z.object({}))
  void body
  return ok({ user: ctx.session })
})
