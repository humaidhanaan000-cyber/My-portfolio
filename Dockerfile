# =============================================================================
# AIBA — production image
#
# One image serves three roles, selected by the compose service command:
#   web        → node server.js        (Next.js standalone server)
#   worker     → npm run worker        (queue worker, tsx)
#   scheduler  → npm run scheduler     (cron scheduler, tsx)
#
# The worker and scheduler need the TypeScript sources, so the runtime stage
# keeps a pruned `node_modules` plus `src/` and `scripts/` rather than only the
# standalone bundle.
#
# Build:  docker build -t aiba:1.0.0 .
# Run:    docker compose up -d
# =============================================================================

# --------------------------------------------------------------- dependencies
FROM node:22-alpine AS deps
WORKDIR /app
# libc6-compat: sharp/canvas-free, but PGlite and pg need musl compatibility
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# --------------------------------------------------------------------- build
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build must not require a live database: every page that touches data is
# `force-dynamic`, so no query runs at build time.
RUN npm run build

# ------------------------------------------------------------------- runtime
FROM node:22-alpine AS runner
WORKDIR /app

# tini for correct signal handling (graceful SIGTERM in the worker), curl for
# the container health check, and pglite/pg friendly libs.
RUN apk add --no-cache libc6-compat curl tini netcat-openbsd

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_LOCAL_DIR=/data/storage \
    EMAIL_OUTBOX_DIR=/data/mail-outbox \
    DATABASE_URL=pglite:///data/pgdata

# Non-root runtime user. The data volume must be writable by uid 1001.
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 --ingroup nodejs aiba

# Next.js standalone server + static assets
COPY --from=builder --chown=aiba:nodejs /app/.next/standalone ./
COPY --from=builder --chown=aiba:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=aiba:nodejs /app/public ./public

# TypeScript runtime for the worker + scheduler, plus the migration SQL and
# tooling the entrypoint uses. `--omit=dev` keeps the image lean while still
# including tsx (a devDependency) — installed here rather than copied so the
# image never ships Next.js build caches.
COPY --from=builder --chown=aiba:nodejs /app/package.json ./package.json
COPY --from=builder --chown=aiba:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=aiba:nodejs /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=aiba:nodejs /app/src ./src
COPY --from=builder --chown=aiba:nodejs /app/scripts ./scripts
COPY --from=builder --chown=aiba:nodejs /app/drizzle ./drizzle
RUN npm install --no-audit --no-fund --omit=optional --ignore-scripts tsx@4 typescript@5 \
      && npm cache clean --force

COPY --chown=aiba:nodejs docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data/storage /data/mail-outbox && chown -R aiba:nodejs /data /app

USER aiba
EXPOSE 3000

# Volumes: the database directory (PGlite mode), generated assets and the mail
# outbox. With an external PostgreSQL these are only needed for assets.
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
