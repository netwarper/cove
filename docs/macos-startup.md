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

### If it doesn't start at login

The installer uses the modern `launchctl bootstrap` API (with a fallback to the
old `load`/`unload` on pre-2016 macOS). If Cove isn't coming up:

```bash
scripts/macos-service.sh status     # shows state / pid / last exit code
tail -n 40 ~/Library/Logs/cove.log  # server's own output and any crash reason
```

Common causes:

- **`node` isn't on the login PATH.** The agent runs through a login shell
  (`zsh -lc`) so most setups resolve `node`, but if you installed it via `nvm`
  the version is only loaded interactively. Either `brew install node`, or point
  the agent at the exact binary (`which node`) and re-run `install`.
- **Full Disk / folder permission.** If `DATA_DIR` is in iCloud/Dropbox, grant
  the terminal app Full Disk Access (System Settings → Privacy & Security) so
  launchd can write there at login.
- **Reinstall cleanly.** `scripts/macos-service.sh uninstall && scripts/macos-service.sh install`
  removes any stale agent registration before loading the new one.

## Restarting the server (e.g. after an update)

Refreshing the browser reloads the app's static files, but the server's API
routes are loaded once when `node server.js` starts — so after you pull a new
version, a running server keeps serving the **old** endpoints until it restarts.
If a brand-new feature returns "not found," the server needs a restart.

If you launched the server from a terminal or Automator action you can't reach
anymore, use the restart script — it finds the running instance via its lock
file (`<DATA_DIR>/instance.lock`) or its port, stops it gracefully (SIGTERM, then
force only if it doesn't drain), and starts a fresh detached server:

```bash
scripts/restart.sh
# or, if you run a non-default data dir:
DATA_DIR="/path/to/data" scripts/restart.sh
```

It logs the new server to `~/Library/Logs/cove.log` and waits for `/api/health`
before reporting success. (If you use the login service above, just
`scripts/macos-service.sh uninstall && scripts/macos-service.sh install`
instead — that reloads it cleanly and it will keep restarting itself.)

`restart.sh` starts the server **detached** and then exits, so it's a good fit
for a double-clickable launcher: it won't tie the server's lifetime to the thing
that launched it (which is how a server ends up "stuck" in a terminal you closed),
and it's safe to run repeatedly — each run just restarts cleanly.

### Launching it from an Automator app

If the login service won't stick, an Automator **Application** that runs
`restart.sh` is a fine alternative. In Automator: new **Application** → add
**Run Shell Script** → set **Shell** to `/bin/bash` → paste:

```bash
COVE_DIR="/Users/you/path/to/cove" "/Users/you/path/to/cove/scripts/restart.sh"
```

Save it as an app and (optionally) add it to **System Settings → General →
Login Items**. Double-clicking it starts (or restarts) Cove.

> **Why the login service or a naïve script can fail: `node` isn't found.**
> Apps launched by launchd or Automator get a minimal `PATH` that usually
> excludes Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) and nvm — so a bare
> `node` fails silently. `restart.sh` now locates `node` in those common spots
> automatically. If you hit this elsewhere, install Node from
> [nodejs.org](https://nodejs.org) (it lands in `/usr/local/bin`) or point at the
> absolute path from `which node`.

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
