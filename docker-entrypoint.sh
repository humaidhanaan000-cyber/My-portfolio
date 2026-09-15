#!/bin/sh
# =============================================================================
# AIBA container entrypoint
#
# Responsibilities, in order:
#   1. wait for a TCP dependency (PostgreSQL/Redis) when one is configured
#   2. apply migrations (only the service that is told to — see RUN_MIGRATIONS)
#   3. hand over to the service command (web / worker / scheduler)
#
# All steps are idempotent, so a container restart is always safe.
# =============================================================================
set -eu

log() { printf '[entrypoint] %s\n' "$*"; }

# --- 1. wait for dependencies -------------------------------------------------
wait_for_tcp() {
  host="$1"; port="$2"; label="$3"; tries="${4:-60}"
  i=1
  while [ "$i" -le "$tries" ]; do
    if nc -z "$host" "$port" 2>/dev/null; then
      log "$label is reachable at $host:$port"
      return 0
    fi
    log "waiting for $label at $host:$port ($i/$tries)"
    i=$((i + 1))
    sleep 2
  done
  log "ERROR: $label at $host:$port did not become reachable"
  return 1
}

parse_host_port() {
  # Strip the scheme, then the credentials, then split host:port.
  without_scheme="${1#*://}"
  without_creds="${without_scheme#*@}"
  hostport="${without_creds%%/*}"
  case "$hostport" in
    *:*)
      host="${hostport%%:*}"
      port="${hostport##*:}"
      ;;
    *)
      host="$hostport"
      port="$2"
      ;;
  esac
  printf '%s %s' "$host" "$port"
}

if [ "${DATABASE_URL#postgres}" != "$DATABASE_URL" ]; then
  set -- $(parse_host_port "$DATABASE_URL" 5432)
  wait_for_tcp "$1" "$2" "PostgreSQL" 60
fi

if [ "${REDIS_URL#redis}" != "$REDIS_URL" ]; then
  set -- $(parse_host_port "$REDIS_URL" 6379)
  wait_for_tcp "$1" "$2" "Redis" 30
fi

# --- 2. migrations ------------------------------------------------------------
# Only the service with RUN_MIGRATIONS=true applies migrations, so three
# containers starting at once cannot race each other.
case "${RUN_MIGRATIONS:-false}" in
  1|true|yes|on)
    log "applying database migrations"
    npm run db:migrate --silent
    if [ "${SEED_ON_START:-false}" = "true" ]; then
      log "seeding plans, agents, sources, schedules and the first administrator"
      npm run db:seed --silent
    fi
    ;;
  *)
    log "skipping migrations (RUN_MIGRATIONS is not true on this service)"
    ;;
esac

# --- 3. service ---------------------------------------------------------------
log "starting: $*"
exec "$@"
