#!/usr/bin/env bash
# Stop the running Cove server, gracefully.
#
# Sends SIGTERM first (so the server drains connections and clears its lock
# file), waits up to 10s, and only then force-kills. Targets the pid recorded in
# the lock file and anything still holding the port.
#
# Usage: ./stop.sh
#        DATA_DIR="/path/to/Google Drive/Cove" ./stop.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/scripts/_cove-lib.sh"

cove_cd_root "$SCRIPT_DIR" || exit 1
cove_find_node || exit 1
cove_load_env
cove_resolve

echo "Cove stop"
echo "  data dir: $DATA_DIR"
echo "  port:     $PORT"

if [ -z "${LOCK_PID:-}" ] && ! cove_port_held && ! cove_probe; then
  echo "✅ Cove doesn't appear to be running (no lock pid, nothing on port $PORT)."
  exit 0
fi

cove_stop_all

if cove_probe || cove_port_held; then
  echo "⚠ Something is still listening on port $PORT after the stop attempt."
  echo "   Check for another process:  lsof -i tcp:$PORT"
  exit 1
fi
echo "✅ Cove stopped."
exit 0
