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

DATA_DIR="${DATA_DIR:-./data}"

# First run: offer to pick a durable local domain for this instance so the URL
# (and port) stay stable across restarts and avoid clashes with other apps.
if [ ! -f "${DATA_DIR}/instance.json" ] && [ -z "$PORT" ] && [ -t 0 ]; then
  printf "Pick a durable local domain for this instance [meeting-notes]: "
  read -r NAME
  NAME="${NAME:-meeting-notes}"
  node server.js --set-domain "$NAME"
fi

# Any extra args (e.g. --port 8080) are forwarded to the server.
URL="$(node server.js --print-config "$@" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).url)}catch(e){console.log('http://127.0.0.1:3000')}})")"
echo "Starting Daymark at ${URL}"

# Try to open a browser (best-effort, non-fatal).
( sleep 1
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) >/dev/null 2>&1 &

exec node server.js "$@"
