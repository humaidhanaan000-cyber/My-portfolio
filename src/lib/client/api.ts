'use client'

/**
 * Browser API client.
 *
 * Every mutating request sends the CSRF token from the double-submit cookie, and
 * every response is unwrapped from the shared `{ data, meta }` / `{ error }`
 * envelope. Errors are thrown as `ApiClientError` so components can show the real
 * message the server produced instead of a generic failure.
 */

/**
 * Name of the CSRF double-submit cookie.
 *
 * It must match the server (`src/lib/security/crypto.ts`), which prefixes the name
 * with `__Host-` when cookies are Secure. Reading the wrong name silently yields no
 * token, and then every mutating request is rejected with `forbidden` — so both
 * spellings are tried, and `/api/csrf` is asked for the value as a fallback: the
 * server returns the token in the response body precisely so the client does not
 * depend on being able to read the cookie itself (which is impossible for a
 * partitioned cookie in some browsers, and for a `__Host-` cookie name that does
 * not match the build-time constant).
 */
export const CSRF_COOKIE_NAMES = ['__Host-aiba_csrf', 'aiba_csrf'] as const
export const CSRF_COOKIE = CSRF_COOKIE_NAMES[1]

export type ApiEnvelope<T> = { data: T; meta?: Record<string, unknown> }
export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } }

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.split('; ').find((row) => row.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null
}

export async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; query?: Record<string, string | number | boolean | undefined | null> } = {},
): Promise<{ data: T; meta?: Record<string, unknown> }> {
  const method = options.method ?? 'GET'
  const url = new URL(path, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }

  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  // Every mutating request carries the double-submit token. Read it from the
  // cookie when possible; otherwise ask the server, which returns the same value
  // in the body of `/api/csrf`.
  if (method !== 'GET' && method !== 'HEAD') {
    let token = CSRF_COOKIE_NAMES.map((name) => readCookie(name)).find((value): value is string => Boolean(value)) ?? null
    if (!token) {
      const issued = await fetch('/api/csrf', { credentials: 'same-origin' })
        .then((response) => (response.ok ? (response.json() as Promise<{ data?: { csrfToken?: string } }>) : null))
        .catch(() => null)
      token = issued?.data?.csrfToken ?? CSRF_COOKIE_NAMES.map((name) => readCookie(name)).find((value): value is string => Boolean(value)) ?? null
    }
    if (token) headers['x-csrf-token'] = token
  }

  const response = await fetch(url.pathname + url.search, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    cache: 'no-store',
  })

  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }

  if (!response.ok) {
    const body = parsed as ApiErrorBody | null
    throw new ApiClientError(
      body?.error?.message ?? `Request failed with HTTP ${response.status}.`,
      body?.error?.code ?? 'http_error',
      response.status,
      body?.error?.details,
    )
  }

  const envelope = parsed as ApiEnvelope<T> | null
  if (envelope && typeof envelope === 'object' && 'data' in envelope) {
    return { data: envelope.data, meta: envelope.meta }
  }
  return { data: parsed as T }
}

export const api = {
  get: <T>(path: string, query?: Record<string, string | number | boolean | undefined | null>) => apiFetch<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'DELETE', body }),
}
