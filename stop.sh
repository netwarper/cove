#!/usr/bin/env bash
# Stop the running Cove server, gracefully (via scripts/cove.js): SIGTERM so it
# drains and clears its lock file, then SIGKILL only if it won't exit in ~10s.
#
# Usage: ./stop.sh
#        DATA_DIR="/path/to/Google Drive/Cove" ./stop.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/scripts/_cove-lib.sh"

cove_cd_root "$SCRIPT_DIR" || exit 1
cove_find_node || exit 1

exec "$NODE" scripts/cove.js stop
