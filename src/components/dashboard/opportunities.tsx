'use client'
/**
 * Opportunity database browser: filters, sorting, pagination, manual entry and
 * the full decision workflow (view, analyse, strategy, approve, reject, archive).
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Filter, Plus, Search, SlidersHorizontal } from 'lucide-react'
import { Badge, Button, Card, CardHeader, DemoBadge, EmptyState, ErrorNote, Field, Input, Modal, Select, Table } from '@/components/ui'
import { useApi } from '@/lib/client/hooks'
import { api, ApiClientError } from '@/lib/client/api'
import { relativeTime } from '@/lib/client/format'
import { OpportunityRow, type OpportunitySummary } from './widgets'

type OpportunityApi = {
  id: string
  title: string
  description: string
  url: string | null
  category: string
  sourceName: string
  status: string
  tags: string[]
  region: string | null
  discoveredAt: string
  decision: string | null
  score: string | null
  verdict: string | null
  demand: number | null
  competition: number | null
  monetizationScore: number | null
  startupCost: number | null
  riskScore: number | null
  automation: number | null
  isDemo: boolean
}

const CATEGORIES = [
  'underserved_market', 'saas_opportunity', 'affiliate_opportunity', 'digital_product', 'lead_generation',
  'public_business_request', 'freelance_opportunity', 'local_business', 'content_opportunity', 'partnership',
  'emerging_niche', 'useful_tool', 'other',
]

const STATUSES = ['discovered', 'cleaned', 'scored', 'strategy_ready', 'approved', 'rejected', 'archived']

export function OpportunityBrowser() {
  const [filters, setFilters] = useState({ q: '', status: '', category: '', minScore: '', sort: 'score', order: 'desc' })
  const [page, setPage] = useState(1)
  const [showFilters, setShowFilters] = useState(false)
  const [creating, setCreating] = useState(false)

  const query = useMemo(
    () => ({
      page,
      limit: 25,
      q: filters.q || undefined,
      status: filters.status || undefined,
      category: filters.category || undefined,
      minScore: filters.minScore || undefined,
      sort: filters.sort,
      order: filters.order,
    }),
    [filters, page],
  )

  const list = useApi<OpportunityApi[]>('/api/opportunities', { query })
  const meta = list.meta as { total?: number; totalPages?: number; page?: number } | undefined

  const rows: OpportunitySummary[] = (list.data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    sourceName: row.sourceName,
    status: row.status,
    discoveredAt: row.discoveredAt,
    score: row.score,
    verdict: row.verdict,
    demo: row.isDemo,
  }))

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">Opportunity database</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            {meta?.total !== undefined ? `${meta.total} opportunities match the current filters` : 'Loading…'} · scores are research estimates, not forecasts
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowFilters((value) => !value)}>
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add manually
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-56">
          <Search className="absolute top-2.5 left-3 h-3.5 w-3.5 text-ink-400" />
          <Input
            className="pl-8"
            placeholder="Search title or description…"
            value={filters.q}
            onChange={(event) => {
              setFilters({ ...filters, q: event.target.value })
              setPage(1)
            }}
          />
        </div>
        <Select
          className="w-40"
          value={filters.sort}
          onChange={(event) => setFilters({ ...filters, sort: event.target.value })}
        >
          <option value="score">Sort: score</option>
          <option value="discovered_at">Sort: discovered</option>
          <option value="title">Sort: title</option>
        </Select>
        <Select className="w-28" value={filters.order} onChange={(event) => setFilters({ ...filters, order: event.target.value })}>
          <option value="desc">Desc</option>
          <option value="asc">Asc</option>
        </Select>
      </div>

      {showFilters ? (
        <Card>
          <CardHeader title="Filters" subtitle="Applied server-side, so pagination stays correct" icon={<Filter className="h-4 w-4" />} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Status">
              <Select
                value={filters.status}
                onChange={(event) => {
                  setFilters({ ...filters, status: event.target.value })
                  setPage(1)
                }}
              >
                <option value="">Any status</option>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category">
              <Select
                value={filters.category}
                onChange={(event) => {
                  setFilters({ ...filters, category: event.target.value })
                  setPage(1)
                }}
              >
                <option value="">Any category</option>
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Minimum score" hint="0–100">
              <Input
                type="number"
                min={0}
                max={100}
                value={filters.minScore}
                onChange={(event) => {
                  setFilters({ ...filters, minScore: event.target.value })
                  setPage(1)
                }}
              />
            </Field>
            <div className="flex items-end">
              <Button
                variant="ghost"
                onClick={() => {
                  setFilters({ q: '', status: '', category: '', minScore: '', sort: 'score', order: 'desc' })
                  setPage(1)
                }}
              >
                Clear filters
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {list.error ? <ErrorNote message={list.error} onRetry={() => void list.refresh()} /> : null}

      {list.loading && !list.data ? (
        <Card>
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((key) => (
              <div key={key} className="h-10 animate-pulse rounded bg-ink-100" />
            ))}
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No opportunities match"
          description="Either nothing has been discovered yet, or the filters exclude everything. Run a discovery cycle from the Sources page, or clear the filters."
        />
      ) : (
        <Card className="p-0">
          <Table headers={['Opportunity', 'Score', 'Status', 'Decide']} className="px-2 py-2">
            {rows.map((row) => (
              <OpportunityRow key={row.id} opportunity={row} onChanged={() => void list.refresh()} />
            ))}
          </Table>
        </Card>
      )}

      {meta?.totalPages && meta.totalPages > 1 ? (
        <div className="flex items-center justify-between text-xs text-ink-600">
          <span>
            Page {meta.page} of {meta.totalPages}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              Previous
            </Button>
            <Button size="sm" variant="secondary" disabled={page >= (meta.totalPages ?? 1)} onClick={() => setPage((value) => value + 1)}>
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <ManualOpportunityModal open={creating} onClose={() => setCreating(false)} onCreated={() => void list.refresh()} />
    </div>
  )
}

function ManualOpportunityModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ title: '', description: '', category: 'other', url: '', region: '', tags: '' })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit() {
    setPending(true)
    setError(null)
    try {
      await api.post('/api/opportunities', {
        title: form.title,
        description: form.description,
        category: form.category,
        url: form.url || undefined,
        region: form.region || undefined,
        tags: form.tags ? form.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
      })
      onCreated()
      onClose()
      setForm({ title: '', description: '', category: 'other', url: '', region: '', tags: '' })
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Could not save the opportunity.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add an opportunity manually"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={pending} onClick={submit} disabled={form.title.length < 5 || form.description.length < 10}>
            Save opportunity
          </Button>
        </>
      }
    >
      {error ? <div className="mb-3"><ErrorNote message={error} /></div> : null}
      <div className="space-y-3">
        <Field label="Title" required hint="Minimum 5 characters.">
          <Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Accounting firms still track invoices in spreadsheets" />
        </Field>
        <Field label="Description" required hint="What is the observed problem, and who has it? Minimum 10 characters.">
          <textarea
            className="min-h-28 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-accent-400 focus:outline-none"
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            <Select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>{category.replace(/_/g, ' ')}</option>
              ))}
            </Select>
          </Field>
          <Field label="Region" hint="Optional">
            <Input value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} placeholder="US, EU, global" />
          </Field>
        </div>
        <Field label="Source URL" hint="Optional. Only link to something you are permitted to reference.">
          <Input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://" />
        </Field>
        <Field label="Tags" hint="Comma separated, up to 10.">
          <Input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="finance, smb, invoicing" />
        </Field>
      </div>
    </Modal>
  )
}

export function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <Badge tone="neutral">unscored</Badge>
  const tone = score >= 80 ? 'positive' : score >= 65 ? 'info' : score >= 50 ? 'warning' : 'critical'
  return <Badge tone={tone}>{score.toFixed(1)}</Badge>
}

export { DemoBadge, relativeTime }
