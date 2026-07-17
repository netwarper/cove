#!/usr/bin/env bash
# One-click launcher for macOS / Linux.
# Usage: ./start.sh            (uses ./data)
#        DATA_DIR="/path/to/Google Drive/MeetingNotes" ./start.sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found. Install it from https://nodejs.org (v18+)."
  exit 1
fi

# Load a local .env if present (KEY=VALUE lines).
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

PORT="${PORT:-3000}"
URL="http://${HOST:-127.0.0.1}:${PORT}"
echo "Starting Meeting Notes at ${URL}"

# Try to open a browser (best-effort, non-fatal).
( sleep 1
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) >/dev/null 2>&1 &

exec node server.js
