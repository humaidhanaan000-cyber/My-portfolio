'use client'

/**
 * Browser API client.
 *
 * Every mutating request sends the CSRF token from the double-submit cookie, and
 * every response is unwrapped from the shared `{ data, meta }` / `{ error }`
 * envelope. Errors are thrown as `ApiClientError` so components can show the real
 * message the server produced instead of a generic failure.
 */

export const CSRF_COOKIE = 'aiba_csrf'

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
  if (method !== 'GET' && method !== 'HEAD') {
    const token = readCookie(CSRF_COOKIE)
    if (token) headers['x-csrf-token'] = token
  }

  // Ensure a CSRF cookie exists before the first mutation.
  if (method !== 'GET' && method !== 'HEAD' && !readCookie(CSRF_COOKIE)) {
    await fetch('/api/csrf', { credentials: 'same-origin' }).catch(() => undefined)
    const token = readCookie(CSRF_COOKIE)
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
