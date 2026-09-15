# Deployment guide

AIBA is designed to run continuously on a server you control, with your laptop
switched off. Two supported shapes:

| Shape | When to use | Database | Queue | Processes |
| --- | --- | --- | --- | --- |
| **A. Single node (embedded)** | A VPS or home server, one operator, smallest footprint | PGlite (a real Postgres-compatible engine, on local disk) | in-process | one container/process (`npm run agent`) |
| **B. Docker Compose (recommended for public use)** | Production, multiple workers, backups, scaling | PostgreSQL 17 | Redis 7 | `web`, `worker`, `scheduler` (+ `postgres`, `redis`) |

Both are production paths. Shape A is genuinely durable (data is a writable
directory you can back up), it simply cannot be scaled horizontally: only one
process may own a PGlite directory.

---

## 1. Prerequisites

- Node.js 22+ (only for bare-metal installs; the Docker image brings its own)
- Docker 24+ and Docker Compose v2 (shape B)
- A domain name and TLS (for public access) — cookies and email links depend on
  the correct `APP_URL`
- Outbound HTTPS if you want live research sources, AI providers, email or Stripe

Minimum realistic resources for shape B: 1 vCPU / 1 GB RAM / 10 GB disk for one
operator; add ~256 MB per extra worker.

---

## 2. Shape A — one-command single node

```bash
git clone https://github.com/humaidhanaan000-cyber/My-portfolio.git
cd My-portfolio
cp .env.example .env
# REQUIRED edits:
#   AUTH_SECRET=$(openssl rand -hex 32)
#   APP_URL=https://your-domain
#   COOKIE_SECURE=true           # https only
#   NODE_ENV=production
npm ci
npm run agent                    # build + migrate + web + worker + scheduler
```

`npm run agent` is safe to leave running under a supervisor. With systemd:

```ini
# /etc/systemd/system/aiba.service
[Unit]
Description=AIBA autonomous business agent
After=network-online.target

[Service]
Type=simple
User=aiba
WorkingDirectory=/opt/aiba
EnvironmentFile=/opt/aiba/.env
ExecStart=/usr/bin/npm run agent
Restart=always
RestartSec=5
# graceful shutdown: the worker finishes the job it is running
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now aiba
sudo systemctl status aiba
```

Put nginx/Caddy in front for TLS (section 5).

---

## 3. Shape B — Docker Compose

```bash
git clone https://github.com/humaidhanaan000-cyber/My-portfolio.git
cd My-portfolio
cp .env.example .env
```

Production values to set in `.env` before the first start:

```bash
NODE_ENV=production
APP_URL=https://your-domain
AUTH_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)   # consumed by docker-compose.yml
COOKIE_SECURE=true
COOKIE_SAMESITE=lax                         # first-party: lax is correct and safest
ALLOW_EMBED=false                           # only true if you really frame the app
RUN_MIGRATIONS=true                         # web applies migrations, then seeds
SEED_ON_START=true                          # plans, agents, sources, schedules, admin
ENABLE_INLINE_JOBS=false                    # real worker container does the jobs
ENABLE_SCHEDULER=false                      # the scheduler container owns cron
# optional integrations — see docs/INTEGRATIONS.md
AI_PROVIDER=openai
OPENAI_API_KEY=sk-…
EMAIL_PROVIDER=smtp
SMTP_HOST=…
PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
```

Start it:

```bash
docker compose up -d --build
docker compose ps                       # all services "healthy"
docker compose logs -f worker           # watch jobs execute
docker compose exec web npm run cli -- status
```

What each service does:

| Service | Command | Notes |
| --- | --- | --- |
| `web` | `node server.js` | Next.js standalone server + REST API. Applies migrations once (`RUN_MIGRATIONS=true`), then seeds. Health-checked on `/api/health`. |
| `worker` | `npm run worker` | 18 job handlers, concurrency from `WORKER_CONCURRENCY` (default 4), graceful SIGTERM with a 60 s stop grace period. |
| `scheduler` | `npm run scheduler` | 20 s tick, leader-locked via Redis, enqueues the 10 recurring jobs. Exactly one instance should run. |
| `postgres` | `postgres:17-alpine` | Data in the `postgres-data` volume. |
| `redis` | `redis:7-alpine` | AOF persistence enabled. |

Scaling the worker is safe and is the intended way to add capacity:

```bash
docker compose up -d --scale worker=3
```

The queue claims jobs with `FOR UPDATE SKIP LOCKED`, so multiple workers never
process the same job. **Do not** scale `scheduler` beyond one, and keep
`ENABLE_INLINE_JOBS=false` whenever a real worker exists.

---

## 4. Migrations, seeding and rollback

```bash
npm run db:migrate                 # apply every pending migration
npm run db:migrate -- --dry-run    # list what would run, change nothing
npm run db:migrate -- --rollback   # run every migration's rollback block, newest first
npm run db:seed                    # idempotent: plans, agents, sources, schedules, admin
npm run docs:schema                # regenerate docs/SCHEMA.md from the live schema
```

- Migrations are plain SQL files in `drizzle/` applied in filename order and
  recorded in a migrations table, so re-running is a no-op.
- Each file may declare a down-migration between `-- +rollback` and
  `-- +end-rollback` markers; that is exactly what `-- --rollback` executes. A
  migration without a rollback block is reported as
  `no rollback block defined` rather than silently skipped.
- **Never edit an applied migration.** Add a new numbered file instead.
- Docker: only the service with `RUN_MIGRATIONS=true` migrates, which is why
  three containers starting simultaneously cannot race each other.

Rollback of an application release (shape B):

```bash
git fetch --tags && git checkout <previous-tag-or-commit>
docker compose up -d --build          # images are built from the checkout
docker compose exec web npm run cli -- status
# and, only if the release contained a schema change you must undo:
docker compose exec web npm run db:migrate -- --rollback
```

---

## 5. TLS and reverse proxy

Terminate TLS at nginx/Caddy and keep `COOKIE_SECURE=true`. The app trusts
`x-forwarded-proto` when deciding whether a cookie may be `Secure`, so HTTPS is
detected correctly even though the container itself speaks HTTP.

```nginx
server {
  listen 443 ssl http2;
  server_name your-domain.com;

  ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

  client_max_body_size 25m;               # asset uploads

  location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;              # long-running agent runs
  }
}
```

```bash
# Caddy equivalent, one line:
# your-domain.com { reverse_proxy 127.0.0.1:3000 }
sudo certbot --nginx -d your-domain.com
```

### Cookie and framing policy

| Situation | `COOKIE_SAMESITE` | `ALLOW_EMBED` | Notes |
| --- | --- | --- | --- |
| Normal first-party site (recommended) | `lax` (default) | `false` | Safest. Session and CSRF cookies are both first-party. |
| Stricter, no cross-site arrival | `strict` | `false` | Users arriving from an external link appear signed out on that first request. |
| App embedded in a frame on another origin (hosted previews, white-label console) | `none` | `true` | Forces `Secure` + `Partitioned`; CSRF still enforced by the double-submit token, which is why this remains safe. |

Reliability note learned the hard way: with `SameSite=Lax` inside a cross-site
frame, browsers **silently discard** the session cookie. Sign-in appears to
succeed and the next page load is anonymous again. If your users report that,
check the frames before debugging anything else.

---

## 6. Health checks and monitoring

```bash
curl -s https://your-domain/api/health | jq
```

```json
{
  "status": "ok | degraded | error",
  "version": "1.0.0",
  "environment": "production",
  "uptimeSeconds": 3600,
  "checks": {
    "database": { "ok": true, "driver": "postgres", "latencyMs": 3 },
    "migrations": { "applied": 2, "failed": 0 },
    "redis": { "configured": true, "ok": true, "latencyMs": 1 },
    "queue": { "queued": 0, "running": 1, "failed": 0, "dead": 0 },
    "workers": [{ "role": "worker", "status": "running", "lastHeartbeatAt": "…" }],
    "ai": { "configured": false, "provider": "none", "reason": "AI_PROVIDER_KEY is not set" }
  }
}
```

- `ok` — database reachable, no failed migrations, workers heart-beating.
- `degraded` — the app works but something optional is missing (typically
  `ai.configured=false`, or no worker heartbeat in the last 3 minutes). This is a
  warning, not an outage.
- `error` — database unreachable or a migration failed. Act immediately.

Both the container `HEALTHCHECK` and Docker Compose depend on this endpoint, and
it never exposes secrets — only booleans, counters and latencies. Point
UptimeRobot/Better Stack at it (docs/INTEGRATIONS.md §10).

The in-app equivalent: `/status` (public summary), `/dashboard` (owner view) and
`/dashboard/admin` (users, agents, jobs, queues, API usage, logs, errors, health).

---

## 7. Backups

### PostgreSQL (shape B)

```bash
# nightly logical backup, 14-day retention
mkdir -p /var/backups/aiba
docker compose exec -T postgres pg_dump -U aiba -Fc aiba > /var/backups/aiba/aiba-$(date +%F).dump
find /var/backups/aiba -name '*.dump' -mtime +14 -delete
```

```bash
# cron: 03:10 every day
10 3 * * * cd /opt/aiba && docker compose exec -T postgres pg_dump -U aiba -Fc aiba > /var/backups/aiba/aiba-$(date +\%F).dump
```

Also snapshot the `aiba-data` volume (generated assets + mail outbox) and, if you
need queue durability across a full restore, the `redis-data` volume.

### PGlite (shape A)

The database is the directory in `DATABASE_URL` (`./data/pgdata` by default).

```bash
# stop the process so the copy is consistent, then archive
sudo systemctl stop aiba
tar czf /var/backups/aiba/pgdata-$(date +%F).tar.gz -C /opt/aiba data/pgdata data/storage
sudo systemctl start aiba
```

### Restore

```bash
# PostgreSQL
docker compose stop web worker scheduler
cat /var/backups/aiba/aiba-2026-01-01.dump | docker compose exec -T postgres pg_restore -U aiba -d aiba --clean --if-exists
docker compose start web worker scheduler

# PGlite
sudo systemctl stop aiba
rm -rf /opt/aiba/data/pgdata && tar xzf /var/backups/aiba/pgdata-2026-01-01.tar.gz -C /opt/aiba
sudo systemctl start aiba
```

Test a restore at least once before you rely on it. A backup that has never been
restored is a hope, not a backup.

---

## 8. Upgrades

```bash
cd /opt/aiba
docker compose exec -T postgres pg_dump -U aiba -Fc aiba > /var/backups/aiba/pre-upgrade.dump
git fetch origin && git checkout <new-tag-or-commit>
docker compose up -d --build
docker compose logs -f web worker scheduler     # watch the first minute
curl -s localhost:3000/api/health | jq '.status, .checks.migrations'
```

Zero-downtime is not attempted: the web container restarts in a couple of
seconds, and jobs in flight are finished by the worker before it exits (60 s
grace). If a release is bad, check out the previous commit and `docker compose up
-d --build`; migrations are additive, and `db:migrate -- --rollback` exists for
the rare release that must undo one.

---

## 9. Security hardening

- `AUTH_SECRET` must be a real random secret (`openssl rand -hex 32`); rotating
  it invalidates every session — useful after an incident.
- Keep `.env` out of Git (already gitignored) and `chmod 600 .env`.
- `COOKIE_SECURE=true` in production, always. The app additionally derives
  `Secure` from `x-forwarded-proto`, so a hostile `X-Forwarded-Proto` header
  cannot downgrade a cookie.
- Keep `ALLOW_EMBED=false` unless you knowingly frame the app.
- Reach the database and Redis only from inside the compose network — both
  services use `expose`, not `ports`, in `docker-compose.yml`.
- Rate limits are on by default: `RATE_LIMIT_MAX_AUTH=10` per 5 minutes for auth
  endpoints and `RATE_LIMIT_MAX_API=240` per minute generally. Raise them only
  with a proxy-level WAF in front.
- Secrets are never sent to the browser; only `publicConfig()` values are.
- Change the seeded administrator password immediately after first login.
- Run `npm run verify` after any code change, and keep the container image updated
  (`docker compose build --pull`).

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Sign-in "does nothing", user stays signed out | Session cookie dropped: `SameSite=Lax` while the app is framed cross-site, or the site is http with `COOKIE_SECURE=true` | Set `COOKIE_SAMESITE=none` **and** `ALLOW_EMBED=true` for framed deployments (section 5); make sure the public URL is https and `APP_URL` matches |
| Mutations return `403 forbidden` | Missing/blocked CSRF cookie or header | Ensure the browser can store the CSRF cookie (same settings as above); the built-in client sends `x-csrf-token` automatically — check for a proxy stripping cookies |
| `status: degraded`, `ai.configured=false` | No AI key | Add one (docs/INTEGRATIONS.md §1) or accept deterministic agents |
| Research runs log `fetch failed` | No outbound network, or the host is blocked | Check `SOURCE_ALLOW_NETWORK`, DNS and egress firewall; stored signals still work offline |
| Jobs pile up in `queued` | No worker running, or `ENABLE_INLINE_JOBS=false` with no worker container | `docker compose up -d worker`; verify `workers[]` in `/api/health` |
| Jobs in `dead` | Repeated failures (attempts exhausted) | Dashboard → Jobs shows the error; fix the cause and retry the job |
| Reports/emails never arrive | `EMAIL_PROVIDER=console/file` | Set SMTP or Resend (docs/INTEGRATIONS.md §5); meanwhile messages are in `data/mail-outbox` and in the notification centre |
| `429 rate_limited` on auth endpoints | More than `RATE_LIMIT_MAX_AUTH` auth calls per 5 minutes from one IP | Wait out the window or raise the limit deliberately |
| Compose service unhealthy | Database not reachable, or a migration failed | `docker compose logs postgres web`; `/api/health` shows `.checks.migrations.failed` |
| PGlite directory locked / two processes fighting | Two processes own one PGlite directory | Single node only: run `npm run agent` once, or move to PostgreSQL |
| `next start` warning about `output: standalone` | Next.js standalone build served by `next start` | Harmless in the one-command flow; the Docker image runs `node server.js` as intended |

---

## 11. What "running in production" means here

After `docker compose up -d` (or the systemd unit), AIBA keeps working with your
computer off:

- the **scheduler** enqueues the recurring jobs (research scan hourly, opportunity
  analysis every 3 h, strategy generation every 6 h, health checks every 15 min,
  email flush every 5 min, memory prune, daily report 08:00, weekly learning and
  weekly report on Mondays, monitoring);
- the **worker** executes them, respecting budget limits, policy rules and the
  approval gate;
- the **web** app serves the dashboard, the API and the notification centre from
  anywhere;
- `/api/health` lets your monitoring, and the Docker health checks, tell the
  difference between "quiet" and "broken".

Everything that spends money or publishes content still stops at the approval
gate and waits for you — that is the intended behaviour, not a missing feature.
