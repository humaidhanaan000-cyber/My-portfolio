#!/usr/bin/env bash
# ===========================================================================
#  AIBA - one-click start for Linux (and any other unix)
#
#  Run it:   chmod +x start-aiba.sh && ./start-aiba.sh
#  Most file managers also let you double-click it.
#
#  It checks Node.js, creates .env on first run, installs dependencies once,
#  starts the web app with the agents, and opens your browser when the server
#  is ready. Press Ctrl+C to stop AIBA.
# ===========================================================================
set -u

cd "$(dirname "$0")" || exit 1

PORT=3000
if [ -f .env ]; then
  env_port=$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '\r')
  [ -n "${env_port:-}" ] && PORT="$env_port"
fi
URL="http://localhost:${PORT}"

printf '\n  ============================================\n'
printf '   AIBA - Autonomous Internet Business Agent\n'
printf '  ============================================\n\n'

open_url() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  elif command -v gio >/dev/null 2>&1; then gio open "$1" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 &
  else printf '      Open %s in your browser.\n' "$1"; fi
}

# ------------------------------------------------------------------- 1. Node
if ! command -v node >/dev/null 2>&1; then
  printf '  [X] Node.js was not found.\n\n'
  printf '      Install Node.js 22 or newer:\n'
  printf '        sudo apt install nodejs npm        (Debian/Ubuntu, Node 22 via NodeSource)\n'
  printf '        sudo dnf install nodejs            (Fedora)\n'
  printf '        or https://nodejs.org\n\n'
  exit 1
fi
printf '  [1/5] Node.js %s\n' "$(node -v)"

# -------------------------------------------------------- 2. Already running?
if curl -sf -o /dev/null --max-time 3 "${URL}/api/health" 2>/dev/null; then
  printf '  [i] AIBA is already running - opening %s\n\n' "$URL"
  open_url "$URL"
  exit 0
fi

# -------------------------------------------------------------------- 3. env
if [ ! -f .env ]; then
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    secret=$(openssl rand -hex 32)
    sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=${secret}|" .env
  fi
  printf '  [2/5] Created .env from .env.example\n'
else
  printf '  [2/5] Using the existing .env\n'
fi

# ---------------------------------------------------------------- 4. install
if [ ! -d node_modules ]; then
  printf '  [3/5] Installing dependencies (first run, a few minutes)...\n'
  if ! npm install --no-audit --no-fund; then
    printf '\n  [X] npm install failed - scroll up for the reason.\n\n'
    exit 1
  fi
else
  printf '  [3/5] Dependencies already installed\n'
fi

# ------------------------------------------------------------------ 5. start
printf '  [4/5] Starting the web app and the agents...\n'

(
  for _ in $(seq 1 90); do
    if curl -sf -o /dev/null --max-time 3 "${URL}/api/health" 2>/dev/null; then
      printf '\n  [5/5] Ready - opening %s\n\n' "$URL"
      open_url "$URL"
      printf '  Useful pages:\n'
      printf '    %s/dashboard           command centre\n' "$URL"
      printf '    %s/dashboard/approvals approve or reject what the agents propose\n' "$URL"
      printf '    %s/dashboard/revenue   money in\n' "$URL"
      printf '    %s/api-docs            REST API reference\n\n' "$URL"
      printf '  Press Ctrl+C here to stop AIBA.\n\n'
      exit 0
    fi
    sleep 2
  done
  printf '\n  [!] The server did not answer within 3 minutes - check the log above.\n\n'
) &

exec npm run agent
