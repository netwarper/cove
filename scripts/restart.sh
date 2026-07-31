#!/usr/bin/env bash
# Gracefully restart the Cove server, detached (via scripts/cove.js) so it
# survives closing the terminal.
#
# Stops the instance for this data directory (found via its lock file / port),
# waiting for it to drain before force-killing, then starts a fresh detached
# server on the same port and waits for it to answer /api/health. Useful when the
# original server was launched from a terminal or Automator action you can no
# longer reach.
#
#   scripts/restart.sh
#   DATA_DIR="/path/to/data" scripts/restart.sh    # non-default data dir
#   COVE_DIR="/path/to/cove" scripts/restart.sh    # for Automator/Finder launches
#
# Logs the new server to the platform log (default ~/Library/Logs/cove.log on macOS).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_cove-lib.sh"

cove_cd_root "$SCRIPT_DIR/.." || exit 1
cove_find_node || exit 1

exec "$NODE" scripts/cove.js restart "$@"
