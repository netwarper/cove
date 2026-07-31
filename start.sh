#!/usr/bin/env bash
# One-click launcher for macOS / Linux.
#
# Starts Cove as a DETACHED background server (via scripts/cove.js) so it keeps
# running after you close this terminal. It waits until the server is answering,
# opens your browser, and prints the URL.
#
# Usage: ./start.sh                 (uses ./data)
#        DATA_DIR="/path/to/Google Drive/Cove" ./start.sh
#        ./start.sh --port 8080     (forwarded to the server)
#
# Stop it later with ./stop.sh, or reload it with scripts/restart.sh.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/scripts/_cove-lib.sh"

cove_cd_root "$SCRIPT_DIR" || exit 1
cove_find_node || exit 1

exec "$NODE" scripts/cove.js start "$@"
