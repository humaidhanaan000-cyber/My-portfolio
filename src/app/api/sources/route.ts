/**
 * GET  /api/sources — the source registry with permission status and health.
 * POST /api/sources — run a scan, or register a custom RSS / API source.
 *
 * Only sources with permission `public_api` or `permitted` are ever scanned.
 * `manual_only` sources accept human-pasted input, and `prohibited` sources are
 * rejected outright so no disallowed collection can be configured by accident.
 */
import { z } from 'zod'
import { and, desc, eq, or, isNull, sql } from 'drizzle-orm'
import { getDb, sources, opportunities } from '@/lib/db'
import { ApiError, created, ok, parseBody, withApi } from '@/lib/api/http'
import { COLLECTORS, defaultSourceConfigs } from '@/lib/agents/sources'
import { runAgentByKey } from '@/lib/agents/registry'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const rows = await db
    .select({
      id: sources.id,
      name: sources.name,
      type: sources.type,
      url: sources.url,
      apiEndpoint: sources.apiEndpoint,
      permissionStatus: sources.permissionStatus,
      termsUrl: sources.termsUrl,
      requiresCredentials: sources.requiresCredentials,
      credentialEnvVar: sources.credentialEnvVar,
      rateLimitPerHour: sources.rateLimitPerHour,
      reliabilityScore: sources.reliabilityScore,
      categories: sources.categories,
      enabled: sources.enabled,
      lastScanAt: sources.lastScanAt,
      lastScanStatus: sources.lastScanStatus,
      lastError: sources.lastError,
      scanCount: sources.scanCount,
      discoveredCount: sources.discoveredCount,
      config: sources.config,
      workspaceId: sources.workspaceId,
      discovered: sql<string>`(select count(*)::text from opportunities o where o.source_name = ${sources.name} and o.workspace_id = ${workspaceId})`,
    })
    .from(sources)
    .where(or(isNull(sources.workspaceId), eq(sources.workspaceId, workspaceId)))
    .orderBy(desc(sources.enabled), sources.name)

  const credentialMissing = rows.filter((row) => row.requiresCredentials && !process.env[row.credentialEnvVar ?? ''])

  return ok({
    sources: rows.map((row) => ({ ...row, discovered: Number(row.discovered) })),
    collectors: COLLECTORS.map((collector) => ({
      key: collector.key,
      name: collector.name,
      type: collector.type,
      permissionStatus: collector.permissionStatus,
      url: collector.url,
      termsUrl: collector.termsUrl ?? null,
      requiresCredentials: collector.requiresCredentials,
      credentialEnvVar: collector.credentialEnvVar ?? null,
      credentialPresent: collector.credentialPresent(),
    })),
    missingCredentials: credentialMissing.map((row) => ({ name: row.name, envVar: row.credentialEnvVar })),
    policy: 'AIBA collects only from public APIs, feeds you own, or sources that explicitly permit it. It never bypasses logins, paywalls or rate limits.',
  })
})

const scanSchema = z.object({
  action: z.literal('scan'),
  sourceKeys: z.array(z.string().max(60)).max(20).optional(),
  limitPerSource: z.number().int().min(1).max(50).default(15),
  useAi: z.boolean().default(true),
})

const registerSchema = z.object({
  action: z.literal('register'),
  name: z.string().min(3).max(120),
  type: z.enum(['rss', 'api', 'manual', 'public_dataset', 'partner']),
  url: z.string().url().max(500),
  categories: z.array(z.string().max(40)).max(10).default([]),
  termsUrl: z.string().url().max(500).optional(),
  /** A feed you own or that explicitly permits automated collection. */
  confirmPermission: z.literal(true),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const body = (await ctx.request.clone().json().catch(() => ({}))) as Record<string, unknown>

  if (body.action === 'register') {
    const input = await parseBody(ctx.request, registerSchema)
    const existing = await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.workspaceId, workspaceId), eq(sources.name, input.name)))
      .limit(1)
    if (existing[0]) throw new ApiError('conflict', 'A source with that name already exists.')

    const rows = await db
      .insert(sources)
      .values({
        workspaceId,
        name: input.name,
        type: input.type,
        url: input.url,
        apiEndpoint: input.url,
        permissionStatus: 'permitted',
        termsUrl: input.termsUrl ?? null,
        requiresCredentials: false,
        categories: input.categories,
        enabled: true,
        config: { registeredBy: ctx.session.email },
      })
      .returning()
    return created({ source: rows[0] })
  }

  const input = await parseBody(ctx.request, scanSchema)
  const outcome = await runAgentByKey(
    'research',
    { sourceKeys: input.sourceKeys, limitPerSource: input.limitPerSource, useAi: input.useAi },
    { workspaceId, triggeredBy: 'user', userId: ctx.session.id, approveImmediately: true },
  )

  if (outcome.status === 'awaiting_approval') {
    throw new ApiError('policy_blocked', outcome.policy.reason, { approvalId: outcome.approvalId })
  }
  if (outcome.status !== 'succeeded') throw new ApiError('internal_error', outcome.error ?? 'Source scan failed.')

  return ok({ result: outcome.output, warnings: outcome.output?.warnings ?? [] })
})

/**
 * PATCH /api/sources — enable/disable, rate-limit or re-classify a source.
 *
 * Guardrails: a source that is not explicitly `public_api` or `permitted` can
 * never be enabled (that is how an accidental prohibited collection is stopped),
 * and a source belonging to another workspace is invisible here.
 */
export const PATCH = withApi(async (ctx) => {
  const schema = z.object({
    id: z.string().uuid(),
    enabled: z.boolean().optional(),
    rateLimitPerHour: z.number().int().min(1).max(3600).optional(),
    permissionStatus: z.enum(['public_api', 'permitted', 'manual_only']).optional(),
  })
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, schema)

  const existing = (
    await db
      .select()
      .from(sources)
      .where(and(eq(sources.id, input.id), or(isNull(sources.workspaceId), eq(sources.workspaceId, workspaceId))))
      .limit(1)
  )[0]
  if (!existing) throw new ApiError('not_found', 'Source not found.')

  const nextPermission = input.permissionStatus ?? existing.permissionStatus
  if (input.enabled === true && !['public_api', 'permitted'].includes(nextPermission)) {
    throw new ApiError('forbidden', 'This source is not marked as permitted, so it cannot be enabled.', {
      permissionStatus: nextPermission,
    })
  }

  const rows = await db
    .update(sources)
    .set({
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.rateLimitPerHour !== undefined ? { rateLimitPerHour: input.rateLimitPerHour } : {}),
      ...(input.permissionStatus !== undefined ? { permissionStatus: input.permissionStatus } : {}),
      updatedAt: new Date(),
    })
    .where(eq(sources.id, existing.id))
    .returning()

  return ok({ source: rows[0], enabled: rows[0]?.enabled ?? false })
})

export const PUT = withApi(async (ctx) => {
  const schema = z.object({
    id: z.string().uuid(),
    enabled: z.boolean().optional(),
    rateLimitPerHour: z.number().int().min(1).max(3600).optional(),
    permissionStatus: z.enum(['public_api', 'permitted', 'manual_only']).optional(),
  })
  const db = await getDb()
  const input = await parseBody(ctx.request, schema)
  const { id, ...patch } = input
  const rows = await db
    .update(sources)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sources.id, id))
    .returning()
  if (!rows[0]) throw new ApiError('not_found', 'Source not found.')
  return ok({ source: rows[0], defaults: defaultSourceConfigs().length })
})
