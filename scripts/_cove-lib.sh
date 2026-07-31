# Shared helpers for Cove's start / stop / restart scripts.
#
# This file is *sourced*, not executed. Each script sets SCRIPT_DIR (its own
# directory) and then sources this file, so the helpers can locate the app and
# manage the server consistently. All behavior is identical across the three
# scripts because it lives here once.
#
# After cove_resolve, these globals are set: DATA_DIR, LOCK_PID, LOCK_PORT,
# PORT, URL, LOG, NODE.

# cd into the Cove app folder. Pass the default root (the caller knows where it
# lives relative to itself); COVE_DIR overrides it — GUI launchers (Automator,
# Finder) start with a $0 that doesn't point at the script, so allow an explicit
# override and verify server.js is actually here.
cove_cd_root() {
  cd "${COVE_DIR:-$1}" 2>/dev/null || true
  if [ ! -f server.js ]; then
    echo "❌ Can't find server.js. Run this from the Cove folder, or set COVE_DIR=/path/to/cove."
    return 1
  fi
}

# GUI launchers start with a minimal PATH that usually excludes Homebrew/nvm, so
# `node` isn't found. Locate it explicitly and put its dir first on PATH so every
# `node` in these scripts (and the server) resolves.
cove_find_node() {
  NODE="$(command -v node 2>/dev/null || true)"
  if [ -z "$NODE" ]; then
    for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do [ -x "$n" ] && { NODE="$n"; break; }; done
  fi
  if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    local v; v="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
    [ -n "$v" ] && [ -x "$HOME/.nvm/versions/node/$v/bin/node" ] && NODE="$HOME/.nvm/versions/node/$v/bin/node"
  fi
  [ -n "$NODE" ] || { echo "❌ Node.js not found. Install Node 18+ (nodejs.org, or 'brew install node')."; return 1; }
  PATH="$(dirname "$NODE"):$PATH"; export PATH
}

# Load a local .env (PORT, DATA_DIR, etc.) if present.
cove_load_env() { [ -f .env ] && { set -a; . ./.env; set +a; }; return 0; }

# Resolve DATA_DIR exactly like server.js (env var > saved pointer > ./data) and
# read the running instance's pid/port from its lock file — all via Node so the
# logic stays in one place. Then settle on the port to act on.
cove_resolve() {
  read -r DATA_DIR LOCK_PID LOCK_PORT < <(node -e '
    const path=require("path"), fs=require("fs"), cfg=require("./lib/config");
    const appDir=process.cwd();
    const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR)
              : (cfg.readDataDirPointer(appDir) || path.join(appDir,"data"));
    let pid="", port="";
    try { const l=JSON.parse(fs.readFileSync(path.join(dir,"instance.lock"),"utf8")); pid=l.pid||""; port=l.port||""; } catch(e){}
    process.stdout.write(dir+" "+pid+" "+port);
  ')
  # The lock file records the port the running server actually bound (which may
  # have come from an env var and not be in instance.json), so prefer it. Fall
  # back to the configured port for this data dir, then the default.
  local cfg_port
  cfg_port="$(DATA_DIR="$DATA_DIR" node server.js --print-config 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).port||""))}catch(e){}})')"
  PORT="${LOCK_PORT:-}"; PORT="${PORT:-$cfg_port}"; PORT="${PORT:-3000}"
  URL="http://127.0.0.1:${PORT}"
  LOG="${LOG:-$HOME/Library/Logs/cove.log}"
}

# Stop one pid gracefully: SIGTERM, wait up to 10s for it to drain, then SIGKILL.
cove_stop_pid() {
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

# Stop the lock-file pid, then anything still holding the port (covers a
# stale/lock-less process).
cove_stop_all() {
  cove_stop_pid "${LOCK_PID:-}"
  if command -v lsof >/dev/null 2>&1; then
    for p in $(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do cove_stop_pid "$p"; done
  fi
}

# True (0) if a Cove server answers /api/health on PORT.
cove_probe() {
  if command -v curl >/dev/null 2>&1; then curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1
  else node -e 'const http=require("http");http.get({host:"127.0.0.1",port:process.argv[1],path:"/api/health",timeout:1500},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' "$PORT"; fi
}

# True (0) if something is listening on PORT (whether or not it's healthy).
cove_port_held() {
  command -v lsof >/dev/null 2>&1 || return 1
  [ -n "$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ]
}

# Start a detached server that survives the terminal closing. Sets NEW_PID.
cove_start_detached() {
  mkdir -p "$(dirname "$LOG")"
  echo "  starting a detached server (logging to $LOG)…"
  DATA_DIR="$DATA_DIR" PORT="$PORT" nohup node server.js >>"$LOG" 2>&1 &
  NEW_PID=$!
  disown "$NEW_PID" 2>/dev/null || true
}

# Wait up to 15s for the server to answer /api/health.
cove_wait_health() {
  local i
  for i in $(seq 1 30); do
    cove_probe && return 0
    sleep 0.5
  done
  return 1
}
