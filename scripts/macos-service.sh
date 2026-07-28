#!/usr/bin/env bash
# Install (or remove) Cove as a macOS launch-on-login service via launchd.
#
#   scripts/macos-service.sh install     # start Cove at login, auto-restart
#   scripts/macos-service.sh uninstall   # remove the service
#   scripts/macos-service.sh status      # is it loaded / running?
#
# Options (env vars):
#   DATA_DIR=/path/to/folder   where notes live (default: <repo>/data — point at
#                              a Google Drive / Dropbox / iCloud folder to sync)
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

case "$CMD" in
  install)
    NODE="$(command -v node || true)"
    [ -z "$NODE" ] && { echo "❌ node was not found in PATH. Install Node 18+ from https://nodejs.org first."; exit 1; }
    DATA_DIR="${DATA_DIR:-$REPO/data}"
    LOG="$HOME/Library/Logs/cove.log"
    PREFIX=""
    if [ "${KEEP_AWAKE:-0}" = "1" ]; then PREFIX="$(command -v caffeinate) -s "; fi
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$DATA_DIR"
    # A login shell (-lc) gives launchd your normal PATH so `node` resolves.
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd '$REPO' && exec ${PREFIX}'$NODE' server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>DATA_DIR</key><string>$DATA_DIR</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
    if load_agent; then
      echo "✅ Installed. Cove starts at login and restarts if it stops."
      echo "   Data:  $DATA_DIR"
      echo "   Log:   $LOG"
      echo "   Open:  run 'node server.js --print-config' to see the URL, or check the log."
      [ "${KEEP_AWAKE:-0}" = "1" ] && echo "   Keep-awake: ON (Mac won't sleep while logged in — see docs/macos-startup.md)."
    else
      echo "❌ launchd wouldn't load the agent. Check the log for details:"
      echo "     tail -n 40 '$LOG'"
      echo "   and: launchctl print '$SERVICE'"
      exit 1
    fi
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
    ;;
  *)
    echo "Usage: scripts/macos-service.sh {install|uninstall|status}"
    echo "  DATA_DIR=... KEEP_AWAKE=1 scripts/macos-service.sh install"
    ;;
esac
