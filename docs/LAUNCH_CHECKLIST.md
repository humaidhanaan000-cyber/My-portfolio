# Launch checklist — 15 items

Work top to bottom. Items 1–6 are mandatory before the app is reachable from the
internet; 7–12 before you let it touch real money or real audiences; 13–15 before
you tell anyone about it. Each item says what to do and how to confirm it is done.

---

### 1. Server, domain and TLS

- [ ] A VPS or cloud instance with Docker installed and SSH key-only access.
- [ ] DNS A/AAAA record pointing your domain at the server.
- [ ] TLS certificate issued (Let's Encrypt via Caddy or `certbot --nginx`).

**Confirm:** `curl -sI https://your-domain | head -1` → `HTTP/2 200`, and the
browser shows a valid certificate with no mixed-content warnings.
See [DEPLOYMENT.md §5](DEPLOYMENT.md).

---

### 2. Production `.env` with real secrets

- [ ] `AUTH_SECRET=$(openssl rand -hex 32)` (never reuse the example value).
- [ ] `NODE_ENV=production`, `APP_URL=https://your-domain`.
- [ ] `POSTGRES_PASSWORD=$(openssl rand -hex 24)`.
- [ ] `.env` is `chmod 600`, owned by the deploy user, and **not** in Git.

**Confirm:** `git check-ignore -v .env` reports it as ignored; `GET /api/status`
shows `environment: "production"`.

---

### 3. Database up, migrated, seeded

- [ ] PostgreSQL reachable (`docker compose ps` → `postgres` healthy).
- [ ] `RUN_MIGRATIONS=true` on the web service; migrations applied once.
- [ ] `SEED_ON_START=true` for the first boot (plans, agents, sources, schedules, admin).

**Confirm:**
`docker compose exec web npm run cli -- status` and
`curl -s https://your-domain/api/health | jq '.checks.database, .checks.migrations'`
→ `ok: true`, `failed: 0`.

---

### 4. Cookie and framing policy matches how the app is served

- [ ] Direct site (recommended): `COOKIE_SECURE=true`, `COOKIE_SAMESITE=lax`,
      `ALLOW_EMBED=false`.
- [ ] Embedded in a frame on another origin: `COOKIE_SAMESITE=none`,
      `ALLOW_EMBED=true` (the app then forces `Secure` + `Partitioned`).

**Confirm:** sign in from a private window at the real https URL, then reload —
you stay signed in. DevTools → Application → Cookies shows `__Host-aiba_session`
and `__Host-aiba_csrf` with `Secure` and the expected `SameSite`. Mutating any
setting returns `200`, not `403 forbidden`. (Getting this wrong is the single most
common way an install looks broken when it is not.)

---

### 5. Worker and scheduler actually running

- [ ] `worker` container healthy and heart-beating.
- [ ] `scheduler` container running — exactly **one** instance.
- [ ] `ENABLE_INLINE_JOBS=false` and `ENABLE_SCHEDULER=false` on the web service
      (so no double execution).

**Confirm:**
`curl -s https://your-domain/api/health | jq '.checks.workers, .checks.queue'` →
a recent heartbeat, and `queued` draining to `0`.

---

### 6. Administrator account secured

- [ ] Sign in as the seeded administrator, change the password immediately
      (Settings → Security).
- [ ] Register a second, personal owner account; keep the admin account for admin
      work only.
- [ ] `REQUIRE_EMAIL_VERIFICATION=true` if the app is public.
- [ ] `ALLOW_REGISTRATION=false` if only you should ever sign up.

**Confirm:** wrong password → `401`; the old admin password no longer works; the
audit log shows the password change.

---

### 7. Backups scheduled and *restored* at least once

- [ ] Nightly `pg_dump` (or a PGlite directory archive) on cron, off-server copy.
- [ ] One restore performed into a scratch environment and verified.

**Confirm:** `cat backup.dump | docker compose exec -T postgres pg_restore …` into a
test database, then sign in against the restored data. A backup you have never
restored is a hope, not a backup. [DEPLOYMENT.md §7](DEPLOYMENT.md).

---

### 8. Email deliverability

- [ ] `EMAIL_PROVIDER` set to `smtp` or `resend` with a verified domain.
- [ ] SPF, DKIM and DMARC records published for the sending domain.
- [ ] `EMAIL_FROM` on your own domain (not `@gmail.com`).

**Confirm:** request a password reset from a real mailbox and receive it in the
inbox (not spam), then complete the reset.
[INTEGRATIONS.md §5](INTEGRATIONS.md).

---

### 9. Payments: live keys + verified webhook

- [ ] `PAYMENT_PROVIDER=stripe` with **live** keys (`sk_live_…`).
- [ ] Webhook endpoint registered: `https://your-domain/api/billing/webhook` with
      the signing secret in `STRIPE_WEBHOOK_SECRET`, subscribing to
      `checkout.session.completed`, `customer.subscription.*`, `invoice.*`.
- [ ] Plan prices created in Stripe and mapped to `free` / `pro` / `business`.
- [ ] Prices are **configuration**: adjust the catalogue in the admin panel rather
      than editing code.

**Confirm:** run one real (or test-mode) subscription end to end; the webhook
returns `2xx`, `/api/billing` shows the subscription `active`, and
`/api/revenue` records the charge as verified. The browser "success" redirect
alone must never be treated as proof of payment.
[INTEGRATIONS.md §4](INTEGRATIONS.md).

---

### 10. AI provider and spend ceiling

- [ ] AI key set (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`,
      or a local Ollama URL).
- [ ] `MAX_DAILY_AI_SPEND_CENTS` set low enough that a runaway loop cannot hurt you.
- [ ] Per-agent and per-project budget limits reviewed in Settings.

**Confirm:** `/api/health` shows `ai.configured: true` (status is no longer
`degraded`), and one `POST /api/agents/analysis/run {"useAi":true,"wait":true}`
returns `200` with a non-zero `costCents` **and** a matching reservation in
`/api/budgets`.
[INTEGRATIONS.md §1](INTEGRATIONS.md).

---

### 11. Monitoring and log retention

- [ ] Uptime monitor polling `https://your-domain/api/health` (alert on
      `status != ok`, and separately on `degraded`).
- [ ] Container log rotation configured (`docker compose` json-file
      `max-size`/`max-file`, or your platform's log driver).
- [ ] Error alerting wired to a channel you actually read (email, webhook, Telegram).

**Confirm:** stop the worker container on purpose — you get an alert about the
missing heartbeat, and restarting clears it. [INTEGRATIONS.md §10](INTEGRATIONS.md).

---

### 12. Review guardrails before real money moves

- [ ] Automation level is **approval required** (the default) for the first weeks.
- [ ] Budget limits reflect what you can genuinely afford to lose.
- [ ] The prohibited list (trading, mining, private-data scraping, CAPTCHA/paywall
      bypass, bulk scraping, fake reviews) is understood and left intact.
- [ ] You know what every high-risk action means: publish, update page, marketing
      email, create account, ad campaign, purchase, delete data — each stops for
      approval.

**Confirm:** raise one approval request and walk it through APPROVE → execution →
audit entry, and reject another to see it stop cleanly with no spend.

---

### 13. Legal pages and honest claims

- [ ] Publish a Terms of Service and a Privacy Policy for your deployment
      (**not included in this repository** — see Known gaps in the audit).
- [ ] Remove every claim of guaranteed income; state that results depend on the
      market and on what you approve.
- [ ] Confirm the demo/real separation is visible: demo data is labelled
      **DEMO DATA**, real revenue only comes from verified payments or manual
      entries marked manual.
- [ ] Cookie/privacy notice if you serve users in a jurisdiction that requires one.

**Confirm:** read the public landing page as a stranger and check that nothing on
it promises money.

---

### 14. End-to-end smoke on the live deployment

- [ ] Register a fresh account, complete the 5-step onboarding, land on the dashboard.
- [ ] Run one research cycle, analyse one opportunity, generate a strategy, create a
      project, approve it, watch the workflow execute, and view the generated asset.
- [ ] Record one manual revenue entry and one expense; confirm net, margin and ROI update.
- [ ] Trigger one over-budget action and confirm it **stops** and raises an approval.
- [ ] Sign out, sign in again, and reload a protected page.

**Confirm:** all five steps behave as above on the live URL (not just locally),
with `npm run test:e2e` green at the same commit.

---

### 15. Operability handover

- [ ] You know the upgrade command and have done it once:
      `git pull && docker compose up -d --build`.
- [ ] You know how to roll back: previous commit + `npm run db:migrate -- --rollback`
      if a release shipped a schema change.
- [ ] You know where the money truth lives: `/dashboard/revenue`,
      `/dashboard/expenses`, `/dashboard/budget` and the admin audit log.
- [ ] You know what `DEGRADED` means (`/api/health` explains the reason) and which
      credential clears it.
- [ ] Daily and weekly reports arrive on schedule and you have read one.

**Confirm:** `docker compose exec web npm run cli -- status` gives a complete,
understandable picture of queue, workers, budget and integrations. Once that is
true, the system is running on its own — with your PC off — and stops at the
approval gate whenever it wants to spend or publish.
