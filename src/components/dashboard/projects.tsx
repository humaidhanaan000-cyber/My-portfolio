'use client'
/**
 * Project board. Twelve states, real transitions. Every state change goes
 * through the API and is written to the audit log.
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Badge, Button, Card, CardHeader, DemoBadge, EmptyState, ErrorNote, Select, Table } from '@/components/ui'
import { useApi } from '@/lib/client/hooks'
import { formatMoney, relativeTime } from '@/lib/client/format'
import { ProjectCard, type ProjectSummary } from './widgets'

type ProjectRow = {
  id: string
  name: string
  status: string
  progress: number
  objective: string
  budgetCents: number
  spentCents: number
  revenueCents: number
  profitCents: number
  demo: boolean
  updatedAt: string
  launchedAt: string | null
  taskCount: number
  openTasks: number
  pendingApprovals: number
  nextTask: string | null
}

const STATUSES = [
  'IDEA', 'VALIDATING', 'VALIDATED', 'PLANNING', 'BUILDING', 'REVIEW', 'APPROVED', 'LAUNCHING', 'LAUNCHED',
  'MONITORING', 'OPTIMIZING', 'PAUSED', 'COMPLETED', 'FAILED', 'ARCHIVED',
]

export function ProjectBoard() {
  const [status, setStatus] = useState('')
  const [view, setView] = useState<'grid' | 'table'>('grid')
  const query = useMemo(() => ({ limit: 50, status: status || undefined }), [status])
  const list = useApi<ProjectRow[]>('/api/projects', { query })
  const meta = list.meta as { total?: number } | undefined

  const projects: ProjectSummary[] = (list.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    progress: row.progress,
    objective: row.objective,
    budgetCents: row.budgetCents,
    expenseCents: row.spentCents,
    revenueCents: row.revenueCents,
    profitCents: row.profitCents,
    nextTask: row.nextTask,
    demo: row.demo,
  }))

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Projects</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            {meta?.total !== undefined ? `${meta.total} projects` : 'Loading…'} · a project is created only from an approved strategy
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-44" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All states</option>
            {STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry.toLowerCase()}
              </option>
            ))}
          </Select>
          <div className="flex overflow-hidden rounded-lg border border-ink-200">
            <button
              type="button"
              onClick={() => setView('grid')}
              className={`px-3 py-2 text-xs font-medium ${view === 'grid' ? 'bg-ink-900 text-white' : 'bg-white text-ink-600'}`}
            >
              Cards
            </button>
            <button
              type="button"
              onClick={() => setView('table')}
              className={`px-3 py-2 text-xs font-medium ${view === 'table' ? 'bg-ink-900 text-white' : 'bg-white text-ink-600'}`}
            >
              Table
            </button>
          </div>
        </div>
      </header>

      {list.error ? <ErrorNote message={list.error} onRetry={() => void list.refresh()} /> : null}

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Approve an opportunity to let the strategy agent draft a plan, then approve that plan. Only then does a project container exist."
          action={
            <Link href="/dashboard/opportunities" className="rounded-lg bg-accent-600 px-4 py-2 text-xs font-medium text-white hover:bg-accent-700">
              Go to opportunities
            </Link>
          }
        />
      ) : view === 'grid' ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      ) : (
        <Card className="p-0">
          <Table headers={['Project', 'State', 'Progress', 'Budget', 'Revenue', 'Net', 'Updated', '']}>
            {(list.data ?? []).map((row) => (
              <tr key={row.id}>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    <Link href={`/dashboard/projects/${row.id}`} className="text-xs font-medium text-ink-900 hover:text-accent-700">
                      {row.name}
                    </Link>
                    {row.demo ? <DemoBadge /> : null}
                  </span>
                  <p className="text-[11px] text-ink-500">
                    {row.openTasks} open tasks · {row.pendingApprovals} approvals pending
                  </p>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={row.status === 'LAUNCHED' || row.status === 'MONITORING' ? 'positive' : row.status === 'FAILED' ? 'critical' : 'info'}>
                    {row.status.toLowerCase()}
                  </Badge>
                </td>
                <td className="tabular px-3 py-2 text-xs">{row.progress}%</td>
                <td className="tabular px-3 py-2 text-xs">{formatMoney(row.spentCents)} / {formatMoney(row.budgetCents)}</td>
                <td className="tabular px-3 py-2 text-xs">{formatMoney(row.revenueCents)}</td>
                <td className={`tabular px-3 py-2 text-xs font-medium ${row.profitCents >= 0 ? 'text-signal-positive' : 'text-signal-critical'}`}>
                  {formatMoney(row.profitCents)}
                </td>
                <td className="px-3 py-2 text-[11px] text-ink-500">{relativeTime(row.updatedAt)}</td>
                <td className="px-3 py-2 text-right">
                  <Link href={`/dashboard/projects/${row.id}`} className="text-[11px] font-medium text-accent-700 hover:underline">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card>
        <CardHeader title="Project lifecycle" subtitle="The twelve operator states plus terminal states, in order" />
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((entry) => (
            <Badge key={entry} tone={entry === 'FAILED' ? 'critical' : entry === 'PAUSED' ? 'warning' : entry === 'LAUNCHED' || entry === 'MONITORING' ? 'positive' : 'neutral'}>
              {entry.toLowerCase()}
            </Badge>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-ink-500">
          Transitions are validated server-side. Launching requires the project to be approved and built, and every launch writes a
          project event, an audit entry and a metric snapshot.
        </p>
      </Card>
    </div>
  )
}
