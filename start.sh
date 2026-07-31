#!/usr/bin/env bash
# One-click launcher for macOS / Linux.
#
# Starts Cove as a DETACHED background server (nohup + disown) so it keeps
# running after you close this terminal or Terminal window. Opens your browser
# and waits until the server is answering before it returns.
#
# Usage: ./start.sh                 (uses ./data)
#        DATA_DIR="/path/to/Google Drive/Cove" ./start.sh
#        ./start.sh --port 8080     (extra args are forwarded to the server)
#
# Stop it later with ./stop.sh, or reload with scripts/restart.sh.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/scripts/_cove-lib.sh"

cove_cd_root "$SCRIPT_DIR" || exit 1
cove_find_node || exit 1
cove_load_env

# Support `./start.sh --port 8080` by turning it into a PORT the resolver honors.
while [ $# -gt 0 ]; do
  case "$1" in
    --port) shift; [ $# -gt 0 ] && { PORT="$1"; export PORT; } ;;
    --port=*) PORT="${1#--port=}"; export PORT ;;
  esac
  shift 2>/dev/null || break
done

# First run: offer to pick a durable local domain for this instance so the URL
# (and port) stay stable across restarts and avoid clashes with other apps.
DATA_DIR_PRE="${DATA_DIR:-./data}"
if [ ! -f "${DATA_DIR_PRE}/instance.json" ] && [ -z "${PORT:-}" ] && [ -t 0 ]; then
  printf "Pick a durable local domain for this instance [cove]: "
  read -r NAME
  NAME="${NAME:-cove}"
  node server.js --set-domain "$NAME"
fi

cove_resolve

echo "Cove start"
echo "  data dir: $DATA_DIR"
echo "  port:     $PORT"

# Already up? Don't try to bind the port twice — just point the browser at it.
if cove_probe; then
  echo "✅ Cove is already running at $URL."
else
  if cove_port_held; then
    echo "⚠ Port $PORT is in use but isn't answering /api/health."
    echo "   Run ./stop.sh first, or start on another port (./start.sh --port 8080)."
    exit 1
  fi
  cove_start_detached
  if ! cove_wait_health; then
    echo "⚠ The server didn't answer /api/health on port $PORT within 15s."
    echo "   Check the log:  tail -n 40 \"$LOG\""
    exit 1
  fi
  echo "✅ Cove is up (pid $NEW_PID) at $URL."
fi

# Open a browser (best-effort, non-fatal).
if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
fi

echo "   You can close this terminal — the server keeps running. Stop it with ./stop.sh."
exit 0
