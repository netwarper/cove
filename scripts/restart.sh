#!/usr/bin/env bash
# Gracefully restart the Cove server.
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

# Find the Cove folder. When launched from an Automator app / Finder, $0 may not
# point at this file, so allow COVE_DIR to override and verify server.js is here.
cd "${COVE_DIR:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}" 2>/dev/null || true
if [ ! -f server.js ]; then
  echo "❌ Can't find server.js. Run this from the Cove folder, or set COVE_DIR=/path/to/cove."
  exit 1
fi

# GUI launchers (Automator, launchd) start with a minimal PATH that usually
# excludes Homebrew/nvm, so `node` isn't found. Locate it explicitly.
find_node() {
  command -v node 2>/dev/null && return 0
  for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do [ -x "$n" ] && { echo "$n"; return 0; }; done
  if [ -d "$HOME/.nvm/versions/node" ]; then
    local v; v="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
    [ -n "$v" ] && [ -x "$HOME/.nvm/versions/node/$v/bin/node" ] && { echo "$HOME/.nvm/versions/node/$v/bin/node"; return 0; }
  fi
  return 1
}
NODE="$(find_node || true)"
[ -n "$NODE" ] || { echo "❌ Node.js not found. Install Node 18+ (nodejs.org, or 'brew install node')."; exit 1; }
# Put node's dir first on PATH so every `node` in this script (and the server) resolves.
PATH="$(dirname "$NODE"):$PATH"; export PATH

[ -f .env ] && { set -a; . ./.env; set +a; }

# Resolve DATA_DIR exactly like server.js (env var > saved pointer > ./data) and
# read the running instance's pid from its lock file — all via Node so the logic
# stays in one place.
read -r DATA_DIR LOCK_PID LOCK_PORT < <(node -e '
  const path=require("path"), fs=require("fs"), cfg=require("./lib/config");
  const appDir=process.cwd();
  const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR)
            : (cfg.readDataDirPointer(appDir) || path.join(appDir,"data"));
  let pid="", port="";
  try { const l=JSON.parse(fs.readFileSync(path.join(dir,"instance.lock"),"utf8")); pid=l.pid||""; port=l.port||""; } catch(e){}
  process.stdout.write(dir+" "+pid+" "+port);
')

# The lock file records the port the running server actually bound (which may have
# come from an env var and not be in instance.json), so prefer it. Fall back to
# the configured port for this data dir.
CFG_PORT="$(DATA_DIR="$DATA_DIR" node server.js --print-config 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).port||""))}catch(e){}})')"
PORT="${LOCK_PORT:-}"; PORT="${PORT:-$CFG_PORT}"; PORT="${PORT:-3000}"
URL="http://127.0.0.1:${PORT}"
LOG="${LOG:-$HOME/Library/Logs/cove.log}"

echo "Cove restart"
echo "  data dir: $DATA_DIR"
echo "  port:     $PORT"

stop_pid() {
  local pid="$1" i
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  echo "  stopping pid $pid (SIGTERM)…"
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || { echo "    exited cleanly."; return 0; }
    sleep 0.5
  done
  echo "    still running after 10s — forcing (SIGKILL)."
  kill -KILL "$pid" 2>/dev/null || true
}

# 1) stop the pid from the lock file
stop_pid "${LOCK_PID:-}"

# 2) stop anything still holding the port (covers a stale/lock-less process)
if command -v lsof >/dev/null 2>&1; then
  for p in $(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do stop_pid "$p"; done
fi

# 3) start a fresh, detached server
mkdir -p "$(dirname "$LOG")"
echo "  starting a fresh server (logging to $LOG)…"
DATA_DIR="$DATA_DIR" PORT="$PORT" nohup node server.js >>"$LOG" 2>&1 &
NEW_PID=$!
disown "$NEW_PID" 2>/dev/null || true

# 4) wait for it to answer /api/health
probe() {
  if command -v curl >/dev/null 2>&1; then curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1
  else node -e 'const http=require("http");http.get({host:"127.0.0.1",port:process.argv[1],path:"/api/health",timeout:1500},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' "$PORT"; fi
}
for i in $(seq 1 30); do
  if probe; then
    echo "✅ Cove is up (pid $NEW_PID)${URL:+ at $URL}."
    exit 0
  fi
  sleep 0.5
done

echo "⚠ The new server didn't answer /api/health on port $PORT within 15s."
echo "   Check the log:  tail -n 40 \"$LOG\""
exit 1
