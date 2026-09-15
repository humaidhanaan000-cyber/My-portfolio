import type { Metadata } from 'next'
import Link from 'next/link'
import { Callout, SectionHeading, SiteFooter, SiteNav, Step } from '@/components/landing'
import { getSession } from '@/lib/auth'
import { AGENT_LABELS } from '@/lib/agents/labels'
import { AGENT_ORDER } from '@/lib/agents/registry'
import { DEFAULT_SCHEDULES } from '@/lib/scheduler/defaults'
import { describeCron } from '@/lib/scheduler/cron'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'How AIBA works',
  description:
    'The full operating loop: approved sources are scanned, candidates are cleaned and scored across ten dimensions, a strategy becomes a project, a human approves, workflows execute, and results feed back into scoring.',
  alternates: { canonical: '/how-it-works' },
}

const STAGES: { index: number; title: string; description: string }[] = [
  {
    index: 1,
    title: 'Discover',
    description:
      'Only sources you have authorised are contacted — each source row carries a permission status, a rate limit and an optional credential environment variable. Sources that are not marked permitted are never called, and the API refuses to enable them.',
  },
  {
    index: 2,
    title: 'Clean',
    description:
      'Candidates are de-duplicated on their canonical URL and normalised (title, category, monetisation model, cost band). Duplicates are counted and reported rather than silently dropped.',
  },
  {
    index: 3,
    title: 'Analyse & score',
    description:
      'Ten sub-scores — demand, competition, effort, cost, time to revenue, automation potential, monetisation clarity, risk, defensibility and fit with your own skills and interests — are combined with weights that depend on your risk tolerance. The weights used are stored with every score, so a result can always be explained.',
  },
  {
    index: 4,
    title: 'Strategy',
    description:
      'Approved or high-scoring opportunities get a strategy: positioning, target customer, monetisation, price range, first task list and a cost estimate. Everything forward-looking in it is marked as an estimate.',
  },
  {
    index: 5,
    title: 'Project & approval',
    description:
      'A strategy becomes a project container in one of twelve states, and creating a real project raises an approval request with its expected cost and benefit. Until you decide, nothing is built.',
  },
  {
    index: 6,
    title: 'Build',
    description:
      'Product and content agents generate drafts as content assets with their own review state. Drafts are never published by the agents themselves.',
  },
  {
    index: 7,
    title: 'Launch',
    description:
      'Publishing is a distinct, always-approval-gated action. The publish target (local export, webhook, WordPress or GitHub) is configuration, and the credentials it needs are documented per target.',
  },
  {
    index: 8,
    title: 'Monitor',
    description:
      'The monitoring agent records visitors, conversions, revenue and cost per project, and raises alerts when a project stalls, fails or spends more than it earns.',
  },
  {
    index: 9,
    title: 'Learn',
    description:
      'Observed outcomes adjust the scoring weights within hard caps, so no single success or failure can dominate future decisions. Every adjustment is stored and reversible.',
  },
]

export default async function HowItWorksPage() {
  const session = await getSession().catch(() => null)
  const agents = AGENT_ORDER.map((key) => ({ key, label: AGENT_LABELS[key] ?? key }))

  return (
    <div className="min-h-screen bg-ink-50">
      <SiteNav signedIn={Boolean(session)} />

      <section className="border-b border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <SectionHeading
            eyebrow="How it works"
            title="One loop, nine agents, and a human at every gate"
            description="AIBA runs on a server, not on your laptop. The worker process ticks on a schedule, executes real jobs, writes real rows and stops whenever a decision is yours to make."
          />
          <div className="mt-8 flex flex-wrap gap-3 text-xs">
            <Link href="/register" className="rounded-lg bg-accent-600 px-4 py-2.5 font-medium text-white hover:bg-accent-700">Create your workspace</Link>
            <Link href="/safety" className="rounded-lg border border-ink-200 bg-white px-4 py-2.5 font-medium text-ink-800 hover:bg-ink-50">Read the safety rules</Link>
            <Link href="/api-docs" className="rounded-lg border border-ink-200 bg-white px-4 py-2.5 font-medium text-ink-800 hover:bg-ink-50">Review the REST API</Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <SectionHeading eyebrow="Pipeline" title="What happens at each stage" />
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {STAGES.map((stage) => (
            <Step key={stage.index} index={stage.index} title={stage.title} description={stage.description} />
          ))}
        </div>
      </section>

      <section className="border-y border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <SectionHeading
            eyebrow="Agents"
            title="Nine specialists, each with its own budget and timeout"
            description="Every agent has a model tier, a maximum number of runs per day, a per-run cost ceiling and a timeout. Runs are recorded with duration, token cost and result."
          />
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <div key={agent.key} className="surface p-4">
                <p className="text-sm font-medium text-ink-900">{agent.label}</p>
                <p className="mt-1 font-mono text-[11px] text-ink-400">{agent.key}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <SectionHeading
          eyebrow="Scheduler"
          title="It keeps working when your computer is off"
          description="These jobs are seeded per workspace with UTC cron expressions. An administrator can change the cadence; the worker picks up changes without a redeploy."
        />
        <div className="mt-8 overflow-hidden rounded-xl border border-ink-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-ink-50 text-ink-500">
              <tr>
                <th className="px-4 py-3 font-medium">Job</th>
                <th className="px-4 py-3 font-medium">Cadence</th>
                <th className="px-4 py-3 font-medium">Cron (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {DEFAULT_SCHEDULES.map((schedule) => (
                <tr key={schedule.key} className="border-t border-ink-200">
                  <td className="px-4 py-3 text-ink-800">{schedule.name}</td>
                  <td className="px-4 py-3 text-ink-600">{describeCron(schedule.cron)}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-ink-500">{schedule.cron}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="border-t border-ink-200 bg-white">
        <div className="mx-auto max-w-4xl px-4 py-14">
          <SectionHeading eyebrow="Guardrails" title="Where the loop deliberately stops" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <Callout tone="info" title="Before anything paid">
              The estimated cost is declared first, the compliance policy is evaluated, then the budget is checked against daily, monthly, per-project,
              per-agent and platform ceilings. If any check fails, the action stops and becomes an approval request.
            </Callout>
            <Callout tone="info" title="Before anything public">
              Publishing a page, sending an email, running an ad, creating an account or making a purchase always requires an explicit human decision.
              Approving one of those records your authorisation — AIBA does not perform it for you.
            </Callout>
            <Callout tone="warning" title="Never, under any configuration">
              Unauthorised access, CAPTCHA or paywall circumvention, fake accounts, impersonation, spam, private-data scraping, terms-of-service
              violations, unlicensed content publishing, automated financial trades, crypto mining, platform manipulation and fabricated reviews are
              permanently disabled in the policy engine.
            </Callout>
            <Callout tone="warning" title="No income promises">
              Scores are research estimates. Revenue appears in the ledger only when a verified provider integration or your own labelled manual entry
              puts it there. Nothing in AIBA promises that a project will earn money.
            </Callout>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}
