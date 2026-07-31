#!/usr/bin/env bash
# Gracefully restart the Cove server, detached so it survives closing the
# terminal (nohup + disown).
#
# Finds the running instance for this data directory via its lock file (and, as a
# fallback, whatever is holding its port), stops it with SIGTERM — waiting for it
# to drain and exit before force-killing — then starts a fresh, detached server
# and waits for it to answer /api/health.
#
# Useful when the original server was launched from a terminal or Automator
# action you can no longer reach.
#
#   scripts/restart.sh
#   DATA_DIR=/path/to/data scripts/restart.sh     # if you run a non-default data dir
#
# Logs the new server to $LOG (default ~/Library/Logs/cove.log on macOS).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_cove-lib.sh"

cove_cd_root "$SCRIPT_DIR/.." || exit 1
cove_find_node || exit 1
cove_load_env
cove_resolve

echo "Cove restart"
echo "  data dir: $DATA_DIR"
echo "  port:     $PORT"

cove_stop_all
cove_start_detached

if cove_wait_health; then
  echo "✅ Cove is up (pid $NEW_PID) at $URL."
  echo "   You can close this terminal — the server keeps running."
  exit 0
fi

echo "⚠ The new server didn't answer /api/health on port $PORT within 15s."
echo "   Check the log:  tail -n 40 \"$LOG\""
exit 1
