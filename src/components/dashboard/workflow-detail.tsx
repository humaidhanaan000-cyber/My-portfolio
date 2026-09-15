'use client'
/**
 * Single-workflow view: execution order, run history with per-step results, and
 * the controls an operator needs (run now, pause, reschedule, rename, archive).
 *
 * Everything on this screen maps to a real API call — the run button executes
 * the same engine the worker uses when the schedule fires.
 */
import { Fragment, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, Pause, Play, RefreshCw, Save, Trash2, Zap } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CopyButton,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  KeyValue,
  Select,
  Skeleton,
  Table,
  Textarea,
} from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { formatDate, relativeTime } from '@/lib/client/format'

type StepResult = {
  nodeId: string
  type: string
  label: string
  status: 'succeeded' | 'failed' | 'skipped' | 'awaiting_approval'
  summary?: string
  error?: string
  durationMs: number
  approvalId?: string
  costCents?: number
}

type WorkflowNode = {
  id: string
  type: string
  label: string
  config?: Record<string, unknown>
  dependsOn?: string[]
  continueOnError?: boolean
}

type Workflow = {
  id: string
  name: string
  description: string
  definition: { nodes: WorkflowNode[]; edges?: { from: string; to: string }[] }
  schedule: string | null
  scheduleTimezone: string | null
  scheduleDescription: string | null
  status: string
  enabled: boolean
  isTemplate: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  runCount: number
  createdAt: string
  updatedAt: string
}

type Run = {
  id: string
  status: string
  trigger: string
  steps: StepResult[]
  error: string | null
  attempt: number
  startedAt: string
  finishedAt: string | null
  durationMs: number
}

type Payload = { workflow: Workflow; runs: Run[] }

type Tone = 'neutral' | 'positive' | 'warning' | 'critical' | 'info' | 'demo'

const SCHEDULE_PRESETS = [
  { label: 'Manual only (no schedule)', cron: '' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 07:00', cron: '0 7 * * *' },
  { label: 'Weekly (Monday 07:00)', cron: '0 7 * * 1' },
]

function statusTone(status: string): Tone {
  if (status === 'succeeded' || status === 'active') return 'positive'
  if (status === 'failed' || status === 'archived') return 'critical'
  if (status === 'awaiting_approval' || status === 'partial' || status === 'paused') return 'warning'
  if (status === 'running') return 'info'
  return 'neutral'
}

/** Execution order: explicit dependencies first, then the order nodes were added. */
function executionOrder(nodes: WorkflowNode[]): { order: WorkflowNode[]; error?: string } {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const order: WorkflowNode[] = []
  let error: string | undefined

  const visit = (node: WorkflowNode) => {
    if (visited.has(node.id) || error) return
    if (visiting.has(node.id)) {
      error = `Circular dependency detected at ${node.label} (${node.id}).`
      return
    }
    visiting.add(node.id)
    for (const dependency of node.dependsOn ?? []) {
      const parent = byId.get(dependency)
      if (parent) visit(parent)
    }
    visiting.delete(node.id)
    visited.add(node.id)
    order.push(node)
  }

  for (const node of nodes) visit(node)
  return { order, error }
}

export function WorkflowDetailView({ id }: { id: string }) {
  const detail = useApi<Payload>(`/api/workflows/${id}`, { pollMs: 15_000 })
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [schedule, setSchedule] = useState<string | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [description, setDescription] = useState<string | null>(null)

  const workflow = detail.data?.workflow
  const runs = detail.data?.runs ?? []
  const nodes = workflow?.definition?.nodes ?? []
  const order = executionOrder(nodes)
  const scheduleValue = schedule ?? workflow?.schedule ?? ''
  const nameValue = name ?? workflow?.name ?? ''
  const descriptionValue = description ?? workflow?.description ?? ''
  const presetValue = SCHEDULE_PRESETS.some((preset) => preset.cron === scheduleValue) ? scheduleValue : '__custom'

  async function act(key: string, action: () => Promise<void>) {
    setPending(key)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The action could not be completed.')
    } finally {
      setPending(null)
    }
  }

  function runNow() {
    return act('run', async () => {
      const result = await api.put<{ runId: string; status: string; steps: StepResult[] }>('/api/workflows', {
        workflowId: id,
        async: false,
        dryRun: false,
      })
      const failed = result.data.steps.filter((step) => step.status === 'failed').length
      const approvals = result.data.steps.filter((step) => step.status === 'awaiting_approval').length
      setNotice(
        `Run ${result.data.status}: ${result.data.steps.length} steps${failed ? `, ${failed} failed` : ''}${
          approvals ? `, ${approvals} stopped at an approval gate` : ''
        }.`,
      )
      await detail.refresh()
    })
  }

  function toggleEnabled() {
    if (!workflow) return
    return act('toggle', async () => {
      await api.patch(`/api/workflows/${id}`, { status: workflow.enabled ? 'paused' : 'active' })
      setNotice(workflow.enabled ? 'Workflow paused. Scheduled runs will not start until you resume it.' : 'Workflow resumed.')
      await detail.refresh()
    })
  }

  function saveSchedule() {
    return act('schedule', async () => {
      await api.patch(`/api/workflows/${id}`, { schedule: scheduleValue.trim() === '' ? null : scheduleValue.trim() })
      setSchedule(null)
      setNotice('Schedule saved. The scheduler picks it up on its next sweep.')
      await detail.refresh()
    })
  }

  function saveDetails() {
    return act('details', async () => {
      await api.patch(`/api/workflows/${id}`, { name: nameValue.trim(), description: descriptionValue.trim() })
      setName(null)
      setDescription(null)
      setNotice('Workflow details saved.')
      await detail.refresh()
    })
  }

  function archive() {
    return act('archive', async () => {
      await api.delete(`/api/workflows/${id}`)
      setNotice('Workflow archived. Its run history is retained for audit.')
      await detail.refresh()
    })
  }

  if (detail.loading && !workflow) return <Skeleton className="h-64 w-full" />
  if (detail.error && !workflow) return <ErrorNote message={detail.error} onRetry={() => void detail.refresh()} />
  if (!workflow) {
    return (
      <EmptyState
        icon={<Zap className="h-5 w-5" />}
        title="Workflow not found"
        description="This workflow either belongs to another workspace or has been removed."
        action={
          <Link href="/dashboard/workflows">
            <Button variant="secondary">Back to workflows</Button>
          </Link>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Link href="/dashboard/workflows" className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-800">
            <ArrowLeft className="h-3.5 w-3.5" /> Workflows
          </Link>
          <h1 className="text-xl font-semibold text-ink-900">{workflow.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
            <Badge tone={statusTone(workflow.status)}>{workflow.status}</Badge>
            <Badge tone={workflow.enabled ? 'positive' : 'neutral'}>{workflow.enabled ? 'scheduled' : 'paused'}</Badge>
            {workflow.isTemplate ? <Badge tone="info">template</Badge> : null}
            <span>{workflow.scheduleDescription ?? 'No schedule — manual or API runs only'}</span>
            <span>· {nodes.length} nodes</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void runNow()} loading={pending === 'run'}>
            <Play className="h-3.5 w-3.5" />
            Run now
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void toggleEnabled()} loading={pending === 'toggle'}>
            {workflow.enabled ? <Pause className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {workflow.enabled ? 'Pause' : 'Resume'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void archive()} loading={pending === 'archive'}>
            <Trash2 className="h-3.5 w-3.5" />
            Archive
          </Button>
        </div>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}
      {order.error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5" />
          <span>{order.error} The worker refuses to execute a cyclic graph — fix the definition before enabling it.</span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Execution order" subtitle="Dependencies run first; every step is recorded against the run." />
          {nodes.length === 0 ? (
            <EmptyState title="No nodes" description="This workflow has an empty definition. Recreate it from a template to add steps." />
          ) : (
            <ol className="space-y-2">
              {order.order.map((node, index) => (
                <li key={node.id} className="rounded-lg border border-ink-200 bg-ink-50/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink-800">
                        <span className="mr-2 text-xs text-ink-400">{index + 1}.</span>
                        {node.label}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {node.type} · {node.id}
                        {node.dependsOn?.length ? ` · after ${node.dependsOn.join(', ')}` : ''}
                      </p>
                    </div>
                    {node.continueOnError ? <Badge tone="warning">continues on error</Badge> : null}
                  </div>
                  {node.config && Object.keys(node.config).length > 0 ? (
                    <pre className="mt-2 max-h-32 overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed text-ink-500">
                      {JSON.stringify(node.config, null, 2)}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Schedule" subtitle="Five-field cron, evaluated by the scheduler process." />
            <div className="space-y-3">
              <Field label="Preset">
                <Select value={presetValue} onChange={(event) => setSchedule(event.target.value === '__custom' ? scheduleValue : event.target.value)}>
                  {SCHEDULE_PRESETS.map((preset) => (
                    <option key={preset.label} value={preset.cron}>
                      {preset.label}
                    </option>
                  ))}
                  <option value="__custom">Custom cron…</option>
                </Select>
              </Field>
              <Field label="Cron expression" hint="Example: 0 */6 * * * runs every six hours.">
                <Input value={scheduleValue} onChange={(event) => setSchedule(event.target.value)} placeholder="0 7 * * *" />
              </Field>
              <Button size="sm" onClick={() => void saveSchedule()} loading={pending === 'schedule'}>
                <Save className="h-3.5 w-3.5" />
                Save schedule
              </Button>
              <KeyValue
                items={[
                  { label: 'Next run', value: workflow.nextRunAt ? formatDate(workflow.nextRunAt) : '—' },
                  { label: 'Last run', value: workflow.lastRunAt ? relativeTime(workflow.lastRunAt) : 'never' },
                  { label: 'Total runs', value: workflow.runCount },
                  { label: 'Timezone', value: workflow.scheduleTimezone ?? 'UTC' },
                ]}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="Details" />
            <div className="space-y-3">
              <Field label="Name">
                <Input value={nameValue} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="Description">
                <Textarea rows={3} value={descriptionValue} onChange={(event) => setDescription(event.target.value)} />
              </Field>
              <Button size="sm" onClick={() => void saveDetails()} loading={pending === 'details'}>
                <Save className="h-3.5 w-3.5" />
                Save details
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Definition"
              subtitle="The stored graph, exactly as the engine reads it."
              action={<CopyButton value={JSON.stringify(workflow.definition, null, 2)} />}
            />
            <pre className="max-h-72 overflow-auto rounded bg-ink-50 p-2 text-[11px] leading-relaxed text-ink-500">
              {JSON.stringify(workflow.definition, null, 2)}
            </pre>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader
          title="Run history"
          subtitle="Each run records its steps, trigger, duration and result — including runs that stopped at an approval gate."
          action={
            <Button size="sm" variant="ghost" onClick={() => void detail.refresh()} loading={detail.loading}>
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          }
        />
        {runs.length === 0 ? (
          <EmptyState title="No runs yet" description="Run the workflow now, or wait for the scheduler to trigger it." />
        ) : (
          <Table headers={['Started', 'Trigger', 'Status', 'Steps', 'Duration', '']}>
            {runs.map((run) => {
              const failed = run.steps.filter((step) => step.status === 'failed').length
              const approvals = run.steps.filter((step) => step.status === 'awaiting_approval').length
              const expanded = openRun === run.id
              return (
                <Fragment key={run.id}>
                  <tr className="border-t border-ink-200">
                    <td className="px-4 py-3 text-sm text-ink-700">
                      {formatDate(run.startedAt)}
                      <span className="ml-2 text-xs text-ink-400">{relativeTime(run.startedAt)}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-500">{run.trigger}</td>
                    <td className="px-4 py-3">
                      <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-500">
                      {run.steps.length}
                      {failed ? <span className="ml-1 text-red-600">({failed} failed)</span> : null}
                      {approvals ? <span className="ml-1 text-amber-700">({approvals} awaiting approval)</span> : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-500">{run.durationMs ? `${run.durationMs} ms` : '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setOpenRun(expanded ? null : run.id)}>
                        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        {expanded ? 'Hide' : 'Steps'}
                      </Button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="border-t border-ink-200 bg-ink-50/60">
                      <td colSpan={6} className="px-4 py-3">
                        {run.error ? <p className="mb-2 text-xs text-red-700">{run.error}</p> : null}
                        <ul className="space-y-1">
                          {run.steps.map((step) => (
                            <li key={`${run.id}-${step.nodeId}`} className="flex flex-wrap items-center gap-2 text-xs">
                              <Badge tone={statusTone(step.status)}>{step.status}</Badge>
                              <span className="text-ink-700">{step.label}</span>
                              <span className="text-ink-400">{step.type}</span>
                              {step.summary ? <span className="text-ink-500">— {step.summary}</span> : null}
                              {step.error ? <span className="text-red-700">— {step.error}</span> : null}
                              {step.costCents ? <span className="text-ink-400">{step.costCents}¢</span> : null}
                              {step.approvalId ? (
                                <Link href="/dashboard/approvals" className="text-amber-700 hover:underline">
                                  approval required
                                </Link>
                              ) : null}
                              <span className="text-ink-300">{step.durationMs} ms</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </Table>
        )}
      </Card>
    </div>
  )
}
