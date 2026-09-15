'use client'
/**
 * Money screens: revenue ledger, expense ledger and the budget guardrails.
 *
 * Every figure comes from a recorded transaction or expense row. Manual entries
 * are labelled `manual`, provider-verified rows are labelled
 * `verified_integration`, and any projected number is marked as an estimate —
 * the interface never presents one as the other.
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, BadgeDollarSign, Gauge, Plus, Receipt, ShieldCheck } from 'lucide-react'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, KeyValue, Modal, ProgressBar, Select, Stat, Table, Textarea } from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { EXPENSE_CATEGORIES } from '@/lib/expenses/categories'
import { formatDate, formatMoney, formatNumber, formatPercent, relativeTime } from '@/lib/client/format'

type RevenueTransaction = {
  id: string
  projectId: string | null
  source: string
  provider: string | null
  description: string
  grossCents: number
  feeCents: number
  netCents: number
  currency: string
  status: string
  verification: string
  occurredAt: string
  demo: boolean
}

type Expense = {
  id: string
  projectId: string | null
  category: string
  description: string
  amountCents: number
  currency: string
  provider: string | null
  verification: string
  occurredAt: string
  demo: boolean
}

type Overview = {
  currency: string
  today: { revenue: number; expenses: number; profit: number }
  week: { revenue: number; expenses: number; profit: number }
  month: { revenue: number; expenses: number; profit: number }
  allTime: { revenue: number; expenses: number; profit: number }
  margin: number
  roi: number
  revenueSeries: { date: string; revenueCents: number; expensesCents: number; profitCents: number }[]
  expenseBreakdown: { category: string; cents: number }[]
  revenueBySource: { source: string; cents: number; count: number }[]
  revenueByProject: { projectId: string | null; name: string; cents: number }[]
}

type RevenuePayload = { overview: Overview; transactions: RevenueTransaction[]; demoFilter: boolean }
type ExpensePayload = { expenses: Expense[]; byCategory: { category: string; totalCents: number; count: number }[]; totalCents: number }

const VERIFICATION_LABEL: Record<string, string> = {
  verified_integration: 'verified by provider',
  manual: 'manual entry',
  metered_estimate: 'metered estimate',
}

function verificationTone(verification: string) {
  if (verification === 'verified_integration') return 'positive' as const
  if (verification === 'manual') return 'neutral' as const
  return 'warning' as const
}

export function RevenueLedger({ projects }: { projects: { id: string; name: string }[] }) {
  const [page, setPage] = useState(1)
  const [demo, setDemo] = useState<'real' | 'demo'>('real')
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const revenue = useApi<RevenuePayload>('/api/revenue', { query: { page, limit: 25, demo: demo === 'demo' ? 'true' : 'false' } })
  const overview = revenue.data?.overview
  const transactions = revenue.data?.transactions ?? []
  const meta = revenue.meta as { total?: number; totalPages?: number } | undefined

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Revenue</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            Recorded revenue only. Provider-verified rows come from signed webhooks; everything else is your own entry, clearly labelled.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select className="w-36" value={demo} onChange={(event) => { setDemo(event.target.value as 'real' | 'demo'); setPage(1) }}>
            <option value="real">Real data</option>
            <option value="demo">Demo data only</option>
          </Select>
          <Button size="sm" onClick={() => setRecording(true)} disabled={demo === 'demo'}>
            <Plus className="h-3.5 w-3.5" />
            Record revenue
          </Button>
        </div>
      </header>

      {demo === 'demo' ? (
        <div className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-2 text-[11px] text-violet-900">
          <Badge tone="demo" className="mr-2">DEMO DATA</Badge>
          You are looking at sample data. It is stored with an explicit demo flag and is never added to the real figures on your dashboard.
        </div>
      ) : null}

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      {overview ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Today" value={formatMoney(overview.today.revenue)} hint={`costs ${formatMoney(overview.today.expenses)}`} icon={<BadgeDollarSign className="h-4 w-4" />} />
            <Stat label="This week" value={formatMoney(overview.week.revenue)} hint={`profit ${formatMoney(overview.week.profit)}`} />
            <Stat label="This month" value={formatMoney(overview.month.revenue)} hint={`profit ${formatMoney(overview.month.profit)}`} />
            <Stat
              label="All time"
              value={formatMoney(overview.allTime.revenue)}
              hint={`margin ${formatPercent(overview.margin)} · ROI ${formatPercent(overview.roi)}`}
              tone={overview.allTime.profit >= 0 ? 'positive' : 'critical'}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Daily revenue vs costs" subtitle="Last 30 days, from recorded rows only" />
              <div className="space-y-1.5">
                {overview.revenueSeries.slice(-14).map((point) => {
                  const max = Math.max(1, ...overview.revenueSeries.map((entry) => Math.max(entry.revenueCents, entry.expensesCents)))
                  return (
                    <div key={point.date} className="flex items-center gap-2 text-[11px]">
                      <span className="w-20 shrink-0 text-ink-500">{point.date.slice(5)}</span>
                      <div className="flex-1">
                        <div className="h-2 rounded-full bg-emerald-200" style={{ width: `${Math.max(2, (point.revenueCents / max) * 100)}%` }} />
                        <div className="mt-0.5 h-1.5 rounded-full bg-rose-200" style={{ width: `${Math.max(1, (point.expensesCents / max) * 100)}%` }} />
                      </div>
                      <span className="tabular w-28 shrink-0 text-right text-ink-600">
                        {formatMoney(point.revenueCents)} / {formatMoney(point.expensesCents)}
                      </span>
                    </div>
                  )
                })}
              </div>
              <p className="mt-3 text-[11px] text-ink-500">
                Green is recorded revenue, red is recorded cost. Figures are actuals, not projections — projections elsewhere are labelled <em>estimate</em>.
              </p>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="By source" subtitle="Where the money came from" />
                {overview.revenueBySource.length === 0 ? (
                  <p className="text-[11px] text-ink-500">No revenue recorded yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {overview.revenueBySource.map((row) => (
                      <li key={row.source} className="flex items-center justify-between text-xs">
                        <span className="text-ink-600">{row.source} <span className="text-ink-400">({row.count})</span></span>
                        <span className="tabular font-medium text-ink-900">{formatMoney(row.cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card>
                <CardHeader title="By project" />
                {overview.revenueByProject.length === 0 ? (
                  <p className="text-[11px] text-ink-500">No project-attributed revenue yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {overview.revenueByProject.map((row) => (
                      <li key={row.projectId ?? row.name} className="flex items-center justify-between text-xs">
                        <span className="truncate text-ink-600">{row.name}</span>
                        <span className="tabular font-medium text-ink-900">{formatMoney(row.cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader
              title="Transaction ledger"
              subtitle={`${formatNumber(meta?.total ?? transactions.length)} row(s)`}
              action={
                overview.allTime.revenue === 0 ? (
                  <Badge tone="neutral">no revenue recorded yet — nothing is estimated for you</Badge>
                ) : null
              }
            />
            {transactions.length === 0 ? (
              <EmptyState
                icon={<BadgeDollarSign className="h-5 w-5" />}
                title={demo === 'demo' ? 'No demo revenue' : 'No revenue recorded'}
                description={
                  demo === 'demo'
                    ? 'Enable demo mode in Settings and generate sample data to preview this screen.'
                    : 'Revenue appears here when a payment provider webhook is verified, or when you record a transaction yourself.'
                }
              />
            ) : (
              <>
                <Table headers={['When', 'Description', 'Source', 'Gross', 'Fees', 'Net', 'Verification']}>
                  {transactions.map((row) => (
                    <tr key={row.id} className="border-t border-ink-200">
                      <td className="px-4 py-3 text-xs text-ink-500">
                        {formatDate(row.occurredAt)}
                        <div className="text-ink-400">{relativeTime(row.occurredAt)}</div>
                      </td>
                      <td className="px-4 py-3 text-sm text-ink-800">
                        {row.description}
                        {row.demo ? <span className="ml-2"><Badge tone="demo">DEMO DATA</Badge></span> : null}
                      </td>
                      <td className="px-4 py-3 text-xs text-ink-500">{row.source}{row.provider ? ` · ${row.provider}` : ''}</td>
                      <td className="tabular px-4 py-3 text-xs text-ink-700">{formatMoney(row.grossCents)}</td>
                      <td className="tabular px-4 py-3 text-xs text-ink-500">{formatMoney(row.feeCents)}</td>
                      <td className="tabular px-4 py-3 text-xs font-medium text-ink-900">{formatMoney(row.netCents)}</td>
                      <td className="px-4 py-3">
                        <Badge tone={verificationTone(row.verification)}>{VERIFICATION_LABEL[row.verification] ?? row.verification}</Badge>
                      </td>
                    </tr>
                  ))}
                </Table>
                <div className="mt-3 flex items-center justify-between text-[11px] text-ink-500">
                  <span>Page {page} of {meta?.totalPages ?? 1}</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button>
                    <Button size="sm" variant="ghost" disabled={page >= (meta?.totalPages ?? 1)} onClick={() => setPage((value) => value + 1)}>Next</Button>
                  </div>
                </div>
              </>
            )}
          </Card>
        </>
      ) : revenue.loading ? (
        <Card><div className="h-40 animate-pulse rounded bg-ink-100" /></Card>
      ) : revenue.error ? (
        <ErrorNote message={revenue.error} onRetry={() => void revenue.refresh()} />
      ) : null}

      <RecordRevenueModal
        open={recording}
        projects={projects}
        onClose={() => setRecording(false)}
        onSaved={async (message) => {
          setRecording(false)
          setNotice(message)
          await revenue.refresh()
        }}
        onError={setError}
      />
    </div>
  )
}

function RecordRevenueModal({
  open,
  projects,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean
  projects: { id: string; name: string }[]
  onClose: () => void
  onSaved: (message: string) => Promise<void>
  onError: (message: string) => void
}) {
  const [gross, setGross] = useState('49.00')
  const [fees, setFees] = useState('1.42')
  const [description, setDescription] = useState('')
  const [source, setSource] = useState('manual')
  const [projectId, setProjectId] = useState('')
  const [saving, setSaving] = useState(false)

  const grossCents = Math.round(Number(gross || '0') * 100)
  const feeCents = Math.round(Number(fees || '0') * 100)
  const invalid = grossCents < 0 || feeCents > grossCents || description.trim().length < 2

  async function save() {
    setSaving(true)
    try {
      await api.post('/api/revenue', {
        grossCents,
        feeCents,
        description: description.trim(),
        source: source.trim() || 'manual',
        ...(projectId ? { projectId } : {}),
      })
      await onSaved('Revenue recorded as a manual entry. Mark it verified only when your provider confirms it.')
      setDescription('')
    } catch (caught) {
      onError(caught instanceof ApiClientError ? caught.message : 'The transaction could not be recorded.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Record revenue">
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          Manual entries are stored with verification <strong>manual</strong> and are shown that way everywhere. They are never presented as
          provider-verified income.
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Gross amount" hint="In your workspace currency." required>
            <Input value={gross} onChange={(event) => setGross(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Processing fees" hint="Payment provider fees deducted from the gross." error={feeCents > grossCents ? 'Fees cannot exceed the gross amount.' : null}>
            <Input value={fees} onChange={(event) => setFees(event.target.value)} inputMode="decimal" />
          </Field>
        </div>
        <Field label="Description" required>
          <Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What was sold, to whom, on which plan" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Source label" hint="For your own bookkeeping — e.g. stripe, gumroad, invoice.">
            <Input value={source} onChange={(event) => setSource(event.target.value)} />
          </Field>
          <Field label="Attach to project">
            <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">Not attributed</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="rounded-lg bg-ink-50 px-3 py-2 text-[11px] text-ink-600">
          Net recorded: <span className="tabular font-medium text-ink-900">{formatMoney(Math.max(0, grossCents - feeCents))}</span>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} loading={saving} disabled={invalid}>Record transaction</Button>
        </div>
      </div>
    </Modal>
  )
}

export function ExpenseLedger({ projects }: { projects: { id: string; name: string }[] }) {
  const [page, setPage] = useState(1)
  const [demo, setDemo] = useState<'real' | 'demo'>('real')
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const expenses = useApi<ExpensePayload>('/api/expenses', { query: { page, limit: 25, demo: demo === 'demo' ? 'true' : 'false' } })
  const rows = expenses.data?.expenses ?? []
  const meta = expenses.meta as { total?: number; totalPages?: number } | undefined
  const byCategory = expenses.data?.byCategory ?? []
  const totalCents = byCategory.reduce((sum, row) => sum + row.totalCents, 0)

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Expenses</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            Every cost AIBA records — model calls, hosting, tools, contractors. Costs count against your budget guardrails immediately.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select className="w-36" value={demo} onChange={(event) => { setDemo(event.target.value as 'real' | 'demo'); setPage(1) }}>
            <option value="real">Real data</option>
            <option value="demo">Demo data only</option>
          </Select>
          <Button size="sm" onClick={() => setRecording(true)} disabled={demo === 'demo'}>
            <Plus className="h-3.5 w-3.5" />
            Record expense
          </Button>
        </div>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}
      {expenses.error ? <ErrorNote message={expenses.error} onRetry={() => void expenses.refresh()} /> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Expense ledger" subtitle={`${formatNumber(meta?.total ?? rows.length)} row(s)`} />
          {rows.length === 0 ? (
            <EmptyState
              icon={<Receipt className="h-5 w-5" />}
              title={expenses.loading ? 'Loading expenses' : 'No expenses recorded'}
              description="Model spend is recorded automatically. Other costs — hosting, tools, contractors — you can add here."
            />
          ) : (
            <>
              <Table headers={['When', 'Category', 'Description', 'Amount', 'Attribution']}>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-ink-200">
                    <td className="px-4 py-3 text-xs text-ink-500">
                      {formatDate(row.occurredAt)}
                      <div className="text-ink-400">{relativeTime(row.occurredAt)}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-600">{row.category.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3 text-sm text-ink-800">
                      {row.description}
                      {row.demo ? <span className="ml-2"><Badge tone="demo">DEMO DATA</Badge></span> : null}
                    </td>
                    <td className="tabular px-4 py-3 text-xs font-medium text-ink-900">{formatMoney(row.amountCents)}</td>
                    <td className="px-4 py-3 text-xs text-ink-500">
                      {row.provider ?? 'manual'}
                      {row.projectId ? <div className="text-ink-400">project attributed</div> : null}
                    </td>
                  </tr>
                ))}
              </Table>
              <div className="mt-3 flex items-center justify-between text-[11px] text-ink-500">
                <span>Page {page} of {meta?.totalPages ?? 1}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button>
                  <Button size="sm" variant="ghost" disabled={page >= (meta?.totalPages ?? 1)} onClick={() => setPage((value) => value + 1)}>Next</Button>
                </div>
              </div>
            </>
          )}
        </Card>

        <Card>
          <CardHeader title="By category" subtitle={`Total ${formatMoney(totalCents)}`} />
          {byCategory.length === 0 ? (
            <p className="text-[11px] text-ink-500">No costs recorded in this view.</p>
          ) : (
            <ul className="space-y-3">
              {byCategory.map((row) => (
                <li key={row.category}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-ink-600">{row.category.replace(/_/g, ' ')}</span>
                    <span className="tabular font-medium text-ink-900">{formatMoney(row.totalCents)}</span>
                  </div>
                  <div className="mt-1">
                    <ProgressBar value={totalCents > 0 ? (row.totalCents / totalCents) * 100 : 0} />
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-400">{row.count} entr{row.count === 1 ? 'y' : 'ies'}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <RecordExpenseModal
        open={recording}
        projects={projects}
        onClose={() => setRecording(false)}
        onSaved={async (message) => {
          setRecording(false)
          setNotice(message)
          await expenses.refresh()
        }}
        onError={setError}
      />
    </div>
  )
}

function RecordExpenseModal({
  open,
  projects,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean
  projects: { id: string; name: string }[]
  onClose: () => void
  onSaved: (message: string) => Promise<void>
  onError: (message: string) => void
}) {
  const [amount, setAmount] = useState('9.00')
  const [category, setCategory] = useState<string>('hosting')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState('')
  const [provider, setProvider] = useState('')
  const [saving, setSaving] = useState(false)
  const amountCents = Math.round(Number(amount || '0') * 100)

  async function save() {
    setSaving(true)
    try {
      await api.post('/api/expenses', {
        amountCents,
        category,
        description: description.trim(),
        ...(projectId ? { projectId } : {}),
        ...(provider ? { provider } : {}),
      })
      await onSaved('Expense recorded. It counts against your budget limits immediately.')
      setDescription('')
    } catch (caught) {
      onError(caught instanceof ApiClientError ? caught.message : 'The expense could not be recorded.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Record expense">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" required>
            <Input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Category" required>
            <Select value={category} onChange={(event) => setCategory(event.target.value)}>
              {EXPENSE_CATEGORIES.map((entry) => (
                <option key={entry} value={entry}>{entry.replace(/_/g, ' ')}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Description" required>
          <Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What was paid for" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provider" hint="Vendor or platform name.">
            <Input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="Stripe, Vercel, contractor…" />
          </Field>
          <Field label="Attach to project">
            <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">Not attributed</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} loading={saving} disabled={amountCents <= 0 || description.trim().length < 2}>Record expense</Button>
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ budgets */

export function BudgetGuardrails() {
  const budget = useApi<{
    snapshot: {
      currency: string
      daily: { limitCents: number; spentCents: number; percentUsed: number; resetsAt: string }
      monthly: { limitCents: number; spentCents: number; percentUsed: number; resetsAt: string }
      projectMaxCents: number
      agentDailyLimitCents: number
      alerting: { level: string; message?: string }[]
    }
    rows: { id: string; scope: string; period: string; limitCents: number; spentCents: number; label?: string }[]
    profile: { dailyBudgetCents: number; monthlyBudgetCents: number; maxProjectBudgetCents: number; perAgentDailyLimitCents: number } | null
    planKey: string
  }>('/api/budgets')

  const snapshot = budget.data?.snapshot
  const profile = budget.data?.profile
  const [form, setForm] = useState<{ daily: string; monthly: string; project: string; agent: string } | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const values = useMemo(
    () => ({
      daily: form?.daily ?? String((profile?.dailyBudgetCents ?? 0) / 100),
      monthly: form?.monthly ?? String((profile?.monthlyBudgetCents ?? 0) / 100),
      project: form?.project ?? String((profile?.maxProjectBudgetCents ?? 0) / 100),
      agent: form?.agent ?? String((profile?.perAgentDailyLimitCents ?? 0) / 100),
    }),
    [form, profile],
  )

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await api.patch('/api/budgets', {
        dailyBudgetCents: Math.round(Number(values.daily || '0') * 100),
        monthlyBudgetCents: Math.round(Number(values.monthly || '0') * 100),
        maxProjectBudgetCents: Math.round(Number(values.project || '0') * 100),
        perAgentDailyLimitCents: Math.round(Number(values.agent || '0') * 100),
        acknowledgeHardLimits: true,
      })
      setNotice('Limits saved. They apply to the next paid action — nothing already running is retroactively billed.')
      setForm(null)
      await budget.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The limits could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">Budget guardrails</h1>
        <p className="mt-0.5 text-xs text-ink-500">
          Hard limits checked before every paid action: cost → budget check → if over the limit, stop, raise an approval and notify you. AIBA never
          spends past a limit it was given.
        </p>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}
      {budget.error ? <ErrorNote message={budget.error} onRetry={() => void budget.refresh()} /> : null}

      {snapshot ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Current usage"
              subtitle={`Plan: ${budget.data?.planKey ?? 'free'} · limits are enforced server-side`}
              icon={<Gauge className="h-4 w-4" />}
            />
            <div className="space-y-5">
              <ProgressBar
                value={snapshot.daily.percentUsed}
                tone={snapshot.daily.percentUsed >= 100 ? 'critical' : snapshot.daily.percentUsed > 80 ? 'warning' : 'positive'}
                label={`Today: ${formatMoney(snapshot.daily.spentCents)} of ${snapshot.daily.limitCents > 0 ? formatMoney(snapshot.daily.limitCents) : 'no limit set'}`}
              />
              <ProgressBar
                value={snapshot.monthly.percentUsed}
                tone={snapshot.monthly.percentUsed >= 100 ? 'critical' : snapshot.monthly.percentUsed > 80 ? 'warning' : 'positive'}
                label={`This month: ${formatMoney(snapshot.monthly.spentCents)} of ${snapshot.monthly.limitCents > 0 ? formatMoney(snapshot.monthly.limitCents) : 'no limit set'}`}
              />
              <KeyValue
                items={[
                  { label: 'Daily limit resets', value: relativeTime(snapshot.daily.resetsAt) },
                  { label: 'Monthly limit resets', value: relativeTime(snapshot.monthly.resetsAt) },
                  { label: 'Max per project', value: formatMoney(snapshot.projectMaxCents) },
                  { label: 'Per agent per day', value: formatMoney(snapshot.agentDailyLimitCents) },
                ]}
              />
              {snapshot.alerting.length > 0 ? (
                <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                  {snapshot.alerting.map((entry, index) => (
                    <li key={index} className="flex items-center gap-1.5">
                      <AlertTriangle className="h-3 w-3" />
                      {entry.message ?? entry.level}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5" />
                <span>
                  When a limit is reached, the paid action stops and an approval request is created with its expected cost. Approving it releases the
                  specific amount for that action only — it does not raise the limit.
                </span>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Change limits" subtitle="Applies immediately." />
            <div className="space-y-3">
              <Field label="Daily limit" hint="Example: 5.00">
                <Input value={values.daily} onChange={(event) => setForm({ ...values, daily: event.target.value })} inputMode="decimal" />
              </Field>
              <Field label="Monthly limit">
                <Input value={values.monthly} onChange={(event) => setForm({ ...values, monthly: event.target.value })} inputMode="decimal" />
              </Field>
              <Field label="Maximum per project">
                <Input value={values.project} onChange={(event) => setForm({ ...values, project: event.target.value })} inputMode="decimal" />
              </Field>
              <Field label="Per agent, per day">
                <Input value={values.agent} onChange={(event) => setForm({ ...values, agent: event.target.value })} inputMode="decimal" />
              </Field>
              <label className="flex items-start gap-2 text-[11px] text-ink-600">
                <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                <span>
                  I understand these are hard limits: AIBA stops and raises an approval request instead of exceeding them. Setting 0 means “no
                  limit configured” — the platform-wide daily ceiling still applies either way.
                </span>
              </label>
              <Button size="sm" onClick={() => void save()} loading={saving} disabled={!acknowledged}>
                Save limits
              </Button>
            </div>
          </Card>
        </div>
      ) : budget.loading ? (
        <Card><div className="h-40 animate-pulse rounded bg-ink-100" /></Card>
      ) : null}

      <Card>
        <CardHeader title="How enforcement works" subtitle="The order of operations for every paid action" />
        <ol className="space-y-2 text-xs text-ink-600">
          <li><strong>1.</strong> The action declares its estimated cost before it runs.</li>
          <li><strong>2.</strong> The compliance policy is evaluated — prohibited actions never run, high-risk actions always need a human.</li>
          <li><strong>3.</strong> The budget is checked against daily, monthly, per-project, per-agent and platform ceilings.</li>
          <li><strong>4.</strong> If any limit would be exceeded: the action stops, an approval request is created with the expected cost, and you are notified.</li>
          <li><strong>5.</strong> Only after approval is a ledger debit written and the action executed — approval releases that one action, it never raises the limit.</li>
        </ol>
        <div className="mt-3 flex flex-wrap gap-3 text-[11px]">
          <Link href="/dashboard/approvals" className="inline-flex items-center gap-1 text-accent-700 hover:underline">
            Review approvals <ArrowRight className="h-3 w-3" />
          </Link>
          <Link href="/dashboard/expenses" className="inline-flex items-center gap-1 text-accent-700 hover:underline">
            See what has been spent <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </Card>
    </div>
  )
}
