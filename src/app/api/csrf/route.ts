/**
 * GET /api/csrf — issue (or reuse) the CSRF double-submit cookie for the client.
 *
 * The cookie attributes come from `authCookieOptions()` rather than being written
 * here by hand: the session cookie and this one must agree, and when the app is
 * embedded in a cross-site frame a `SameSite=Lax` cookie is discarded by the
 * browser — which made every mutating request fail with `forbidden` even though
 * the token had just been handed out.
 */
import { cookies } from 'next/headers'
import { ok } from '@/lib/api/http'
import { authCookieOptions } from '@/lib/auth'
import { CSRF_COOKIE, randomToken } from '@/lib/security/crypto'

export const dynamic = 'force-dynamic'

export async function GET() {
  const store = await cookies()
  let token = store.get(CSRF_COOKIE)?.value
  if (!token) {
    token = randomToken(24)
    store.set(CSRF_COOKIE, token, { httpOnly: false, path: '/', ...(await authCookieOptions()) })
  }
  return ok({ csrfToken: token })
}
