#!/usr/bin/env bash
# Install (or remove) Cove as a macOS launch-on-login service via launchd.
#
#   scripts/macos-service.sh install     # start Cove at login, auto-restart
#   scripts/macos-service.sh uninstall   # remove the service
#   scripts/macos-service.sh status      # is it loaded / running?
#
# Options (env vars):
#   DATA_DIR=/path/to/folder   where notes live (default: <repo>/data — point at
#                              a Google Drive / Dropbox / iCloud folder to sync).
#                              Only baked into the service when set here; the
#                              default is left unpinned so you can relocate it
#                              later from the app's Settings → Data location.
#   KEEP_AWAKE=1               wrap the server in `caffeinate` so the Mac does
#                              not sleep while you are logged in (see caveats in
#                              docs/macos-startup.md)
set -euo pipefail

LABEL="com.cove.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-help}"

# Per-user GUI launchd domain. Modern macOS (Ventura/Sonoma/Sequoia) manages
# LaunchAgents with `bootstrap`/`bootout`/`kickstart` against this domain; the
# old `load`/`unload` verbs are deprecated and silently no-op on recent systems
# — which is the usual reason "start at login" appears to do nothing.
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"

# Load (or reload) the plist, preferring the modern API and falling back to the
# legacy one on older macOS. Returns non-zero only if both approaches fail.
load_agent() {
  launchctl bootout "$SERVICE" 2>/dev/null || true       # clear any stale copy
  if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
    launchctl enable "$SERVICE" 2>/dev/null || true
    launchctl kickstart -k "$SERVICE" 2>/dev/null || true # start now (and on future logins)
    return 0
  fi
  # Legacy fallback (pre-Yosemite … early Sierra).
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
}

unload_agent() {
  launchctl bootout "$SERVICE" 2>/dev/null \
    || launchctl unload "$PLIST" 2>/dev/null || true
}

# Resolve an absolute node path. launchd runs with a minimal PATH, so we bake the
# full path into the plist rather than relying on it. Covers the nodejs.org
# installer (/usr/local/bin), Homebrew (/opt/homebrew/bin), and nvm.
find_node() {
  command -v node 2>/dev/null && return 0
  for n in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do [ -x "$n" ] && { echo "$n"; return 0; }; done
  if [ -d "$HOME/.nvm/versions/node" ]; then
    local v; v="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
    [ -n "$v" ] && [ -x "$HOME/.nvm/versions/node/$v/bin/node" ] && { echo "$HOME/.nvm/versions/node/$v/bin/node"; return 0; }
  fi
  return 1
}

case "$CMD" in
  install)
    NODE="$(find_node || true)"
    [ -z "$NODE" ] && { echo "❌ node was not found. Install Node 18+ from https://nodejs.org first."; exit 1; }
    # Only PIN a data dir into the service when the user explicitly chose one.
    # Otherwise leave DATA_DIR unset in the plist so the server falls back to its
    # WorkingDirectory (<repo>/data) or a location picked later in the app's
    # Settings — a baked-in default would wrongly show the app's "change data
    # directory" field as permanently "Pinned by DATA_DIR".
    DATA_DIR_EXPLICIT="${DATA_DIR:-}"
    DATA_DIR="${DATA_DIR:-$REPO/data}"      # effective path (for mkdir + port probe)
    LOG="$HOME/Library/Logs/cove.log"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$DATA_DIR"
    DATA_DIR_PLIST_LINE=""
    [ -n "$DATA_DIR_EXPLICIT" ] && DATA_DIR_PLIST_LINE="    <key>DATA_DIR</key><string>$DATA_DIR</string>
"
    # Run node DIRECTLY (no login shell) with absolute paths — avoids the
    # dotfile-sourcing flakiness of `zsh -lc`. caffeinate wraps it for keep-awake.
    ARGS="    <string>$NODE</string>
    <string>$REPO/server.js</string>"
    if [ "${KEEP_AWAKE:-0}" = "1" ]; then
      ARGS="    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
$ARGS"
    fi
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
$ARGS
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
$DATA_DIR_PLIST_LINE    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
    if ! load_agent; then
      echo "❌ launchd wouldn't load the agent."
      echo "   launchctl print '$SERVICE':"; launchctl print "$SERVICE" 2>&1 | sed 's/^/     /' | head -20
      exit 1
    fi
    echo "✅ Installed the login agent. Verifying it starts…"
    # Verify it actually came up: probe /api/health for a few seconds.
    PORT="$(DATA_DIR="$DATA_DIR" "$NODE" server.js --print-config 2>/dev/null | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).port||"3000"))}catch(e){process.stdout.write("3000")}})')"
    PORT="${PORT:-3000}"
    up=""
    for i in $(seq 1 12); do
      if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then up=1; break; fi
      sleep 0.5
    done
    if [ -n "$up" ]; then
      echo "✅ Cove is running and answering on http://127.0.0.1:$PORT (starts at login, restarts if it stops)."
      echo "   Data:  $DATA_DIR${DATA_DIR_EXPLICIT:+  (pinned by DATA_DIR — set explicitly)}"
      [ -z "$DATA_DIR_EXPLICIT" ] && echo "          (not pinned — you can relocate it later from the app's Settings → Data location)"
      echo "   Log:   $LOG"
      [ "${KEEP_AWAKE:-0}" = "1" ] && echo "   Keep-awake: ON (see docs/macos-startup.md)."
    else
      echo "⚠ The agent loaded but Cove isn't answering on port $PORT yet. Most common cause:"
      echo "   another Cove is already running on that port (e.g. your Automator app) —"
      echo "   stop it, then: scripts/macos-service.sh restart"
      echo "   Recent log ($LOG):"
      tail -n 15 "$LOG" 2>/dev/null | sed 's/^/     /'
      echo "   State: launchctl print '$SERVICE' | grep -E 'state|last exit'"
    fi
    ;;
  restart)
    launchctl kickstart -k "$SERVICE" 2>/dev/null && echo "✅ Restarted." \
      || echo "Couldn't restart — is it installed? Try: scripts/macos-service.sh install"
    ;;
  uninstall)
    unload_agent
    rm -f "$PLIST"
    echo "✅ Removed the Cove login service."
    ;;
  status)
    if launchctl print "$SERVICE" >/dev/null 2>&1; then
      echo "Cove service is loaded ($SERVICE). Recent state:"
      launchctl print "$SERVICE" 2>/dev/null | grep -E 'state|pid|last exit' | sed 's/^/   /'
    elif launchctl list 2>/dev/null | grep -q "$LABEL"; then
      echo "Cove service is loaded (legacy):"; launchctl list | grep "$LABEL"
    else
      echo "Cove service is not loaded. Run: scripts/macos-service.sh install"
    fi
    echo
    echo "Where DATA_DIR is set (this is what makes the app show 'Pinned by DATA_DIR'):"
    found=""
    pdd="$(plutil -extract EnvironmentVariables.DATA_DIR raw "$PLIST" 2>/dev/null || true)"
    if [ -n "$pdd" ]; then echo "   • launch-agent plist → $pdd   (fix: scripts/macos-service.sh unpin)"; found=1
    else echo "   • launch-agent plist → not set ✓"; fi
    edd="$(grep -HnE '^[[:space:]]*DATA_DIR=' "$REPO/.env" 2>/dev/null || true)"
    [ -n "$edd" ] && { echo "   • $edd   (fix: remove that line from .env, then ./stop.sh && ./start.sh)"; found=1; }
    for f in "$HOME/.zshenv" "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
      s="$(grep -HnE 'DATA_DIR=' "$f" 2>/dev/null || true)"; [ -n "$s" ] && { echo "   • shell → $s   (fix: remove that line, open a new terminal, restart Cove)"; found=1; }
    done
    live_pid=""; live=""
    for pid in $(pgrep -f 'server.js' 2>/dev/null | sort -u); do
      v="$(ps eww "$pid" 2>/dev/null | tr ' ' '\n' | grep '^DATA_DIR=' | head -1 || true)"
      [ -n "$v" ] && { echo "   • running server pid $pid → $v   (the live value in effect now)"; live_pid="$pid"; live="$v"; break; }
    done
    if [ -n "$found" ]; then
      : # a persistent source was reported above with its fix
    elif [ -n "$live_pid" ]; then
      echo "   → Not set anywhere persistent, but the RUNNING server still carries it —"
      echo "     baked in by an OLDER launcher. A plain restart.sh may not replace it if"
      echo "     it now resolves a different data dir/port. Stop EVERY Cove server and"
      echo "     start once with the current code:"
      echo "         pkill -f server.js   &&   ./start.sh"
      echo "     (start.sh uses your saved location; your notes are wherever the line"
      echo "      above points — copy that folder to a new spot first if you relocate.)"
    else
      echo "   (nothing pins it — the app's Settings → Data location should be editable)"
    fi
    ;;
  unpin)
    # Convert a DATA_DIR env-pin in the service into an editable pointer: keep the
    # SAME location (so no notes are lost) but stop pinning it via the env var, so
    # the app's Settings → Data location becomes editable again.
    [ -f "$PLIST" ] || { echo "No service plist at $PLIST. If you don't use the login service, DATA_DIR is set elsewhere — run: scripts/macos-service.sh status"; exit 1; }
    cur="$(plutil -extract EnvironmentVariables.DATA_DIR raw "$PLIST" 2>/dev/null || true)"
    [ -z "$cur" ] && { echo "DATA_DIR isn't pinned in the service plist — nothing to unpin. Run 'status' to see where it comes from."; exit 0; }
    NODE="$(find_node || true)"; [ -z "$NODE" ] && { echo "❌ node was not found."; exit 1; }
    "$NODE" -e 'require(process.argv[1]+"/lib/config").writeDataDirPointer(process.argv[1], process.argv[2])' "$REPO" "$cur" \
      && echo "→ recorded the current location as an editable pointer ($cur)."
    /usr/bin/sed -i '' '/<key>DATA_DIR<\/key>/d' "$PLIST"
    if load_agent; then
      echo "✅ Unpinned DATA_DIR. Reload the app — Settings → Data location is now editable (source: pointer)."
    else
      echo "⚠ Edited the plist but launchd wouldn't reload it. Try: scripts/macos-service.sh restart"
    fi
    ;;
  *)
    echo "Usage: scripts/macos-service.sh {install|uninstall|status|restart|unpin}"
    echo "  DATA_DIR=... KEEP_AWAKE=1 scripts/macos-service.sh install   # pin a specific data folder"
    echo "  scripts/macos-service.sh unpin                               # stop pinning DATA_DIR (keep the location, make it editable)"
    ;;
esac
