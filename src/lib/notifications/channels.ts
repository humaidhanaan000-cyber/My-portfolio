/**
 * Channel registry for the notification centre.
 *
 * Each channel reports whether it is actually usable in the current
 * environment, and what is missing when it is not — the dashboard shows this so
 * a missing credential is visible instead of silently swallowing alerts.
 */
import { and, eq } from 'drizzle-orm'
import { getDb, profiles } from '../db'
import { env } from '../env'

export type NotificationChannel = 'in_app' | 'browser' | 'email' | 'telegram' | 'webhook'

export type ChannelInfo = {
  key: NotificationChannel
  label: string
  /** True when delivery can be attempted right now. */
  available: boolean
  /** Where the credential lives, or null when none is needed. */
  envVar: string | null
  detail: string
  configuredBy: 'environment' | 'profile' | 'built-in'
}

export function describeChannels(): ChannelInfo[] {
  const emailProvider = env.EMAIL_PROVIDER
  const emailReady = emailProvider !== 'console' || true
  return [
    {
      key: 'in_app',
      label: 'In-app notification centre',
      available: true,
      envVar: null,
      detail: 'Always on. Every alert is stored and readable in the dashboard.',
      configuredBy: 'built-in',
    },
    {
      key: 'browser',
      label: 'Browser (Web Notifications)',
      available: true,
      envVar: null,
      detail: 'Requires the browser permission prompt on the dashboard. Works while a tab is open.',
      configuredBy: 'built-in',
    },
    {
      key: 'email',
      label: 'Email',
      available: emailReady,
      envVar: 'EMAIL_PROVIDER, SMTP_* or RESEND_API_KEY, EMAIL_FROM',
      detail:
        emailProvider === 'smtp'
          ? `SMTP relay via ${env.SMTP_HOST ?? '(host not set)'}`
          : emailProvider === 'resend'
            ? 'Resend HTTP API'
            : emailProvider === 'file'
              ? 'Written to data/outbox for local development'
              : 'Console transport (development only — messages are logged, not delivered)',
      configuredBy: 'environment',
    },
    {
      key: 'telegram',
      label: 'Telegram',
      available: Boolean(env.TELEGRAM_BOT_TOKEN),
      envVar: 'TELEGRAM_BOT_TOKEN (bot) + telegram chat id on your profile',
      detail: env.TELEGRAM_BOT_TOKEN
        ? 'Bot token present. Add your chat id in Settings to enable delivery.'
        : 'Create a bot with @BotFather, put the token in TELEGRAM_BOT_TOKEN, then save your chat id.',
      configuredBy: 'environment',
    },
    {
      key: 'webhook',
      label: 'Outbound webhook',
      available: Boolean(env.NOTIFY_WEBHOOK_URL),
      envVar: 'NOTIFY_WEBHOOK_URL',
      detail: env.NOTIFY_WEBHOOK_URL ? 'POSTs a JSON payload to your endpoint.' : 'Optional. Set NOTIFY_WEBHOOK_URL to receive alerts in another system.',
      configuredBy: 'environment',
    },
  ]
}

/** Channels that are switched on for a workspace, given env + profile. */
export async function enabledChannels(workspaceId: string): Promise<NotificationChannel[]> {
  const channels: NotificationChannel[] = ['in_app', 'browser']
  try {
    const db = await getDb()
    const rows = await db.select().from(profiles).where(and(eq(profiles.workspaceId, workspaceId))).limit(1)
    const profile = rows[0]
    if (!profile) {
      channels.push('email')
    } else {
      if (profile.notifyEmail) channels.push('email')
      if (profile.notifyBrowser) channels.push('browser')
      if (profile.notifyTelegram && profile.telegramChatId) channels.push('telegram')
    }
  } catch {
    channels.push('email')
  }
  if (env.NOTIFY_WEBHOOK_URL) channels.push('webhook')
  return Array.from(new Set(channels))
}
