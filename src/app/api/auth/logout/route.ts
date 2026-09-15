/** POST /api/auth/logout — revoke the current session. */
import { ok, withPublicApi, ApiError } from '@/lib/api/http'
import { destroySession, verifyCsrf } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export const POST = withPublicApi(async (ctx) => {
  if (!(await verifyCsrf(ctx.request))) throw new ApiError('forbidden', 'CSRF validation failed.')
  await destroySession()
  return ok({ signedOut: true })
})
