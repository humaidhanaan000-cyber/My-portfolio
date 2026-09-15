# External integrations

Every integration below is **optional**. AIBA starts, and the whole core loop
runs, with none of these configured — the dashboard then reports `DEGRADED` with
the specific reason, and the affected screen explains what is missing instead of
showing invented data.

No credential is bundled, guessed or invented anywhere in this repository. Add
your own values to `.env` (never to source control; `.env` is gitignored) and
restart the affected process.

Format for each entry:

```
SERVICE           what it enables
CREDENTIAL        what you need
WHERE TO OBTAIN   the official page
ENV VAR           the keys to set
TEST PROCEDURE    how to prove it works in this app
```

Common test helpers used below:

```bash
npm run cli -- status          # platform, queue, worker and integration status
curl -s localhost:3000/api/status | jq '.data.integrations'   # booleans, no secrets
curl -s localhost:3000/api/health | jq '.status, .checks.ai'  # health probe
```

An integration that is configured but unreachable is reported as such — the app
never silently pretends a call succeeded.

---

## 1. AI provider (the single most valuable integration)

```
SERVICE           Real LLM reasoning: opportunity analysis, strategy, product and
                  content drafting, weekly learning summaries. Without it the
                  deterministic template agents still run every job.
CREDENTIAL        One API key: OpenAI, Anthropic, or OpenRouter; or a reachable
                  local Ollama endpoint with no key.
WHERE TO OBTAIN   OpenAI        https://platform.openai.com/api-keys
                  Anthropic     https://console.anthropic.com/settings/keys
                  OpenRouter    https://openrouter.ai/keys
                  Ollama (local) https://ollama.com/download
ENV VAR           AI_PROVIDER=auto|openai|anthropic|openrouter|ollama|custom
                  OPENAI_API_KEY=sk-…            (or AI_PROVIDER_KEY=…)
                  ANTHROPIC_API_KEY=sk-ant-…
                  OPENROUTER_API_KEY=sk-or-…
                  OLLAMA_BASE_URL=http://host:11434
                  AI_BASE_URL=…                  (custom/self-hosted gateways)
                  AI_CHAT_MODEL / AI_REASONING_MODEL / AI_CHEAP_MODEL
                  AI_ALLOW_NETWORK=true          (false = never call out)
                  MAX_DAILY_AI_SPEND_CENTS=2000  (hard daily ceiling)
TEST PROCEDURE    npm run cli -- status         → ai.configured: true, provider shown
                  POST /api/agents/analysis/run  with {"useAi":true,"wait":true}
                    → 200, run.costCents > 0, run.ai.provider = your provider,
                      and the agent output contains model-written text.
                  Failure modes are explicit: not_configured (501) when no key is
                  set, and a run with aiUsed:false when AI_ALLOW_NETWORK=false.
```

Cost control: every AI call goes through the budget engine first (per-agent and
per-project limits, `MAX_DAILY_AI_SPEND_CENTS`, thread-wide ceilings). If a call
would breach a limit it is **not made** — you get an approval request instead.

---

## 2. PostgreSQL (recommended for anything public)

```
SERVICE           Primary datastore for multi-process deployments (web + worker +
                  scheduler) and for any data you would be upset to lose.
CREDENTIAL        Host, port, database, user, password (or a managed connection
                  string). A managed provider is fine: Neon, Supabase, RDS, Azure.
WHERE TO OBTAIN   Docker      docker compose up -d postgres  (bundled)
                  Neon        https://neon.tech
                  Supabase    https://supabase.com
                  RDS         https://aws.amazon.com/rds/postgresql
ENV VAR           DATABASE_URL=postgres://user:pass@host:5432/aiba
                  DB_SSL=true          (most managed providers require TLS)
                  DB_POOL_MAX=10
TEST PROCEDURE    npm run db:migrate        → "applied N migration(s)"
                  npm run db:seed           → plans, 9 agents, sources, 10 schedules
                  curl -s localhost:3000/api/health | jq '.checks.database'
                    → { ok: true, driver: "postgres", latencyMs: <n> }
Without a database nothing works — this is the one required external service for
a server deployment. The embedded PGlite driver (`pglite://./data/pgdata`) is a
real database on disk and is the default for single-node installs.
```

---

## 3. Redis (queue, rate limiting, scheduler lock)

```
SERVICE           Durable job queue shared between web and worker processes,
                  distributed rate limiting, scheduler leader lock.
CREDENTIAL        A reachable Redis URL (with password if your provider requires
                  one). No key is needed for a private instance.
WHERE TO OBTAIN   Docker      docker compose up -d redis  (bundled, AOF enabled)
                  Upstash     https://upstash.com
                  Redis Cloud https://redis.io/cloud
ENV VAR           REDIS_URL=redis://[:password@]host:6379
                  QUEUE_PREFIX=aiba
TEST PROCEDURE    curl -s localhost:3000/api/health | jq '.checks.redis'
                    → { configured: true, ok: true, latencyMs: <n> }
                  curl -s localhost:3000/api/jobs | jq '.data.queue'
                    → queued/running/failed/dead counters move as jobs run.
Without Redis, the in-process driver (`REDIS_URL=memory`) is used: correct for
single-process deployments, not usable across containers.
```

---

## 4. Payments — Stripe

```
SERVICE           Real subscriptions: checkout, billing portal, and revenue that
                  counts as real because the provider verified it.
CREDENTIAL        Secret key + webhook signing secret + two price IDs.
WHERE TO OBTAIN   https://dashboard.stripe.com/apikeys   (secret key)
                  https://dashboard.stripe.com/webhooks   (signing secret)
                  Product catalogue → create Pro and Business prices
                  Test mode keys (sk_test_…, price_…) are fine and recommended.
ENV VAR           PAYMENT_PROVIDER=stripe
                  STRIPE_SECRET_KEY=sk_live_… (or sk_test_…)
                  STRIPE_WEBHOOK_SECRET=whsec_…
                  STRIPE_PRICE_PRO=price_…       (subscription price id)
                  STRIPE_PRICE_BUSINESS=price_…
                  PAYMENT_SUCCESS_URL, PAYMENT_CANCEL_URL
TEST PROCEDURE    # 1. signature verification and idempotency are unit-tested:
                  npx vitest run tests/payments.test.ts
                  # 2. live flow:
                  stripe listen --forward-to localhost:3000/api/billing/webhook
                  # 3. in the app: Dashboard → Billing → Upgrade → pay with 4242…
                  # 4. verify:  curl -s localhost:3000/api/billing | jq '.data.subscription'
                  #    status becomes 'active' and /api/revenue shows the charge.
Server-side verification only: the webhook signature is verified against
STRIPE_WEBHOOK_SECRET, events are stored and de-duplicated by event id, and a
browser "payment succeeded" redirect is never trusted as proof of payment.
PAYMENT_PROVIDER=demo exists for local walkthroughs: it simulates the flow,
never claims a real charge, and is labelled as demo everywhere.
```

---

## 5. Email delivery

```
SERVICE           Verification links, password resets, alerts and the daily /
                  weekly reports, actually reaching a mailbox.
CREDENTIAL        SMTP host + port + user + password, or a Resend API key.
WHERE TO OBTAIN   Resend      https://resend.com/api-keys
                  Postmark    https://postmarkapp.com/servers
                  SES         https://console.aws.amazon.com/ses
                  Gmail app password (testing only) — Google account settings
ENV VAR           EMAIL_PROVIDER=smtp|resend|console|file
                  EMAIL_FROM="AIBA <no-reply@yourdomain.com>"
                  SMTP_HOST, SMTP_PORT=587, SMTP_USER, SMTP_PASSWORD
                  EMAIL_PROVIDER_KEY=re_…            (Resend)
                  EMAIL_OUTBOX_DIR=./data/mail-outbox (console/file drivers)
TEST PROCEDURE    EMAIL_PROVIDER=console (default) → every message is written to
                  data/mail-outbox/*.log and visible in Dashboard → Notifications.
                  With SMTP/Resend: trigger a real one —
                    POST /api/auth/forgot-password {"email":"you@example.com"}
                  → 200; the message arrives with a working reset link.
                  POST /api/reports {"period":"daily"} sends the report email.
EMAIL_PROVIDER=file/console is a legitimate production option for single-operator
installs: nothing is lost, messages are simply not delivered off-box.
```

---

## 6. Object storage (generated assets)

```
SERVICE           Durable storage for generated landing pages, images and
                  export bundles, served over HTTPS.
CREDENTIAL        S3 bucket + access key + secret (or Cloudflare R2 / MinIO /
                  Backblaze B2 keys with an S3-compatible endpoint).
WHERE TO OBTAIN   AWS S3      https://s3.console.aws.amazon.com
                  Cloudflare R2 https://dash.cloudflare.com → R2
                  Backblaze B2 https://www.backblaze.com/cloud-storage
                  MinIO (self-hosted) https://min.io
ENV VAR           STORAGE_DRIVER=s3|s3_compatible|local
                  STORAGE_BUCKET=aiba-assets
                  STORAGE_REGION=us-east-1
                  STORAGE_ENDPOINT=https://<account>.r2.cloudflarestorage.com
                  STORAGE_KEY=…, STORAGE_SECRET=…
                  STORAGE_PUBLIC_BASE_URL=https://cdn.example.com
TEST PROCEDURE    Local: generate an asset (Dashboard → Projects → <project> →
                  Assets) → the file appears under data/storage and loads through
                  /api/storage/<key>.
                  S3: repeat with STORAGE_DRIVER=s3 → the object appears in the
                  bucket and its URL is the configured public base URL.
```

---

## 7. Telegram (push notifications)

```
SERVICE           Instant push alerts (approval requests, budget stops, project
                  failures) to your phone.
CREDENTIAL        A bot token from BotFather, plus your chat id.
WHERE TO OBTAIN   https://t.me/BotFather  → /newbot → token
                  Chat id: message your bot, then open
                  https://api.telegram.org/bot<TOKEN>/getUpdates
ENV VAR           TELEGRAM_BOT_TOKEN=123456:ABC-…
                  TELEGRAM_WEBHOOK_SECRET=… (if you register a webhook)
TEST PROCEDURE    Settings → Notifications → enable Telegram and paste your chat
                  id, then: POST /api/notifications {"channel":"telegram",
                  "message":"AIBA test"}
                  → notification row shows status telegram-sent; you receive it.
Without a token the Telegram channel stays inactive and the app says so; email,
in-app and browser channels keep working.
```

---

## 8. Research sources

```
SERVICE           Live opportunity discovery. GitHub, Product Hunt and NewsAPI
                  raise rate limits; the public APIs below need no credential.
CREDENTIAL        Optional tokens:
                  GITHUB_TOKEN      classic PAT with public read — raises limits
                  PRODUCTHUNT_TOKEN OAuth token from the Product Hunt API
                  NEWSAPI_KEY       free developer key
WHERE TO OBTAIN   GitHub      https://github.com/settings/tokens
                  Product Hunt https://www.producthunt.com/v2/oauth/applications
                  NewsAPI     https://newsapi.org/register
ENV VAR           SOURCE_ALLOW_NETWORK=true       (false = offline mode)
                  GITHUB_TOKEN=ghp_…
                  PRODUCTHUNT_TOKEN=…
                  NEWSAPI_KEY=…
                  RESEARCH_USER_AGENT="AIBA-bot/1.0 (+https://yourdomain.com)"
TEST PROCEDURE    Dashboard → Sources shows every collector as active, missing
                  credential, or disabled, and lists the exact env var needed.
                  POST /api/agents/research/run {"useAi":false,"wait":true,
                  "limitPerSource":5} → run summary lists per-source counts;
                  opportunities appear in Dashboard → Opportunities.
                  In a sandbox without outbound network the sources log
                  "fetch failed" and are skipped — this is reported, not faked.
Only public, documented endpoints are used, robots/ToS-respecting, no private
data, no CAPTCHA or paywall circumvention (blocked by the policy engine).
```

---

## 9. Browser and webhook notification channels

```
SERVICE           Desktop notifications in the user's browser; generic webhook
                  (Slack, Discord, n8n, Zapier) for your own automation.
CREDENTIAL        Browser: user permission only, no credential.
                  Webhook: your own URL (with a secret path if your endpoint needs it).
WHERE TO OBTAIN   Slack    https://api.slack.com/messaging/webhooks
                  Discord  Server settings → Integrations → Webhooks
                  n8n      https://docs.n8n.io
ENV VAR           NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/…
TEST PROCEDURE    Browser: Settings → Notifications → enable, grant permission,
                  then trigger an approval request; the OS notification appears.
                  Webhook: POST /api/notifications {"channel":"webhook",
                  "message":"AIBA test"} → your endpoint receives the JSON payload
                  and the notification row shows webhook-sent.
```

---

## 10. Uptime monitoring and log shipping (optional, no app change needed)

```
SERVICE           External health monitoring and centralised logs.
CREDENTIAL        Whatever the provider issues (usually a token or a DSN).
WHERE TO OBTAIN   UptimeRobot   https://uptimerobot.com
                  Better Stack  https://betterstack.com
                  Grafana Cloud https://grafana.com/products/cloud
ENV VAR           none — point the monitor at https://your-domain/api/health
                  (returns status/version/uptime/checks with no secrets), and
                  ship container logs with your platform's agent.
TEST PROCEDURE    curl -s https://your-domain/api/health | jq '.status'
                    → "ok" (healthy), "degraded" (e.g. AI not configured),
                      "error" (database unreachable or a failed migration).
                  The Docker health check and compose depend on this endpoint.
```

---

## What is deliberately **not** integrated

- **No marketplace or ad-platform auto-publishing.** Publishing, ad campaigns,
  account creation and purchases are approval-gated actions: the system prepares
  the exact payload, asks you, and — until you connect a specific provider — stops
  there rather than pretending to have launched something.
- **No broker/trading or crypto APIs.** Prohibited by the policy engine and by
  design.
- **No dark-pattern growth tooling** — no fake reviews, no bulk scraping of
  private data, no CAPTCHA/paywall bypass, no spam.

If you need one of these connected later, the integration belongs in
`src/lib/integrations/` behind an approval-gated action type, with the credential
documented here in the same five-line format.
