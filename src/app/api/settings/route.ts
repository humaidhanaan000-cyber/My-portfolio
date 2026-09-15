/**
 * GET   /api/settings — every operator-facing setting with its current value.
 * PATCH /api/settings — update workspace settings (publish target, demo mode,
 *         notification preferences, automation level).
 *
 * Secrets are never returned: only whether a credential is present.
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb, profiles, settings as settingsTable, users, workspaces } from '@/lib/db'
import { ApiError, ok, parseBody, withApi } from '@/lib/api/http'
import { AUTOMATION_LEVELS, RISK_TOLERANCES } from '@/lib/utils'
import { describeTargets } from '@/lib/integrations'
import { aiStatus } from '@/lib/ai'
import { paymentStatus, listPlans, currentSubscription } from '@/lib/payments'
import { storageStatus } from '@/lib/storage'
import { describeChannels } from '@/lib/notifications/channels'
import { SERVICE_CREDENTIALS, env, publicConfig } from '@/lib/env'
import { DEFAULT_SCHEDULES } from '@/lib/scheduler/defaults'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const [workspace, profile, workspaceSettings, user, plans, subscription] = await Promise.all([
    db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
    db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1),
    db.select().from(settingsTable).where(eq(settingsTable.workspaceId, workspaceId)),
    db.select().from(users).where(eq(users.id, ctx.session.id)).limit(1),
    listPlans({ includeHidden: true }),
    currentSubscription(workspaceId),
  ])

  const { passwordHash, ...safeUser } = user[0] ?? ({ passwordHash: '' } as { passwordHash: string })
  void passwordHash

  return ok({
    workspace: workspace[0] ?? null,
    profile: profile[0] ?? null,
    user: safeUser,
    settings: Object.fromEntries(workspaceSettings.map((row) => [row.key, row.value])),
    plans,
    subscription,
    integrations: { targets: describeTargets() },
    ai: aiStatus(),
    payments: paymentStatus(),
    storage: storageStatus(),
    channels: describeChannels(),
    credentials: SERVICE_CREDENTIALS.map((entry) => ({ ...entry, present: Boolean(process.env[entry.envVar]) })),
    environment: publicConfig(),
    scheduler: { schedules: DEFAULT_SCHEDULES, note: 'Schedules are executed by the worker process; each row above is seeded per workspace.' },
    demoMode: workspace[0]?.demoMode ?? false,
    demoModeEnabled: env.DEMO_MODE_ENABLED,
  })
})

const schema = z.object({
  demoMode: z.boolean().optional(),
  automationLevel: z.enum(AUTOMATION_LEVELS as unknown as [string, ...string[]]).optional(),
  riskTolerance: z.enum(RISK_TOLERANCES as unknown as [string, ...string[]]).optional(),
  scoreThreshold: z.number().int().min(0).max(100).optional(),
  publishTarget: z.enum(['webhook', 'wordpress', 'github', 'local_export']).optional(),
  notifyEmail: z.boolean().optional(),
  notifyBrowser: z.boolean().optional(),
  notifyTelegram: z.boolean().optional(),
  telegramChatId: z.string().max(60).nullable().optional(),
  timezone: z.string().max(60).optional(),
  /** Arbitrary workspace-scoped settings bag (feature flags, labels, etc.). */
  values: z.record(z.unknown()).optional(),
})

export const PATCH = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const input = await parseBody(ctx.request, schema)

  if (input.demoMode !== undefined) {
    if (input.demoMode && !env.DEMO_MODE_ENABLED) {
      throw new ApiError('forbidden', 'Demo mode is disabled on this deployment (DEMO_MODE_ENABLED=false).')
    }
    await db.update(workspaces).set({ demoMode: input.demoMode, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId))
  }

  const profilePatch: Record<string, unknown> = {}
  for (const key of ['automationLevel', 'riskTolerance', 'scoreThreshold', 'notifyEmail', 'notifyBrowser', 'notifyTelegram', 'telegramChatId', 'timezone'] as const) {
    if (input[key] !== undefined) profilePatch[key] = input[key]
  }
  if (Object.keys(profilePatch).length) {
    await db.update(profiles).set({ ...profilePatch, updatedAt: new Date() }).where(eq(profiles.workspaceId, workspaceId))
  }

  if (input.publishTarget) {
    const { setPublishTarget } = await import('@/lib/integrations')
    await setPublishTarget(workspaceId, input.publishTarget)
  }

  if (input.values) {
    const existingRows = await db.select().from(settingsTable).where(eq(settingsTable.workspaceId, workspaceId)).limit(200)
    for (const [key, value] of Object.entries(input.values)) {
      const hit = existingRows.find((entry) => entry.key === key)
      if (hit) {
        await db.update(settingsTable).set({ value: value as unknown, updatedAt: new Date() }).where(eq(settingsTable.id, hit.id))
      } else {
        await db.insert(settingsTable).values({ workspaceId, key, value: value as unknown })
      }
    }
  }

  return ok({ updated: true, demoMode: input.demoMode, profile: profilePatch })
})
