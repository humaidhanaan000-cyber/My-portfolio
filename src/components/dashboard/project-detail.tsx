'use client'
/**
 * Project workspace: tasks, generated assets, approvals, metrics, events and the
 * launch control. Publishing and launching are approval-gated server-side; this
 * screen only reflects what the server allowed.
 */
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Download, FileText, Play, Pause, Rocket, ShieldCheck, Trash2 } from 'lucide-react'
import { Badge, Button, Card, CardHeader, DemoBadge, EmptyState, ErrorNote, KeyValue, ProgressBar, Tabs, Table, Textarea, Field, Input } from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { formatDate, formatMoney, formatNumber, relativeTime } from '@/lib/client/format'

type Detail = {
  project: {
    id: string
    name: string
    slug: string
    objective: string
    status: string
    progress: number
    businessModel: string
    revenueModel: string
    costModel: string | null
    automationLevel: string
    budgetCents: number
    spentCents: number
    revenueCents: number
    profitCents: number
    metrics: Record<string, number> | null
    launchedAt: string | null
    pausedAt: string | null
    completedAt: string | null
    failureReason: string | null
    demo: boolean
    createdAt: string
    updatedAt: string
    opportunityId: string | null
  }
  tasks: {
    id: string
    title: string
    description: string
    status: string
    priority: number
    assigneeAgentKey: string | null
    requiresApproval: boolean
    estimatedCostCents: number
    actualCostCents: number
    attempts: number
    lastError: string | null
    result: Record<string, unknown> | null
    finishedAt: string | null
  }[]
  revenue: { grossCents: number; netCents: number; count: number }
  expenses: { totalCents: number; byCategory: { category: string; cents: number }[] }
  metrics: { visitors: number; conversions: number; conversionRate: number; revenueSeries: { date: string; revenueCents: number; expensesCents: number }[] }
  approvals: { id: string; title: string; status: string; risk: string; createdAt: string }[]
  events: { id: string; type: string; message: string; actor: string; createdAt: string }[]
  agents: { agentKey: string; runs: number; failures: number; costCents: number }[]
}

type Asset = {
  id: string
  type: string
  title: string
  summary: string
  body: string
  status: string
  version: number
  publishedUrl: string | null
  publishedAt: string | null
  engine: string
  createdAt: string
  compliance: { ok: boolean; violations: string[]; warnings: string[] }
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'assets', label: 'Assets' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'metrics', label: 'Metrics' },
  { key: 'events', label: 'Events' },
]

export function ProjectDetailView({ id }: { id: string }) {
  const router = useRouter()
  const [tab, setTab] = useState('overview')
  const detail = useApi<Detail>(`/api/projects/${id}`, { pollMs: 30_000 })
  const assets = useApi<Asset[]>(`/api/projects/${id}/assets`)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [taskDraft, setTaskDraft] = useState({ title: '', description: '', priority: 3 })
  const [assetDraft, setAssetDraft] = useState({ type: 'landing_page', title: '', brief: '' })

  async function call(path: string, body: unknown, label: string, message: string) {
    setPending(label)
    setError(null)
    setNotice(null)
    try {
      await api.post(path, body)
      setNotice(message)
      await detail.refresh()
      await assets.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The action failed.')
    } finally {
      setPending(null)
    }
  }

  if (detail.error && !detail.data) return <ErrorNote message={detail.error} onRetry={() => void detail.refresh()} />
  if (!detail.data) return <div className="surface h-96 animate-pulse bg-white/60" />

  const { project, tasks, expenses, metrics, approvals, events, agents } = detail.data
  const budgetPct = project.budgetCents > 0 ? (project.spentCents / project.budgetCents) * 100 : 0

  async function exportMarkdown() {
    setPending('export')
    setError(null)
    try {
      const result = await api.get<{ markdown: string; assetCount: number }>(`/api/projects/${id}/export`)
      const blob = new Blob([result.data.markdown], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${project.slug || project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-assets.md`
      anchor.click()
      URL.revokeObjectURL(url)
      setNotice(`Exported ${result.data.assetCount} assets as Markdown.`)
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Export failed.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-5">
      <button type="button" onClick={() => router.push('/dashboard/projects')} className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-3.5 w-3.5" />
        All projects
      </button>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-ink-900">{project.name}</h1>
            {project.demo ? <DemoBadge /> : null}
            <Badge tone={project.status === 'LAUNCHED' || project.status === 'MONITORING' ? 'positive' : project.status === 'FAILED' ? 'critical' : 'info'}>
              {project.status.toLowerCase()}
            </Badge>
            <Badge tone="neutral">automation: {project.automationLevel.replace(/_/g, ' ')}</Badge>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-600">{project.objective}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={pending === 'export'} onClick={() => void exportMarkdown()}>
            <Download className="h-3.5 w-3.5" />
            Export assets
          </Button>
          {project.status === 'PAUSED' ? (
            <Button
              size="sm"
              variant="secondary"
              loading={pending === 'resume'}
              onClick={() => void call(`/api/projects/${id}`, { status: 'BUILDING' }, 'resume', 'Project resumed.')}
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={pending === 'pause'}
              onClick={() => void call(`/api/projects/${id}`, { status: 'PAUSED' }, 'pause', 'Project paused. No further automated steps will run until you resume.')}
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </Button>
          )}
          <Button
            size="sm"
            variant="success"
            loading={pending === 'launch'}
            onClick={() => void call(`/api/projects/${id}/launch`, {}, 'launch', 'Project launched. The monitoring agent will now track its metrics.')}
          >
            <Rocket className="h-3.5 w-3.5" />
            Launch
          </Button>
        </div>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStat label="Progress" value={`${project.progress}%`} hint="from completed tasks" />
        <MiniStat label="Spent" value={formatMoney(project.spentCents)} hint={`of ${formatMoney(project.budgetCents)} budget`} />
        <MiniStat label="Revenue" value={formatMoney(project.revenueCents)} hint={`${detail.data.revenue.count} verified transactions`} />
        <MiniStat label="Net" value={formatMoney(project.profitCents)} hint="revenue minus recorded costs" tone={project.profitCents >= 0 ? 'positive' : 'critical'} />
      </div>

      <Tabs tabs={TABS.map((entry) => ({ ...entry, count: entry.key === 'tasks' ? tasks.length : entry.key === 'assets' ? (assets.data?.length ?? 0) : entry.key === 'approvals' ? approvals.length : undefined }))} active={tab} onChange={setTab} />

      {tab === 'overview' ? (
        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <Card>
              <CardHeader title="Budget consumption" subtitle="Costs recorded against this project" />
              <ProgressBar
                value={budgetPct}
                tone={budgetPct > 90 ? 'critical' : budgetPct > 70 ? 'warning' : 'positive'}
                label={`${formatMoney(project.spentCents)} of ${formatMoney(project.budgetCents)}`}
              />
              <div className="mt-4">
                <p className="text-[11px] text-ink-500">Costs by category</p>
                {expenses.byCategory.length === 0 ? (
                  <p className="mt-1 text-[11px] text-ink-500">No expenses recorded yet.</p>
                ) : (
                  <ul className="mt-2 space-y-1 text-[11px]">
                    {expenses.byCategory.map((entry) => (
                      <li key={entry.category} className="flex items-center justify-between">
                        <span className="text-ink-600 capitalize">{entry.category.replace(/_/g, ' ')}</span>
                        <span className="tabular text-ink-800">{formatMoney(entry.cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Agent involvement" subtitle="Runs, failures and spend per agent on this project" />
              {agents.length === 0 ? (
                <p className="text-xs text-ink-500">No agent runs recorded against this project yet.</p>
              ) : (
                <Table headers={['Agent', 'Runs', 'Failures', 'Cost']}>
                  {agents.map((agent) => (
                    <tr key={agent.agentKey}>
                      <td className="px-3 py-2 text-xs capitalize">{agent.agentKey}</td>
                      <td className="tabular px-3 py-2 text-xs">{agent.runs}</td>
                      <td className="tabular px-3 py-2 text-xs">{agent.failures}</td>
                      <td className="tabular px-3 py-2 text-xs">{formatMoney(agent.costCents)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader title="Definition" />
              <KeyValue
                items={[
                  { label: 'Business model', value: project.businessModel || '—' },
                  { label: 'Revenue model', value: project.revenueModel || '—' },
                  { label: 'Cost model', value: project.costModel ?? '—' },
                  { label: 'Created', value: formatDate(project.createdAt) },
                  { label: 'Launched', value: project.launchedAt ? formatDate(project.launchedAt) : 'not launched' },
                  { label: 'Last update', value: relativeTime(project.updatedAt) },
                  { label: 'Opportunity', value: project.opportunityId ? <Link href={`/dashboard/opportunities/${project.opportunityId}`} className="text-accent-700 hover:underline">view source</Link> : '—' },
                ]}
              />
            </Card>

            {project.failureReason ? (
              <Card>
                <CardHeader title="Failure reason" subtitle="Recorded when the project was marked failed" />
                <p className="text-xs text-signal-critical">{project.failureReason}</p>
              </Card>
            ) : null}

            <Card>
              <CardHeader title="Add a task" subtitle="Tasks are the unit of work the agents pick up" />
              <div className="space-y-3">
                <Field label="Title">
                  <Input value={taskDraft.title} onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} placeholder="Draft pricing page copy" />
                </Field>
                <Field label="Description">
                  <Textarea value={taskDraft.description} onChange={(event) => setTaskDraft({ ...taskDraft, description: event.target.value })} />
                </Field>
                <Field label="Priority" hint="1 = highest">
                  <Input type="number" min={1} max={5} value={taskDraft.priority} onChange={(event) => setTaskDraft({ ...taskDraft, priority: Number(event.target.value) })} />
                </Field>
                <Button
                  size="sm"
                  loading={pending === 'task'}
                  disabled={taskDraft.title.length < 3}
                  onClick={() =>
                    void call(
                      `/api/projects/${id}/tasks`,
                      { title: taskDraft.title, description: taskDraft.description, priority: taskDraft.priority },
                      'task',
                      'Task added. The execution agent will pick it up on its next run.',
                    ).then(() => setTaskDraft({ title: '', description: '', priority: 3 }))
                  }
                >
                  Add task
                </Button>
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === 'tasks' ? (
        <Card className="p-0">
          {tasks.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No tasks" description="Tasks are created by the strategy agent when a project is set up, or added by you on the overview tab." />
            </div>
          ) : (
            <Table headers={['Task', 'Status', 'Priority', 'Agent', 'Cost', 'Approval', 'Finished']}>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td className="px-3 py-2">
                    <p className="text-xs font-medium text-ink-900">{task.title}</p>
                    <p className="text-[11px] text-ink-500">{task.description}</p>
                    {task.lastError ? <p className="mt-1 text-[11px] text-signal-critical">Last error: {task.lastError}</p> : null}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={task.status === 'done' ? 'positive' : task.status === 'failed' || task.status === 'blocked' ? 'critical' : task.status === 'in_progress' ? 'info' : 'neutral'}>
                      {task.status.replace(/_/g, ' ')}
                    </Badge>
                    {task.attempts > 1 ? <p className="mt-0.5 text-[10px] text-ink-400">{task.attempts} attempts</p> : null}
                  </td>
                  <td className="tabular px-3 py-2 text-xs">{task.priority}</td>
                  <td className="px-3 py-2 text-xs capitalize">{task.assigneeAgentKey ?? 'unassigned'}</td>
                  <td className="tabular px-3 py-2 text-xs">{formatMoney(task.actualCostCents || task.estimatedCostCents)}</td>
                  <td className="px-3 py-2 text-xs">{task.requiresApproval ? <Badge tone="warning">required</Badge> : '—'}</td>
                  <td className="px-3 py-2 text-[11px] text-ink-500">{task.finishedAt ? relativeTime(task.finishedAt) : '—'}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : null}

      {tab === 'assets' ? (
        <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
          <Card className="p-0">
            {(assets.data ?? []).length === 0 ? (
              <div className="p-5">
                <EmptyState title="No assets" description="The product and content agents generate drafts here. Drafts are never published automatically." icon={<FileText className="h-6 w-6" />} />
              </div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {(assets.data ?? []).map((asset) => (
                  <li key={asset.id} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-semibold text-ink-900">
                          {asset.title} <span className="font-normal text-ink-400">v{asset.version}</span>
                        </p>
                        <p className="text-[11px] text-ink-500">
                          {asset.type.replace(/_/g, ' ')} · {asset.engine} · created {relativeTime(asset.createdAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {asset.compliance.violations.length ? <Badge tone="critical">policy: {asset.compliance.violations.length} issue(s)</Badge> : null}
                        <Badge tone={asset.status === 'published' ? 'positive' : 'neutral'}>{asset.status}</Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={pending === `asset-${asset.id}`}
                          onClick={() =>
                            void api
                              .delete(`/api/projects/${id}/assets?assetId=${asset.id}`)
                              .then(() => {
                                setNotice('Asset archived. It is retained for audit and can be restored from the database.')
                                return assets.refresh()
                              })
                              .catch((caught) => setError(caught instanceof ApiClientError ? caught.message : 'Could not archive the asset.'))
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-600">{asset.summary}</p>
                    {asset.compliance.violations.length || asset.compliance.warnings.length ? (
                      <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-800">
                        {asset.compliance.violations.map((entry, index) => (
                          <p key={`v${index}`}>Blocked pattern: {entry}</p>
                        ))}
                        {asset.compliance.warnings.map((entry, index) => (
                          <p key={`w${index}`}>Warning: {entry}</p>
                        ))}
                      </div>
                    ) : null}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-medium text-ink-500 hover:text-ink-800">View draft body</summary>
                      <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-ink-50 p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-700">{asset.body}</pre>
                    </details>
                    {asset.publishedUrl ? (
                      <p className="mt-2 text-[11px]">
                        Published: <span className="font-mono break-all">{asset.publishedUrl}</span>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Generate an asset" subtitle="Content is drafted locally, screened against the policy engine, and left unpublished" icon={<ShieldCheck className="h-4 w-4" />} />
            <div className="space-y-3">
              <Field label="Asset type">
                <select
                  className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                  value={assetDraft.type}
                  onChange={(event) => setAssetDraft({ ...assetDraft, type: event.target.value })}
                >
                  {['landing_page', 'product_spec', 'faq', 'documentation', 'onboarding', 'marketing', 'seo_metadata', 'blog_post', 'social_post', 'email_draft', 'ad_copy', 'product_description', 'video_script'].map((type) => (
                    <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </Field>
              <Field label="Title">
                <Input value={assetDraft.title} onChange={(event) => setAssetDraft({ ...assetDraft, title: event.target.value })} placeholder="Pricing page draft" />
              </Field>
              <Field label="Brief" hint="What should this asset say or do?">
                <Textarea value={assetDraft.brief} onChange={(event) => setAssetDraft({ ...assetDraft, brief: event.target.value })} placeholder="Explain the three plans and what each includes…" />
              </Field>
              <Button
                size="sm"
                loading={pending === 'asset'}
                disabled={assetDraft.title.length < 3}
                onClick={() =>
                  void call(`/api/projects/${id}/assets`, { type: assetDraft.type, title: assetDraft.title, brief: assetDraft.brief }, 'asset', 'Draft generated and screened. It stays unpublished until you approve publishing.').then(
                    () => setAssetDraft({ type: 'landing_page', title: '', brief: '' }),
                  )
                }
              >
                Generate draft
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'approvals' ? (
        <Card className="p-0">
          {approvals.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No approvals for this project" description="Anything public, paid or irreversible connected to this project will appear here." />
            </div>
          ) : (
            <Table headers={['Request', 'Status', 'Risk', 'Raised']}>
              {approvals.map((approval) => (
                <tr key={approval.id}>
                  <td className="px-3 py-2 text-xs">{approval.title}</td>
                  <td className="px-3 py-2"><Badge tone={approval.status === 'executed' ? 'positive' : approval.status === 'pending' ? 'warning' : 'neutral'}>{approval.status}</Badge></td>
                  <td className="px-3 py-2 text-xs capitalize">{approval.risk}</td>
                  <td className="px-3 py-2 text-[11px] text-ink-500">{relativeTime(approval.createdAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : null}

      {tab === 'metrics' ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <MiniStat label="Visitors (30d)" value={formatNumber(metrics.visitors)} hint="from recorded analytics events" />
          <MiniStat label="Conversions (30d)" value={formatNumber(metrics.conversions)} hint={`${metrics.conversionRate.toFixed(2)}% conversion rate`} />
          <MiniStat label="Revenue series" value={`${metrics.revenueSeries.length} days`} hint="daily net revenue and expenses" />
          <Card className="lg:col-span-3">
            <CardHeader title="Daily revenue and expenses" subtitle="Only recorded transactions appear here" />
            {metrics.revenueSeries.length === 0 ? (
              <p className="text-xs text-ink-500">No transactions recorded for this project yet.</p>
            ) : (
              <Table headers={['Date', 'Revenue', 'Expenses', 'Net']}>
                {metrics.revenueSeries.map((point) => (
                  <tr key={point.date}>
                    <td className="px-3 py-2 text-xs">{point.date}</td>
                    <td className="tabular px-3 py-2 text-xs">{formatMoney(point.revenueCents)}</td>
                    <td className="tabular px-3 py-2 text-xs">{formatMoney(point.expensesCents)}</td>
                    <td className={`tabular px-3 py-2 text-xs font-medium ${point.revenueCents - point.expensesCents >= 0 ? 'text-signal-positive' : 'text-signal-critical'}`}>
                      {formatMoney(point.revenueCents - point.expensesCents)}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      ) : null}

      {tab === 'events' ? (
        <Card className="p-0">
          {events.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No events" description="State transitions, launches and agent activity are all written here." />
            </div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {events.map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-xs font-medium text-ink-800">{event.message}</p>
                    <p className="text-[11px] text-ink-500">
                      {event.type.replace(/_/g, ' ')} · by {event.actor}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-ink-400">{relativeTime(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </div>
  )
}

function MiniStat({ label, value, hint, tone = 'neutral' }: { label: string; value: string; hint?: string; tone?: 'neutral' | 'positive' | 'critical' }) {
  return (
    <div className="surface p-4">
      <p className="text-[11px] font-medium tracking-wide text-ink-500 uppercase">{label}</p>
      <p className={`tabular mt-1.5 text-lg font-semibold ${tone === 'positive' ? 'text-signal-positive' : tone === 'critical' ? 'text-signal-critical' : 'text-ink-900'}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-ink-500">{hint}</p> : null}
    </div>
  )
}
