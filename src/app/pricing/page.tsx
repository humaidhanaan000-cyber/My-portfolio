import type { Metadata } from 'next'
import Link from 'next/link'
import { Callout, SectionHeading, SiteFooter, SiteNav } from '@/components/landing'
import { getSession } from '@/lib/auth'
import { listPlans, paymentStatus } from '@/lib/payments'
import { publicConfig } from '@/lib/env'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Free, Pro and Business plans. Prices are stored in the database and changed by an administrator — never hardcoded into the product. Subscriptions activate only after a server-side verification of the payment provider webhook.',
  alternates: { canonical: '/pricing' },
}

const LIMIT_LABELS: Record<string, string> = {
  members: 'Members',
  projects: 'Projects',
  workflows: 'Workflows',
  agentRunsPerDay: 'Agent runs per day',
  analysesPerMonth: 'Opportunity analyses per month',
  opportunitiesPerMonth: 'Opportunities per month',
}

function formatLimit(value: number | undefined) {
  if (value === undefined) return '—'
  if (value < 0) return 'Unlimited'
  return new Intl.NumberFormat('en-US').format(value)
}

export default async function PricingPage() {
  const [session, plans] = await Promise.all([getSession().catch(() => null), listPlans().catch(() => [])])
  const payments = paymentStatus()
  const config = publicConfig()

  return (
    <div className="min-h-screen bg-ink-50">
      <SiteNav signedIn={Boolean(session)} />

      <section className="border-b border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <SectionHeading
            eyebrow="Pricing"
            title="Plans configured by your own deployment"
            description="These prices are read live from the plans table. The operator of this deployment can change them at any time from the admin console or with PATCH /api/billing/plans — no redeploy, and every change is written to the audit trail."
          />
          <p className="mt-4 max-w-3xl text-xs text-ink-500">
            Payment provider in use: <strong className="font-medium text-ink-700">{payments.provider}</strong>
            {payments.configured ? ' (checkout configured)' : ' (checkout not configured on this deployment — plans can still be created and used)'}.
            Subscriptions only activate after the provider webhook passes a server-side signature verification; a browser redirect is never treated as
            proof of payment.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <div className="grid gap-5 lg:grid-cols-3">
          {plans.map((plan) => (
            <div key={plan.key} className="surface flex flex-col p-6">
              <p className="text-xs font-semibold tracking-widest text-accent-600 uppercase">{plan.key}</p>
              <h2 className="mt-2 text-lg font-semibold text-ink-900">{plan.name}</h2>
              <p className="mt-1 text-xs text-ink-500">{plan.tagline}</p>
              <p className="mt-4 text-3xl font-semibold tracking-tight text-ink-900">
                {plan.priceMonthlyCents === 0 ? 'Free' : `$${(plan.priceMonthlyCents / 100).toFixed(2)}`}
                {plan.priceMonthlyCents > 0 ? <span className="text-sm font-normal text-ink-500">/month</span> : null}
              </p>
              {plan.priceYearlyCents > 0 ? (
                <p className="mt-1 text-xs text-ink-500">or ${(plan.priceYearlyCents / 100).toFixed(2)} per year</p>
              ) : (
                <p className="mt-1 text-xs text-ink-500">No card required</p>
              )}

              <ul className="mt-5 space-y-2 text-xs text-ink-600">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <span className="text-signal-positive">✓</span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-5 space-y-1.5 rounded-lg bg-ink-50 px-3 py-3 text-[11px]">
                {Object.entries(plan.limits).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-ink-500">{LIMIT_LABELS[key] ?? key}</span>
                    <span className="tabular font-medium text-ink-800">{formatLimit(typeof value === 'number' ? value : undefined)}</span>
                  </div>
                ))}
              </div>

              <Link
                href={plan.priceMonthlyCents === 0 ? '/register' : '/dashboard/billing'}
                className="mt-6 rounded-lg bg-ink-900 px-4 py-2.5 text-center text-xs font-medium text-white hover:bg-ink-800"
              >
                {plan.priceMonthlyCents === 0 ? 'Start free' : 'Choose this plan'}
              </Link>
            </div>
          ))}
          {plans.length === 0 ? (
            <p className="text-sm text-ink-500">
              No plans are published on this deployment yet. Run <code className="font-mono text-xs">npm run db:seed</code> to load the catalogue.
            </p>
          ) : null}
        </div>
      </section>

      <section className="border-y border-ink-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-14">
          <SectionHeading eyebrow="What every plan includes" title="Same guardrails, same honesty, all tiers" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <Callout tone="info" title="Agent and AI costs are separate from the subscription">
              Your subscription pays for the software. Third-party model, hosting and tool costs are billed to you by those providers and recorded in
              AIBA&apos;s expense ledger, where they count against your own budget limits. Nothing is marked up silently.
            </Callout>
            <Callout tone="info" title="Hard limits are not a paid feature">
              Daily, monthly, per-project and per-agent budget limits, the approval centre, the policy engine and the audit trail are present on every
              plan — including Free.
            </Callout>
            <Callout tone="info" title="You can self-host indefinitely">
              AIBA runs from a single Docker Compose file. If you would rather not pay a subscription, you can run the whole system yourself; a
              subscription covers hosting, updates and support for the hosted deployment.
            </Callout>
            <Callout tone="warning" title="No revenue guarantees — at any price">
              No plan, and no feature in any plan, promises that you will earn money. Opportunity scores are research estimates. Earnings depend on
              execution, market conditions and factors outside this software.
            </Callout>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-14 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-ink-900">Start on the free plan</h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-ink-600">
          Register, complete the five-step onboarding wizard, set your risk tolerance and budget limits, and run your first research cycle. Upgrading
          later keeps all of your data — plans change limits, never your rows.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3 text-xs">
          <Link href="/register" className="rounded-lg bg-accent-600 px-5 py-3 font-medium text-white hover:bg-accent-700">Create account</Link>
          <Link href="/safety" className="rounded-lg border border-ink-200 bg-white px-5 py-3 font-medium text-ink-800 hover:bg-ink-50">Read the limits first</Link>
        </div>
        <p className="mt-4 text-[11px] text-ink-400">Environment: {config.appName} · {config.paymentProvider} payments · demo mode {config.demoModeEnabled ? 'available' : 'disabled'}</p>
      </section>

      <SiteFooter />
    </div>
  )
}
