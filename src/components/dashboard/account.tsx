'use client'
/**
 * Plan, billing and notification screens.
 *
 * Nothing here pretends a payment happened: checkout is a server call to the
 * configured provider, and the screen states plainly when no provider is wired
 * up. Subscription state only ever moves as a result of a verified webhook.
 */
import { useMemo, useState } from 'react'
import { BadgeCheck, BellRing, CalendarClock, CheckCircle2, CreditCard, ExternalLink, FileBarChart, Lock, Mail, MessageSquare, Monitor, Send, ShieldAlert } from 'lucide-react'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, KeyValue, Select, Stat, Switch, Table, Textarea } from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { formatDate, formatMoney, formatNumber, relativeTime } from '@/lib/client/format'

/* --------------------------------------------------------------- billing */

type Plan = {
  key: string
  name: string
  tagline: string
  priceMonthlyCents: number
  priceYearlyCents: number
  currency: string
  features: string[]
  limits: Record<string, number>
  isPublic: boolean
  sortOrder: number
}

type BillingPayload = {
  subscription: { planKey: string; status: string; interval: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null
  plan: Plan | null
  demo: boolean
  demoNotice: string | null
  plans: Plan[]
  provider: { provider: string; configured: boolean; webhookConfigured: boolean; requiredCredentials: { service: string; credential: string; envVar: string; where: string }[]; note: string }
  events: { id: string; type: string; amountCents: number | null; createdAt: string; note?: string | null }[]
  note: string
}

export function BillingCenter({ isAdmin }: { isAdmin: boolean }) {
  const billing = useApi<BillingPayload>('/api/billing')
  const [interval, setInterval] = useState<'monthly' | 'yearly'>('monthly')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const current = billing.data?.subscription?.planKey ?? billing.data?.plan?.key ?? 'free'
  const plans = billing.data?.plans ?? []

  async function checkout(planKey: string) {
    setBusy(planKey)
    setError(null)
    setNotice(null)
    try {
      const result = await api.post<{ url?: string; mode?: string; message?: string }>('/api/billing/checkout', { planKey, interval })
      if (result.data.url) {
        window.location.href = result.data.url
        return
      }
      setNotice(result.data.message ?? 'Checkout created. Follow the provider instructions that were returned.')
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Checkout could not be started.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Plan &amp; billing</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            Subscription state changes only when the payment provider confirms it server-side. A browser redirect is never treated as payment.
          </p>
        </div>
        <Select className="w-36" value={interval} onChange={(event) => setInterval(event.target.value as 'monthly' | 'yearly')}>
          <option value="monthly">Monthly billing</option>
          <option value="yearly">Yearly billing</option>
        </Select>
      </header>

      {billing.error ? <ErrorNote message={billing.error} onRetry={() => void billing.refresh()} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}
      {billing.data?.demo ? (
        <div className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-2 text-[11px] text-violet-900">
          <Badge tone="demo" className="mr-2">DEMO DATA</Badge>
          {billing.data.demoNotice ?? 'Demo mode is on. Demo revenue never counts towards real revenue or billing.'}
        </div>
      ) : null}

      {!billing.data ? (
        <Card><div className="h-40 animate-pulse rounded bg-ink-100" /></Card>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Current subscription" subtitle={billing.data.note} icon={<CreditCard className="h-4 w-4" />} />
              <div className="grid gap-3 sm:grid-cols-2">
                <KeyValue
                  items={[
                    { label: 'Plan', value: billing.data.plan?.name ?? current },
                    { label: 'Status', value: billing.data.subscription?.status ?? 'not subscribed' },
                    { label: 'Interval', value: billing.data.subscription?.interval ?? '—' },
                    { label: 'Renews', value: billing.data.subscription?.currentPeriodEnd ? formatDate(billing.data.subscription.currentPeriodEnd) : '—' },
                  ]}
                />
                <ul className="space-y-1.5 text-[11px] text-ink-600">
                  {(billing.data.plan?.features ?? []).map((feature) => (
                    <li key={feature} className="flex items-start gap-1.5">
                      <CheckCircle2 className="mt-0.5 h-3 w-3 text-signal-positive" />
                      {feature}
                    </li>
                  ))}
                  {billing.data.plan?.limits
                    ? Object.entries(billing.data.plan.limits).map(([key, value]) => (
                        <li key={key} className="text-ink-500">
                          {key.replace(/([A-Z])/g, ' $1').toLowerCase()}: <span className="tabular text-ink-800">{value < 0 ? 'unlimited' : formatNumber(value)}</span>
                        </li>
                      ))
                    : null}
                </ul>
              </div>
            </Card>

            <Card>
              <CardHeader title="Payment provider" subtitle={billing.data.provider.provider} icon={<Lock className="h-4 w-4" />} />
              <div className="space-y-2 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="text-ink-500">Checkout configured</span>
                  <Badge tone={billing.data.provider.configured ? 'positive' : 'warning'}>{billing.data.provider.configured ? 'yes' : 'no'}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-500">Webhook secret present</span>
                  <Badge tone={billing.data.provider.webhookConfigured ? 'positive' : 'warning'}>{billing.data.provider.webhookConfigured ? 'yes' : 'no'}</Badge>
                </div>
                <p className="text-ink-500">{billing.data.provider.note}</p>
                <ul className="space-y-1.5">
                  {billing.data.provider.requiredCredentials.map((entry) => (
                    <li key={entry.envVar} className="rounded-lg bg-ink-50 px-2.5 py-2">
                      <p className="font-medium text-ink-800">{entry.envVar}</p>
                      <p className="text-ink-500">{entry.credential} — {entry.where}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {plans.filter((plan) => plan.isPublic).map((plan) => {
              const price = interval === 'monthly' ? plan.priceMonthlyCents : plan.priceYearlyCents
              const isCurrent = plan.key === current
              return (
                <Card key={plan.key} className={isCurrent ? 'ring-2 ring-accent-300' : undefined}>
                  <CardHeader
                    title={plan.name}
                    subtitle={plan.tagline}
                    action={isCurrent ? <Badge tone="positive">current plan</Badge> : null}
                  />
                  <p className="tabular text-2xl font-semibold text-ink-900">
                    {formatMoney(price)}
                    <span className="ml-1 text-xs font-normal text-ink-500">/{interval === 'monthly' ? 'month' : 'year'}</span>
                  </p>
                  <ul className="mt-3 space-y-1.5 text-[11px] text-ink-600">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-1.5">
                        <CheckCircle2 className="mt-0.5 h-3 w-3 text-signal-positive" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <Button
                    className="mt-4 w-full"
                    variant={isCurrent ? 'secondary' : 'primary'}
                    size="sm"
                    disabled={isCurrent}
                    loading={busy === plan.key}
                    onClick={() => void checkout(plan.key)}
                  >
                    {isCurrent ? 'Active plan' : billing.data?.provider.configured ? 'Choose plan' : 'Provider not configured'}
                  </Button>
                  <p className="mt-2 text-[10px] text-ink-400">
                    Prices are read from the database and can be changed by an administrator without a redeploy.
                  </p>
                </Card>
              )
            })}
          </div>

          {isAdmin ? <AdminPlanEditor plans={plans} onSaved={async () => { await billing.refresh() }} /> : null}

          <Card>
            <CardHeader title="Billing events" subtitle="Recorded provider events for this workspace" icon={<CalendarClock className="h-4 w-4" />} />
            {billing.data.events.length === 0 ? (
              <EmptyState icon={<FileBarChart className="h-5 w-5" />} title="No billing events yet" description="Verified provider events appear here with their signature check result." />
            ) : (
              <Table headers={['When', 'Type', 'Amount', 'Note']}>
                {billing.data.events.map((event) => (
                  <tr key={event.id} className="border-t border-ink-200">
                    <td className="px-4 py-3 text-xs text-ink-500">{formatDate(event.createdAt)}<div className="text-ink-400">{relativeTime(event.createdAt)}</div></td>
                    <td className="px-4 py-3 text-xs text-ink-700">{event.type}</td>
                    <td className="tabular px-4 py-3 text-xs text-ink-700">{event.amountCents ? formatMoney(event.amountCents) : '—'}</td>
                    <td className="px-4 py-3 text-xs text-ink-500">{event.note ?? '—'}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

function AdminPlanEditor({ plans, onSaved }: { plans: Plan[]; onSaved: () => Promise<void> }) {
  const [edits, setEdits] = useState<Record<string, { monthly: string; yearly: string; isPublic: boolean }>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function valueFor(plan: Plan, field: 'monthly' | 'yearly') {
    const edit = edits[plan.key]
    if (field === 'monthly') return edit?.monthly ?? String(plan.priceMonthlyCents / 100)
    return edit?.yearly ?? String(plan.priceYearlyCents / 100)
  }

  async function save(plan: Plan) {
    setSaving(plan.key)
    setError(null)
    try {
      await api.patch('/api/billing/plans', {
        key: plan.key,
        priceMonthlyCents: Math.round(Number(valueFor(plan, 'monthly') || '0') * 100),
        priceYearlyCents: Math.round(Number(valueFor(plan, 'yearly') || '0') * 100),
        isPublic: edits[plan.key]?.isPublic ?? plan.isPublic,
      })
      setNotice(`${plan.name} updated. The change is recorded in payment events with your user id.`)
      await onSaved()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The plan could not be updated.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <Card>
      <CardHeader
        title="Pricing (administrator)"
        subtitle="Prices are configuration, not code: change them here or via PATCH /api/billing/plans. Every change is audited."
        icon={<ShieldAlert className="h-4 w-4" />}
      />
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}
      <div className="space-y-3">
        {plans.map((plan) => {
          const edit = edits[plan.key]
          return (
            <div key={plan.key} className="grid gap-3 rounded-lg border border-ink-200 px-3 py-3 sm:grid-cols-4 sm:items-end">
              <div>
                <p className="text-xs font-medium text-ink-800">{plan.name}</p>
                <p className="text-[11px] text-ink-500">{plan.key}</p>
              </div>
              <Field label="Monthly price">
                <Input value={valueFor(plan, 'monthly')} inputMode="decimal" onChange={(event) => setEdits({ ...edits, [plan.key]: { monthly: event.target.value, yearly: valueFor(plan, 'yearly'), isPublic: edit?.isPublic ?? plan.isPublic } })} />
              </Field>
              <Field label="Yearly price">
                <Input value={valueFor(plan, 'yearly')} inputMode="decimal" onChange={(event) => setEdits({ ...edits, [plan.key]: { monthly: valueFor(plan, 'monthly'), yearly: event.target.value, isPublic: edit?.isPublic ?? plan.isPublic } })} />
              </Field>
              <div className="flex items-center justify-between gap-2">
                <Switch checked={edit?.isPublic ?? plan.isPublic} onChange={(checked) => setEdits({ ...edits, [plan.key]: { monthly: valueFor(plan, 'monthly'), yearly: valueFor(plan, 'yearly'), isPublic: checked } })} label="Public" />
                <Button size="sm" loading={saving === plan.key} onClick={() => void save(plan)}>Save</Button>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/* --------------------------------------------------------- notifications */

type NotificationRow = {
  id: string
  type: string
  severity: string
  title: string
  body: string
  link: string
  channels: string[]
  status: string
  delivery: Record<string, string>
  readAt: string | null
  createdAt: string
}

export function NotificationCenter() {
  const [page, setPage] = useState(1)
  const notifications = useApi<{
    notifications: NotificationRow[]
    unread: number
    alerts: { id: string; type: string; severity: string; title: string; message: string; source: string; status: string; occurrenceCount: number; lastSeenAt: string }[]
    stats: { unread: number; last24h: number; criticalWeek: number }
    channels: { key: string; label: string; available: boolean; envVar: string | null; detail: string; configuredBy: string }[]
  }>('/api/notifications', { query: { page, limit: 25 }, pollMs: 45_000 })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function markAll() {
    setBusy(true)
    try {
      await api.patch('/api/notifications', { all: true })
      setNotice('All notifications marked as read.')
      await notifications.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Could not update notifications.')
    } finally {
      setBusy(false)
    }
  }

  async function testChannel(channel: 'email' | 'telegram' | 'browser') {
    setBusy(true)
    setError(null)
    try {
      const result = await api.post<{ delivered: number; note: string }>('/api/notifications', { channel, message: 'Test notification from AIBA.' })
      setNotice(result.data.delivered > 0 ? `Test delivered through ${channel}.` : result.data.note)
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The test notification failed.')
    } finally {
      setBusy(false)
    }
  }

  async function resolveAlert(id: string) {
    setBusy(true)
    try {
      await api.post(`/api/notifications/alerts/${id}`, { resolve: true })
      await notifications.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The alert could not be resolved.')
    } finally {
      setBusy(false)
    }
  }

  const data = notifications.data

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Notifications</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            In-app notifications are always recorded. Email, browser push and Telegram are delivered when the channel is configured — the status
            below is read from the server, not assumed.
          </p>
        </div>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void markAll()} disabled={!data?.unread}>Mark all as read</Button>
      </header>

      {notifications.error ? <ErrorNote message={notifications.error} onRetry={() => void notifications.refresh()} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Unread" value={formatNumber(data.stats.unread)} icon={<BellRing className="h-4 w-4" />} />
            <Stat label="Last 24 hours" value={formatNumber(data.stats.last24h)} />
            <Stat label="Critical this week" value={formatNumber(data.stats.criticalWeek)} tone={data.stats.criticalWeek ? 'critical' : 'neutral'} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Inbox" subtitle={`Page ${page}`} />
              {data.notifications.length === 0 ? (
                <EmptyState icon={<BellRing className="h-5 w-5" />} title="Nothing to read" description="Statements, budget warnings, approvals and failures land here." />
              ) : (
                <>
                  <ul className="space-y-2">
                    {data.notifications.map((row) => (
                      <li key={row.id} className={`rounded-lg border px-3 py-2.5 ${row.readAt ? 'border-ink-200 bg-white' : 'border-accent-200 bg-accent-50/40'}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-medium text-ink-900">{row.title}</p>
                            <p className="mt-0.5 text-[11px] text-ink-600">{row.body}</p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <Badge tone={row.severity === 'critical' ? 'critical' : row.severity === 'warning' ? 'warning' : 'info'}>{row.severity}</Badge>
                            <span className="text-[10px] text-ink-400">{relativeTime(row.createdAt)}</span>
                          </div>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-ink-500">
                          {row.channels.map((channel) => (
                            <span key={channel} className="rounded bg-ink-100 px-1.5 py-0.5">
                              {channel}: {row.delivery?.[channel] ?? 'recorded'}
                            </span>
                          ))}
                          {row.link ? <span className="text-accent-700">{row.link}</span> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button>
                    <Button size="sm" variant="ghost" disabled={data.notifications.length < 25} onClick={() => setPage((value) => value + 1)}>Next</Button>
                  </div>
                </>
              )}
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="Channels" subtitle="Delivery status is live from the server" />
                <ul className="space-y-2">
                  {data.channels.map((channel) => (
                    <li key={channel.key} className="rounded-lg border border-ink-200 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-ink-800">{channel.label}</span>
                        <Badge tone={channel.available ? 'positive' : 'neutral'}>{channel.available ? 'configured' : 'not configured'}</Badge>
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-500">{channel.detail}</p>
                      {channel.envVar ? <p className="mt-0.5 font-mono text-[10px] text-ink-400">{channel.envVar}</p> : null}
                      {(channel.key === 'email' || channel.key === 'telegram' || channel.key === 'browser') ? (
                        <Button className="mt-2" size="sm" variant="ghost" loading={busy} onClick={() => void testChannel(channel.key as 'email' | 'telegram' | 'browser')}>
                          <Send className="h-3 w-3" />
                          Send test
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[10px] text-ink-400">Preferences live in Settings → Notifications.</p>
              </Card>

              <Card>
                <CardHeader title="Open alerts" subtitle="Condition-based alerts, deduplicated" />
                {data.alerts.length === 0 ? (
                  <p className="text-[11px] text-ink-500">No open alerts.</p>
                ) : (
                  <ul className="space-y-2">
                    {data.alerts.map((alert) => (
                      <li key={alert.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                        <p className="text-xs font-medium text-amber-900">{alert.title}</p>
                        <p className="mt-0.5 text-[11px] text-amber-800">{alert.message}</p>
                        <div className="mt-1 flex items-center justify-between text-[10px] text-amber-700">
                          <span>{alert.source} · seen {alert.occurrenceCount}× · {relativeTime(alert.lastSeenAt)}</span>
                          <Button size="sm" variant="ghost" onClick={() => void resolveAlert(alert.id)}>Resolve</Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </>
      ) : notifications.loading ? (
        <Card><div className="h-40 animate-pulse rounded bg-ink-100" /></Card>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------- notification prefs */

export function NotificationPreferences({
  initial,
}: {
  initial: { notifyEmail: boolean; notifyBrowser: boolean; notifyTelegram: boolean; telegramChatId: string | null; timezone: string }
}) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await api.patch('/api/settings', {
        notifyEmail: form.notifyEmail,
        notifyBrowser: form.notifyBrowser,
        notifyTelegram: form.notifyTelegram,
        telegramChatId: form.telegramChatId || null,
      })
      setNotice('Notification preferences saved.')
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Preferences could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader title="Notification channels" subtitle="Pick where AIBA reaches you. In-app is always on." icon={<BellRing className="h-4 w-4" />} />
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}
      <div className="space-y-3">
        <Switch checked={form.notifyEmail} onChange={(checked) => setForm({ ...form, notifyEmail: checked })} label="Email (requires EMAIL_PROVIDER and provider credentials)" />
        <Switch checked={form.notifyBrowser} onChange={(checked) => setForm({ ...form, notifyBrowser: checked })} label="Browser (in-app alerts, works without third-party credentials)" />
        <Switch checked={form.notifyTelegram} onChange={(checked) => setForm({ ...form, notifyTelegram: checked })} label="Telegram (requires TELEGRAM_BOT_TOKEN)" />
        <Field label="Telegram chat id" hint="Send /start to your bot, then paste the chat id here. This is not a secret.">
          <Input value={form.telegramChatId ?? ''} onChange={(event) => setForm({ ...form, telegramChatId: event.target.value })} placeholder="123456789" />
        </Field>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-500">
          <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" /> email</span>
          <span className="inline-flex items-center gap-1"><MessageSquare className="h-3 w-3" /> telegram</span>
          <span className="inline-flex items-center gap-1"><Monitor className="h-3 w-3" /> browser</span>
          <span className="inline-flex items-center gap-1"><BadgeCheck className="h-3 w-3 text-signal-positive" /> every notification is stored in-app regardless of channel</span>
        </div>
        <Button size="sm" loading={saving} onClick={() => void save()}>Save preferences</Button>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------- reports */

type Report = {
  id: string
  period: string
  title: string
  summary: string
  body: string
  generatedAt: string
  demo: boolean
  metrics?: Record<string, number>
}

export function ReportLibrary({ canGenerate }: { canGenerate: boolean }) {
  const [period, setPeriod] = useState<'daily' | 'weekly'>('daily')
  const reports = useApi<{ reports: Report[]; latest: Report | null }>('/api/reports', { query: { period, limit: 20 } })
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const rows = reports.data?.reports ?? []
  const active = useMemo(() => rows.find((row) => row.id === selected) ?? reports.data?.latest ?? rows[0] ?? null, [rows, selected, reports.data])

  async function generate(useAi: boolean) {
    setBusy(true)
    setError(null)
    try {
      const { data: report } = await api.post<Report>('/api/reports', { period, useAi })
      setNotice(`${report.title} generated from recorded data.`)
      setSelected(report.id)
      await reports.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The report could not be generated.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Reports</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            Daily and weekly reports are generated automatically by the scheduler from recorded data. Anything forward-looking is marked as an
            estimate inside the report text.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select className="w-32" value={period} onChange={(event) => setPeriod(event.target.value as 'daily' | 'weekly')}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </Select>
          {canGenerate ? (
            <>
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void generate(false)}>Generate now</Button>
              <Button size="sm" loading={busy} onClick={() => void generate(true)}>Generate with AI summary</Button>
            </>
          ) : null}
        </div>
      </header>

      {reports.error ? <ErrorNote message={reports.error} onRetry={() => void reports.refresh()} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Report library" subtitle={`${rows.length} stored report(s)`} />
          {rows.length === 0 ? (
            <p className="text-[11px] text-ink-500">No reports stored yet. The scheduler writes one after each cycle, or generate one now.</p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(row.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs ${active?.id === row.id ? 'border-accent-300 bg-accent-50' : 'border-ink-200 hover:bg-ink-50'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-ink-800">{row.title}</span>
                      {row.demo ? <Badge tone="demo">DEMO DATA</Badge> : <Badge tone="neutral">{row.period}</Badge>}
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-500">{formatDate(row.generatedAt)} · {relativeTime(row.generatedAt)}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-2">
          {active ? (
            <>
              <CardHeader title={active.title} subtitle={`${active.period} report · generated ${relativeTime(active.generatedAt)}`} />
              {active.metrics ? (
                <div className="mb-3 grid gap-2 sm:grid-cols-3">
                  {Object.entries(active.metrics).slice(0, 6).map(([key, value]) => (
                    <div key={key} className="rounded-lg bg-ink-50 px-3 py-2">
                      <p className="text-[11px] text-ink-500">{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</p>
                      <p className="tabular mt-0.5 text-sm font-medium text-ink-900">{typeof value === 'number' && key.toLowerCase().includes('cent') ? formatMoney(value) : String(value)}</p>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="prose prose-sm max-w-none whitespace-pre-wrap text-xs leading-relaxed text-ink-700">{active.body}</div>
            </>
          ) : (
            <EmptyState
              icon={<FileBarChart className="h-5 w-5" />}
              title="No report selected"
              description="Reports are written from recorded events. Generate one to see exactly what AIBA did in the period."
            />
          )}
        </Card>
      </div>
    </div>
  )
}
