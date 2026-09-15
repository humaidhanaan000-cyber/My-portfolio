/**
 * API conventions.
 *
 * Every route returns the same envelope, so clients (and the dashboard's fetch
 * helpers) can handle success and failure uniformly:
 *
 *   success → { data, meta? }
 *   failure → { error: { code, message, details? } }
 *
 * `withApi()` centralises authentication, CSRF, rate limiting and error
 * translation, and guarantees that internal errors never leak stack traces to
 * the client while still being logged and persisted server-side.
 */
import { NextResponse } from 'next/server'
import { ZodError, type z } from 'zod'
import { AuthError, getSession, verifyCsrf, type SessionUser } from '../auth'
import { rateLimit, clientIdentifier } from '../security/rate-limit'
import { createLogger, persistLog } from '../observability/logger'
import { env } from '../env'

const log = createLogger({ component: 'api' })

export type ApiContext = {
  session: SessionUser
  request: Request
  params: Record<string, string>
  searchParams: URLSearchParams
  log: ReturnType<typeof createLogger>
}

export type PublicContext = {
  request: Request
  params: Record<string, string>
  searchParams: URLSearchParams
  log: ReturnType<typeof createLogger>
}

export type ApiMeta = Record<string, unknown>

export function ok<T>(data: T, meta?: ApiMeta, init?: ResponseInit) {
  return NextResponse.json({ data, ...(meta ? { meta } : {}) }, { status: 200, ...init })
}

export function created<T>(data: T, meta?: ApiMeta) {
  return NextResponse.json({ data, ...(meta ? { meta } : {}) }, { status: 201 })
}

export function noContent() {
  return new NextResponse(null, { status: 204 })
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'rate_limited'
  | 'conflict'
  | 'budget_blocked'
  | 'policy_blocked'
  | 'not_configured'
  | 'internal_error'

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_error: 422,
  rate_limited: 429,
  conflict: 409,
  budget_blocked: 402,
  policy_blocked: 403,
  not_configured: 501,
  internal_error: 500,
}

export function fail(code: ApiErrorCode, message: string, details?: unknown, headers?: HeadersInit) {
  return NextResponse.json({ error: { code, message, details } }, { status: STATUS[code], headers })
}

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/* ------------------------------------------------------------ route factory */

export type RouteHandler = (ctx: ApiContext, request: Request) => Promise<Response> | Response
export type PublicRouteHandler = (ctx: PublicContext, request: Request) => Promise<Response> | Response

type RouteOptions = {
  /** Require a CSRF token (any mutating request should set this). */
  csrf?: boolean
  /** Rate limit bucket override. */
  rateLimit?: { limit: number; windowMs: number; scope: string }
  /** Admin-only route. */
  admin?: boolean
  /** Skip authentication entirely (public endpoints). */
  public?: boolean
}

type RouteParams = { params: Promise<Record<string, string | string[] | undefined>> }

/**
 * Next.js validates the *declared* shape of a route handler at build time: the
 * second argument must be required and must resolve to the route's segment
 * params. Our wrappers are defensive at runtime (a static route is invoked with
 * no second argument), so the runtime signature stays optional and the exported
 * type is narrowed to what Next expects.
 */
export type WrappedRoute = (request: Request, routeParams: RouteParams) => Promise<Response>

function normaliseParams(raw: Record<string, string | string[] | undefined> | undefined): Record<string, string> {
  if (!raw) return {}
  const entries: [string, string][] = []
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    entries.push([key, Array.isArray(value) ? (value[0] ?? '') : value])
  }
  return Object.fromEntries(entries)
}

/** Wrap an authenticated route handler. */
export function withApi(handler: RouteHandler, options: RouteOptions = {}): WrappedRoute {
  const wrapped = async (request: Request, routeParams?: RouteParams): Promise<Response> => {
    const started = Date.now()
    const params = normaliseParams(routeParams ? await routeParams.params : undefined)
    const searchParams = new URL(request.url).searchParams
    const requestLog = createLogger({
      component: 'api',
      method: request.method,
      path: new URL(request.url).pathname,
    })

    try {
      const session = await getSession()
      if (!session) throw new ApiError('unauthorized', 'Sign in to continue.')
      if (options.admin && session.role !== 'admin') {
        throw new ApiError('forbidden', 'Administrator access required.')
      }

      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
      if (options.csrf !== false && mutating) {
        const valid = await verifyCsrf(request)
        if (!valid) {
          throw new ApiError('forbidden', 'CSRF validation failed. Reload the page and try again.')
        }
      }

      const limit = options.rateLimit ?? { limit: env.RATE_LIMIT_MAX_API, windowMs: env.RATE_LIMIT_WINDOW_MS, scope: 'api' }
      const gate = await rateLimit(clientIdentifier(request.headers, limit.scope, session.workspaceId), limit)
      if (!gate.allowed) {
        throw new ApiError('rate_limited', `Rate limit reached. Retry in ${gate.retryAfterSeconds}s.`, {
          limit: gate.limit,
          resetAt: new Date(gate.resetAt).toISOString(),
        })
      }

      const response = await handler({ session, request, params, searchParams, log: requestLog }, request)
      const durationMs = Date.now() - started
      if (durationMs > 1500) {
        requestLog.warn('slow api request', { durationMs, status: response.status })
      }
      response.headers.set('x-response-time', `${durationMs}ms`)
      return response
    } catch (error) {
      return handleError(error, { request, log: requestLog, durationMs: Date.now() - started })
    }
  }
  return wrapped as WrappedRoute
}

/** Wrap a public route handler (no session required). */
export function withPublicApi(handler: PublicRouteHandler, options: Omit<RouteOptions, 'admin' | 'public'> = {}): WrappedRoute {
  const wrapped = async (request: Request, routeParams?: RouteParams): Promise<Response> => {
    const started = Date.now()
    const params = normaliseParams(routeParams ? await routeParams.params : undefined)
    const searchParams = new URL(request.url).searchParams
    const requestLog = createLogger({ component: 'api', method: request.method, path: new URL(request.url).pathname })

    try {
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
      if (options.csrf && mutating) {
        const valid = await verifyCsrf(request)
        if (!valid) throw new ApiError('forbidden', 'CSRF validation failed.')
      }

      const limit = options.rateLimit ?? { limit: 60, windowMs: 60_000, scope: 'public' }
      const gate = await rateLimit(clientIdentifier(request.headers, limit.scope), limit)
      if (!gate.allowed) {
        throw new ApiError('rate_limited', `Too many requests. Retry in ${gate.retryAfterSeconds}s.`, undefined, )
      }

      const response = await handler({ request, params, searchParams, log: requestLog }, request)
      response.headers.set('x-response-time', `${Date.now() - started}ms`)
      return response
    } catch (error) {
      return handleError(error, { request, log: requestLog, durationMs: Date.now() - started })
    }
  }
  return wrapped as WrappedRoute
}

async function handleError(
  error: unknown,
  context: { request: Request; log: ReturnType<typeof createLogger>; durationMs: number },
): Promise<Response> {
  if (error instanceof ApiError) {
    if (error.code === 'internal_error') context.log.error(error.message, error)
    return fail(error.code, error.message, error.details)
  }
  if (error instanceof AuthError) {
    return fail(error.code === 'no_session' ? 'unauthorized' : 'forbidden', error.message)
  }
  if (error instanceof ZodError) {
    return fail('validation_error', 'Request validation failed.', {
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  context.log.error('unhandled api error', error, { durationMs: context.durationMs })
  await persistLog({
    level: 'error',
    source: 'api',
    message: `Unhandled API error: ${message}`,
    context: { path: new URL(context.request.url).pathname, method: context.request.method },
    durationMs: context.durationMs,
  }).catch(() => undefined)
  return fail('internal_error', 'Something went wrong. The error has been logged.')
}

/* ------------------------------------------------------------------ helpers */

export async function parseBody<T>(request: Request, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new ApiError('validation_error', 'Request body must be valid JSON.')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiError('validation_error', 'Request validation failed.', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    })
  }
  return parsed.data
}

export function parseQuery<T>(searchParams: URLSearchParams, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const raw = Object.fromEntries(searchParams.entries())
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiError('validation_error', 'Invalid query parameters.', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    })
  }
  return parsed.data
}

export const paginationSchema = (defaultLimit = 25) =>
  zLimits(defaultLimit)

function zLimits(defaultLimit: number) {
  // Kept as a plain validator to avoid circular imports with zod usage patterns.
  return {
    parse(input: URLSearchParams) {
      const limit = Math.min(Math.max(Number.parseInt(input.get('limit') ?? String(defaultLimit), 10) || defaultLimit, 1), 200)
      const page = Math.max(Number.parseInt(input.get('page') ?? '1', 10) || 1, 1)
      const cursor = input.get('cursor') ?? undefined
      const q = (input.get('q') ?? '').trim().slice(0, 200)
      const sort = input.get('sort') ?? 'created_at'
      const order = input.get('order') === 'asc' ? 'asc' : 'desc'
      return { limit, page, offset: (page - 1) * limit, cursor, q, sort, order }
    },
  }
}

export function requireWorkspace<T extends { workspaceId: string }>(session: SessionUser, handler: (workspaceId: string) => Promise<T>): Promise<T> {
  return handler(session.workspaceId)
}

export { log }
