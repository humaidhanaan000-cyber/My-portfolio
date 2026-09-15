'use client'
/**
 * Agent fleet manager: enable/disable, per-agent spend limits, automation level
 * and manual runs. A manual run performs the real work and is recorded.
 */
import { useState } from 'react'
import Link from 'next/link'
import { Bot, Play, Power, Zap } from 'lucide-react'
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, Modal, Select, Switch, Table } from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { formatMoney, relativeTime } from '@/lib/client/format'

type AgentRow = {
  key: string
  name: string
  description: string
  category: string
  enabled: boolean
  status: string
  modelTier: string
  maxDailyRuns: number
  maxCostCentsPerRun: number
  timeoutSeconds: number
  avgDurationMs: number | null
  successCount: number
  failureCount: number
  lastRunAt: string | null
  lastError: string | null
  health: string
  spendCents: number
  runs24h: number
  totalRuns: number
  schedule: { key: string; cron: string; enabled: boolean; description: string; nextRunAt: string | null } | null
}

type Payload = {
  agents: AgentRow[]
  summary: { total: number; enabled: number; running: number; errored: number; totalRuns: number; totalSpendCents: number }
  automationLevel: string
  demoMode: boolean
  planKey: string
}

export function AgentFleetManager() {
  const fleet = useApi<Payload>('/api/agents', { pollMs: 30_000 })
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [runModal, setRunModal] = useState<AgentRow | null>(null)
  const [runInput, setRunInput] = useState('{}')

  async function patch(key: string, body: Record<string, unknown>, message: string) {
    setPending(key)
    setError(null)
    setNotice(null)
    try {
      await api.patch('/api/agents', { key, ...body })
      setNotice(message)
      await fleet.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The change could not be saved.')
    } finally {
      setPending(null)
    }
  }

  async function run(key: string, input: Record<string, unknown>) {
    setPending(`run-${key}`)
    setError(null)
    setNotice(null)
    try {
      await api.post(`/api/agents/${key}/run`, { useAi: true, async: false, input })
      setNotice(`${key} run completed. Open its history to read the full output.`)
      setRunModal(null)
      await fleet.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The run failed.')
    } finally {
      setPending(null)
    }
  }

  const data = fleet.data

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Agents</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            {data ? `${data.summary.enabled} of ${data.summary.total} enabled · ${data.summary.totalRuns} runs recorded · ${formatMoney(data.summary.totalSpendCents)} spent` : 'Loading…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data ? <Badge tone="info">automation: {data.automationLevel.replace(/_/g, ' ')}</Badge> : null}
          {data?.demoMode ? <Badge tone="demo">DEMO DATA</Badge> : null}
        </div>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      {!data ? (
        <Card><div className="h-64 animate-pulse rounded bg-ink-100" /></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.agents.map((agent) => (
            <Card key={agent.key}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                    {agent.name}
                    <Badge tone={agent.health === 'ok' ? 'positive' : agent.health === 'error' ? 'critical' : 'neutral'}>{agent.health}</Badge>
                    {agent.status === 'running' ? <Badge tone="info">running</Badge> : null}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-600">{agent.description}</p>
                  <p className="mt-1 text-[11px] text-ink-500">
                    {agent.category} · model tier {agent.modelTier} · {agent.totalRuns} runs · {formatMoney(agent.spendCents)} spend
                  </p>
                  <p className="text-[11px] text-ink-500">
                    {agent.lastRunAt ? `last run ${relativeTime(agent.lastRunAt)}` : 'never run'}
                    {agent.avgDurationMs ? ` · avg ${(agent.avgDurationMs / 1000).toFixed(1)}s` : ''}
                    {agent.runs24h ? ` · ${agent.runs24h} in 24h` : ''}
                  </p>
                  {agent.lastError ? <p className="mt-1 text-[11px] text-signal-critical">Last error: {agent.lastError}</p> : null}
                </div>
                <Switch
                  checked={agent.enabled}
                  onChange={(value) => void patch(agent.key, { enabled: value }, `${agent.name} ${value ? 'enabled' : 'disabled'}.`)}
                  label={agent.enabled ? 'Enabled' : 'Disabled'}
                />
              </div>

              {agent.schedule ? (
                <div className="mt-3 rounded-lg border border-ink-100 bg-ink-50 px-3 py-2 text-[11px]">
                  <p className="flex items-center gap-1.5 text-ink-600">
                    <Zap className="h-3 w-3" />
                    {agent.schedule.description} <span className="font-mono text-ink-400">({agent.schedule.cron})</span>
                  </p>
                  <p className="text-ink-400">
                    {agent.schedule.enabled ? `next run ${agent.schedule.nextRunAt ? relativeTime(agent.schedule.nextRunAt) : 'not scheduled'}` : 'schedule disabled'}
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-[11px] text-ink-400">No schedule registered for this agent.</p>
              )}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <Field label="Max runs / day">
                  <Input
                    type="number"
                    min={0}
                    defaultValue={agent.maxDailyRuns}
                    onBlur={(event) => {
                      const value = Number(event.target.value)
                      if (value !== agent.maxDailyRuns) void patch(agent.key, { maxDailyRuns: value }, `${agent.name} daily run limit updated.`)
                    }}
                  />
                </Field>
                <Field label="Max cost / run (cents)">
                  <Input
                    type="number"
                    min={0}
                    defaultValue={agent.maxCostCentsPerRun}
                    onBlur={(event) => {
                      const value = Number(event.target.value)
                      if (value !== agent.maxCostCentsPerRun) void patch(agent.key, { maxCostCentsPerRun: value }, `${agent.name} per-run cost ceiling updated.`)
                    }}
                  />
                </Field>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" loading={pending === `run-${agent.key}`} onClick={() => { setRunModal(agent); setRunInput('{}') }}>
                  <Play className="h-3.5 w-3.5" />
                  Run now
                </Button>
                <Link href={`/dashboard/agents/${agent.key}`} className="rounded-lg bg-ink-100 px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-200">
                  Run history
                </Link>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending === agent.key}
                  onClick={() => void patch(agent.key, { scheduleEnabled: !(agent.schedule?.enabled ?? false) }, `${agent.name} schedule ${agent.schedule?.enabled ? 'paused' : 'enabled'}.`)}
                >
                  <Power className="h-3.5 w-3.5" />
                  {agent.schedule?.enabled ? 'Pause schedule' : 'Enable schedule'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="p-0">
        <div className="p-5">
          <CardHeader title="How the fleet is governed" subtitle="Limits are enforced by the runtime, not by the prompt" icon={<Bot className="h-4 w-4" />} />
        </div>
        <div className="px-5 pb-5">
          <Table headers={['Control', 'Where it is enforced', 'What happens when it is hit']}>
            <tr>
              <td className="px-3 py-2 text-xs">Max runs per day</td>
              <td className="px-3 py-2 text-xs">Runtime, before the agent starts</td>
              <td className="px-3 py-2 text-xs">Run is refused and the schedule is skipped until the next window</td>
            </tr>
            <tr>
              <td className="px-3 py-2 text-xs">Max cost per run</td>
              <td className="px-3 py-2 text-xs">Policy ceilings + budget guardrails</td>
              <td className="px-3 py-2 text-xs">The paid step stops and an approval request is raised</td>
            </tr>
            <tr>
              <td className="px-3 py-2 text-xs">Automation level</td>
              <td className="px-3 py-2 text-xs">Policy engine, re-evaluated at decision time</td>
              <td className="px-3 py-2 text-xs">Public, paid and irreversible actions become approval requests</td>
            </tr>
            <tr>
              <td className="px-3 py-2 text-xs">Daily / monthly budget</td>
              <td className="px-3 py-2 text-xs">Database, before any spend commit</td>
              <td className="px-3 py-2 text-xs">The action is blocked, the approval is raised, and you are notified</td>
            </tr>
          </Table>
        </div>
      </Card>

      <Modal
        open={Boolean(runModal)}
        onClose={() => setRunModal(null)}
        title={runModal ? `Run ${runModal.name}` : 'Run agent'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRunModal(null)}>Cancel</Button>
            <Button
              loading={pending === `run-${runModal?.key}`}
              onClick={() => {
                let parsed: Record<string, unknown> = {}
                try {
                  parsed = runInput.trim() ? (JSON.parse(runInput) as Record<string, unknown>) : {}
                } catch {
                  setError('The input must be valid JSON.')
                  return
                }
                if (runModal) void run(runModal.key, parsed)
              }}
            >
              Start run
            </Button>
          </>
        }
      >
        <p className="text-xs text-ink-600">
          This starts a real run. If the agent needs to spend money, publish something or launch a project, the run will stop and raise an
          approval request instead of doing it.
        </p>
        <div className="mt-3">
          <Field label="Input (JSON)" hint="Optional. Leave as {} to let the agent use its own defaults.">
            <textarea
              className="min-h-32 w-full rounded-lg border border-ink-200 px-3 py-2 font-mono text-[11px]"
              value={runInput}
              onChange={(event) => setRunInput(event.target.value)}
              spellCheck={false}
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}

export function AgentRunHistory({ agentKey }: { agentKey: string }) {
  const [page, setPage] = useState(1)
  const runs = useApi<{ runs: AgentRun[] }>('/api/agents/runs', { query: { agent: agentKey, page, limit: 25 } })
  const meta = runs.meta as { total?: number; totalPages?: number } | undefined

  return (
    <div className="space-y-4">
      {runs.error ? <ErrorNote message={runs.error} onRetry={() => void runs.refresh()} /> : null}
      <Card className="p-0">
        <Table headers={['Status', 'Trigger', 'Started', 'Duration', 'Cost', 'Detail']}>
          {(runs.data?.runs ?? []).map((run) => (
            <tr key={run.id}>
              <td className="px-3 py-2">
                <Badge tone={run.status === 'succeeded' ? 'positive' : run.status === 'failed' ? 'critical' : 'warning'}>{run.status.replace(/_/g, ' ')}</Badge>
              </td>
              <td className="px-3 py-2 text-xs">{run.triggeredBy}</td>
              <td className="px-3 py-2 text-[11px] text-ink-500">{relativeTime(run.startedAt)}</td>
              <td className="tabular px-3 py-2 text-xs">{(run.durationMs / 1000).toFixed(1)}s</td>
              <td className="tabular px-3 py-2 text-xs">{formatMoney(run.costCents)}</td>
              <td className="px-3 py-2 text-[11px] text-ink-600">
                {run.error ? <span className="text-signal-critical">{run.error}</span> : run.output ? <OutputSummary output={run.output} /> : '—'}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      {meta?.totalPages && meta.totalPages > 1 ? (
        <div className="flex items-center justify-between text-xs text-ink-600">
          <span>Page {page} of {meta.totalPages} · {meta.total ?? 0} runs</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={page >= meta.totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

type AgentRun = {
  id: string
  agentKey: string
  status: string
  triggeredBy: string
  startedAt: string
  finishedAt: string | null
  durationMs: number
  costCents: number
  error: string | null
  output: Record<string, unknown> | null
}

function OutputSummary({ output }: { output: Record<string, unknown> }) {
  const summary = typeof output.summary === 'string' ? output.summary : null
  if (summary) return <span>{summary}</span>
  const keys = Object.keys(output).slice(0, 4)
  return <span className="font-mono">{keys.map((key) => `${key}=${(JSON.stringify(output[key]) ?? 'null').slice(0, 40)}`).join(' ')}</span>
}
