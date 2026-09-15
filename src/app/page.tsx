import type { Metadata } from 'next'
import Link from 'next/link'
import { Callout, FeatureCard, SectionHeading, SiteFooter, SiteNav, Step } from '@/components/landing'
import { listPlans } from '@/lib/payments'
import { publicConfig } from '@/lib/env'
import { getSession } from '@/lib/auth'
import { checkDatabaseHealth } from '@/lib/db'
import { aiStatus } from '@/lib/ai'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'AIBA — Autonomous Internet Business Agent',
  description:
    'AIBA finds opportunities, scores them against your own criteria, builds the project assets, monitors results and tracks every dollar — stopping for your approval before anything public, risky, or paid.',
  alternates: { canonical: '/' },
}

const HEADLINE = 'Your autonomous internet business agent'
const SUBHEADLINE =
  'AIBA researches opportunities, scores them against your own criteria, builds the project, and tracks every dollar of revenue and cost. It runs on a server, keeps working when your computer is off, and stops for your approval before anything public, risky or paid ever happens.'

const CAPABILITIES = [
  {
    title: 'Opportunity engine',
    description:
      'Collects from official APIs and feeds you authorise, de-duplicates, cleans and scores every candidate across ten dimensions — demand, competition, cost, risk, automation and more.',
  },
  {
    title: 'Nine specialist agents',
    description:
      'Research, cleaning, analysis, strategy, product, content, execution, monitoring and learning. Each run is recorded with its cost, duration and result.',
  },
  {
    title: 'Approval center',
    description:
      'Anything irreversible, public, outbound or paid becomes a request with the reason, expected cost, expected benefit and risk. Nothing proceeds without your decision.',
  },
  {
    title: 'Hard budget guardrails',
    description:
      'Daily, monthly, per-project and per-agent limits are enforced in the database before a cent is spent. When a limit is reached the work stops and asks — it never overspends.',
  },
  {
    title: 'Revenue and expense ledger',
    description:
      'Real transactions from verified integrations, your own manual entries, and metered costs. Gross, fees, net, margin and ROI are calculated from rows that exist, not from projections.',
  },
  {
    title: 'Workflow builder and scheduler',
    description:
      'Compose triggers, research, scoring, strategy, approvals, builds, launches and monitoring into a graph, schedule it with cron, and pause, resume or retry any run.',
  },
]

export default async function LandingPage() {
  const [plans, session, database, ai] = await Promise.all([
    listPlans().catch(() => []),
    getSession().catch(() => null),
    checkDatabaseHealth().catch(() => ({ ok: false, driver: 'unknown', latencyMs: 0 })),
    Promise.resolve(aiStatus()),
  ])
  const config = publicConfig()

  return (
    <div className="min-h-screen bg-ink-50">
      <SiteNav signedIn={Boolean(session)} />

      {/* ------------------------------------------------------------------ hero */}
      <section className="grid-lines border-b border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1.15fr_0.85fr]">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-ink-50 px-3 py-1 text-[11px] font-medium text-ink-600">
                <span className={`h-1.5 w-1.5 rounded-full ${database.ok ? 'bg-signal-positive live-dot' : 'bg-signal-warning'}`} />
                {database.ok ? 'Worker, queue and database online' : 'Database unreachable — check configuration'}
              </div>
              <h1 className="mt-5 text-3xl leading-tight font-semibold tracking-tight text-ink-900 sm:text-5xl">{HEADLINE}</h1>
              <p className="mt-5 max-w-2xl text-sm leading-relaxed text-ink-600 sm:text-base">{SUBHEADLINE}</p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link href="/register" className="rounded-lg bg-accent-600 px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-accent-700">
                  Create your workspace
                </Link>
                <Link href="/how-it-works" className="rounded-lg border border-ink-200 bg-white px-5 py-3 text-sm font-medium text-ink-800 hover:bg-ink-50">
                  See how it works
                </Link>
                <Link href="/status" className="text-xs font-medium text-ink-500 underline hover:text-ink-800">
                  Live system status
                </Link>
              </div>

              <p className="mt-4 max-w-2xl text-xs text-ink-500">
                Free to start on your own server. No credit card, no income promises, and you can export every row AIBA stores.
              </p>
            </div>

            {/* live console preview, fed by real environment state */}
            <div className="surface-dark p-4 font-mono text-[11px] leading-relaxed text-ink-200">
              <div className="mb-3 flex items-center gap-2 text-ink-400">
                <span className="h-2 w-2 rounded-full bg-signal-critical/70" />
                <span className="h-2 w-2 rounded-full bg-signal-warning/70" />
                <span className="h-2 w-2 rounded-full bg-signal-positive/70" />
                <span className="ml-2">aiba · operator console</span>
              </div>
              <pre className="whitespace-pre-wrap text-ink-100">{`system      ${database.ok ? 'ONLINE' : 'DEGRADED'}  ·  db ${database.latencyMs}ms (${database.driver})
agents      9 registered  ·  ${ai.configured ? 'AI provider connected' : 'AI provider not configured'}
guardrails  approval required for public, paid or irreversible actions
budget      daily / monthly / per-project / per-agent hard limits
revenue     verified integrations + manual entries, separated from demo

pipeline    discover → clean → score → strategy → project
            → approve → build → launch → monitor → learn`}</pre>
              <p className="mt-3 border-t border-white/10 pt-3 text-[10px] text-ink-400">
                AIBA stops at every approval gate. Projections stay labelled as estimates until a payment provider confirms them.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- capabilities */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <SectionHeading
          eyebrow="What it does"
          title="A full operating loop, not a dashboard mock-up"
          description="Every capability below is backed by working code in this deployment: real database writes, real queue jobs, real provider integrations where credentials exist."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((capability) => (
            <FeatureCard key={capability.title} title={capability.title} description={capability.description} />
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- lifecycle */}
      <section className="border-y border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <SectionHeading
            eyebrow="The loop"
            title="How an opportunity becomes a monitored project"
            description="Each step is a real stage in the database, with its own state, cost record and audit trail."
          />
          <div className="mx-auto mt-10 grid max-w-4xl gap-6 sm:grid-cols-2">
            <Step index={1} title="Discover" description="Agents scan the official APIs and feeds you enable. Each source carries a permission status and a rate limit; anything not permitted is never contacted." />
            <Step index={2} title="Clean & score" description="Duplicates are removed, rows are normalised, and ten sub-scores are combined with weights you can tune. Every score keeps the weights used to produce it." />
            <Step index={3} title="Plan & approve" description="The strategy agent drafts positioning, pricing and a first task list, creates a project container, and then stops: creating a real project needs your approval." />
            <Step index={4} title="Build & launch" description="Product and content agents generate drafts. Publishing or launching is a separate, always-approval-gated action — drafts are never published automatically." />
            <Step index={5} title="Track money" description="Verified integration revenue, manual entries and metered costs land in one ledger. Profit, margin and ROI are computed from those rows." />
            <Step index={6} title="Learn" description="The learning agent turns observed outcomes into bounded weight adjustments. Adjustments are capped so no single result can dominate future scoring." />
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------------- pricing */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <SectionHeading
          eyebrow="Pricing"
          title="Configured by your deployment, not hardcoded"
          description="Prices are read from the database and can be changed by an administrator at any time. AIBA never invents a price or a discount in the interface."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(plans.length ? plans : []).map((plan) => (
            <div key={plan.key} className="surface flex flex-col p-6">
              <p className="text-xs font-semibold tracking-widest text-accent-600 uppercase">{plan.key}</p>
              <h3 className="mt-2 text-lg font-semibold text-ink-900">{plan.name}</h3>
              <p className="mt-1 text-xs text-ink-500">{plan.tagline}</p>
              <p className="mt-4 text-3xl font-semibold tracking-tight text-ink-900">
                {plan.priceMonthlyCents === 0 ? 'Free' : `$${(plan.priceMonthlyCents / 100).toFixed(2)}`}
                {plan.priceMonthlyCents > 0 ? <span className="text-sm font-normal text-ink-500">/month</span> : null}
              </p>
              {plan.priceYearlyCents > 0 ? (
                <p className="mt-1 text-xs text-ink-500">or ${(plan.priceYearlyCents / 100).toFixed(2)} per year</p>
              ) : null}
              <ul className="mt-5 flex-1 space-y-2 text-xs text-ink-600">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <span className="text-signal-positive">✓</span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="/register"
                className="mt-6 rounded-lg bg-ink-900 px-4 py-2.5 text-center text-xs font-medium text-white hover:bg-ink-800"
              >
                {plan.priceMonthlyCents === 0 ? 'Start free' : 'Start and upgrade later'}
              </Link>
            </div>
          ))}
          {plans.length === 0 ? <p className="text-sm text-ink-500">Pricing is being configured for this deployment.</p> : null}
        </div>
        <p className="mt-6 text-center text-xs text-ink-500">
          Payment provider in use: <strong className="font-medium text-ink-700">{config.paymentProvider}</strong>. Subscriptions activate only
          after a server-side verification of the provider webhook — a browser redirect is never treated as proof of payment.
        </p>
      </section>

      {/* ------------------------------------------------------------------ limits */}
      <section className="border-t border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <SectionHeading eyebrow="Honest by design" title="What AIBA will not do" />
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            <Callout tone="warning" title="No income guarantees, ever">
              AIBA never claims guaranteed profit, guaranteed income, or money for doing nothing. Opportunity scores are research
              estimates. Revenue appears in the ledger only when a verified integration or your own entry puts it there.
            </Callout>
            <Callout tone="warning" title="No growth hacking at other people's expense">
              No fake accounts, no fabricated reviews, no spam, no CAPTCHA or paywall circumvention, no scraping of private data, no
              impersonation, no automated financial trading and no crypto mining. These actions are permanently disabled in the
              policy engine — they cannot be enabled by configuration.
            </Callout>
            <Callout tone="info" title="Hard limits are hard">
              Daily, monthly, per-project and per-agent budgets are enforced before every paid action. When a limit is reached, the
              agent stops and raises an approval request instead of spending.
            </Callout>
            <Callout tone="info" title="Estimates are labelled as estimates">
              Scenarios, projections and cost estimates are stored and displayed with an explicit label until a real transaction
              replaces them. Demo data is stored separately and can never be added to real revenue.
            </Callout>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- final CTA */}
      <section className="border-t border-ink-200 bg-ink-900">
        <div className="mx-auto max-w-4xl px-4 py-16 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Start with a free workspace</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-ink-300">
            Register, answer the five-step onboarding wizard, and set your own risk tolerance and budget limits. The first research
            cycle can run within a minute; everything after that waits for your approval.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/register" className="rounded-lg bg-accent-500 px-5 py-3 text-sm font-medium text-white hover:bg-accent-400">
              Create account
            </Link>
            <Link href="/login" className="rounded-lg border border-white/20 px-5 py-3 text-sm font-medium text-white hover:bg-white/10">
              Sign in
            </Link>
            <Link href="/api-docs" className="rounded-lg border border-white/20 px-5 py-3 text-sm font-medium text-white hover:bg-white/10">
              Read the API docs
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}
