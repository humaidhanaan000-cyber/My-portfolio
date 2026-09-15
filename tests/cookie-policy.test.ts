/**
 * Regression tests for the cookie policy behind sign-in.
 *
 * Three real bugs lived here, all invisible in a plain `curl` run but fatal in a
 * browser:
 *   1. the session cookie was `SameSite=Lax` while the app was served inside a
 *      cross-site frame → the browser silently dropped it → every page load was
 *      anonymous and the user bounced back to the sign-in page;
 *   2. `/api/csrf` wrote its own cookie with hardcoded `SameSite=lax`, so the
 *      double-submit token was dropped too and every mutating request answered
 *      `403 forbidden` even with a valid session;
 *   3. the browser client looked the CSRF cookie up under a hardcoded name, which
 *      stops matching as soon as the server prefixes it with `__Host-`.
 *
 * Each test below pins one of those properties, using the real route handler and
 * the real session-cookie writer with `next/headers` replaced by an in-memory jar.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Written = { name: string; value: string; options: Record<string, unknown> }

const jar = new Map<string, string>()
const written: Written[] = []

vi.mock('next/headers', () => ({
  // `x-forwarded-proto: https` mimics a TLS-terminating proxy (the hosted preview
  // and every production deployment). The app itself speaks http in that setup,
  // so `Secure` must not depend on the request scheme alone.
  headers: async () => new Headers({ 'x-forwarded-proto': 'https' }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      if (value) jar.set(name, value)
      else jar.delete(name)
      written.push({ name, value, options })
    },
    delete: (name: string) => {
      jar.delete(name)
    },
  }),
}))

const { applySessionCookies, authCookieOptions, verifyCsrf } = await import('../src/lib/auth')
const { CSRF_COOKIE, SESSION_COOKIE } = await import('../src/lib/security/crypto')
const { CSRF_COOKIE_NAMES } = await import('../src/lib/client/api')
const { GET: csrfRoute } = await import('../src/app/api/csrf/route')

/** The security-relevant attributes, so a cookie cannot be judged by accident. */
function securityAttributes(options: Record<string, unknown>) {
  return {
    path: options.path,
    sameSite: options.sameSite,
    secure: options.secure,
    partitioned: options.partitioned ?? false,
  }
}

function lastWrite(name: string): Written {
  const match = [...written].reverse().find((entry) => entry.name === name)
  if (!match) throw new Error(`cookie ${name} was never written`)
  return match
}

beforeEach(() => {
  jar.clear()
  written.length = 0
})

describe('cookie policy', () => {
  it('gives the CSRF cookie exactly the session cookie security attributes', async () => {
    const response = await csrfRoute()
    const body = (await response.json()) as { data: { csrfToken: string } }
    const csrf = lastWrite(CSRF_COOKIE)
    // The token handed back in the body is the one stored in the cookie.
    expect(body.data.csrfToken).toBe(csrf.value)
    expect(jar.get(CSRF_COOKIE)).toBe(csrf.value)

    const record = { token: 'session-token-value', csrfToken: 'csrf-token-value', expiresAt: new Date(Date.now() + 60_000) }
    await applySessionCookies(record)
    const session = lastWrite(SESSION_COOKIE)
    const sessionCsrf = lastWrite(CSRF_COOKIE)

    // Cross-site framing fixes: https forwarded, so `Secure` is on even though the
    // request reached the app over http.
    expect(securityAttributes(csrf.options)).toEqual({ path: '/', sameSite: 'lax', secure: true, partitioned: false })
    expect(securityAttributes(csrf.options)).toEqual(securityAttributes(session.options))
    expect(securityAttributes(csrf.options)).toEqual(securityAttributes(sessionCsrf.options))

    // Double-submit needs the client to read the token, the session must stay hidden.
    expect(csrf.options.httpOnly).toBe(false)
    expect(session.options.httpOnly).toBe(true)

  })

  it('reuses the CSRF cookie instead of issuing a new token on every call', async () => {
    const first = (await (await csrfRoute()).json()) as { data: { csrfToken: string } }
    const writesAfterFirst = written.length
    const second = (await (await csrfRoute()).json()) as { data: { csrfToken: string } }

    expect(second.data.csrfToken).toBe(first.data.csrfToken)
    expect(written.length).toBe(writesAfterFirst)
  })

  it('accepts only a header that matches the cookie (double submit)', async () => {
    jar.set(CSRF_COOKIE, 'token-abc')
    const withHeader = (value?: string) =>
      new Request('http://localhost/api/x', { headers: value ? { 'x-csrf-token': value } : {} })

    await expect(verifyCsrf(withHeader('token-abc'))).resolves.toBe(true)
    await expect(verifyCsrf(withHeader('token-abd'))).resolves.toBe(false)
    await expect(verifyCsrf(withHeader('token-abc-longer'))).resolves.toBe(false)
    await expect(verifyCsrf(withHeader())).resolves.toBe(false)
    // A matching header is worthless when the cookie is gone (fresh browser, or a
    // cookie the browser refused to store).
    jar.clear()
    await expect(verifyCsrf(withHeader('token-abc'))).resolves.toBe(false)
  })

  it('switches both cookies to cross-site (Secure + Partitioned) when COOKIE_SAMESITE=none', async () => {
    process.env.COOKIE_SAMESITE = 'none'
    vi.resetModules()
    try {
      const fresh = await import('../src/lib/auth')
      // No request context is available here and none is needed: with `none` the
      // answer is decided from configuration alone.
      expect(await fresh.authCookieOptions()).toEqual({ secure: true, sameSite: 'none', partitioned: true })
    } finally {
      delete process.env.COOKIE_SAMESITE
      vi.resetModules()
    }
  })

  it('lets the browser client find the CSRF cookie under either name', () => {
    // Whichever spelling the server issued, the client must be able to send it —
    // a name mismatch means silently sending no token and getting `forbidden`.
    expect([...CSRF_COOKIE_NAMES]).toEqual(['__Host-aiba_csrf', 'aiba_csrf'])
    expect(CSRF_COOKIE_NAMES).toContain(CSRF_COOKIE)
    expect(SESSION_COOKIE.endsWith('aiba_session')).toBe(true)
  })
})
