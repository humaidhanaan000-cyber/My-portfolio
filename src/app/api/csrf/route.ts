/** GET /api/csrf — issue (or reuse) the CSRF double-submit cookie for the client. */
import { cookies } from 'next/headers'
import { ok } from '@/lib/api/http'
import { CSRF_COOKIE, randomToken } from '@/lib/security/crypto'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

export async function GET() {
  const store = await cookies()
  let token = store.get(CSRF_COOKIE)?.value
  if (!token) {
    token = randomToken(24)
    store.set(CSRF_COOKIE, token, { httpOnly: false, sameSite: 'lax', secure: env.COOKIE_SECURE, path: '/' })
  }
  return ok({ csrfToken: token })
}
