import type { Metadata } from 'next'
import Link from 'next/link'
import { Callout, SectionHeading, SiteFooter, SiteNav } from '@/components/landing'
import { getSession } from '@/lib/auth'
import { POLICY_RULES } from '@/lib/compliance/policy'
import { SERVICE_CREDENTIALS } from '@/lib/env'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Safety & limits',
  description:
    'The exact policy: which actions are permanently prohibited, which always need human approval, and how daily, monthly, per-project and per-agent budget limits are enforced before money is spent.',
  alternates: { canonical: '/safety' },
}

const APPROVAL_HIGH: string[] = ['publish_content', 'update_website_page', 'send_marketing_email', 'create_account', 'run_ad_campaign', 'make_purchase', 'delete_data']



const COST_CEILINGS = Object.values(POLICY_RULES)
  .filter((rule) => rule.autonomousCostCeilingCents > 0)
  .map((rule) => ({ action: rule.action, ceiling: rule.autonomousCostCeilingCents }))

export default async function SafetyPage() {
  const session = await getSession().catch(() => null)
  const prohibited = Object.values(POLICY_RULES)
    .filter((rule) => rule.risk === 'prohibited')
    .map((rule) => rule.action)
  const highRisk = Object.values(POLICY_RULES)
    .filter((rule) => rule.risk === 'high')
    .map((rule) => rule.action)
  const mediumRisk = Object.values(POLICY_RULES)
    .filter((rule) => rule.risk === 'medium')
    .map((rule) => rule.action)

  return (
    <div className="min-h-screen bg-ink-50">
      <SiteNav signedIn={Boolean(session)} />

      <section className="border-b border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <SectionHeading
            eyebrow="Safety & limits"
            title="What AIBA is allowed to do — and what it will never do"
            description="This page is generated from the same policy table the server enforces at runtime. Prohibited actions are disabled in code; they cannot be switched on by a setting, a prompt or an environment variable."
          />
          <div className="mt-8 flex flex-wrap gap-3 text-xs">
            <Link href="/how-it-works" className="rounded-lg border border-ink-200 bg-white px-4 py-2.5 font-medium text-ink-800 hover:bg-ink-50">How the loop runs</Link>
            <Link href="/pricing" className="rounded-lg border border-ink-200 bg-white px-4 py-2.5 font-medium text-ink-800 hover:bg-ink-50">Plans</Link>
            <Link href="/api-docs" className="rounded-lg border border-ink-200 bg-white px-4 py-2.5 font-medium text-ink-800 hover:bg-ink-50">REST API</Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <SectionHeading
          eyebrow="Permanently disabled"
          title="Prohibited actions"
          description="If the policy engine sees one of these action types it returns allowed: false, requiresApproval: false and risk: prohibited. The reason is fixed: permanently disabled. An unknown action name also fails closed."
        />
        <div className="mt-8 flex flex-wrap gap-2">
          {prohibited.map((action) => (
            <span key={action} className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 font-mono text-[11px] text-red-800">{action}</span>
          ))}
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Callout tone="warning" title="No unauthorised access of any kind">
            No bypassing authentication, CAPTCHAs or paywalls, no scraping private information, no violating the terms of a site or API, and no
            publishing copyrighted material without a licence. These are not “off by default” — there is no code path that performs them.
          </Callout>
          <Callout tone="warning" title="No deception, no manipulation">
            No fake accounts, no human impersonation, no bulk spam, no fabricated reviews, no deceptive content and no platform-manipulation tactics.
            Generated marketing copy is scanned for prohibited claims before it can be shown to you as ready.
          </Callout>
          <Callout tone="warning" title="No financial or resource abuse">
            No automated financial trades, no crypto mining, no unauthorised purchases and no spending beyond the limits you configured.
          </Callout>
          <Callout tone="warning" title="No guaranteed income language">
            The generated-content policy also blocks claims of guaranteed profit, guaranteed income or “money while you do nothing”. Reports and
            projections are labelled as estimates until a real, verified transaction replaces them.
          </Callout>
        </div>
      </section>

      <section className="border-y border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <SectionHeading
            eyebrow="Approval gates"
            title="Actions that always wait for a human"
            description="These actions are allowed by policy but never executed by the software. They create an approval request containing the action, the reason, the expected cost, the expected benefit, the risk and the exact payload."
          />
          <div className="mt-8 flex flex-wrap gap-2">
            {[...new Set([...APPROVAL_HIGH, ...highRisk, ...mediumRisk])].sort().map((action) => (
              <span key={action} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 font-mono text-[11px] text-amber-900">{action}</span>
            ))}
          </div>
          <div className="mt-8">
            <Callout tone="info" title="Approving records your authorisation">
              For creating accounts, making purchases, running ad campaigns and financial actions, approving a request marks it as authorised and
              tracked for you to carry out. AIBA does not log into third-party accounts, spend your money or place trades on your behalf.
            </Callout>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <SectionHeading
          eyebrow="Money"
          title="Budget limits are enforced before a cent moves"
          description="Every paid action declares its estimated cost. The budget check runs in the database against the current ledger, and includes your daily limit, monthly limit, per-project ceiling, per-agent daily ceiling and the platform ceiling from MAX_DAILY_AI_SPEND_CENTS."
        />
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          <div className="surface p-5">
            <p className="text-sm font-medium text-ink-900">Order of operations</p>
            <ol className="mt-3 space-y-2 text-xs text-ink-600">
              <li>1. Declare the estimated cost of the action.</li>
              <li>2. Evaluate the action against the policy table.</li>
              <li>3. Check the ledger against every applicable limit.</li>
              <li>4. Over the limit? Stop, create an approval request, notify you.</li>
              <li>5. Otherwise write the debit and run the action.</li>
            </ol>
          </div>
          <div className="surface p-5">
            <p className="text-sm font-medium text-ink-900">Metered cost ceilings</p>
            <ul className="mt-3 space-y-2 text-xs text-ink-600">
              {COST_CEILINGS.map((row) => (
                <li key={row.action} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[11px] text-ink-500">{row.action}</span>
                  <span className="text-ink-800">${(row.ceiling / 100).toFixed(2)} per run</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="surface p-5">
            <p className="text-sm font-medium text-ink-900">Honest numbers</p>
            <ul className="mt-3 space-y-2 text-xs text-ink-600">
              <li>Revenue is counted only from provider-verified rows or entries you labelled as manual.</li>
              <li>Anything projected carries an <em>estimate</em> label until verified.</li>
              <li>Demo data is stored with a demo flag, badged in the interface and excluded from real totals.</li>
              <li>Costs are recorded as they are incurred, not estimated after the fact.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="border-t border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <SectionHeading
            eyebrow="Security"
            title="How your data and credentials are handled"
            description="AIBA is designed to run on infrastructure you control. It will start and work with no third-party credentials at all — features that need one simply report themselves as not configured."
          />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <Callout tone="info" title="Passwords and sessions">
              Passwords are hashed with scrypt and a per-user salt — never stored in plain text, never logged. Sessions are signed HTTP-only cookies,
              with a double-submit CSRF token on every mutating request. Repeated failed sign-ins lock the account temporarily.
            </Callout>
            <Callout tone="info" title="Secrets stay on the server">
              Credentials live only in the server environment. The interface shows whether a variable is present — never its value. Nothing secret is
              exposed to the browser, and no secret is written into the database or into source code.
            </Callout>
            <Callout tone="info" title="Every change is attributable">
              Approval decisions, plan and price changes, source permission changes and administrative actions are written to an append-only audit
              trail with the acting user id and timestamp.
            </Callout>
            <Callout tone="info" title="You can leave with your data">
              The schema is a completely standard relational design with a single initialisation migration, plus a documented backup and restore
              procedure and an exportable project bundle. There is no lock-in format.
            </Callout>
          </div>

          <div className="mt-10">
            <p className="text-xs font-semibold tracking-wide text-ink-500 uppercase">Optional integrations</p>
            <p className="mt-2 max-w-3xl text-xs text-ink-500">
              Each integration below is optional. Configure it by adding the named environment variable to the server and restarting the web process and
              the worker. The credential never passes through the browser.
            </p>
            <div className="mt-4 overflow-hidden rounded-xl border border-ink-200">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-ink-50 text-ink-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Service</th>
                    <th className="px-4 py-3 font-medium">Credential</th>
                    <th className="px-4 py-3 font-medium">Environment variable</th>
                    <th className="px-4 py-3 font-medium">Required?</th>
                  </tr>
                </thead>
                <tbody>
                  {SERVICE_CREDENTIALS.map((entry) => (
                    <tr key={entry.envVar} className="border-t border-ink-200">
                      <td className="px-4 py-2.5 text-ink-800">{entry.service}</td>
                      <td className="px-4 py-2.5 text-ink-600">{entry.credential}</td>
                      <td className="px-4 py-2.5 font-mono text-ink-500">{entry.envVar}</td>
                      <td className="px-4 py-2.5 text-ink-600">{entry.required ? 'required for that feature' : 'optional'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}
