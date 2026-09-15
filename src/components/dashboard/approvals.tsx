'use client'
/**
 * Approval center. Nothing public, outbound, paid or irreversible gets past this
 * screen without an explicit decision, and every decision is audited.
 */
import { useMemo, useState } from 'react'
import { ClipboardCheck, ShieldAlert } from 'lucide-react'
import { Badge, Card, CardHeader, EmptyState, ErrorNote, Select, Stat, Table } from '@/components/ui'
import { useApi } from '@/lib/client/hooks'
import { formatMoney, relativeTime } from '@/lib/client/format'
import { ApprovalCard, type Approval } from './widgets'

type Payload = Approval[]

export function ApprovalCenter() {
  const [status, setStatus] = useState('pending')
  const query = useMemo(() => ({ status: status || undefined, limit: 50 }), [status])
  const approvals = useApi<Payload>('/api/approvals', { query })
  const meta = approvals.meta as { total?: number; stats?: { pending: number; approved: number; rejected: number; executed: number; failed: number; deferred: number; expired: number } } | undefined
  const stats = meta?.stats

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Approval center</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            Each request carries the action, the reason, the expected cost, the expected benefit, the risk and the exact payload that will run.
          </p>
        </div>
        <Select className="w-44" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="pending">Pending &amp; deferred</option>
          <option value="">All statuses</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="executed">Executed</option>
          <option value="failed">Failed</option>
          <option value="expired">Expired</option>
        </Select>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Waiting on you" value={String(stats?.pending ?? 0)} hint="Deferred requests are counted here too" icon={<ClipboardCheck className="h-4 w-4" />} />
        <Stat label="Approved" value={String(stats?.approved ?? 0)} hint={`${stats?.executed ?? 0} executed`} />
        <Stat label="Rejected" value={String(stats?.rejected ?? 0)} hint="Fed back into learning" />
        <Stat label="Failed / expired" value={`${stats?.failed ?? 0} / ${stats?.expired ?? 0}`} hint="Expired requests are re-raised if still needed" tone={stats?.failed ? 'critical' : 'neutral'} />
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-[11px] text-amber-900">
        <ShieldAlert className="mr-1 inline h-3.5 w-3.5" />
        Approval requests for <strong>create account</strong>, <strong>make purchase</strong>, <strong>run ad campaign</strong> and{' '}
        <strong>financial trade</strong> are never executed by AIBA. Approving one records your authorisation and marks it for you to carry out —
        the software does not perform those actions on your behalf.
      </div>

      {approvals.error ? <ErrorNote message={approvals.error} onRetry={() => void approvals.refresh()} /> : null}

      {!approvals.data ? (
        <Card><div className="h-40 animate-pulse rounded bg-ink-100" /></Card>
      ) : approvals.data.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="When an agent wants to spend money, publish content, launch a project or create an account, the request appears here."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {approvals.data.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} onDecided={() => void approvals.refresh()} />
          ))}
        </div>
      )}

      <Card className="p-0">
        <div className="p-5">
          <CardHeader title="Decision audit trail" subtitle="The most recent decisions, with who made them and what happened as a result" />
        </div>
        {!approvals.data || approvals.data.length === 0 ? (
          <p className="px-5 pb-5 text-xs text-ink-500">No decisions recorded for this filter.</p>
        ) : (
          <Table headers={['Request', 'Decision', 'Risk', 'Cost', 'Decided']}>
            {approvals.data.map((approval) => (
              <tr key={approval.id}>
                <td className="px-3 py-2 text-xs">{approval.title}</td>
                <td className="px-3 py-2"><Badge tone={approval.status === 'executed' ? 'positive' : approval.status === 'rejected' ? 'critical' : 'neutral'}>{approval.status.replace(/_/g, ' ')}</Badge></td>
                <td className="px-3 py-2 text-xs capitalize">{approval.risk}</td>
                <td className="tabular px-3 py-2 text-xs">{formatMoney(approval.expectedCostCents)}</td>
                <td className="px-3 py-2 text-[11px] text-ink-500">{relativeTime(approval.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}
