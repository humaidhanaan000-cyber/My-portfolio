import type { Metadata } from 'next'
import Link from 'next/link'
import { Callout, SectionHeading, SiteFooter, SiteNav } from '@/components/landing'
import { getSession } from '@/lib/auth'
import { publicConfig } from '@/lib/env'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'REST API reference',
  description:
    'Every AIBA endpoint with its method, authentication requirement and purpose: auth, users, agents, opportunities, projects, workflows, approvals, revenue, expenses, budgets, analytics, notifications, billing, settings, reports, timeline and health.',
  alternates: { canonical: '/api-docs' },
}

type Endpoint = {
  group: string
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  auth: 'public' | 'session' | 'session + csrf' | 'admin'
  purpose: string
}

const ENDPOINTS: Endpoint[] = [
  // auth
  { group: 'Auth', method: 'POST', path: '/api/auth/register', auth: 'public', purpose: 'Create an account and workspace. Rejects weak passwords and enforces the plan member limit. Returns the session cookie on success.' },
  { group: 'Auth', method: 'POST', path: '/api/auth/login', auth: 'public', purpose: 'Sign in. Rate limited, with temporary lockout after repeated failures.' },
  { group: 'Auth', method: 'POST', path: '/api/auth/logout', auth: 'session + csrf', purpose: 'Destroy the current session and clear the session cookie.' },
  { group: 'Auth', method: 'GET', path: '/api/auth/session', auth: 'public', purpose: 'Current session, or `{ user: null }` when signed out. Used by the dashboard guard.' },
  { group: 'Auth', method: 'POST', path: '/api/auth/forgot-password', auth: 'public', purpose: 'Begin a password reset. Always answers 200 so account existence is not disclosed.' },
  { group: 'Auth', method: 'POST', path: '/api/auth/reset-password', auth: 'public', purpose: 'Complete a reset with a single-use, expiring token.' },
  { group: 'Auth', method: 'POST', path: '/api/auth/verify-email', auth: 'public', purpose: 'Consume an email verification token.' },
  { group: 'Auth', method: 'POST', path: '/api/auth/change-password', auth: 'session + csrf', purpose: 'Change the password of the signed-in user after verifying the current one.' },
  { group: 'Auth', method: 'GET', path: '/api/csrf', auth: 'public', purpose: 'Issue the double-submit CSRF cookie required by every mutating request.' },

  // users & onboarding
  { group: 'Users', method: 'GET', path: '/api/users', auth: 'session', purpose: 'Signed-in member, workspace and profile.' },
  { group: 'Users', method: 'PATCH', path: '/api/users', auth: 'session + csrf', purpose: 'Update name, timezone, currency, risk tolerance, automation level, skill/interest lists and budget ceilings.' },
  { group: 'Users', method: 'GET', path: '/api/onboarding', auth: 'session', purpose: 'Five-step wizard state with the completion flags for the current workspace.' },
  { group: 'Users', method: 'PATCH', path: '/api/onboarding', auth: 'session + csrf', purpose: 'Submit a wizard step. Automation level defaults to approval-required.' },

  // agents
  { group: 'Agents', method: 'GET', path: '/api/agents', auth: 'session', purpose: 'Agent roster with enablement, status, success/failure counters, daily run caps and cost ceilings.' },
  { group: 'Agents', method: 'PATCH', path: '/api/agents', auth: 'session + csrf', purpose: 'Enable or disable an agent and adjust its caps (bounded by the plan).' },
  { group: 'Agents', method: 'POST', path: '/api/agents/{key}/run', auth: 'session + csrf', purpose: 'Run one agent immediately. Policy and budget are evaluated first; the run is recorded with its cost.' },
  { group: 'Agents', method: 'GET', path: '/api/agents/runs', auth: 'session', purpose: 'Paginated agent run history with duration, cost and result.' },

  // opportunities
  { group: 'Opportunities', method: 'GET', path: '/api/opportunities', auth: 'session', purpose: 'Paginated, filterable list: score range, category, source, status, minimum demand/profit. Never loads the whole table.' },
  { group: 'Opportunities', method: 'POST', path: '/api/opportunities', auth: 'session + csrf', purpose: 'Add an opportunity manually, or run the discovery agent across permitted sources.' },
  { group: 'Opportunities', method: 'GET', path: '/api/opportunities/{id}', auth: 'session', purpose: 'One opportunity with its ten sub-scores, weights used, source provenance and linked project.' },
  { group: 'Opportunities', method: 'PATCH', path: '/api/opportunities/{id}', auth: 'session + csrf', purpose: 'Update operator-owned fields (notes, category, archive state).' },
  { group: 'Opportunities', method: 'POST', path: '/api/opportunities/{id}/score', auth: 'session + csrf', purpose: 'Score or re-score an opportunity. Stores the weights used so the result is explainable.' },
  { group: 'Opportunities', method: 'POST', path: '/api/opportunities/{id}/strategy', auth: 'session + csrf', purpose: 'Generate a strategy: positioning, pricing, task list and a cost estimate labelled as an estimate.' },
  { group: 'Opportunities', method: 'POST', path: '/api/opportunities/{id}/decision', auth: 'session + csrf', purpose: 'Approve, reject or archive. Approving may create a project, which itself raises an approval request.' },

  // projects
  { group: 'Projects', method: 'GET', path: '/api/projects', auth: 'session', purpose: 'Project list with the twelve lifecycle states, paginated and filterable.' },
  { group: 'Projects', method: 'GET', path: '/api/projects/{id}', auth: 'session', purpose: 'Project detail: state history, assets, tasks, revenue and cost attributed to it.' },
  { group: 'Projects', method: 'PATCH', path: '/api/projects/{id}', auth: 'session + csrf', purpose: 'Change state, budget or metadata. Illegal state transitions are rejected.' },
  { group: 'Projects', method: 'GET', path: '/api/projects/{id}/assets', auth: 'session', purpose: 'Generated content and product assets with their review state.' },
  { group: 'Projects', method: 'POST', path: '/api/projects/{id}/assets', auth: 'session + csrf', purpose: 'Create or edit a draft asset. Drafts are never published automatically.' },
  { group: 'Projects', method: 'GET', path: '/api/projects/{id}/tasks', auth: 'session', purpose: 'Project task list with owners, status and recorded cost.' },
  { group: 'Projects', method: 'POST', path: '/api/projects/{id}/tasks', auth: 'session + csrf', purpose: 'Create, assign or complete a task.' },
  { group: 'Projects', method: 'POST', path: '/api/projects/{id}/launch', auth: 'session + csrf', purpose: 'Launch a project after explicit confirmation. This is a permanently approval-gated action.' },
  { group: 'Projects', method: 'POST', path: '/api/projects/{id}/export', auth: 'session + csrf', purpose: 'Export the project bundle (assets, tasks, notes) so you keep your work outside AIBA.' },

  // workflows
  { group: 'Workflows', method: 'GET', path: '/api/workflows', auth: 'session', purpose: 'Workflow definitions, recent runs, seeded schedules, templates and the node catalogue.' },
  { group: 'Workflows', method: 'POST', path: '/api/workflows', auth: 'session + csrf', purpose: 'Create a workflow from a node/edge graph with a cron schedule. Cycles are rejected.' },
  { group: 'Workflows', method: 'GET', path: '/api/workflows/{id}', auth: 'session', purpose: 'One workflow with its definition and complete run history including per-step results.' },
  { group: 'Workflows', method: 'PATCH', path: '/api/workflows/{id}', auth: 'session + csrf', purpose: 'Rename, change schedule, pause or resume a workflow.' },
  { group: 'Workflows', method: 'DELETE', path: '/api/workflows/{id}', auth: 'session + csrf', purpose: 'Archive a workflow. History is retained.' },
  { group: 'Workflows', method: 'PUT', path: '/api/workflows', auth: 'session + csrf', purpose: 'Run a workflow now, synchronously or queued, with an optional dry run. Approval gates stop the run and create a request.' },

  // approvals
  { group: 'Approvals', method: 'GET', path: '/api/approvals', auth: 'session', purpose: 'Approval queue with status filters and counts. Each row carries action, reason, expected cost, expected benefit and risk.' },
  { group: 'Approvals', method: 'GET', path: '/api/approvals/{id}', auth: 'session', purpose: 'One approval request with its exact payload and decision history.' },
  { group: 'Approvals', method: 'POST', path: '/api/approvals/{id}', auth: 'session + csrf', purpose: 'Approve, reject, edit, or defer. The decision is written to the audit trail; executing happens server-side only.' },

  // money
  { group: 'Revenue', method: 'GET', path: '/api/revenue', auth: 'session', purpose: 'Overview (today, week, month, all-time, margin, ROI, series) plus a paginated transaction ledger. Demo rows are separate by default.' },
  { group: 'Revenue', method: 'POST', path: '/api/revenue', auth: 'session + csrf', purpose: 'Record revenue manually. The row is stored with verification `manual` and is labelled that way in the interface.' },
  { group: 'Expenses', method: 'GET', path: '/api/expenses', auth: 'session', purpose: 'Paginated expense ledger with a category breakdown.' },
  { group: 'Expenses', method: 'POST', path: '/api/expenses', auth: 'session + csrf', purpose: 'Record an expense. Metered model costs are written automatically by the runtime.' },
  { group: 'Budgets', method: 'GET', path: '/api/budgets', auth: 'session', purpose: 'Current usage against every limit, plus per-scope rows and the plan ceiling.' },
  { group: 'Budgets', method: 'PATCH', path: '/api/budgets', auth: 'session + csrf', purpose: 'Set daily, monthly, per-project and per-agent limits. The request must acknowledge that the limits are hard.' },
  { group: 'Analytics', method: 'GET', path: '/api/analytics', auth: 'session', purpose: 'Financial, business, opportunity-engine, conversion and success-rate analytics with charts and a demo summary. `?demo=true|only` selects demo scoping.' },
  { group: 'Reports', method: 'GET', path: '/api/reports', auth: 'session', purpose: 'Stored daily and weekly reports.' },
  { group: 'Reports', method: 'POST', path: '/api/reports', auth: 'session + csrf', purpose: 'Generate a daily or weekly report now, optionally with an AI-written summary. Projections are labelled as estimates.' },

  // notifications
  { group: 'Notifications', method: 'GET', path: '/api/notifications', auth: 'session', purpose: 'Inbox, unread counts, open alerts and the delivery status of each channel.' },
  { group: 'Notifications', method: 'PATCH', path: '/api/notifications', auth: 'session + csrf', purpose: 'Mark notifications read by id, or all at once.' },
  { group: 'Notifications', method: 'POST', path: '/api/notifications', auth: 'session + csrf', purpose: 'Send a test message through email, browser or Telegram and report the real delivery result.' },
  { group: 'Notifications', method: 'POST', path: '/api/notifications/alerts/{id}', auth: 'session + csrf', purpose: 'Acknowledge or resolve a condition alert.' },

  // billing
  { group: 'Billing', method: 'GET', path: '/api/billing', auth: 'session', purpose: 'Current subscription, the active plan, all public plans and the provider configuration state.' },
  { group: 'Billing', method: 'POST', path: '/api/billing/checkout', auth: 'session + csrf', purpose: 'Create a provider checkout session. Returns the provider URL; no local state changes until the webhook verifies.' },
  { group: 'Billing', method: 'POST', path: '/api/billing/portal', auth: 'session + csrf', purpose: 'Create a provider customer-portal session for card and invoice management.' },
  { group: 'Billing', method: 'POST', path: '/api/billing/webhook', auth: 'public', purpose: 'Signed provider webhook. The signature is verified server-side; an invalid or missing secret is rejected with 400/501.' },
  { group: 'Billing', method: 'PATCH', path: '/api/billing/plans', auth: 'admin', purpose: 'Change prices, features or visibility. Prices are configuration, and every change is audited.' },

  // platform
  { group: 'Platform', method: 'GET', path: '/api/settings', auth: 'session', purpose: 'Workspace settings, integration status, credential inventory (presence only, never values) and the scheduler table.' },
  { group: 'Platform', method: 'PATCH', path: '/api/settings', auth: 'session + csrf', purpose: 'Update publish target, demo mode, automation level, risk tolerance, score threshold and notification preferences.' },
  { group: 'Platform', method: 'GET', path: '/api/sources', auth: 'session', purpose: 'Authorised sources, their permission status, rate limits and missing credentials.' },
  { group: 'Platform', method: 'POST', path: '/api/sources', auth: 'session + csrf', purpose: 'Register an authorised source or run a collection scan across the selected ones.' },
  { group: 'Platform', method: 'PATCH', path: '/api/sources', auth: 'session + csrf', purpose: 'Enable or disable a source. Enabling fails with 403 unless the source is marked permitted.' },
  { group: 'Platform', method: 'GET', path: '/api/memory', auth: 'session', purpose: 'Agent memory entries with the retention bound, kind filters and per-agent counts.' },
  { group: 'Platform', method: 'POST', path: '/api/memory', auth: 'session + csrf', purpose: 'Record a memory entry, or summarise older entries into a bounded summary.' },
  { group: 'Platform', method: 'GET', path: '/api/jobs', auth: 'session', purpose: 'Queue depth, per-queue stats and paginated job history.' },
  { group: 'Platform', method: 'POST', path: '/api/jobs', auth: 'session + csrf', purpose: 'Retry, cancel or requeue a job.' },
  { group: 'Platform', method: 'GET', path: '/api/timeline', auth: 'session', purpose: 'One chronological stream of agent runs, approvals, project events, money movements, workflow runs and audit entries.' },
  { group: 'Platform', method: 'GET', path: '/api/dashboard', auth: 'session', purpose: 'Everything the command centre renders: status, agents, money, opportunity counters, approvals, alerts, projects and budget.' },
  { group: 'Platform', method: 'GET', path: '/api/dashboard/status', auth: 'session', purpose: 'Lightweight status payload polled by the dashboard header.' },
  { group: 'Platform', method: 'GET', path: '/api/admin', auth: 'admin', purpose: 'Platform-wide console data: users, agents, queues, jobs, money, API usage, logs, errors, migrations and health.' },
  { group: 'Platform', method: 'GET', path: '/api/demo', auth: 'session', purpose: 'Demo mode state and the separation notice.' },
  { group: 'Platform', method: 'POST', path: '/api/demo', auth: 'session + csrf', purpose: 'Create or clear demo data. Demo rows carry a demo flag and are excluded from real figures.' },
  { group: 'Platform', method: 'GET', path: '/api/health', auth: 'public', purpose: 'Liveness and readiness probe used by Docker health checks: database, queue, migrations, AI and worker heartbeats.' },
  { group: 'Platform', method: 'GET', path: '/api/status', auth: 'public', purpose: 'Public status summary — booleans and counters only, no workspace data.' },
  { group: 'Platform', method: 'GET', path: '/api/storage/{key}', auth: 'session', purpose: 'Serve a stored asset through an authenticated route instead of exposing the bucket.' },
]

const GROUPS = [...new Set(ENDPOINTS.map((endpoint) => endpoint.group))]

const AUTH_TONE: Record<Endpoint['auth'], string> = {
  public: 'border-ink-200 bg-ink-50 text-ink-600',
  session: 'border-accent-200 bg-accent-50 text-accent-700',
  'session + csrf': 'border-emerald-200 bg-emerald-50 text-emerald-700',
  admin: 'border-amber-200 bg-amber-50 text-amber-800',
}

export default async function ApiDocsPage() {
  const session = await getSession().catch(() => null)
  const config = publicConfig()

  return (
    <div className="min-h-screen bg-ink-50">
      <SiteNav signedIn={Boolean(session)} />

      <section className="border-b border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <SectionHeading
            eyebrow="API"
            title="A documented REST API, not an internal side-channel"
            description="Every screen in AIBA is built on the endpoints below. Anything the interface can do, you can automate — with the same authentication, policy checks, budget guardrails and audit trail."
          />
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="surface p-4">
              <p className="text-[11px] font-semibold tracking-wide text-ink-500 uppercase">Base URL</p>
              <p className="mt-1 font-mono text-xs break-all text-ink-800">{config.appUrl}/api</p>
            </div>
            <div className="surface p-4">
              <p className="text-[11px] font-semibold tracking-wide text-ink-500 uppercase">Authentication</p>
              <p className="mt-1 text-xs text-ink-700">HTTP-only signed session cookie, issued by sign-in.</p>
            </div>
            <div className="surface p-4">
              <p className="text-[11px] font-semibold tracking-wide text-ink-500 uppercase">Mutating requests</p>
              <p className="mt-1 text-xs text-ink-700">Require the double-submit header <code className="font-mono">x-csrf-token</code> from the <code className="font-mono">aiba_csrf</code> cookie.</p>
            </div>
            <div className="surface p-4">
              <p className="text-[11px] font-semibold tracking-wide text-ink-500 uppercase">Rate limits</p>
              <p className="mt-1 text-xs text-ink-700">Per-route ceilings; exceeded requests return <code className="font-mono">429 rate_limited</code>.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="surface p-5 lg:col-span-2">
            <p className="text-sm font-medium text-ink-900">Response envelope</p>
            <p className="mt-1 text-xs text-ink-500">Success responses always carry <code className="font-mono">data</code>, plus <code className="font-mono">meta</code> for paginated lists.</p>
            <pre className="mt-3 overflow-auto rounded-lg bg-ink-900 p-3 text-[11px] text-ink-100">{`{
  "data": { ... },
  "meta": { "page": 1, "limit": 25, "total": 128, "totalPages": 6 }
}`}</pre>
            <p className="mt-4 text-sm font-medium text-ink-900">Error envelope</p>
            <pre className="mt-2 overflow-auto rounded-lg bg-ink-900 p-3 text-[11px] text-ink-100">{`{
  "error": {
    "code": "budget_blocked",
    "message": "Blocked by Daily AI budget: 500 of 500 cents already spent.",
    "details": { "action": "generate_content", "amountCents": 150 }
  }
}`}</pre>
          </div>
          <div className="surface p-5">
            <p className="text-sm font-medium text-ink-900">Error codes</p>
            <ul className="mt-2 space-y-1.5 text-[11px] text-ink-600">
              {[
                ['unauthorized', '401 — no valid session'],
                ['forbidden', '403 — wrong role, or the action is prohibited'],
                ['not_found', '404 — unknown id in this workspace'],
                ['conflict', '409 — state conflict (e.g. duplicate email)'],
                ['validation_error', '422 — request body failed validation'],
                ['rate_limited', '429 — too many requests'],
                ['budget_blocked', '402 — a hard budget limit would be exceeded'],
                ['policy_blocked', '403 — permanently disabled by the policy engine'],
                ['not_configured', '501 — the required credential is missing'],
                ['internal_error', '500 — logged with a request id'],
              ].map(([code, meaning]) => (
                <li key={code} className="flex items-start justify-between gap-3">
                  <code className="font-mono text-ink-800">{code}</code>
                  <span className="text-right text-ink-500">{meaning}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-8 space-y-8">
          {GROUPS.map((group) => (
            <div key={group}>
              <h2 className="text-sm font-semibold tracking-tight text-ink-900">{group}</h2>
              <div className="mt-3 overflow-hidden rounded-xl border border-ink-200 bg-white">
                <table className="w-full text-left text-xs">
                  <thead className="bg-ink-50 text-ink-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Method</th>
                      <th className="px-4 py-3 font-medium">Path</th>
                      <th className="px-4 py-3 font-medium">Access</th>
                      <th className="px-4 py-3 font-medium">Purpose</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ENDPOINTS.filter((endpoint) => endpoint.group === group).map((endpoint) => (
                      <tr key={`${endpoint.method} ${endpoint.path}`} className="border-t border-ink-200 align-top">
                        <td className="px-4 py-3">
                          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${endpoint.method === 'GET' ? 'bg-accent-50 text-accent-700' : endpoint.method === 'DELETE' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
                            {endpoint.method}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] break-all text-ink-800">{endpoint.path}</td>
                        <td className="px-4 py-3">
                          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${AUTH_TONE[endpoint.auth]}`}>{endpoint.auth}</span>
                        </td>
                        <td className="px-4 py-3 text-[11px] text-ink-600">{endpoint.purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          <Callout tone="info" title="Guardrails apply to the API too">
            Calling an endpoint directly does not bypass anything: policy evaluation, budget checks, approval gates and audit logging all run inside the
            route handler. A direct call to publish an asset still stops at the approval gate.
          </Callout>
          <Callout tone="info" title="Pagination and performance">
            List endpoints accept <code className="font-mono text-[11px]">page</code> and <code className="font-mono text-[11px]">limit</code> and return
            totals in <code className="font-mono text-[11px]">meta</code>. The interface never downloads full tables — dashboards use aggregate queries and
            paginated lists.
          </Callout>
          <Callout tone="warning" title="No secret is ever returned">
            Credentials are read from the server environment only. Endpoints that report integration state return booleans and the environment variable
            name — never a value.
          </Callout>
          <div className="surface p-5">
            <p className="text-sm font-medium text-ink-900">Try it</p>
            <p className="mt-1 text-xs text-ink-500">A signed-in session in this browser already carries the cookie. Fetch the status endpoint to see the envelope:</p>
            <pre className="mt-3 overflow-auto rounded-lg bg-ink-900 p-3 text-[11px] text-ink-100">{`curl -s ${config.appUrl}/api/status | jq

curl -s -X PATCH ${config.appUrl}/api/budgets \\
  -H 'content-type: application/json' \\
  -H "x-csrf-token: $AIBA_CSRF" \\
  --cookie "aiba_session=$AIBA_SESSION" \\
  -d '{"dailyBudgetCents":500,"acknowledgeHardLimits":true}'`}</pre>
            <Link href="/dashboard" className="mt-3 inline-block text-[11px] text-accent-700 hover:underline">
              Open the dashboard and inspect the network tab
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}
