#!/bin/bash
# ===========================================================================
#  AIBA - one-click start for macOS
#
#  Double-click this file in Finder (right-click -> Open the first time).
#  It checks Node.js, creates .env on first run, installs dependencies once,
#  starts the web app with the agents, and opens your browser when the server
#  is ready. Press Ctrl+C in the Terminal window to stop AIBA.
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

# ------------------------------------------------------------------- 1. Node
if ! command -v node >/dev/null 2>&1; then
  printf '  [X] Node.js was not found.\n\n'
  printf '      Install Node.js 22 or newer:  https://nodejs.org\n'
  printf '      (or with Homebrew:  brew install node)\n\n'
  printf '      Then double-click this file again.\n\n'
  read -r -p "  Press Return to close. " _
  exit 1
fi
printf '  [1/5] Node.js %s\n' "$(node -v)"

# -------------------------------------------------------- 2. Already running?
if curl -sf -o /dev/null --max-time 3 "${URL}/api/health" 2>/dev/null; then
  printf '  [i] AIBA is already running - opening %s\n\n' "$URL"
  open "$URL" 2>/dev/null || printf '      Open %s in your browser.\n' "$URL"
  exit 0
fi

# -------------------------------------------------------------------- 3. env
if [ ! -f .env ]; then
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    secret=$(openssl rand -hex 32)
    # portable in-place edit (BSD sed needs the empty -i argument)
    sed -i '' "s|^AUTH_SECRET=.*|AUTH_SECRET=${secret}|" .env 2>/dev/null \
      || sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=${secret}|" .env
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
    read -r -p "  Press Return to close. " _
    exit 1
  fi
else
  printf '  [3/5] Dependencies already installed\n'
fi

# ------------------------------------------------------------------ 5. start
printf '  [4/5] Starting the web app and the agents...\n'

# Open the browser from a background watcher, so the server itself keeps the
# Terminal in the foreground and Ctrl+C stops everything cleanly.
(
  for _ in $(seq 1 90); do
    if curl -sf -o /dev/null --max-time 3 "${URL}/api/health" 2>/dev/null; then
      printf '\n  [5/5] Ready - opening %s\n\n' "$URL"
      open "$URL" 2>/dev/null || printf '      Open %s in your browser.\n\n' "$URL"
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
