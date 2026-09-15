'use client'
/**
 * Settings screen: profile, risk/automation posture, publishing target, demo
 * mode and the credential inventory.
 *
 * Credentials are never displayed — only whether the corresponding environment
 * variable is present, together with the documented way to obtain it and how to
 * test it.
 */
import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, Cpu, KeyRound, Palette, Play, ShieldCheck, Sparkles, Trash2, Workflow } from 'lucide-react'
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, KeyValue, Select, Switch, Table } from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { formatDate, formatMoney, relativeTime } from '@/lib/client/format'

type Credential = {
  service: string
  credential: string
  envVar: string
  whereToObtain: string
  testProcedure: string
  required: boolean
  present: boolean
}

type SettingsPayload = {
  workspace: { id: string; name: string; slug: string; planKey: string; demoMode: boolean; createdAt: string } | null
  profile: {
    legalName: string | null
    country: string
    currency: string
    timezone: string
    riskTolerance: string
    automationLevel: string
    scoreThreshold: number
    interests: string[]
    industries: string[]
    businessModels: string[]
    monetizationPreferences: string[]
    dailyBudgetCents: number
    monthlyBudgetCents: number
    maxProjectBudgetCents: number
    perAgentDailyLimitCents: number
    notifyEmail: boolean
    notifyBrowser: boolean
    notifyTelegram: boolean
    telegramChatId: string | null
  } | null
  user: { email: string; name: string; role: string; timezone: string; createdAt: string; lastLoginAt: string | null }
  settings: Record<string, unknown>
  credentials: Credential[]
  ai: { configured: boolean; provider: string; models: { cheap: string; standard: string; reasoning: string }; networkAllowed: boolean; reason: string }
  payments: { provider: string; configured: boolean; webhookConfigured: boolean; note: string }
  storage: { driver: string; bucket: string; region: string; ready: boolean; note?: string; requiredCredentials: Credential[] }
  environment: { appName: string; appUrl: string; demoModeEnabled: boolean; allowRegistration: boolean; requireEmailVerification: boolean; paymentProvider: string; aiConfigured: boolean; emailProvider: string; storageDriver: string; queueDriver: string; databaseDriver: string }
  channels: { key: string; label: string; available: boolean; envVar: string | null; detail: string; configuredBy: string }[]
  scheduler: { schedules: { key: string; name: string; cron: string; jobName: string; enabled: boolean }[]; note: string }
  demoMode: boolean
  demoModeEnabled: boolean
}

export function SettingsPanel({ isAdmin }: { isAdmin: boolean }) {
  const settings = useApi<SettingsPayload>('/api/settings')
  const data = settings.data
  const [form, setForm] = useState<Partial<SettingsPayload['profile'] & { name: string; timezone: string }> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const profile = data?.profile
  const value = <K extends keyof NonNullable<SettingsPayload['profile']>>(key: K, fallback: NonNullable<SettingsPayload['profile']>[K] | undefined) =>
    (form?.[key] as NonNullable<SettingsPayload['profile']>[K] | undefined) ?? fallback

  async function saveProfile() {
    setBusy('profile')
    setError(null)
    try {
      await api.patch('/api/users', {
        riskTolerance: value('riskTolerance', profile?.riskTolerance),
        automationLevel: value('automationLevel', profile?.automationLevel),
        scoreThreshold: value('scoreThreshold', profile?.scoreThreshold),
        currency: value('currency', profile?.currency),
        country: value('country', profile?.country),
        legalName: value('legalName', profile?.legalName) ?? null,
        timezone: value('timezone', profile?.timezone),
      })
      setNotice('Profile saved. Scoring, risk posture and automation level apply to the next agent run.')
      await settings.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Profile could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  async function savePublishing(publishTarget: string) {
    setBusy('publish')
    try {
      await api.patch('/api/settings', { publishTarget })
      setNotice(`Publishing target set to ${publishTarget.replace('_', ' ')}. Publishing still requires approval each time.`)
      await settings.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Publishing target could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  async function toggleDemo(next: boolean) {
    setBusy('demo')
    try {
      await api.patch('/api/settings', { demoMode: next })
      setNotice(
        next
          ? 'Demo mode on. Sample data is flagged and excluded from real figures by default.'
          : 'Demo mode off. Demo rows stay in the database but are excluded from every real figure.',
      )
      await settings.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Demo mode could not be changed.')
    } finally {
      setBusy(null)
    }
  }

  async function saveNotifications(next: { notifyEmail: boolean; notifyBrowser: boolean; notifyTelegram: boolean; telegramChatId: string | null }) {
    setBusy('notify')
    try {
      await api.patch('/api/settings', next)
      setNotice('Notification preferences saved.')
      await settings.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Notification preferences could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  if (settings.loading) return <Card><div className="h-40 animate-pulse rounded bg-ink-100" /></Card>
  if (settings.error) return <ErrorNote message={settings.error} onRetry={() => void settings.refresh()} />
  if (!data) return null

  const publishTarget = String((data.settings.publishTarget as string | undefined) ?? 'local_export')

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">Settings</h1>
        <p className="mt-0.5 text-xs text-ink-500">
          Everything configurable about this workspace. Secrets are never shown — only whether the server can see them.
        </p>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile & posture" subtitle="Drives scoring, risk limits and how much AIBA does on its own" icon={<ShieldCheck className="h-4 w-4" />} />
          <div className="space-y-3">
            <Field label="Legal / trading name" hint="Used on generated documents and public pages you publish.">
              <Input value={value('legalName', profile?.legalName) ?? ''} onChange={(event) => setForm({ ...form, legalName: event.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Risk tolerance">
                <Select value={value('riskTolerance', profile?.riskTolerance)} onChange={(event) => setForm({ ...form, riskTolerance: event.target.value })}>
                  <option value="conservative">Conservative</option>
                  <option value="balanced">Balanced</option>
                  <option value="aggressive">Aggressive</option>
                </Select>
              </Field>
              <Field label="Automation level" hint="‘Approval required’ is the default and the safest setting.">
                <Select value={value('automationLevel', profile?.automationLevel)} onChange={(event) => setForm({ ...form, automationLevel: event.target.value })}>
                  <option value="approval_required">Approval required</option>
                  <option value="assisted">Assisted</option>
                  <option value="supervised_auto">Supervised auto</option>
                  <option value="autonomous">Autonomous (still honours policy and budget)</option>
                </Select>
              </Field>
              <Field label="Currency">
                <Select value={value('currency', profile?.currency)} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
                  {['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'INR', 'LKR', 'SGD', 'AED', 'ZAR', 'JPY', 'BRL'].map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Timezone">
                <Input value={value('timezone', profile?.timezone) ?? 'UTC'} onChange={(event) => setForm({ ...form, timezone: event.target.value })} />
              </Field>
            </div>
            <Field label="Score threshold" hint="Opportunities scoring at or above this are treated as worth a strategy. 0 disables auto-strategy.">
              <Input type="number" min={0} max={100} value={String(value('scoreThreshold', profile?.scoreThreshold) ?? 70)} onChange={(event) => setForm({ ...form, scoreThreshold: Number(event.target.value) })} />
            </Field>
            <Button size="sm" loading={busy === 'profile'} onClick={() => void saveProfile()}>Save profile</Button>
            <p className="text-[11px] text-ink-400">
              Budget limits are managed on the <Link className="text-accent-700 hover:underline" href="/dashboard/budget">Budget guardrails</Link> page so
              the confirmation step is explicit.
            </p>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Publishing" subtitle="Where approved content goes. Delivery is decided per action and each publish still needs approval." />
            <div className="space-y-2">
              <Select value={publishTarget} onChange={(event) => void savePublishing(event.target.value)} disabled={busy === 'publish'}>
                <option value="local_export">Local export (no external credentials needed)</option>
                <option value="webhook">Webhook endpoint</option>
                <option value="wordpress">WordPress site</option>
                <option value="github">GitHub repository</option>
              </Select>
              <p className="text-[11px] text-ink-500">
                {publishTarget === 'local_export'
                  ? 'Assets are written to local storage and downloaded by you. Nothing leaves the server.'
                  : 'The matching credentials must be present in the server environment before this target can deliver.'}
              </p>
              <Link href="/dashboard/workflows" className="inline-flex items-center gap-1 text-[11px] text-accent-700 hover:underline">
                Review the publish workflow <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </Card>

          <Card>
            <CardHeader title="Demo mode" subtitle="Keeps sample data strictly separate from real data" icon={<Palette className="h-4 w-4" />} />
            <Switch
              checked={data.demoMode}
              disabled={!data.demoModeEnabled || busy === 'demo'}
              onChange={(checked) => void toggleDemo(checked)}
              label={data.demoMode ? 'Demo mode is ON' : 'Demo mode is OFF'}
              description={
                data.demoModeEnabled
                  ? 'Demo rows carry a demo flag, show a DEMO DATA badge and are excluded from real revenue, budget and analytics totals unless you explicitly ask for them.'
                  : 'Disabled on this deployment by DEMO_MODE_ENABLED=false.'
              }
            />
            <div className="mt-2 flex gap-2">
              <Link href="/dashboard/revenue" className="text-[11px] text-accent-700 hover:underline">See demo revenue</Link>
              <Link href="/dashboard/analytics" className="text-[11px] text-accent-700 hover:underline">See demo analytics</Link>
            </div>
          </Card>

          <Card>
            <CardHeader title="Notifications" subtitle="Email, browser and Telegram" />
            <Switch
              checked={profile?.notifyEmail ?? true}
              onChange={(checked) => void saveNotifications({ notifyEmail: checked, notifyBrowser: profile?.notifyBrowser ?? true, notifyTelegram: profile?.notifyTelegram ?? false, telegramChatId: profile?.telegramChatId ?? null })}
              label="Email"
              description={data.channels.find((channel) => channel.key === 'email')?.available ? 'Provider configured.' : 'EMAIL_PROVIDER not configured — notifications are still recorded in-app.'}
            />
            <Switch
              checked={profile?.notifyBrowser ?? true}
              onChange={(checked) => void saveNotifications({ notifyEmail: profile?.notifyEmail ?? true, notifyBrowser: checked, notifyTelegram: profile?.notifyTelegram ?? false, telegramChatId: profile?.telegramChatId ?? null })}
              label="Browser / in-app"
            />
            <Switch
              checked={profile?.notifyTelegram ?? false}
              onChange={(checked) => void saveNotifications({ notifyEmail: profile?.notifyEmail ?? true, notifyBrowser: profile?.notifyBrowser ?? true, notifyTelegram: checked, telegramChatId: profile?.telegramChatId ?? null })}
              label="Telegram"
              description={data.channels.find((channel) => channel.key === 'telegram')?.available ? 'Bot token present.' : 'TELEGRAM_BOT_TOKEN not configured.'}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <Input
                placeholder="Telegram chat id"
                defaultValue={profile?.telegramChatId ?? ''}
                onBlur={(event) => void saveNotifications({ notifyEmail: profile?.notifyEmail ?? true, notifyBrowser: profile?.notifyBrowser ?? true, notifyTelegram: profile?.notifyTelegram ?? false, telegramChatId: event.target.value || null })}
              />
              <Link href="/dashboard/notifications" className="shrink-0 text-[11px] text-accent-700 hover:underline">Test channels</Link>
            </div>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader
          title="Service integration status"
          subtitle="What is wired up right now, read from the running server"
          icon={<Cpu className="h-4 w-4" />}
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KeyValue
            items={[
              { label: 'AI provider', value: `${data.ai.provider}${data.ai.configured ? '' : ' (not configured)'}` },
              { label: 'Payments', value: `${data.payments.provider}${data.payments.configured ? '' : ' (not configured)'}` },
              { label: 'Storage', value: `${data.storage.driver}${data.storage.ready ? '' : ' (not ready)'}` },
              { label: 'Queue', value: data.environment.queueDriver },
            ]}
          />
          <div className="text-[11px] text-ink-500">
            <p className="font-medium text-ink-700">AI</p>
            <p className="mt-0.5">{data.ai.reason}</p>
            <p className="mt-1 text-ink-400">cheap {data.ai.models.cheap} · standard {data.ai.models.standard} · reasoning {data.ai.models.reasoning}</p>
            <p className="mt-1">Outbound network: {data.ai.networkAllowed ? 'allowed' : 'blocked by SOURCE_ALLOW_NETWORK=false'}</p>
          </div>
          <div className="text-[11px] text-ink-500">
            <p className="font-medium text-ink-700">Payments</p>
            <p className="mt-0.5">{data.payments.note}</p>
            <p className="mt-1">Webhook secret: {data.payments.webhookConfigured ? 'present' : 'missing'}</p>
          </div>
          <div className="text-[11px] text-ink-500">
            <p className="font-medium text-ink-700">Deployment</p>
            <p className="mt-0.5">{data.environment.appName} · {data.environment.appUrl}</p>
            <p className="mt-1">Registration {data.environment.allowRegistration ? 'enabled' : 'closed'} · email verification {data.environment.requireEmailVerification ? 'required' : 'optional'}</p>
            <p className="mt-1 text-ink-400">{data.environment.databaseDriver} · {data.environment.storageDriver}</p>
          </div>
        </div>

        <div className="mt-4">
          <Table headers={['Service', 'Credential', 'Environment variable', 'Where to obtain', 'How to test', 'Status']}>
            {data.credentials.map((entry) => (
              <tr key={entry.envVar} className="border-t border-ink-200">
                <td className="px-4 py-3 text-xs text-ink-700">{entry.service}</td>
                <td className="px-4 py-3 text-xs text-ink-600">{entry.credential}</td>
                <td className="px-4 py-3 font-mono text-[11px] text-ink-600">{entry.envVar}</td>
                <td className="px-4 py-3 text-[11px] text-ink-500">{entry.whereToObtain}</td>
                <td className="px-4 py-3 text-[11px] text-ink-500">{entry.testProcedure}</td>
                <td className="px-4 py-3">
                  <Badge tone={entry.present ? 'positive' : entry.required ? 'warning' : 'neutral'}>
                    {entry.present ? 'present' : entry.required ? 'required, missing' : 'optional, missing'}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-[11px] text-ink-500">
            Values are never rendered. Add them to the server environment (<code className="font-mono">.env</code> locally, or your host&apos;s secret
            store) and restart the web process and the worker.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Scheduler"
          subtitle={data.scheduler.note}
          icon={<Workflow className="h-4 w-4" />}
          action={<Link href="/dashboard/jobs" className="text-[11px] text-accent-700 hover:underline">Open job console</Link>}
        />
        <Table headers={['Job', 'Cron (UTC)', 'Queue', 'State']}>
          {data.scheduler.schedules.map((schedule) => (
            <tr key={schedule.key} className="border-t border-ink-200">
              <td className="px-4 py-2.5 text-xs text-ink-700">{schedule.name}</td>
              <td className="px-4 py-2.5 font-mono text-[11px] text-ink-600">{schedule.cron}</td>
              <td className="px-4 py-2.5 text-[11px] text-ink-500">{schedule.jobName}</td>
              <td className="px-4 py-2.5"><Badge tone={schedule.enabled ? 'positive' : 'neutral'}>{schedule.enabled ? 'enabled' : 'disabled'}</Badge></td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <CardHeader title="Account" subtitle="Owner and workspace facts" icon={<KeyRound className="h-4 w-4" />} />
        <div className="grid gap-3 sm:grid-cols-2">
          <KeyValue
            items={[
              { label: 'Email', value: data.user.email },
              { label: 'Name', value: data.user.name },
              { label: 'Role', value: data.user.role },
              { label: 'Member since', value: formatDate(data.user.createdAt) },
              { label: 'Last sign-in', value: data.user.lastLoginAt ? relativeTime(data.user.lastLoginAt) : '—' },
            ]}
          />
          <KeyValue
            items={[
              { label: 'Workspace', value: data.workspace?.name ?? '—' },
              { label: 'Plan', value: data.workspace?.planKey ?? 'free' },
              { label: 'Workspace created', value: data.workspace ? formatDate(data.workspace.createdAt) : '—' },
              { label: 'Daily budget', value: formatMoney(profile?.dailyBudgetCents ?? 0) },
              { label: 'Monthly budget', value: formatMoney(profile?.monthlyBudgetCents ?? 0) },
            ]}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-[11px]">
          <Link href="/dashboard/billing" className="inline-flex items-center gap-1 text-accent-700 hover:underline">
            Manage plan <ArrowRight className="h-3 w-3" />
          </Link>
          <Link href="/dashboard/approvals" className="inline-flex items-center gap-1 text-accent-700 hover:underline">
            Approval history <ArrowRight className="h-3 w-3" />
          </Link>
          {isAdmin ? (
            <Link href="/dashboard/admin" className="inline-flex items-center gap-1 text-accent-700 hover:underline">
              Admin console <ArrowRight className="h-3 w-3" />
            </Link>
          ) : null}
        </div>
      </Card>

      {isAdmin ? <DemoDataPanel /> : null}
    </div>
  )
}

function DemoDataPanel() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function run(action: 'seed' | 'clear') {
    setBusy(action)
    setError(null)
    try {
      const { data } = await api.post<{ notice?: string; cleared?: boolean; opportunities?: number; projects?: number }>('/api/demo', { action })
      setNotice(data.notice ?? (action === 'seed' ? 'Sample data created.' : 'Demo data removed.'))
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The demo operation failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader
        title="Demo data (administrator)"
        subtitle="Sample rows are written with an explicit demo flag so they can never be mistaken for real revenue"
        icon={<Sparkles className="h-4 w-4" />}
      />
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" loading={busy === 'seed'} onClick={() => void run('seed')}>
          <Play className="h-3.5 w-3.5" />
          Generate sample cycle
        </Button>
        <Button size="sm" variant="danger" loading={busy === 'clear'} onClick={() => void run('clear')}>
          <Trash2 className="h-3.5 w-3.5" />
          Remove demo data
        </Button>
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-500">
          <AlertTriangle className="h-3 w-3 text-amber-500" />
          Removal only ever touches rows flagged as demo.
        </span>
      </div>
    </Card>
  )
}
