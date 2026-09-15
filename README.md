# AIBA — Autonomous Internet Business Agent

AIBA is a self-hosted, production-grade web application that runs an autonomous
business loop for you: it researches opportunities, scores them, builds a
strategy, turns an approved strategy into a project, executes the work through
scheduled agents, tracks real revenue and costs against hard budget limits, and
feeds what it learns back into the next decision.

It is **not** a mockup, a static demo, or a wall of fake buttons. Every screen is
backed by a REST API, a database row, and a worker job. Every number on the
dashboard comes from a query you can reproduce.

- **Stack** — Next.js 15 (App Router) + TypeScript + Tailwind 4, REST API in
  Next route handlers, queue worker and cron scheduler as separate processes.
- **Database** — PostgreSQL for real deployments, or the embedded PGlite engine
  for single-node/self-hosted use. 42 tables, Drizzle ORM, versioned SQL
  migrations.
- **Runs without your PC** — designed for `docker compose up -d` on a cloud VM
  or VPS; the web app, worker and scheduler keep running after you close your
  laptop.
- **Honest by construction** — no fabricated revenue, no fabricated payments, no
  guaranteed income claims, demo data never mixed with real money.

---

## Table of contents

1. [Quick start (one command)](#quick-start-one-command)
2. [What the system does](#what-the-system-does)
3. [The core loop](#the-core-loop)
4. [Screens](#screens)
5. [REST API](#rest-api)
6. [Configuration](#configuration)
7. [External services (credentials)](#external-services-credentials)
8. [Deploying to a server](#deploying-to-a-server)
9. [Testing](#testing)
10. [Demo mode vs. real mode](#demo-mode-vs-real-mode)
11. [Safety, policy and legal boundaries](#safety-policy-and-legal-boundaries)
12. [What works today, honestly](#what-works-today-honestly)
13. [Documentation map](#documentation-map)

---

## Quick start (one command)

```bash
git clone https://github.com/humaidhanaan000-cyber/My-portfolio.git
cd My-portfolio
cp .env.example .env          # edit: at minimum set AUTH_SECRET
npm install
npm run agent                 # production build + web app + worker + scheduler
```

Open <http://localhost:3000>, create an account, and finish the 5-step
onboarding wizard. `npm run agent` is the single command: it builds the app,
starts Next.js on `0.0.0.0:3000`, applies database migrations, and runs the queue
worker and cron loop inside the same process (PGlite mode).

### Prefer double-clicking to typing?

Three start files live in the project root. Each one checks Node.js, creates
`.env` on the first run, installs dependencies once, starts the web app together
with the agents, waits until the server answers, and then opens your browser:

| System | File | Note |
| --- | --- | --- |
| Windows | `start-aiba.bat` | Double-click. The server runs in its own window; close it to stop. |
| macOS | `start-aiba.command` | Double-click (right-click → Open the first time). Ctrl+C in Terminal stops it. |
| Linux | `start-aiba.sh` | `chmod +x start-aiba.sh && ./start-aiba.sh`. |

And for opening the console itself, there is a self-contained browser page —
no build, no internet, no install:

**`public/aiba-launcher.html`** — double-click the file, or open
`/aiba-launcher.html` from the running app. It shows whether the server is up
(and its degraded/ok state), gives one-click buttons for the dashboard, sign-in,
registration, landing page, status page and API docs, and remembers a hosted
address (e.g. an Arena preview URL or your own domain) in that browser so you can
reopen it later with one click. It never stores passwords.

Other entry points:

| Command | What it does |
| --- | --- |
| `npm run agent:dev` | Same, with the Next.js dev server and hot reload. |
| `npm run dev` | Web app only (no workers) — UI work. |
| `npm run agent:jobs` | Worker + scheduler only, no web server (PostgreSQL mode). |
| `npm run worker` | Standalone queue worker (18 job handlers, concurrency 4). |
| `npm run scheduler` | Standalone cron scheduler (20 s tick, leader-locked). |
| `npm run db:setup` | Apply migrations and seed plans, agents, sources, schedules. |
| `npm run demo:seed` | Create clearly-labelled demo data in a demo workspace. |
| `npm run cli -- status` | Print platform status, queue depth, budget and worker health. |
| `npm run verify` | TypeScript typecheck + the full unit/integration suite. |

First user to register becomes the platform administrator. The seed script also
creates `admin@aiba.local` when `SEED_ADMIN_PASSWORD` (or the default) is used —
change it immediately in **Settings → Security**.

---

## What the system does

### Nine agents, one pipeline

| Agent | Responsibility |
| --- | --- |
| `research` | Scans configured public sources, saves raw signals. |
| `cleaning` | Normalises, de-duplicates and validates raw signals. |
| `analysis` | Extracts demand, competition, cost and risk signals. |
| `strategy` | Turns an opportunity into a staged business strategy. |
| `product` | Drafts the deliverable: copy, landing content, asset plan. |
| `content` | Produces publishable content drafts with claim checking. |
| `execution` | Runs the workflow steps that build and publish assets. |
| `monitoring` | Watches live projects: uptime, traffic, conversions, anomalies. |
| `learning` | Compares projections with outcomes and adjusts scoring weights. |

### Opportunity engine

Opportunities carry title, category, source, score, demand, competition, cost,
risk, automation potential, monetisation model and discovery date. Each one can
be viewed, analysed, turned into a strategy, approved, rejected or archived. The
scoring model is deterministic, explainable and versioned; the learning agent
adjusts weights from realised outcomes, not from guesses.

### Projects and workflows

Twelve explicit states — `DISCOVERED → ANALYZING → STRATEGY_READY →
WAITING_FOR_APPROVAL → APPROVED → BUILDING → LAUNCHED → MONITORING ⇄ OPTIMIZING`
plus `PAUSED`, `FAILED`, `COMPLETED` — with an enforced transition table, so a
project cannot skip the approval gate. Workflows are built in a visual editor
with a node catalogue, cron or interval schedules (15 min, hourly, 6 h, daily,
weekly, or a custom expression), pause/resume, retry, and manual trigger.

### Money, budgets and approvals

- Revenue and expenses are recorded per workspace with gross, costs, AI spend,
  fees, net, margin and ROI, sliced today / week / month / all-time.
- Budget guardrails are **hard**: daily, monthly, per-project and per-agent
  limits. Every paid action checks cost → checks budget → if it would breach a
  limit it stops, raises an approval request, and notifies you. There is no
  bypass flag; `BUDGET_ENFORCEMENT=false` only exists to disable *automatic*
  spending, not to let the code spend past a limit.
- The approval centre shows action type, project, reason, expected cost, expected
  benefit, risk, and the exact payload, with APPROVE / REJECT / EDIT / DEFER and
  a full audit trail. Default automation level is **approval required**.

### Operations

Notification centre (email, browser, Telegram/webhook channels), agent memory
with summarised, retention-bounded entries, analytics charts, daily and weekly
automatic reports, and an admin panel covering users, agents, jobs, queues,
opportunities, projects, approvals, revenue, expenses, API usage, logs, errors
and health.

---

## The core loop

```
discover → save → analyze → score → strategy → project → user approves
      → workflow executes → assets → launch → monitor → revenue & cost
      → profit → learning → (feeds back into scoring)
```

Every arrow is implemented. The loop is exercised end to end by
`npm run test:e2e` (19 sections, 158 assertions) against a real database, and by
the unit suite (`npm test`, 10 files, 84 tests) covering auth, cookies, budget
enforcement, policy, payments/webhooks, queue deduplication, scheduler claiming,
scoring, workflows and database-level authorisation.

---

## Screens

Public: `/` (landing), `/how-it-works`, `/pricing`, `/safety`, `/status`,
`/api-docs`, `/login`, `/register`, `/forgot-password`, `/reset-password`,
`/verify-email`.

Application: `/onboarding` (5 steps: profile → risk tolerance → budgets →
monetisation preferences → automation level), `/dashboard`,
`/dashboard/opportunities` (+ `/analysis` detail), `/dashboard/projects`
(+ detail), `/dashboard/workflows` (+ detail), `/dashboard/agents`
(+ per-agent), `/dashboard/approvals`, `/dashboard/revenue`,
`/dashboard/expenses`, `/dashboard/budget`, `/dashboard/analytics`,
`/dashboard/reports`, `/dashboard/notifications`, `/dashboard/memory`,
`/dashboard/timeline`, `/dashboard/sources`, `/dashboard/jobs`,
`/dashboard/settings`, `/dashboard/billing`, `/dashboard/users`,
`/dashboard/admin`.

All screens are responsive (mobile → desktop) and follow one dark operations
theme. The design language is deliberately restrained: this is a console for
money, not a marketing page.

---

## REST API

Envelope: success `{ data, meta? }`, error `{ error: { code, message, details? } }`.
Codes: `unauthorized`, `forbidden`, `not_found`, `conflict`, `validation_error`,
`rate_limited`, `budget_blocked` (402), `policy_blocked` (403),
`not_configured` (501), `internal_error`.

| Area | Endpoints |
| --- | --- |
| Auth | `/api/auth/register`, `/login`, `/logout`, `/session`, `/verify-email`, `/forgot-password`, `/reset-password`, `/change-password`, `/api/csrf` |
| Users & onboarding | `/api/users`, `/api/onboarding`, `/api/settings`, `/api/csrf` |
| Agents | `/api/agents`, `/api/agents/:key/run`, `/api/agents/runs` |
| Opportunities | `/api/opportunities`, `/api/opportunities/:id`, `/:id/score`, `/:id/strategy`, `/:id/decision` |
| Projects | `/api/projects`, `/api/projects/:id`, `/:id/tasks`, `/:id/assets`, `/:id/launch`, `/:id/export` |
| Workflows | `/api/workflows`, `/api/workflows/:id` |
| Approvals | `/api/approvals`, `/api/approvals/:id` |
| Money | `/api/revenue`, `/api/expenses`, `/api/budgets` |
| Analytics & reports | `/api/analytics`, `/api/reports`, `/api/dashboard`, `/api/dashboard/status`, `/api/timeline` |
| Notifications | `/api/notifications`, `/api/notifications/alerts/:id` |
| Ops | `/api/health`, `/api/status`, `/api/jobs`, `/api/admin`, `/api/demo`, `/api/sources`, `/api/memory`, `/api/storage/:key` |
| Billing | `/api/billing`, `/api/billing/plans`, `/api/billing/checkout`, `/api/billing/portal`, `/api/billing/webhook` |

Every mutating request requires the `x-csrf-token` header matching the
double-submit cookie issued by `GET /api/csrf`. The browser client
(`src/lib/client/api.ts`) does this automatically. Live examples:
`/api-docs` in the running app.

---

## Configuration

All configuration is environment-driven (`src/lib/env.ts`, validated with Zod at
boot — an invalid value is logged loudly rather than silently ignored). See
`.env.example` for every variable with comments. The groups that matter most:

| Group | Keys (abridged) |
| --- | --- |
| Core | `APP_URL`, `APP_NAME`, `AUTH_SECRET`, `SESSION_TTL_HOURS`, `ALLOW_REGISTRATION`, `REQUIRE_EMAIL_VERIFICATION` |
| Cookies / framing | `COOKIE_SECURE`, `COOKIE_SAMESITE=lax\|strict\|none`, `ALLOW_EMBED`, `FRAME_ANCESTORS` |
| Data | `DATABASE_URL` (`postgres://…` or `pglite://./data/pgdata`), `DB_POOL_MAX`, `DB_SSL`, `REDIS_URL` |
| Queue / cron | `WORKER_CONCURRENCY`, `WORKER_POLL_MS`, `ENABLE_INLINE_JOBS`, `ENABLE_SCHEDULER`, `SCHEDULER_TICK_MS`, `JOB_MAX_ATTEMPTS` |
| AI | `AI_PROVIDER`, `AI_PROVIDER_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`, `AI_CHAT_MODEL`, `AI_ALLOW_NETWORK` |
| Payments | `PAYMENT_PROVIDER=stripe\|demo\|none`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYMENT_SUCCESS_URL`, `PAYMENT_CANCEL_URL` |
| Email | `EMAIL_PROVIDER=smtp\|resend\|console\|file`, `SMTP_*`, `EMAIL_FROM`, `EMAIL_OUTBOX_DIR` |
| Storage | `STORAGE_DRIVER=local\|s3\|s3_compatible`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT`, `STORAGE_KEY`, `STORAGE_SECRET` |
| Research | `SOURCE_ALLOW_NETWORK`, `PRODUCTHUNT_TOKEN`, `GITHUB_TOKEN`, `NEWSAPI_KEY`, `RESEARCH_USER_AGENT` |
| Notifications | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `NOTIFY_WEBHOOK_URL` |
| Guardrails | `BUDGET_ENFORCEMENT`, `MAX_DAILY_AI_SPEND_CENTS`, `RATE_LIMIT_*`, `DEMO_MODE_ENABLED` |

**Embedded deployments** (the app served inside a frame on another origin, e.g. a
hosted preview): set `COOKIE_SAMESITE=none` and `ALLOW_EMBED=true`. Browsers drop
`SameSite=Lax` cookies in cross-site frames, which looks exactly like "sign-in
did nothing". With `none`, `Secure` and `Partitioned` are applied automatically
and CSRF protection rests on the double-submit token.

Subscription **prices are configuration, not code**: the `free` / `pro` /
`business` catalogue is seeded into the `plans` table (defaults in
`src/lib/plans/catalogue.ts`) and can be edited by an administrator without a
redeploy. No price is hardcoded into the frontend.

---

## External services (credentials)

Nothing is invented and nothing is required to start: AI, payments, email,
object storage and paid research sources are all optional, and the app tells you
in plain language which integration is missing instead of pretending to work.
Each one is documented in **[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)** in the
format `SERVICE / REQUIRED CREDENTIAL / WHERE TO OBTAIN / ENV VAR /
TEST PROCEDURE` — including how to verify it after you add the key.

**Missing credentials are visible, not hidden.** The dashboard shows
`DEGRADED` with the reason (`ai.configured=false`), the opportunity engine
reports `missingCredentials`, and the sources page lists which collectors are
idle and why.

---

## Deploying to a server

Full playbook: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. The short version:

```bash
# on the server (Ubuntu 22.04+, Docker installed)
git clone https://github.com/humaidhanaan000-cyber/My-portfolio.git && cd My-portfolio
cp .env.example .env      # set POSTGRES_PASSWORD, AUTH_SECRET, APP_URL, COOKIE_SECURE=true
docker compose up -d --build
docker compose logs -f worker
```

That starts four services — `postgres`, `redis`, `web`, `worker` and
`scheduler` — with health checks on every one. The `web` container applies
migrations once (`RUN_MIGRATIONS=true`) before the others start; the worker and
scheduler each run only their own role, so nothing races. Backups, restore,
migration rollback, TLS/cookie setup, log rotation and scaling are all covered in
`docs/DEPLOYMENT.md`.

---

## Testing

```bash
npm run verify        # tsc --noEmit + vitest (10 files, 84 tests)
npm run test:e2e      # end-to-end API/workflow suite (19 sections, 158 assertions)
npm run test:watch    # watch mode
```

Measured on this checkout (Node 22, PGlite):

| Suite | Result |
| --- | --- |
| `npx tsc --noEmit` | no diagnostics |
| `npm run build` | compiled successfully |
| `npx vitest run` | **10 files, 84 tests passed** |
| `npm run test:e2e` | **158 passed, 0 failed** (19 sections) |
| UI smoke script | **62 checks passed, 0 failed** |

The suite deliberately covers the things that break quietly: password hashing
and token single-use, CSRF double-submit, cookie policy (including the embedded
cross-site case), cross-workspace read denial, hard budget blocking, prohibited
action policy, Stripe webhook signature verification and idempotency, job
de-duplication, scheduler claiming, scoring determinism, workflow transitions,
and the full loop end to end.

---

## Demo mode vs. real mode

Demo mode exists so you can explore the engine without touching real money, and
it is **never mixed** with real figures:

- Every demo row is written into a demo workspace, tagged `isDemo = true` and a
  `demo:*` scope; the analytics API returns a `scope` field and the UI renders a
  persistent **DEMO DATA** badge.
- Revenue queries on the real scope exclude demo rows, and demo summaries are
  returned in their own object (`demoSummary`, `revenueByDemo`) so the two
  cannot be summed by accident.
- A real (non-demo) workspace never receives demo rows; `npm run demo:seed`
  creates/uses a separate demo workspace.
- Projections and estimates are labelled as estimates until a verified
  integration or a manual entry marked as `manual` produces actual revenue.

Real revenue enters the system in exactly two ways: a verified payment-provider
webhook (signature checked server-side), or a manual entry you marked as manual.
Nothing else is ever counted as revenue.

---

## Safety, policy and legal boundaries

The compliance engine (`src/lib/compliance`) classifies every action before it
runs and refuses prohibited ones outright:

- **Prohibited** — automated financial trading, crypto mining, scraping private
  data, CAPTCHA/paywall/auth bypass, bulk scraping, posting fake reviews. The
  system stops, explains and asks for a legitimate alternative.
- **High-risk (approval required)** — publishing content, updating a website
  page, sending marketing email, creating accounts, running ad campaigns, making
  purchases, deleting data.
- **Spending ceilings** — research scan 50¢, clean 25¢, analyse 60¢, generate
  assets 150¢, maintenance 50¢, on top of the per-agent and per-project budget you
  configured.

Also enforced in code: passwords are stored as salted scrypt hashes and never
recoverable; secrets are server-side only and never shipped to the browser; no
real credentials appear in the source; content containing guaranteed-income
claims is flagged and rewritten by `sanitizeClaims` before it can be published.

AIBA does **not** promise income, and it is not a "make money while you do
nothing" machine. It removes the repetitive research, planning and reporting
work. The profit still depends on what you approve and what the market does —
which is exactly why the approval gate is on by default.

---

## What works today, honestly

**Works with no external credentials:** the whole application — accounts,
sessions, password reset, email verification (outbox-file delivery), onboarding,
dashboard, opportunity engine (scored from stored signals), strategies,
projects, 12-state lifecycle, workflow builder and runner, approvals, budget
guardrails, revenue/expense ledger, analytics, reports, notifications, agent
memory, admin panel, REST API, scheduler, health checks, demo mode, and the full
core loop.

**Needs a credential (and says so when it is missing):**

| Capability | Needs | Without it |
| --- | --- | --- |
| Real AI reasoning | `AI_PROVIDER_KEY` (OpenAI/Anthropic/OpenRouter) or a local Ollama | Deterministic template agents run; dashboard shows `DEGRADED`, `ai.configured=false` |
| Live research sources | Outbound network + optional `GITHUB_TOKEN`, `PRODUCTHUNT_TOKEN`, `NEWSAPI_KEY` | Public-source scans log `fetch failed` and are skipped; stored signals and manual entries still work |
| Real payments | Stripe keys + webhook secret | `PAYMENT_PROVIDER=demo` simulates the *flow* only and is labelled; no subscription is claimed as paid |
| Real email | SMTP or Resend | Emails land in the outbox (`data/mail-outbox`) and remain visible in the app |
| Cloud asset storage | S3/S3-compatible credentials | Local `data/storage` is used and served through `/api/storage/:key` |
| Telegram notifications | Bot token | Email + in-app + browser notifications only |

**Known limitations:** no live ad-platform or marketplace publishing integration
(those are approval-gated stubs that request credentials and stop); the learning
agent needs a few weeks of realised outcomes before its weight adjustments are
meaningful; PGlite mode is single-process by design — use PostgreSQL for
scale-out; and the notification "browser" channel requires the user to grant
permission in a supported browser. See `docs/QUALITY_CONTROL_AUDIT.md` for the
full 21-item audit and `docs/LAUNCH_CHECKLIST.md` for the 15
before-going-public steps.

---

## Documentation map

| File | Contents |
| --- | --- |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Single-node and Docker deployment, TLS, backups, restore, rollback, scaling, troubleshooting |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Every external service with credential, source, env var and test procedure |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Generated schema reference — 42 tables, 637 columns |
| [docs/QUALITY_CONTROL_AUDIT.md](docs/QUALITY_CONTROL_AUDIT.md) | The 21-item pre-launch quality-control audit, with evidence |
| [docs/LAUNCH_CHECKLIST.md](docs/LAUNCH_CHECKLIST.md) | The 15-item launch checklist |

---

## License and acceptable use

Run it on your own infrastructure, with your own accounts, at your own risk. The
compliance rules above are not suggestions: do not remove the policy checks, do
not disable budget enforcement to spend beyond configured limits, and do not use
the engine for spam, evasion, fake reviews, unauthorised access or anything the
policy engine refuses.
