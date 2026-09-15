/** POST /api/auth/verify-email */
import { z } from 'zod'
import { ok, withPublicApi, parseBody, ApiError } from '@/lib/api/http'
import { verifyEmailToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const schema = z.object({ token: z.string().min(10).max(300) })

export const POST = withPublicApi(async (ctx) => {
  const { token } = await parseBody(ctx.request, schema)
  const verified = await verifyEmailToken(token)
  if (!verified) throw new ApiError('validation_error', 'This verification link is invalid or has expired.')
  return ok({ verified: true })
})
