'use client'
/**
 * Sources, agent memory and job queue screens.
 *
 * Each one shows the real row-level state: which source is permitted, how much
 * memory is stored and when it expires, and every job with its attempts and
 * last error.
 */
import { useState } from 'react'
import { Brain, CircleAlert, Plug, Play, RefreshCw, RotateCcw, Trash2, XCircle } from 'lucide-react'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, Modal, ProgressBar, Select, Table, Textarea } from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { formatDate, formatMoney, formatNumber, relativeTime } from '@/lib/client/format'

/* ------------------------------------------------------------------ sources */

type SourceRow = {
  id: string
  name: string
  type: string
  url: string
  permissionStatus: string
  termsUrl: string | null
  requiresCredentials: boolean
  credentialEnvVar: string | null
  rateLimitPerHour: number
  reliabilityScore: number
  categories: string[]
  enabled: boolean
  lastScanAt: string | null
  lastScanStatus: string | null
  lastError: string | null
  scanCount: number
  discovered: number
  discoveredCount: number
}

type Collector = {
  key: string
  name: string
  type: string
  permissionStatus: string
  url: string
  termsUrl: string | null
  requiresCredentials: boolean
  credentialEnvVar: string | null
  credentialPresent: boolean
}

type SourcesPayload = {
  sources: SourceRow[]
  collectors: Collector[]
  missingCredentials: { name: string; envVar: string | null }[]
  policy: string
}

export function SourceManager() {
  const sources = useApi<SourcesPayload>('/api/sources')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [registering, setRegistering] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'rss', url: '', categories: '', termsUrl: '' })

  async function toggle(source: SourceRow) {
    setPending(source.id)
    setError(null)
    try {
      await api.patch('/api/sources', { id: source.id, enabled: !source.enabled })
      setNotice(`${source.name} ${source.enabled ? 'disabled' : 'enabled'}.`)
      await sources.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The change could not be saved.')
    } finally {
      setPending(null)
    }
  }

  async function scan(keys?: string[]) {
    setPending('scan')
    setError(null)
    setNotice(null)
    try {
      const result = await api.post<{ collected?: number; inserted?: number; duplicates?: number; sourcesScanned?: number }>('/api/sources', {
        action: 'scan',
        sourceKeys: keys,
        limitPerSource: 15,
        useAi: true,
      })
      setNotice(
        `Scan finished: ${result.data.inserted ?? 0} new, ${result.data.duplicates ?? 0} duplicates skipped across ${result.data.sourcesScanned ?? 0} sources.`,
      )
      await sources.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The scan failed.')
    } finally {
      setPending(null)
    }
  }

  const data = sources.data

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Sources</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-ink-500">{data?.policy ?? 'Loading collection policy…'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={pending === 'scan'} onClick={() => void scan()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Scan enabled sources
          </Button>
          <Button size="sm" onClick={() => setRegistering(true)}>
            <Plug className="h-3.5 w-3.5" />
            Register a feed
          </Button>
        </div>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      {data?.missingCredentials.length ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[11px] text-amber-900">
          <p className="font-medium">
            <CircleAlert className="mr-1 inline h-3.5 w-3.5" />
            {data.missingCredentials.length} source(s) need credentials before they can collect:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {data.missingCredentials.map((entry) => (
              <li key={entry.name}>
                {entry.name} — set <code className="font-mono">{entry.envVar}</code> in your environment. AIBA does not invent credentials and will
                simply skip these sources until they are provided.
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card className="p-0">
        <div className="p-5">
          <CardHeader title="Registered sources" subtitle="Only sources marked permitted are ever contacted" />
        </div>
        {!data ? (
          <div className="px-5 pb-5"><div className="h-32 animate-pulse rounded bg-ink-100" /></div>
        ) : data.sources.length === 0 ? (
          <div className="p-5"><EmptyState title="No sources registered" description="Register an RSS feed you own or one that permits automated collection, then run a scan." /></div>
        ) : (
          <Table headers={['Source', 'Permission', 'Credentials', 'Rate limit', 'Last scan', 'Discovered', 'Status', '']}>
            {data.sources.map((source) => (
              <tr key={source.id}>
                <td className="px-3 py-2">
                  <p className="text-xs font-medium text-ink-900">{source.name}</p>
                  <p className="font-mono text-[10px] break-all text-ink-500">{source.url}</p>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={source.permissionStatus === 'permitted' ? 'positive' : source.permissionStatus === 'unknown' ? 'warning' : 'neutral'}>
                    {source.permissionStatus}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-[11px]">
                  {source.requiresCredentials ? (
                    <span className="font-mono text-ink-600">{source.credentialEnvVar}</span>
                  ) : (
                    <span className="text-ink-500">not required</span>
                  )}
                </td>
                <td className="tabular px-3 py-2 text-xs">{source.rateLimitPerHour}/h</td>
                <td className="px-3 py-2 text-[11px] text-ink-500">
                  {source.lastScanAt ? relativeTime(source.lastScanAt) : 'never'}
                  {source.lastScanStatus ? <span className="ml-1 text-ink-400">({source.lastScanStatus})</span> : null}
                  {source.lastError ? <p className="text-signal-critical">{source.lastError}</p> : null}
                </td>
                <td className="tabular px-3 py-2 text-xs">{formatNumber(source.discovered)}</td>
                <td className="px-3 py-2">
                  <Badge tone={source.enabled ? 'positive' : 'neutral'}>{source.enabled ? 'enabled' : 'disabled'}</Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="secondary" disabled={!source.enabled} loading={pending === 'scan'} onClick={() => void scan([source.name])}>
                      Scan
                    </Button>
                    <Button size="sm" variant="ghost" loading={pending === source.id} onClick={() => void toggle(source)}>
                      {source.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Available collectors" subtitle="Built-in integrations and whether this deployment has credentials for them" icon={<Plug className="h-4 w-4" />} />
        <ul className="divide-y divide-ink-100">
          {(data?.collectors ?? []).map((collector) => (
            <li key={collector.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div>
                <p className="text-xs font-medium text-ink-800">{collector.name}</p>
                <p className="text-[11px] text-ink-500">
                  {collector.type} · {collector.url}
                  {collector.termsUrl ? (
                    <>
                      {' · '}
                      <a href={collector.termsUrl} target="_blank" rel="noreferrer" className="underline">
                        terms
                      </a>
                    </>
                  ) : null}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge tone={collector.permissionStatus === 'permitted' ? 'positive' : 'warning'}>{collector.permissionStatus}</Badge>
                {collector.requiresCredentials ? (
                  <Badge tone={collector.credentialPresent ? 'positive' : 'critical'}>
                    {collector.credentialPresent ? 'credentials present' : `set ${collector.credentialEnvVar}`}
                  </Badge>
                ) : (
                  <Badge tone="neutral">no credentials needed</Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Modal
        open={registering}
        onClose={() => setRegistering(false)}
        title="Register a feed you are permitted to collect from"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRegistering(false)}>Cancel</Button>
            <Button
              loading={pending === 'register'}
              disabled={form.name.length < 3 || !form.url.startsWith('http')}
              onClick={async () => {
                setPending('register')
                setError(null)
                try {
                  await api.post('/api/sources', {
                    action: 'register',
                    name: form.name,
                    type: form.type,
                    url: form.url,
                    categories: form.categories ? form.categories.split(',').map((entry) => entry.trim()).filter(Boolean) : [],
                    termsUrl: form.termsUrl || undefined,
                    confirmPermission: true,
                  })
                  setNotice(`${form.name} registered. It will be picked up on the next scan.`)
                  setRegistering(false)
                  setForm({ name: '', type: 'rss', url: '', categories: '', termsUrl: '' })
                  await sources.refresh()
                } catch (caught) {
                  setError(caught instanceof ApiClientError ? caught.message : 'The source could not be registered.')
                } finally {
                  setPending(null)
                }
              }}
            >
              Register source
            </Button>
          </>
        }
      >
        <p className="text-xs text-ink-600">
          Only register feeds you own, that you have written permission to collect from, or that are explicitly public and permit automated
          access. AIBA records your confirmation with the source row.
        </p>
        <div className="mt-3 space-y-3">
          <Field label="Name" required>
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Feed URL" required>
            <Input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://example.com/feed.xml" />
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              {['rss', 'api', 'manual', 'public_dataset', 'partner'].map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </Select>
          </Field>
          <Field label="Categories" hint="Comma separated">
            <Input value={form.categories} onChange={(event) => setForm({ ...form, categories: event.target.value })} />
          </Field>
          <Field label="Terms URL" hint="Optional, but recommended: link the page that grants permission.">
            <Input value={form.termsUrl} onChange={(event) => setForm({ ...form, termsUrl: event.target.value })} />
          </Field>
        </div>
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------- memory */

type MemoryEntry = {
  id: string
  agentKey: string
  kind: string
  key: string
  content: string
  importance: number
  refType: string | null
  refId: string | null
  createdAt: string
  expiresAt: string | null
}

type MemoryPayload = {
  entries: MemoryEntry[]
  stats: { totalEntries: number; byAgent: { agentKey: string; count: number }[]; expired: number; oldestAt: string | null; retentionPolicy: Record<string, unknown> }
}

export function MemoryBrowser() {
  const [kind, setKind] = useState('')
  const memory = useApi<MemoryPayload>('/api/memory', { query: { kind: kind || undefined, limit: 100 } })
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function act(body: Record<string, unknown>, label: string, message: string) {
    setPending(label)
    setError(null)
    try {
      await api.post('/api/memory', body)
      setNotice(message)
      await memory.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The action failed.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Agent memory</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-ink-500">
            Memory is deliberately bounded: entries are summarised, carry an importance score and expire. There is no unbounded
            conversation log, and no entry can be used to sidestep the policy engine.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-40" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">All kinds</option>
            {['insight', 'preference', 'outcome', 'pattern', 'fact', 'summary'].map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </Select>
          <Button size="sm" variant="secondary" loading={pending === 'summarise'} onClick={() => void act({ action: 'summarise' }, 'summarise', 'Memory summarised and pruned to the retention budget.')}>
            <Brain className="h-3.5 w-3.5" />
            Summarise &amp; prune
          </Button>
        </div>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Stored entries" subtitle="Across all agents in this workspace" />
          <p className="tabular text-2xl font-semibold text-ink-900">{formatNumber(memory.data?.stats.totalEntries ?? 0)}</p>
          <ProgressBar value={Math.min(100, memory.data?.stats.totalEntries ?? 0)} tone="info" label="of the configured budget" />
          <p className="mt-2 text-[11px] text-ink-500">
            {memory.data?.stats.expired ?? 0} expired entries pending cleanup
            {memory.data?.stats.oldestAt ? ` · oldest ${relativeTime(memory.data.stats.oldestAt)}` : ''}
          </p>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="By agent" />
          <div className="flex flex-wrap gap-1.5">
            {(memory.data?.stats.byAgent ?? []).map((entry) => (
              <Badge key={entry.agentKey} tone="neutral">
                {entry.agentKey}: {entry.count}
              </Badge>
            ))}
            {!memory.data?.stats.byAgent.length ? <span className="text-xs text-ink-500">No memory stored yet.</span> : null}
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-[11px] font-medium text-ink-500">Retention policy</summary>
            <pre className="mt-2 overflow-auto rounded-lg bg-ink-950 p-3 text-[10px] text-ink-100">
              {JSON.stringify(memory.data?.stats.retentionPolicy ?? {}, null, 2)}
            </pre>
          </details>
        </Card>
      </div>

      {memory.error ? <ErrorNote message={memory.error} onRetry={() => void memory.refresh()} /> : null}

      <Card className="p-0">
        {!memory.data ? (
          <div className="p-5"><div className="h-40 animate-pulse rounded bg-ink-100" /></div>
        ) : memory.data.entries.length === 0 ? (
          <div className="p-5"><EmptyState title="No memory entries" description="Agents write an entry when they learn something that should change future behaviour — an outcome, a rejected pattern or a preference." /></div>
        ) : (
          <Table headers={['Agent', 'Kind', 'Key', 'Content', 'Importance', 'Expires', '']}>
            {memory.data.entries.map((entry) => (
              <tr key={entry.id}>
                <td className="px-3 py-2 text-xs capitalize">{entry.agentKey}</td>
                <td className="px-3 py-2"><Badge tone="neutral">{entry.kind}</Badge></td>
                <td className="px-3 py-2 font-mono text-[11px] text-ink-600">{entry.key}</td>
                <td className="max-w-md px-3 py-2 text-[11px] text-ink-700">{entry.content}</td>
                <td className="tabular px-3 py-2 text-xs">{entry.importance}</td>
                <td className="px-3 py-2 text-[11px] text-ink-500">{entry.expiresAt ? formatDate(entry.expiresAt) : 'never'}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="ghost" loading={pending === `promote-${entry.id}`} onClick={() => void act({ action: 'promote', id: entry.id }, `promote-${entry.id}`, 'Importance raised. Higher-importance entries are retained longer.')}>
                      Promote
                    </Button>
                    <Button size="sm" variant="ghost" loading={pending === `forget-${entry.id}`} onClick={() => void act({ action: 'forget', id: entry.id }, `forget-${entry.id}`, 'Entry deleted.')}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}

/* --------------------------------------------------------------------- jobs */

type JobRow = {
  id: string
  queue: string
  name: string
  status: string
  priority: number
  attempts: number
  maxAttempts: number
  runAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  lastError: string | null
  dedupeKey: string | null
}

type JobsPayload = {
  jobs: JobRow[]
  stats: { driver: string; queued: number; running: number; failed: number; dead: number; succeeded24h: number; oldestQueuedSeconds: number; byQueue: Record<string, number> }
  byStatus: Record<string, number>
}

export function JobConsole() {
  const [status, setStatus] = useState('')
  const jobs = useApi<JobsPayload>('/api/jobs', { query: { status: status || undefined, limit: 50 }, pollMs: 15_000 })
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function act(jobId: string, action: 'retry' | 'cancel') {
    setPending(`${action}-${jobId}`)
    setError(null)
    try {
      const result = await api.post<{ applied: boolean }>('/api/jobs', { jobId, action })
      setNotice(result.data.applied ? `Job ${action} applied.` : `Job could not be ${action}ed in its current state.`)
      await jobs.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The action failed.')
    } finally {
      setPending(null)
    }
  }

  const stats = jobs.data?.stats

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Jobs &amp; queues</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            Durable queue · driver {stats?.driver ?? '…'} · {stats?.queued ?? 0} queued, {stats?.running ?? 0} running, {stats?.failed ?? 0} failed,{' '}
            {stats?.dead ?? 0} dead, {stats?.succeeded24h ?? 0} succeeded in 24h
            {stats?.oldestQueuedSeconds ? ` · oldest queued ${stats.oldestQueuedSeconds}s` : ''}
          </p>
        </div>
        <Select className="w-40" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          {['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'].map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </Select>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      <div className="flex flex-wrap gap-1.5">
        {Object.entries(jobs.data?.byStatus ?? {}).map(([key, value]) => (
          <Badge key={key} tone={key === 'failed' || key === 'dead' ? 'critical' : key === 'running' ? 'info' : 'neutral'}>
            {key}: {value}
          </Badge>
        ))}
      </div>

      <Card className="p-0">
        {!jobs.data ? (
          <div className="p-5"><div className="h-40 animate-pulse rounded bg-ink-100" /></div>
        ) : jobs.data.jobs.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={status ? `No ${status} jobs` : 'No jobs yet'}
              description="Jobs are created by the scheduler, by approvals that need execution, and by any action you trigger that runs in the background."
            />
          </div>
        ) : (
          <Table headers={['Job', 'Status', 'Attempts', 'Run at', 'Duration', 'Last error', '']}>
            {jobs.data.jobs.map((job) => (
              <tr key={job.id}>
                <td className="px-3 py-2">
                  <p className="text-xs font-medium text-ink-900">{job.name}</p>
                  <p className="font-mono text-[10px] text-ink-500">
                    {job.queue} · {job.id.slice(0, 8)}
                    {job.dedupeKey ? ` · dedupe ${job.dedupeKey}` : ''}
                  </p>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={job.status === 'succeeded' ? 'positive' : job.status === 'failed' || job.status === 'dead' ? 'critical' : job.status === 'running' ? 'info' : 'neutral'}>
                    {job.status}
                  </Badge>
                </td>
                <td className="tabular px-3 py-2 text-xs">
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td className="px-3 py-2 text-[11px] text-ink-500">{relativeTime(job.runAt)}</td>
                <td className="tabular px-3 py-2 text-xs">{job.durationMs ? `${(job.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                <td className="max-w-sm px-3 py-2 text-[11px] text-signal-critical">{job.lastError ?? '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1.5">
                    {job.status === 'failed' || job.status === 'dead' ? (
                      <Button size="sm" variant="secondary" loading={pending === `retry-${job.id}`} onClick={() => void act(job.id, 'retry')}>
                        <RotateCcw className="h-3.5 w-3.5" />
                        Retry
                      </Button>
                    ) : null}
                    {job.status === 'queued' || job.status === 'running' ? (
                      <Button size="sm" variant="ghost" loading={pending === `cancel-${job.id}`} onClick={() => void act(job.id, 'cancel')}>
                        <XCircle className="h-3.5 w-3.5" />
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}

export { Play, Textarea, formatMoney }
