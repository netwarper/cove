# Running Cove on macOS: start at login & behavior through sleep

Cove is a small local server (`node server.js`). This guide makes it **start
automatically at login**, restart if it ever stops, and explains exactly what
happens when your MacBook sleeps.

## Start at login (one command)

```bash
# from the Cove folder
DATA_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Cove" \
  scripts/macos-service.sh install
```

This installs a **launchd LaunchAgent** (`~/Library/LaunchAgents/com.cove.app.plist`)
that:

- starts Cove when you log in (`RunAtLoad`),
- restarts it automatically if it exits (`KeepAlive`),
- runs it with your chosen `DATA_DIR` (point it at an iCloud / Google Drive /
  Dropbox folder to sync across machines),
- logs to `~/Library/Logs/cove.log`.

Manage it:

```bash
scripts/macos-service.sh status      # is it running?
scripts/macos-service.sh uninstall   # remove it
```

To find the URL to open, run `node server.js --print-config` (or set a durable
address once with `node server.js --set-domain cove`, which pins a stable
`cove.localhost` address + port).

## What happens when the Mac sleeps (lid close)

**Short version: closing the lid is safe. Cove pauses and resumes cleanly.**

- When macOS sleeps, the Cove process is *frozen*, not killed. On wake it
  continues serving instantly. No data is lost — every write is atomic
  (write-then-rename) and the encryption key stays in memory across the freeze.
- Your browser tab / installed PWA reconnects on wake (live-sync re-subscribes
  automatically).
- **Session lock:** for security, your *unlocked* browser session times out
  after inactivity (`SESSION_TTL`, default 240 min). After a long sleep you may
  be asked to unlock again with your passphrase or Touch ID — the server itself
  keeps running; only the in-browser session re-locks.

So for the normal "close the lid, reopen later" workflow, the login service
above is all you need.

## Keeping Cove running *while the lid is closed*

Only relevant if you want Cove to keep doing work with the lid **shut** — e.g.
serving other devices on your network, processing the Slack → task inbox, or
running scheduled backups overnight. macOS resists this on purpose; the honest
options are:

1. **Clamshell mode (supported):** connect the Mac to **power + an external
   display** (and a keyboard/mouse, or Bluetooth). macOS then stays awake with
   the lid closed. This is the only Apple-supported way to run lid-closed on a
   laptop.
2. **Prevent sleep while logged in (`caffeinate`):** reinstall with keep-awake:
   ```bash
   KEEP_AWAKE=1 DATA_DIR="…" scripts/macos-service.sh install
   ```
   This wraps the server in `caffeinate -s`, which stops **idle** sleep while
   you're logged in. Caveat: it does **not** override *lid-close* sleep on
   battery, and it will keep the machine awake (more battery use) whenever
   you're logged in. Best paired with the Mac on AC power.
3. **A dedicated always-on host:** if you truly want 24/7 lid-closed operation,
   run Cove on a Mac mini, an always-on desktop, or any small always-on box
   (it's just `node server.js`), and point your data dir at a synced folder.

There is no fully-supported CLI trick to keep a closed-lid MacBook awake on
battery without third-party tools that alter power management — so for a
travel laptop, prefer option 1 or simply rely on the safe pause/resume above.

## Uninstalling

```bash
scripts/macos-service.sh uninstall
```

Removes the LaunchAgent. Your data (in `DATA_DIR`) is untouched.
