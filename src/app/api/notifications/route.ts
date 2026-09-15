/** GET /api/notifications — notification centre. PATCH — mark read. POST — test a channel. */
import { z } from 'zod'
import { getDb, profiles } from '@/lib/db'
import { ok, parseBody, withApi } from '@/lib/api/http'
import { eq } from 'drizzle-orm'
import { activeAlerts, listNotifications, markNotificationsRead, notify, notificationStats, unreadCount } from '@/lib/notifications'
import { describeChannels } from '@/lib/notifications/channels'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const workspaceId = ctx.session.workspaceId
  const limit = Math.min(100, Math.max(1, Number(ctx.searchParams.get('limit') ?? 40)))
  const unreadOnly = ctx.searchParams.get('unread') === 'true'
  const [notifications, unread, alerts, stats] = await Promise.all([
    listNotifications(workspaceId, { limit, unreadOnly }),
    unreadCount(workspaceId),
    activeAlerts(workspaceId),
    notificationStats(workspaceId),
  ])
  return ok({ notifications, unread, alerts, stats, channels: describeChannels() })
})

const patchSchema = z.object({ ids: z.array(z.string().uuid()).max(200).optional(), all: z.boolean().default(false) })

export const PATCH = withApi(async (ctx) => {
  const input = await parseBody(ctx.request, patchSchema)
  const count = await markNotificationsRead(ctx.session.workspaceId, input.all ? undefined : input.ids)
  return ok({ markedRead: count })
})

const testSchema = z.object({
  channel: z.enum(['email', 'telegram', 'browser']),
  message: z.string().max(500).default('Test notification from AIBA.'),
})

export const POST = withApi(async (ctx) => {
  const db = await getDb()
  const input = await parseBody(ctx.request, testSchema)
  const profile = (await db.select().from(profiles).where(eq(profiles.workspaceId, ctx.session.workspaceId)).limit(1))[0]

  const delivery = await notify({
    workspaceId: ctx.session.workspaceId,
    type: 'system',
    severity: 'info',
    title: `Test: ${input.channel} channel`,
    body: input.message,
    link: '/dashboard/settings/notifications',
    userId: ctx.session.id,
    channels: [input.channel],
    dedupeKey: `channel-test:${input.channel}:${Math.floor(Date.now() / 60_000)}`,
    inAppOnly: input.channel === 'browser',
  })

  return ok({
    delivered: delivery.delivered,
    note:
      input.channel === 'telegram'
        ? profile?.notifyTelegram
          ? 'Telegram delivery attempted. A bot token and chat id must both be configured.'
          : 'Telegram is disabled in your profile, so the test was recorded in-app only.'
        : input.channel === 'email'
          ? 'Email delivery attempted through the configured provider.'
          : 'Browser notifications are delivered by the dashboard while it is open.',
  })
})
