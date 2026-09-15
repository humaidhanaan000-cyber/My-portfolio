'use client'
/**
 * Workflow studio.
 *
 * The builder creates a real workflow row with a node graph and an optional cron
 * schedule. Runs execute through the same engine the worker uses, so what you
 * test here is what runs unattended.
 */
import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, Play, Plus, Save, Trash2, Zap } from 'lucide-react'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, Modal, Select, Table, Textarea } from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { relativeTime } from '@/lib/client/format'

type NodeDef = { id: string; type: string; label: string; config: Record<string, unknown>; dependsOn?: string[]; continueOnError?: boolean }
type WorkflowDefinition = { nodes: NodeDef[]; edges: { from: string; to: string }[] }

type WorkflowRow = {
  id: string
  name: string
  description: string
  definition: WorkflowDefinition
  schedule: string | null
  scheduleTimezone: string | null
  status: string
  enabled: boolean
  isTemplate: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  runCount: number
  updatedAt: string
  nodeCount: number
  edgeCount: number
  nodeTypes: string[]
  scheduleDescription: string | null
}

type RunRow = {
  id: string
  workflowId: string | null
  status: string
  trigger: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  steps: unknown
  error: string | null
}

type Payload = {
  workflows: WorkflowRow[]
  runs: RunRow[]
  schedules: { id: string; key: string; name: string; jobName: string; cron: string; description: string; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; system: boolean }[]
  templates: { key: string; name: string; description: string; schedule: string | null; nodeCount: number; definition: WorkflowDefinition }[]
  nodeCatalog: { kind: string; description: string }[]
}

const SCHEDULE_PRESETS = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 07:00', cron: '0 7 * * *' },
  { label: 'Weekly (Monday 07:00)', cron: '0 7 * * 1' },
]

export function WorkflowStudio() {
  const studio = useApi<Payload>('/api/workflows', { pollMs: 30_000 })
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  async function run(workflow: WorkflowRow) {
    setPending(`run-${workflow.id}`)
    setError(null)
    setNotice(null)
    try {
      const result = await api.put<{ status: string; steps: { nodeId: string; type: string; status: string; message?: string }[]; runId: string }>('/api/workflows', {
        workflowId: workflow.id,
        async: false,
        dryRun: false,
      })
      const failed = result.data.steps.filter((step) => step.status === 'failed').length
      setNotice(
        `Run ${result.data.status}: ${result.data.steps.length} steps${failed ? `, ${failed} failed` : ''}.` +
          (result.data.status === 'awaiting_approval' ? ' The run stopped at an approval gate — check the approval center.' : ''),
      )
      await studio.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The run could not be completed.')
    } finally {
      setPending(null)
    }
  }

  async function toggle(workflow: WorkflowRow) {
    setPending(`toggle-${workflow.id}`)
    setError(null)
    try {
      await api.patch(`/api/workflows/${workflow.id}`, { status: workflow.enabled ? 'paused' : 'active' })
      setNotice(`${workflow.name} ${workflow.enabled ? 'paused' : 'enabled'}.`)
      await studio.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The change could not be saved.')
    } finally {
      setPending(null)
    }
  }

  async function archive(workflow: WorkflowRow) {
    setPending(`archive-${workflow.id}`)
    setError(null)
    try {
      await api.delete(`/api/workflows/${workflow.id}`)
      setNotice(`${workflow.name} archived. Existing runs are retained for audit.`)
      await studio.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The workflow could not be archived.')
    } finally {
      setPending(null)
    }
  }

  const workflows = studio.data?.workflows ?? []
  const runs = studio.data?.runs ?? []
  const schedules = studio.data?.schedules ?? []
  const templates = studio.data?.templates ?? []
  const catalog = studio.data?.nodeCatalog ?? []

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Workflows</h1>
          <p className="mt-1 text-sm text-ink-500">
            Chain agents into a repeatable pipeline and schedule it. Runs execute through the same engine the worker process uses.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" />
          New workflow
        </Button>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      {studio.loading && !studio.data ? <Skeleton /> : null}
      {studio.error ? <ErrorNote message={studio.error} onRetry={() => void studio.refresh()} /> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Definitions" subtitle={`${workflows.length} workflow(s) in this workspace`} />
            {workflows.length === 0 ? (
              <EmptyState
                icon={<Zap className="h-5 w-5" />}
                title="No workflows yet"
                description="Start from a template: discovery → scoring → strategy, or the full build pipeline."
                action={<Button size="sm" onClick={() => setCreating(true)}>Create from template</Button>}
              />
            ) : (
              <Table headers={['Workflow', 'Schedule', 'Nodes', 'Last run', 'Status', '']}>
                {workflows.map((workflow) => (
                  <tr key={workflow.id} className="border-t border-ink-200">
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/workflows/${workflow.id}`} className="text-sm font-medium text-ink-900 hover:text-accent-700">
                        {workflow.name}
                      </Link>
                      <p className="mt-0.5 line-clamp-1 text-xs text-ink-500">{workflow.description || 'No description'}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-500">
                      {workflow.scheduleDescription ?? 'manual only'}
                      {workflow.nextRunAt ? <div className="text-ink-400">next {relativeTime(workflow.nextRunAt)}</div> : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-500">
                      {workflow.nodeCount} nodes
                      <div className="text-ink-400">{workflow.nodeTypes.join(', ')}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-500">
                      {workflow.lastRunAt ? relativeTime(workflow.lastRunAt) : 'never'}
                      {workflow.lastStatus ? <div className="text-ink-400">{workflow.lastStatus}</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={workflow.status === 'active' ? 'positive' : workflow.status === 'paused' ? 'warning' : 'neutral'}>{workflow.status}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button size="sm" variant="secondary" loading={pending === `run-${workflow.id}`} onClick={() => void run(workflow)}>
                          <Play className="h-3.5 w-3.5" />
                          Run
                        </Button>
                        <Button size="sm" variant="ghost" loading={pending === `toggle-${workflow.id}`} onClick={() => void toggle(workflow)}>
                          {workflow.enabled ? 'Pause' : 'Enable'}
                        </Button>
                        <Button size="sm" variant="ghost" loading={pending === `archive-${workflow.id}`} onClick={() => void archive(workflow)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="Recent runs" subtitle="Every execution is recorded with its steps and outcome." />
            {runs.length === 0 ? (
              <EmptyState title="No runs recorded" description="Run a workflow manually or wait for its schedule to fire." />
            ) : (
              <Table headers={['Workflow', 'Trigger', 'Started', 'Duration', 'Status']}>
                {runs.map((entry) => {
                  const workflow = workflows.find((item) => item.id === entry.workflowId)
                  const steps = Array.isArray(entry.steps) ? (entry.steps as { status: string }[]) : []
                  const failed = steps.filter((step) => step.status === 'failed').length
                  return (
                    <tr key={entry.id} className="border-t border-ink-200">
                      <td className="px-4 py-3 text-sm text-ink-700">
                        {workflow ? (
                          <Link href={`/dashboard/workflows/${workflow.id}`} className="hover:text-accent-700">
                            {workflow.name}
                          </Link>
                        ) : (
                          'ad-hoc'
                        )}
                        <span className="ml-2 text-xs text-ink-400">{steps.length} steps</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-ink-500">{entry.trigger}</td>
                      <td className="px-4 py-3 text-xs text-ink-500">{relativeTime(entry.startedAt)}</td>
                      <td className="px-4 py-3 text-xs text-ink-500">{entry.durationMs ? `${entry.durationMs} ms` : '—'}</td>
                      <td className="px-4 py-3">
                        <Badge
                          tone={
                            entry.status === 'succeeded'
                              ? 'positive'
                              : entry.status === 'failed'
                                ? 'critical'
                                : entry.status === 'awaiting_approval'
                                  ? 'warning'
                                  : 'info'
                          }
                        >
                          {entry.status}
                          {failed ? ` (${failed} failed)` : ''}
                        </Badge>
                      </td>
                    </tr>
                  )
                })}
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Scheduler" subtitle="System schedules run every workspace." />
            {schedules.length === 0 ? (
              <EmptyState title="No active schedules" description="Seeded schedules appear here once the workspace is bootstrapped." />
            ) : (
              <ul className="space-y-2">
                {schedules.map((schedule) => (
                  <li key={schedule.id} className="rounded-lg border border-ink-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm text-ink-800">{schedule.name}</p>
                      {schedule.system ? <Badge tone="neutral">system</Badge> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {schedule.description} · {schedule.jobName}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-400">
                      next {schedule.nextRunAt ? relativeTime(schedule.nextRunAt) : '—'} · last {schedule.lastRunAt ? relativeTime(schedule.lastRunAt) : 'never'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-500">
              Schedules are evaluated by the scheduler process. If the queue backs up, work is picked up as soon as a worker is free — nothing is dropped.
            </p>
          </Card>

          <Card>
            <CardHeader title="Node catalog" subtitle="What each step can do." />
            <ul className="space-y-1.5">
              {catalog.map((node) => (
                <li key={node.kind} className="text-xs">
                  <span className="font-mono text-ink-700">{node.kind}</span>
                  <span className="text-ink-500"> — {node.description}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <CreateWorkflowModal
        open={creating}
        onClose={() => setCreating(false)}
        templates={templates}
        catalog={catalog}
        onCreated={async (name) => {
          setCreating(false)
          setNotice(`${name} created. Open it to run or schedule.`)
          await studio.refresh()
        }}
        onError={(message) => setError(message)}
      />
    </div>
  )
}

function Skeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="h-64 animate-pulse rounded-xl bg-ink-100 lg:col-span-2" />
      <div className="h-64 animate-pulse rounded-xl bg-ink-100" />
    </div>
  )
}

function CreateWorkflowModal({
  open,
  onClose,
  templates,
  catalog,
  onCreated,
  onError,
}: {
  open: boolean
  onClose: () => void
  templates: Payload['templates']
  catalog: Payload['nodeCatalog']
  onCreated: (name: string) => Promise<void>
  onError: (message: string) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [schedule, setSchedule] = useState('0 7 * * *')
  const [templateKey, setTemplateKey] = useState('')
  const [nodes, setNodes] = useState<NodeDef[]>([
    { id: 'trigger', type: 'trigger', label: 'Start', config: {} },
    { id: 'step-1', type: 'research', label: 'Collect opportunities', config: { limitPerSource: 10 }, dependsOn: ['trigger'] },
  ])
  const [saving, setSaving] = useState(false)

  function applyTemplate(key: string) {
    setTemplateKey(key)
    const template = templates.find((item) => item.key === key)
    if (!template) return
    setName(template.name)
    setDescription(template.description)
    setSchedule(template.schedule ?? '')
    setNodes(template.definition.nodes.map((node) => ({ ...node, config: node.config ?? {} })))
  }

  function addNode() {
    const index = nodes.length + 1
    setNodes([
      ...nodes,
      { id: `step-${index}`, type: 'score', label: `Step ${index}`, config: {}, dependsOn: [nodes[nodes.length - 1]?.id ?? 'trigger'] },
    ])
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= nodes.length) return
    const copy = [...nodes]
    const [item] = copy.splice(index, 1)
    copy.splice(target, 0, item!)
    setNodes(copy)
  }

  async function save() {
    setSaving(true)
    try {
      const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id }))
      await api.post('/api/workflows', {
        name,
        description,
        schedule: schedule.trim() === '' ? null : schedule.trim(),
        definition: { nodes, edges },
      })
      await onCreated(name)
      setName('')
      setDescription('')
      setTemplateKey('')
    } catch (caught) {
      onError(caught instanceof ApiClientError ? caught.message : 'The workflow could not be created.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New workflow" wide>
      <div className="space-y-4">
        <Field label="Start from a template" hint="Templates are real graphs you can edit before saving.">
          <Select value={templateKey} onChange={(event) => applyTemplate(event.target.value)}>
            <option value="">Blank workflow</option>
            {templates.map((template) => (
              <option key={template.key} value={template.key}>
                {template.name} — {template.description}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily discovery sweep" />
          </Field>
          <Field label="Schedule" hint="Leave blank for manual runs only. Five-field cron.">
            <div className="space-y-2">
              <Select value={SCHEDULE_PRESETS.some((preset) => preset.cron === schedule) ? schedule : '__custom'} onChange={(event) => setSchedule(event.target.value === '__custom' ? schedule : event.target.value)}>
                {SCHEDULE_PRESETS.map((preset) => (
                  <option key={preset.cron} value={preset.cron}>
                    {preset.label}
                  </option>
                ))}
                <option value="__custom">Custom / none</option>
              </Select>
              <Input value={schedule} onChange={(event) => setSchedule(event.target.value)} placeholder="0 7 * * *" />
            </div>
          </Field>
        </div>

        <Field label="Description">
          <Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-ink-800">Steps ({nodes.length})</p>
            <Button size="sm" variant="secondary" onClick={addNode}>
              <Plus className="h-3.5 w-3.5" />
              Add step
            </Button>
          </div>
          <ul className="space-y-2">
            {nodes.map((node, index) => (
              <li key={node.id} className="rounded-lg border border-ink-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="max-w-[14rem]"
                    value={node.label}
                    onChange={(event) => setNodes(nodes.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)))}
                  />
                  <Select
                    className="max-w-[12rem]"
                    value={node.type}
                    onChange={(event) => setNodes(nodes.map((item, i) => (i === index ? { ...item, type: event.target.value } : item)))}
                  >
                    {catalog.map((entry) => (
                      <option key={entry.kind} value={entry.kind}>
                        {entry.kind}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" variant="ghost" onClick={() => move(index, -1)} disabled={index === 0}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => move(index, 1)} disabled={index === nodes.length - 1}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setNodes(nodes.filter((_, i) => i !== index))}
                    disabled={nodes.length <= 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {catalog.find((entry) => entry.kind === node.type)?.description}
                  {index > 0 ? ` · runs after ${nodes[index - 1]!.label}` : ' · first step'}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={name.trim().length < 3 || nodes.length === 0}>
            <Save className="h-4 w-4" />
            Create workflow
          </Button>
        </div>
      </div>
    </Modal>
  )
}
