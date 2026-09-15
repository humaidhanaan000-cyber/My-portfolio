/**
 * Notification Center.
 *
 * In-app notifications are always recorded. External channels (email, Telegram,
 * generic webhook) activate automatically when their credentials are present;
 * email falls back to a durable file-based outbox so password resets and
 * approval alerts are never silently lost in a misconfigured environment.
 *
 * Browser notifications: the API exposes unread notifications which the client
 * polls, and the Settings page can request the Web Notifications permission.
 */
import { mkdirSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { getDb, alerts, emailOutbox, notifications, extractRows } from '../db'
import { env } from '../env'
import { enabledChannels, type NotificationChannel } from './channels'
import { createLogger } from '../observability/logger'

const log = createLogger({ component: 'notifications' })

export type { NotificationChannel } from './channels'
export { describeChannels, enabledChannels } from './channels'

export type NotificationType =
  | 'high_score_opportunity'
  | 'approval_required'
  | 'approval_decision'
  | 'project_launched'
  | 'project_failed'
  | 'revenue_recorded'
  | 'expense_recorded'
  | 'budget_limit_reached'
  | 'budget_warning'
  | 'system_error'
  | 'agent_offline'
  | 'unusual_activity'
  | 'report_ready'
  | 'system'

export type NotifyInput = {
  workspaceId: string
  type: NotificationType
  title: string
  body?: string
  severity?: 'info' | 'success' | 'warning' | 'critical'
  link?: string | null
  userId?: string | null
  dedupeKey?: string | null
  /** Restrict delivery to specific channels (used by the Settings test button). */
  channels?: NotificationChannel[]
  /** Silence external delivery (used for bulk/backfill operations). */
  inAppOnly?: boolean
}

export async function notify(input: NotifyInput): Promise<{ id: string | null; delivered: string[] }> {
  const db = await getDb()

  if (input.dedupeKey) {
    const dupe = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, input.workspaceId),
          eq(notifications.dedupeKey, input.dedupeKey),
          gte(notifications.createdAt, new Date(Date.now() - 6 * 3_600_000)),
        ),
      )
      .limit(1)
    if (dupe[0]) return { id: dupe[0].id, delivered: [] }
  }

  const active = input.inAppOnly ? (['in_app'] as NotificationChannel[]) : await resolvedChannels(input)
  const delivery: Record<string, string> = {}

  const rows = await db
    .insert(notifications)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      type: input.type,
      severity: input.severity ?? 'info',
      title: input.title,
      body: input.body ?? '',
      link: input.link ?? null,
      channels: active,
      dedupeKey: input.dedupeKey ?? null,
      delivery,
    })
    .returning({ id: notifications.id })

  const id = rows[0]?.id ?? null

  if (!input.inAppOnly) {
    for (const channel of active.filter((c) => c !== 'in_app' && c !== 'browser')) {
      try {
        const result = await deliver(channel, input)
        delivery[channel] = result
      } catch (error) {
        delivery[channel] = `failed: ${error instanceof Error ? error.message : String(error)}`
        log.warn('notification delivery failed', { channel, message: delivery[channel] })
      }
    }
    if (id) await db.update(notifications).set({ delivery }).where(eq(notifications.id, id))
  }

  return { id, delivered: Object.keys(delivery) }
}

async function resolvedChannels(input: NotifyInput): Promise<NotificationChannel[]> {
  const enabled = await enabledChannels(input.workspaceId)
  if (!input.channels?.length) return enabled
  const requested = new Set(input.channels)
  // in_app is the safety net: an alert is never lost because a channel was unavailable.
  return Array.from(new Set(['in_app', ...enabled.filter((channel) => requested.has(channel))])) as NotificationChannel[]
}

async function deliver(channel: string, input: NotifyInput): Promise<string> {
  switch (channel) {
    case 'email':
      return deliverEmail(input)
    case 'telegram':
      return deliverTelegram(input)
    case 'webhook':
      return deliverWebhook(input)
    default:
      return 'skipped'
  }
}

async function workspaceRecipients(workspaceId: string): Promise<string[]> {
  const { getDb: _getDb, memberships, users } = await import('../db')
  const db = await _getDb()
  const rows = await db
    .select({ email: users.email, notifyEmail: users.email })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(users.status, 'active')))
    .limit(20)
  return rows.map((r) => r.email).filter(Boolean)
}

async function deliverEmail(input: NotifyInput): Promise<string> {
  const recipients = input.userId
    ? (([await userEmail(input.userId)].filter(Boolean)) as string[])
    : await workspaceRecipients(input.workspaceId)
  return deliverEmailTo([...new Set(recipients)], input.title, input.body ?? '', input.link ?? null)
}

/** Deliver an email to explicit recipients, bypassing workspace resolution. */
async function deliverEmailTo(recipients: string[], title: string, bodyText: string, link: string | null): Promise<string> {
  if (recipients.length === 0) return 'no-recipients'

  const subject = title.startsWith('[') ? title : `[AIBA] ${title}`
  const body = `${bodyText}\n\n${link ? `${env.APP_URL}${link}` : ''}`.trim()

  if (env.EMAIL_PROVIDER === 'console' || env.EMAIL_PROVIDER === 'file') {
    const dir = path.resolve(env.EMAIL_OUTBOX_DIR)
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`),
      `${JSON.stringify({ to: recipients, subject, body, at: new Date().toISOString() })}\n`,
    )
    return 'file-outbox'
  }

  const db = await getDb()
  for (const to of recipients) {
    await db.insert(emailOutbox).values({ to, subject, body, provider: env.EMAIL_PROVIDER, status: 'queued' })
  }

  if (env.EMAIL_PROVIDER === 'smtp') {
    try {
      const nodemailer = await import('nodemailer')
      const transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      })
      await transport.sendMail({ from: env.EMAIL_FROM, to: recipients.join(','), subject, text: body })
      await db.update(emailOutbox).set({ status: 'sent', sentAt: new Date() }).where(eq(emailOutbox.subject, subject))
      return 'smtp-sent'
    } catch (error) {
      await db
        .update(emailOutbox)
        .set({ status: 'failed', error: error instanceof Error ? error.message : String(error), attempts: 1 })
        .where(eq(emailOutbox.subject, subject))
      return `smtp-failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (env.EMAIL_PROVIDER === 'resend' && env.EMAIL_PROVIDER_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.EMAIL_PROVIDER_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: recipients, subject, text: body }),
    })
    return response.ok ? 'resend-sent' : `resend-failed:${response.status}`
  }

  return 'queued'
}

async function userEmail(userId: string): Promise<string | null> {
  const { getDb: _getDb, users } = await import('../db')
  const db = await _getDb()
  const rows = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
  return rows[0]?.email ?? null
}

async function deliverTelegram(input: NotifyInput): Promise<string> {
  if (!env.TELEGRAM_BOT_TOKEN) return 'not-configured'
  const { getDb: _getDb, profiles } = await import('../db')
  const db = await _getDb()
  const rows = await db.select().from(profiles).where(eq(profiles.workspaceId, input.workspaceId)).limit(1)
  const chatId = rows[0]?.telegramChatId
  if (!chatId) return 'no-chat-id'
  const text = `*${escapeMarkdown(input.title)}*\n${escapeMarkdown(input.body ?? '')}${input.link ? `\n${env.APP_URL}${input.link}` : ''}`
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  })
  return response.ok ? 'telegram-sent' : `telegram-failed:${response.status}`
}

function escapeMarkdown(value: string): string {
  return value.replace(/([*_`[\]])/g, '\\$1')
}

async function deliverWebhook(input: NotifyInput): Promise<string> {
  if (!env.NOTIFY_WEBHOOK_URL) return 'not-configured'
  const response = await fetch(env.NOTIFY_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'aiba',
      type: input.type,
      title: input.title,
      body: input.body,
      severity: input.severity ?? 'info',
      link: input.link ? `${env.APP_URL}${input.link}` : null,
      at: new Date().toISOString(),
    }),
  })
  return response.ok ? 'webhook-sent' : `webhook-failed:${response.status}`
}

/* --------------------------------------------------------------- alerting */

export async function raiseAlert(input: {
  workspaceId: string | null
  type: string
  severity?: 'info' | 'warning' | 'critical'
  title: string
  message: string
  source?: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  const db = await getDb()
  const conditions = [eq(alerts.type, input.type), eq(alerts.status, 'open')]
  if (input.workspaceId) conditions.push(eq(alerts.workspaceId, input.workspaceId))
  else conditions.push(isNull(alerts.workspaceId))
  const existing = await db
    .select({ id: alerts.id, occurrenceCount: alerts.occurrenceCount })
    .from(alerts)
    .where(and(...conditions))
    .limit(1)

  if (existing[0]) {
    await db
      .update(alerts)
      .set({ occurrenceCount: existing[0].occurrenceCount + 1, lastSeenAt: new Date(), message: input.message })
      .where(eq(alerts.id, existing[0].id))
    return
  }

  await db.insert(alerts).values({
    workspaceId: input.workspaceId ?? null,
    type: input.type,
    severity: input.severity ?? 'warning',
    title: input.title,
    message: input.message,
    source: input.source ?? 'system',
    metadata: input.metadata ?? {},
  })

  if (input.workspaceId) {
    await notify({
      workspaceId: input.workspaceId,
      type: input.type === 'unusual_activity' ? 'unusual_activity' : 'system_error',
      severity: input.severity === 'critical' ? 'critical' : 'warning',
      title: input.title,
      body: input.message,
      link: '/dashboard/alerts',
      dedupeKey: `alert:${input.type}`,
    })
  }
}

export async function listNotifications(workspaceId: string, options: { limit?: number; unreadOnly?: boolean } = {}) {
  const db = await getDb()
  const conditions = [eq(notifications.workspaceId, workspaceId)]
  if (options.unreadOnly) conditions.push(eq(notifications.status, 'unread'))
  return db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(options.limit ?? 50, 200))
}

export async function markNotificationsRead(workspaceId: string, ids?: string[]): Promise<number> {
  const db = await getDb()
  const conditions = [eq(notifications.workspaceId, workspaceId), eq(notifications.status, 'unread')]
  if (ids?.length) {
    const { inArray } = await import('drizzle-orm')
    conditions.push(inArray(notifications.id, ids))
  }
  const updated = await db
    .update(notifications)
    .set({ status: 'read', readAt: new Date() })
    .where(and(...conditions))
    .returning({ id: notifications.id })
  return updated.length
}

export async function unreadCount(workspaceId: string): Promise<number> {
  const db = await getDb()
  const result = await db
    .select({ value: sql<string>`count(*)::text` })
    .from(notifications)
    .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.status, 'unread')))
  return Number(result[0]?.value ?? 0)
}

export async function activeAlerts(workspaceId: string, limit = 25) {
  const db = await getDb()
  return db
    .select()
    .from(alerts)
    .where(and(eq(alerts.workspaceId, workspaceId), eq(alerts.status, 'open')))
    .orderBy(desc(alerts.lastSeenAt))
    .limit(limit)
}

export async function resolveAlert(workspaceId: string, alertId: string, userId: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db
    .update(alerts)
    .set({ status: 'resolved', resolvedAt: new Date(), acknowledgedBy: userId })
    .where(and(eq(alerts.workspaceId, workspaceId), eq(alerts.id, alertId)))
    .returning({ id: alerts.id })
  return rows.length > 0
}

export async function notificationStats(workspaceId: string) {
  const db = await getDb()
  const result = await db.execute(sql`
    select
      count(*) filter (where status = 'unread') as unread,
      count(*) filter (where created_at >= now() - interval '24 hours') as last24h,
      count(*) filter (where severity = 'critical' and created_at >= now() - interval '7 days') as critical_week
    from notifications where workspace_id = ${workspaceId}
  `)
  const row = extractRows<{ unread: string; last24h: string; critical_week: string }>(result)[0]
  return {
    unread: Number(row?.unread ?? 0),
    last24h: Number(row?.last24h ?? 0),
    criticalWeek: Number(row?.critical_week ?? 0),
  }
}

/**
 * Send a transactional email directly to an explicit address (auth flows, tests,
 * approved transactional messages). Never resolves recipients from a workspace.
 */
export async function sendTransactionalEmail(input: { to: string; subject: string; body: string; html?: string }): Promise<string> {
  const result = await deliverEmailTo([input.to], input.subject, input.body, null)
  if (env.EMAIL_PROVIDER === 'console' || env.EMAIL_PROVIDER === 'file') {
    const dir = path.resolve(env.EMAIL_OUTBOX_DIR)
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, 'transactional.log'), `${JSON.stringify({ ...input, result, at: new Date().toISOString() })}\n`)
  }
  return result
}
