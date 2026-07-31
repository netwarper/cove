# Shared helpers for Cove's start / stop / restart shell launchers.
#
# Sourced, not executed. Each launcher sets SCRIPT_DIR (its own directory),
# sources this file, then calls `cove_cd_root <default-root>` and
# `cove_find_node` before delegating to `scripts/cove.js` — the cross-platform
# engine that actually starts (detached), stops, and health-checks the server.
# Keeping the real logic in cove.js means macOS/Linux and Windows behave
# identically and there's only one place to change it.

# cd into the Cove app folder. Pass the default root (the caller knows where it
# lives relative to itself); COVE_DIR overrides it — GUI launchers (Automator,
# Finder) start with a $0 that may not point at the script, so allow an explicit
# override and verify server.js is actually here.
cove_cd_root() {
  cd "${COVE_DIR:-$1}" 2>/dev/null || true
  if [ ! -f server.js ]; then
    echo "❌ Can't find server.js. Run this from the Cove folder, or set COVE_DIR=/path/to/cove."
    return 1
  fi
}

# GUI launchers start with a minimal PATH that usually excludes Homebrew/nvm, so
# `node` isn't found. Locate it explicitly and put its dir first on PATH. Sets NODE.
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
