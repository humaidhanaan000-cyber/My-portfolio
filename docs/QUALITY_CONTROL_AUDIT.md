# Quality-control audit — 21 items

Run at commit `65b6048` on this checkout (Node 22.22.3, embedded PGlite, no
external credentials). Every claim below names the command or observation that
produced it. When something is not fully verified, it says so.

**Verdict: PASS with documented gaps.** The application builds, starts, connects
to its database, runs background jobs, and completes the core money loop end to
end. It does not fabricate revenue or payments, and it stops at the approval gate
and at budget limits exactly as specified. Remaining gaps are listed in
[Known gaps](#known-gaps) and are integration/UX items, not broken behaviour.

| # | Area | Result |
| --- | --- | --- |
| 1 | Clean install & production build | PASS |
| 2 | TypeScript typecheck | PASS |
| 3 | Unit/integration suite | PASS (10 files, 84 tests) |
| 4 | End-to-end core loop | PASS (19 sections, 158 assertions) |
| 5 | Schema, migrations & rollback | PASS |
| 6 | Seed, bootstrap, first administrator | PASS |
| 7 | Authentication surface | PASS |
| 8 | Cookie & CSRF policy (incl. embedded) | PASS (was broken, fixed + pinned by tests) |
| 9 | Authorization & multi-tenant isolation | PASS |
| 10 | Secret & credential handling | PASS |
| 11 | Rate limiting & abuse controls | PASS |
| 12 | Budget guardrails never bypassed | PASS |
| 13 | Compliance policy engine | PASS |
| 14 | Approval centre & audit trail | PASS |
| 15 | Payments: server-side verification | PASS (unit-tested; live requires Stripe keys) |
| 16 | Revenue integrity & estimate labelling | PASS |
| 17 | Demo/real data isolation | PASS |
| 18 | Queue & job reliability | PASS (regression fixed) |
| 19 | Scheduler & worker liveness | PASS |
| 20 | Observability: health, logs, admin, alerts | PASS |
| 21 | Performance & scalability hygiene | PASS with caveats |

---

## 1. Clean install & production build — PASS

```bash
npm ci && npm run build
```

`✓ Compiled successfully` (Next.js 15.5.25, standalone output). No database is
required at build time: every data-touching route is `force-dynamic`. The Docker
image builds from the same source (`Dockerfile`, multi-stage, non-root user
`aiba`, `tini` for signal handling).

## 2. TypeScript typecheck — PASS

```bash
npx tsc --noEmit      # no diagnostics
```

Zero errors and zero `@ts-ignore`/`any` escapes introduced in the auth, budget,
policy, payments or queue modules.

## 3. Unit/integration suite — PASS

```bash
npx vitest run
# Test Files 10 passed (10) | Tests 84 passed (84)
```

Coverage by risk: `security` (12) — password hashing, token single-use, HMAC
signatures, constant-time comparison, rate limiting, cross-workspace denial;
`payments` (11) — webhook signature verification and event idempotency;
`scoring` (11) — deterministic, explainable scoring; `db-auth` (9) — database-level
authorisation; `policy` (9) — prohibited and high-risk action classification;
`budget` (8) — hard-limit arithmetic and reservation/release; `queue` (7) —
de-duplication across terminal states; `scheduler-claim` (6) — due-claim and
stale re-arm; `workflows` (6) — transition legality; `cookie-policy` (5) —
session/CSRF cookie parity, cross-site mode, client cookie-name fallback.

## 4. End-to-end core loop — PASS

```bash
npm run test:e2e      # Sections: 19 | Result: 158 passed, 0 failed
```

The 19 sections walk the real loop against a real database: migrations and
workspace bootstrap → auth → policy → scoring → research against a live HTTP feed
→ analysis → strategy → approval decision with budget reservation → execution,
assets and launch gate → revenue verification, profit and projections → hard
budget limits → workflow engine and job queue → learning and memory → monitoring,
alerts and notifications → daily/weekly reports → system status and the full
autonomous cycle → demo isolation → agent run ledger → runtime guards (timeouts,
cancellation, unknown agents).

## 5. Schema, migrations & rollback — PASS

```bash
npm run db:migrate -- --dry-run     # lists pending, changes nothing
npm run db:migrate                  # applies in order, idempotent
npm run db:migrate -- --rollback    # executes -- +rollback blocks, newest first
npm run docs:schema                 # regenerates docs/SCHEMA.md
```

42 tables / 637 columns, documented in [SCHEMA.md](SCHEMA.md). A migration without
a rollback block is reported (`no rollback block defined`) instead of being
silently skipped, and migrations are recorded so repeated runs are no-ops.

## 6. Seed, bootstrap, first administrator — PASS

`npm run db:seed` is idempotent and creates the plan catalogue (free/pro/business),
the nine agents, research sources, the ten cron schedules and an administrator
account. A newly registered user gets a workspace, a budget profile with the
documented defaults (500¢ daily / 5000¢ monthly / 20000¢ per project / 2000¢ per
agent) and an audit trail. Bootstrap is covered by e2e section 1.

## 7. Authentication surface — PASS

Verified live on the running server: registration (single counted attempt, no
retry storm — the auth rate limit is 10 calls / 300 s per IP), sign-in → `200`
with `next: /onboarding`, session cookie set, protected pages `/dashboard`,
`/dashboard/approvals`, `/dashboard/agents` → `200`, sign-out → `200`,
re-sign-in → `200`, wrong password → `401 "Email or password is incorrect."`,
forgot-password → `200` with a real reset link written to the mail outbox,
email-verification tokens single-use. Sessions are hashed at rest
(`hashToken`) and revocation is server-side.

## 8. Cookie & CSRF policy — PASS (this was broken; fixed and pinned)

Three real defects were found by testing in a browser-like setup and are now
covered by `tests/cookie-policy.test.ts`:

1. the session cookie was hardcoded `SameSite=Lax`; inside a cross-site frame the
   browser dropped it, so sign-in appeared to do nothing;
2. `/api/csrf` hardcoded `SameSite=lax` on its own cookie, so the double-submit
   token was dropped and every mutation answered `403 forbidden`;
3. the browser client looked the CSRF cookie up under a fixed name, which stops
   matching once the server prefixes it with `__Host-`.

Now: `COOKIE_SAMESITE=lax|strict|none` (`none` forces `Secure` + `Partitioned`),
`Secure` derived from configuration **and** `x-forwarded-proto`, session and CSRF
cookies written from one shared policy, deletions use the same attributes, and the
client falls back to the token in the `/api/csrf` body. Live proof:
`__Host-aiba_csrf=…; Path=/; Secure; SameSite=none; Partitioned`, body token equals
cookie, mutating `POST` returns `200`.

## 9. Authorization & multi-tenant isolation — PASS

Every query is scoped to the session's workspace; cross-workspace reads are denied
(`tests/db-auth.test.ts`, e2e). Admin endpoints are gated by `requireAdmin()`.
Row-level checks exist on approval decisions, budget reservations and exports.

## 10. Secret & credential handling — PASS

- No plaintext passwords: scrypt with per-password salt, verified in
  `security.test.ts`.
- No secrets in the client: no file under `src/` that contains `'use client'`
  imports `src/lib/env.ts`; only `publicConfig()` values cross the boundary.
- No credentials in source: a scan for key-shaped literals
  (`sk-…`, `whsec_…`, `AIza…`) in `src/` and `scripts/` finds only the deliberate
  test fixtures in the test suite.
- `.env` is gitignored; `.env.example` documents every variable with no values.

## 11. Rate limiting & abuse controls — PASS

Auth endpoints: 10 calls / 300 s per IP (observed as
`429 rate_limited "Too many requests. Retry in …s."` during probing — proof the
limiter works). API: 240 requests / minute. Public endpoints: 60 / minute.
Registration can be switched off entirely (`ALLOW_REGISTRATION=false`) and email
verification can be required (`REQUIRE_EMAIL_VERIFICATION=true`).

## 12. Budget guardrails never bypassed — PASS

Hard limits are enforced in `authorizeSpend()` before any paid action: cost →
budget check → over limit **stops**, creates a spending approval request and
notifies. Daily, monthly, per-project and per-agent ceilings are all evaluated,
plus `MAX_DAILY_AI_SPEND_CENTS`. Verified by `tests/budget.test.ts` and e2e section
11 ("the project budget comes from the profile ceiling, not from AI";
"over-budget work creates a spending approval request instead of spending").
There is no code path that spends past a limit.

## 13. Compliance policy engine — PASS

`evaluateAction()` classifies every action before it runs. Prohibited: financial
trading, crypto mining, scraping private data, CAPTCHA bypass, paywall bypass,
bulk scraping, posting reviews. High-risk → approval required: publishing content,
updating a website page, marketing email, creating accounts, ad campaigns,
purchases, data deletion. Spending ceilings per action type are defined. Content
containing guaranteed-income claims is flagged and rewritten by `sanitizeClaims`.
Covered by `tests/policy.test.ts` and e2e section 3.

## 14. Approval centre & audit trail — PASS

Approval requests carry action type, project, reason, expected cost, expected
benefit, risk and full payload, with APPROVE / REJECT / EDIT / DEFER, and every
decision writes an audit entry. e2e section 8 covers decision → budget
reservation → execution; live verification produced real approval rows
(`actionType: create_project`, `publish_content`).

## 15. Payments: server-side verification — PASS (unit) / NEEDS KEYS (live)

`tests/payments.test.ts` (11 tests) covers signature verification against the
webhook secret, rejection of tampered payloads, event-id idempotency and
subscription state transitions. A browser "payment succeeded" redirect is never
trusted. `PAYMENT_PROVIDER=demo` simulates the *flow only* and is labelled as
demo everywhere. A live Stripe charge requires your own keys
([INTEGRATIONS.md §4](INTEGRATIONS.md)) — the code path is complete, the
credential is not mine to invent.

## 16. Revenue integrity & estimate labelling — PASS

Revenue enters only from (a) a provider-verified webhook or (b) a manual entry
recorded as manual. Every projection is labelled `estimate`/`projection` in the
API payload and in the UI. Revenue, fees, AI cost, net, margin and ROI are
computed from stored rows, never inferred. e2e section 10 verifies this chain
including profit and projection labelling.

## 17. Demo/real data isolation — PASS

Demo rows live in a demo workspace with `isDemo = true` and `demo:*` providers;
analytics returns `scope: 'real' | 'demo'` plus a separate `demoSummary`, and the
UI renders a persistent **DEMO DATA** badge. e2e section 17 asserts: demo revenue
exists, is excluded from the real overview, every demo row carries the demo
provider, demo cleanup does not touch real data, and real revenue survives demo
cleanup.

## 18. Queue & job reliability — PASS

Jobs de-duplicate on a partial unique index over live rows only
(`UNIQUE (dedupe_key) WHERE status IN ('queued','running')`), so a key is reusable
once terminal and several `failed`/`dead` rows for one key are legal. This fixed a
real bug where the second completion of a keyed job was dead-lettered as a
duplicate. Retries honour `JOB_MAX_ATTEMPTS` with backoff; `JOB_DEFAULT_TIMEOUT_MS`
bounds runtime; `tests/queue.test.ts` pins the index behaviour. Live job log shows
`reports.daily`, `email.flush`, `maintenance.cleanup`, `agent.monitoring` and
`agent.product`/`agent.content` succeeding.

## 19. Scheduler & worker liveness — PASS

The scheduler claims due schedules with a Redis/DB leader lock
(`claimDueSchedules`, `rearmStalledSchedules`), so exactly one instance dispatches
each tick and crashed locks are re-armed rather than lost. Ten recurring jobs are
seeded. Workers write heartbeats surfaced by `/api/health`
(`workers[].lastHeartbeatAt`) and by the admin panel. Single-process mode runs the
same code in-process (`inline-worker-web-<pid>`, `scheduler-web-inline-<pid>`),
which is what keeps a bare-metal install alive with no extra containers.

## 20. Observability: health, logs, admin, alerts — PASS

`/api/health` returns `status: ok | degraded | error` with database, migrations,
Redis, queue counters, worker heartbeats and AI configuration — booleans and
latencies only, no secrets — and is wired into both the container `HEALTHCHECK`
and Compose. Structured JSON logs carry service, component, job id, worker id and
duration. `/dashboard/admin` exposes users, agents, jobs, queues, opportunities,
projects, approvals, revenue, expenses, API usage, logs, errors and audit.
Alerts are raised for job failures, budget stops, worker staleness and monitoring
anomalies. Current honest state on this checkout: `degraded` **only** because
`ai.configured=false`.

## 21. Performance & scalability hygiene — PASS with caveats

- Every list endpoint is paginated (`paginationSchema`, default 25, max 200) with
  `limit`/`page`/`offset`/`cursor`/`q`/`sort`/`order`; dashboards aggregate in SQL
  rather than loading tables into memory.
- Agent runs are bounded by per-action cost ceilings, `AI_MAX_TOKENS`,
  `AI_TIMEOUT_MS` and `JOB_DEFAULT_TIMEOUT_MS`, with cancellation support
  (e2e section 19).
- Indexes exist on the hot paths (jobs by status/dedupe, opportunities by
  workspace/score, revenue by workspace/date, sessions by token hash).
- **Caveat:** the embedded PGlite driver is single-process by design — it is the
  right choice for one operator and the wrong choice for scale-out, where
  PostgreSQL is used (the code detects and refuses unsafe multi-process PGlite
  combinations rather than corrupting data).
- **Caveat:** no load test was run; throughput figures are not claimed.

---

## Known gaps

Honest, current, and not disguised as features:

1. **AI, live research, real email, real payments and cloud storage need your
   credentials.** Without them the app runs deterministically, says
   `DEGRADED` with the reason, and never invents a result. In this sandbox there
   is no outbound network, so research sources log `fetch failed`.
2. **No live marketplace/ad-platform publishing.** Publishing is an
   approval-gated action that stops until you connect a provider — deliberate.
3. **`/dashboard/ai` is not implemented** (404). AI status is shown in
   `/dashboard/settings`, `/dashboard/admin` and `/api/health`.
4. **Accessibility is a baseline, not an audit**: form fields are labelled through
   a wrapping `<label>` in the `Field` primitive, icon-only buttons carry
   `aria-label`, and only a couple of elements use explicit ARIA roles. A full
   WCAG pass (contrast ratios, focus order, screen-reader walkthrough) has not
   been performed.
5. **Mobile layout is verified by markup and smoke checks, not by a device
   matrix.** The shell switches to a drawer below `lg`, tables scroll
   horizontally, and breakpoint classes are used in 28 components; no screenshot
   regression suite exists.
6. **The e2e suite is API-level, not browser-level.** Browser-only defects (like
   the three cookie bugs above) therefore need a real browser or an embedded
   harness to be caught; those specific cases are now pinned by unit tests.
7. **Terms of Service and Privacy Policy pages are not included.** Publishing them
   is item 13 of the launch checklist.
8. **A live payment, a real withdrawal and a real payout have not been executed**
   — doing so requires the operator's own payment account.

## Reproducing this audit

```bash
npx tsc --noEmit && npm run build
npx vitest run
npm run test:e2e
npm run agent &            # then: curl -s localhost:3000/api/health | jq
python3 /tmp/uismoke.py <password>    # 62 checks over the running app (this checkout)
```
