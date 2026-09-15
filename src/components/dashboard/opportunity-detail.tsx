'use client'
/**
 * Opportunity detail: the full score breakdown the analysis agent produced,
 * every strategy version, linked projects and the decision history.
 */
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Archive, CheckCircle2, Lightbulb, Play, XCircle } from 'lucide-react'
import { Badge, Button, Card, CardHeader, DemoBadge, EmptyState, ErrorNote, KeyValue, ProgressBar, Table } from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { formatDate, relativeTime } from '@/lib/client/format'
import { ScoreBadge } from './opportunities'

type Detail = {
  opportunity: {
    id: string
    title: string
    description: string
    url: string | null
    category: string
    sourceName: string
    sourceUrl: string | null
    status: string
    decision: string | null
    tags: string[]
    region: string | null
    discoveredAt: string
    createdAt: string
    demo: boolean
    relevancyScore: number | null
    spamScore: number | null
    decisionNote: string | null
    raw: Record<string, unknown> | null
    metadata: Record<string, unknown> | null
  }
  latestScore: {
    id: string
    version: number
    finalScore: string
    verdict: string
    confidence: number
    summary: string
    rationale: Record<string, string>
    demand: number
    competition: number
    monetization: number
    automationPotential: number
    startupCost: number
    scalability: number
    operatingCost: number
    timeToRevenue: number
    difficulty: number
    risk: number
    weights: Record<string, number>
    engine: string
    provider: string | null
    model: string | null
    createdAt: string
  } | null
  scores: { id: string; version: number; finalScore: string; verdict: string; createdAt: string }[]
  strategies: {
    id: string
    version: number
    title: string
    problem: string
    targetCustomer: string
    solution: string
    businessModel: string
    monetization: string
    acquisition: string
    costEstimate: Record<string, unknown> | null
    scenarios: Record<string, unknown> | null
    risks: unknown[]
    techRequirements: unknown[]
    launchPlan: unknown[]
    successMetrics: unknown[]
    status: string
    engine: string
    createdAt: string
  }[]
  projects: { id: string; name: string; status: string }[]
  decisions: { id: string; decision: string; reason: string; actor: string; scoreAtDecision: string | null; createdAt: string }[]
}

const DIMENSIONS: { key: keyof NonNullable<Detail['latestScore']>; label: string }[] = [
  { key: 'demand', label: 'Demand' },
  { key: 'competition', label: 'Competition (higher is better)' },
  { key: 'monetization', label: 'Monetization' },
  { key: 'automationPotential', label: 'Automation potential' },
  { key: 'startupCost', label: 'Startup cost (higher = cheaper to start)' },
  { key: 'scalability', label: 'Scalability' },
  { key: 'operatingCost', label: 'Operating cost (higher = cheaper to run)' },
  { key: 'timeToRevenue', label: 'Time to revenue (higher = faster)' },
  { key: 'difficulty', label: 'Difficulty (higher = easier)' },
  { key: 'risk', label: 'Risk (higher = lower risk)' },
]

export function OpportunityDetail({ id }: { id: string }) {
  const router = useRouter()
  const detail = useApi<Detail>(`/api/opportunities/${id}`)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function act(kind: 'score' | 'strategy' | 'approve' | 'reject' | 'archive') {
    setPending(kind)
    setError(null)
    setNotice(null)
    try {
      if (kind === 'score') {
        await api.post(`/api/opportunities/${id}/score`, {})
        setNotice('Analysis complete. The score below reflects the weights in effect at run time.')
      } else if (kind === 'strategy') {
        await api.post(`/api/opportunities/${id}/strategy`, { createProject: true, requestApproval: true })
        setNotice('Strategy drafted and an approval request was raised. Nothing is public until you decide.')
      } else {
        await api.post(`/api/opportunities/${id}/decision`, { decision: kind, createStrategy: kind === 'approve' })
        setNotice(
          kind === 'approve'
            ? 'Opportunity approved. The strategy agent has been queued where a strategy does not exist yet.'
            : `Opportunity ${kind}d.`,
        )
      }
      await detail.refresh()
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The action could not be completed.')
    } finally {
      setPending(null)
    }
  }

  if (detail.error && !detail.data) return <ErrorNote message={detail.error} onRetry={() => void detail.refresh()} />
  if (!detail.data) return <div className="surface h-96 animate-pulse bg-white/60" />

  const { opportunity, latestScore, strategies, projects, decisions, scores } = detail.data

  return (
    <div className="space-y-5">
      <button type="button" onClick={() => router.push('/dashboard/opportunities')} className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-3.5 w-3.5" />
        Opportunity database
      </button>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-ink-900">{opportunity.title}</h1>
            {opportunity.demo ? <DemoBadge /> : null}
            <Badge tone="info">{opportunity.status.replace(/_/g, ' ')}</Badge>
          </div>
          <p className="mt-1 text-xs text-ink-500">
            {opportunity.category.replace(/_/g, ' ')} · {opportunity.sourceName} · discovered {relativeTime(opportunity.discoveredAt)}
            {opportunity.region ? ` · ${opportunity.region}` : ''}
            {opportunity.url ? (
              <>
                {' · '}
                <a href={opportunity.url} target="_blank" rel="noreferrer nofollow" className="underline hover:text-ink-800">
                  source link
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={pending === 'score'} onClick={() => void act('score')}>
            <Play className="h-3.5 w-3.5" />
            {latestScore ? 'Re-analyse' : 'Analyse'}
          </Button>
          <Button size="sm" variant="secondary" loading={pending === 'strategy'} onClick={() => void act('strategy')}>
            <Lightbulb className="h-3.5 w-3.5" />
            Create strategy
          </Button>
          <Button size="sm" variant="success" loading={pending === 'approve'} onClick={() => void act('approve')}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            Approve
          </Button>
          <Button size="sm" variant="ghost" loading={pending === 'reject'} onClick={() => void act('reject')}>
            <XCircle className="h-3.5 w-3.5" />
            Reject
          </Button>
          <Button size="sm" variant="ghost" loading={pending === 'archive'} onClick={() => void act('archive')}>
            <Archive className="h-3.5 w-3.5" />
            Archive
          </Button>
        </div>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Observation" subtitle="Exactly what was recorded from the source" />
            <p className="text-xs leading-relaxed whitespace-pre-line text-ink-700">{opportunity.description}</p>
            {opportunity.tags.length ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {opportunity.tags.map((tag) => (
                  <Badge key={tag} tone="neutral">{tag}</Badge>
                ))}
              </div>
            ) : null}
          </Card>

          <Card>
            <CardHeader
              title="Score breakdown"
              subtitle={latestScore ? `Version ${latestScore.version} · produced ${relativeTime(latestScore.createdAt)}` : 'Not analysed yet'}
              action={latestScore ? <ScoreBadge score={Number(latestScore.finalScore)} /> : null}
            />
            {!latestScore ? (
              <EmptyState
                title="No analysis yet"
                description="Run the analysis agent to score demand, competition, cost, risk, automation potential and time to revenue. The score is an estimate, not a forecast."
                action={<Button size="sm" loading={pending === 'score'} onClick={() => void act('score')}>Analyse now</Button>}
              />
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-ink-200 bg-ink-50 px-3 py-2">
                  <p className="text-xs font-medium text-ink-800">{latestScore.summary}</p>
                  {Object.entries(latestScore.rationale ?? {}).slice(0, 6).map(([key, value]) => (
                    <p key={key} className="mt-1 text-[11px] leading-relaxed text-ink-600">
                      <span className="font-medium capitalize">{key.replace(/_/g, ' ')}:</span> {value}
                    </p>
                  ))}
                  <p className="mt-2 text-[10px] text-ink-500">
                    Confidence {latestScore.confidence}% · verdict {latestScore.verdict.replace(/_/g, ' ')} · scored by {latestScore.engine}
                    {latestScore.provider ? ` via ${latestScore.provider}` : ''}
                    {latestScore.model ? ` (${latestScore.model})` : ''} · the weights applied are stored with this version.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {DIMENSIONS.map((dimension) => {
                    const value = latestScore[dimension.key]
                    const numeric = typeof value === 'number' ? value : 0
                    return (
                      <ProgressBar
                        key={dimension.key}
                        value={numeric}
                        tone={numeric >= 70 ? 'positive' : numeric >= 50 ? 'info' : 'warning'}
                        label={dimension.label}
                      />
                    )
                  })}
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  Every figure on this page is a research estimate produced from the signal text, not a forecast or a promise. AIBA records
                  actual revenue only from verified integrations or your own manual entries, which you will find in the Revenue ledger.
                </div>
                <details>
                  <summary className="cursor-pointer text-[11px] font-medium text-ink-500 hover:text-ink-800">Weights used for this score</summary>
                  <div className="mt-2">
                    <KeyValue
                      items={Object.entries(latestScore.weights).map(([key, value]) => ({
                        label: key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' '),
                        value: `${(value * 100).toFixed(1)}%`,
                      }))}
                    />
                  </div>
                </details>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Strategies" subtitle="Every version is kept — drafts are never published automatically" />
            {strategies.length === 0 ? (
              <p className="text-xs text-ink-500">No strategy drafted yet.</p>
            ) : (
              <ul className="space-y-3">
                {strategies.map((strategy) => (
                  <li key={strategy.id} className="rounded-lg border border-ink-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-ink-900">
                        v{strategy.version} · {strategy.title}
                      </p>
                      <Badge tone={strategy.status === 'approved' ? 'positive' : 'neutral'}>{strategy.status}</Badge>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-600">{strategy.solution}</p>
                    <div className="mt-2 grid gap-1 text-[10px] text-ink-500 sm:grid-cols-2">
                      <p><span className="font-medium text-ink-600">Customer:</span> {strategy.targetCustomer || '—'}</p>
                      <p><span className="font-medium text-ink-600">Model:</span> {strategy.businessModel || '—'}</p>
                      <p><span className="font-medium text-ink-600">Monetization:</span> {strategy.monetization || '—'}</p>
                      <p><span className="font-medium text-ink-600">Acquisition:</span> {strategy.acquisition || '—'}</p>
                    </div>
                    {strategy.launchPlan.length ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[10px] font-medium text-ink-500">Launch plan ({strategy.launchPlan.length} steps)</summary>
                        <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[10px] text-ink-600">
                          {strategy.launchPlan.map((step, index) => (
                            <li key={index}>{String(typeof step === 'string' ? step : JSON.stringify(step))}</li>
                          ))}
                        </ol>
                      </details>
                    ) : null}
                    <p className="mt-1 text-[10px] text-ink-400">
                      {formatDate(strategy.createdAt)} · drafted by {strategy.engine}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Provenance" />
            <KeyValue
              items={[
                { label: 'Source', value: opportunity.sourceName },
                { label: 'Category', value: opportunity.category.replace(/_/g, ' ') },
                { label: 'Relevance', value: opportunity.relevancyScore ?? '—' },
                { label: 'Spam score', value: opportunity.spamScore ?? '—' },
                { label: 'Status', value: opportunity.status.replace(/_/g, ' ') },
                { label: 'Decision', value: opportunity.decision ?? 'none recorded' },
                { label: 'Decision note', value: opportunity.decisionNote ?? '—' },
                { label: 'Discovered', value: formatDate(opportunity.discoveredAt) },
                { label: 'Demo row', value: opportunity.demo ? 'yes — excluded from real totals' : 'no' },
              ]}
            />
          </Card>

          <Card>
            <CardHeader title="Score history" subtitle="Learning adjusts weights, so versions differ over time" />
            {scores.length <= 1 ? (
              <p className="text-xs text-ink-500">Only one score version exists.</p>
            ) : (
              <Table headers={['Version', 'Score', 'Verdict', 'When']}>
                {scores.map((score) => (
                  <tr key={score.id}>
                    <td className="px-2 py-1.5 text-xs">v{score.version}</td>
                    <td className="tabular px-2 py-1.5 text-xs font-medium">{Number(score.finalScore).toFixed(1)}</td>
                    <td className="px-2 py-1.5 text-xs capitalize">{score.verdict.replace(/_/g, ' ')}</td>
                    <td className="px-2 py-1.5 text-[11px] text-ink-500">{relativeTime(score.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="Linked projects" />
            {projects.length === 0 ? (
              <p className="text-xs text-ink-500">No project created from this opportunity yet.</p>
            ) : (
              <ul className="space-y-2">
                {projects.map((project) => (
                  <li key={project.id} className="flex items-center justify-between gap-2">
                    <Link href={`/dashboard/projects/${project.id}`} className="text-xs font-medium text-accent-700 hover:underline">
                      {project.name}
                    </Link>
                    <Badge tone={project.status === 'LAUNCHED' ? 'positive' : 'info'}>{project.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Decision history" subtitle="Audited and fed back into the learning agent" />
            {decisions.length === 0 ? (
              <p className="text-xs text-ink-500">No explicit decision recorded.</p>
            ) : (
              <ul className="space-y-2 text-[11px]">
                {decisions.map((decision) => (
                  <li key={decision.id}>
                    <p className="font-medium text-ink-800 capitalize">{decision.decision}</p>
                    <p className="text-ink-500">{decision.reason || 'No reason recorded.'}</p>
                    <p className="text-ink-400">
                      {decision.actor} · {relativeTime(decision.createdAt)}
                      {decision.scoreAtDecision ? ` · score at decision ${Number(decision.scoreAtDecision).toFixed(1)}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {opportunity.raw ? (
            <Card>
              <CardHeader title="Raw signal" subtitle="Stored so a score can always be traced back" />
              <pre className="max-h-64 overflow-auto rounded-lg bg-ink-950 p-3 text-[10px] leading-relaxed text-ink-100">
                {JSON.stringify(opportunity.raw, null, 2)}
              </pre>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}

