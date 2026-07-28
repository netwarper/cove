# 🗒️ Cove

**Cove** is a self-contained, **encrypted** meeting-notes application that runs locally with a
one-click launcher — and is ready to be hosted remotely later. It has **zero
runtime dependencies** (Node core only), so the whole folder can be copied to
any machine with Node.js and started immediately.

The central idea: **each new daily note is seeded with the ongoing notes from
the most recent note in the same workspace**, while the meeting-specific notes
stay behind. Tasks live at the **workspace** level (Todoist-style, with due
dates, priorities, and recurrence) and surface on each note as **Overdue &
Today** and **Upcoming**.

---

## Quick start (one click)

You need [Node.js](https://nodejs.org) v18 or newer. Then:

- **macOS / Linux:** double-click `start.sh` (or run `./start.sh` in a terminal)
- **Windows:** double-click `start.bat`
- **Any platform:** `npm start` (equivalently `node server.js`)

Your browser opens at **http://127.0.0.1:3000**. On first run you set a
**passphrase** that encrypts all your data. There is no account and no cloud —
everything stays on your machine.

> ⚠️ The passphrase is never stored. If you forget it, the data cannot be
> recovered — that is the point of encryption at rest.

**Start Cove automatically at login (macOS):** run
`scripts/macos-service.sh install` — it registers a launchd agent that starts
Cove at login and restarts it if it stops. See
[`docs/macos-startup.md`](docs/macos-startup.md) for that plus exactly how Cove
behaves through sleep / lid-close.

---

## Features

| Area | What it does |
|------|--------------|
| **Workspaces** | Notes are grouped into **General** plus any workspaces you create. Empty workspaces show a landing page with tips instead of an auto-created note. |
| **Daily & scratch notes** | **New Daily** starts a note that carries your ongoing notes forward from the last **daily** note. **New scratch note** is a clean Meeting Notes page for a quick jot — it never affects the ongoing thread. |
| **Sections** | Overdue & Today · Upcoming · Ongoing Notes · Meeting Notes. Scratch notes show only Meeting Notes. |
| **Tasks (Todoist-style)** | One unified module for to-dos **and** reminders. Each task is **workspace-level** with a **due date** (defaults to today if you don't set one), **priority (P1–P4)**, and optional **recurrence** (daily / weekdays / weekly / monthly / every-N-days). The note view shows your workspace's **Overdue & Today** and **Upcoming** tasks; complete one and it rolls forward if it repeats, or crosses out **on the note it was completed on** (never on future notes). ⏭ skips a single occurrence. |
| **Quick-add (no LLM)** | Type naturally — `email Sam tomorrow p1 every Friday` — and the due date, priority, and repeat are parsed locally (deterministic, no model calls), with pickers to adjust. |
| **Ongoing Notes** | Rich text that **copies into the next daily note**. |
| **Re-date a note** | Click a note's date to pre-/post-date it — label one you forgot yesterday or prep tomorrow's. Changes the **displayed date only**; the carry-forward order (by creation) is untouched, so the running thread never rewires. |
| **Meeting Notes** | Rich text that is **not** copied over. |
| **Rich text** | Bold, italic, underline, strikethrough, bullet & numbered lists, headings, links, and **inline images** you can **resize** (drag the corner handle, or `+`/`-`) and **paste or drag-and-drop** straight in. |
| **Attachments** | Attach files (up to 20 MB) to a note; stored encrypted. |
| **Titles** | Auto-titled with the date, with an optional specific title. |
| **Global search** | Search across every note in every workspace. |
| **Tasks page** | One view of every open task across all workspaces, **grouped by due date** (overdue → today → upcoming → no date) and, within a day, by priority then workspace. Complete a task or click its workspace badge to jump there. |
| **Meeting recording** | Record your **mic** and the **other side** (shared tab/system audio) mixed into **one `.wav` file** (encrypted like any attachment), with an optional near-live transcript — timestamped and labeled **You** vs **Them** — in its own area below your notes. |
| **Screen recording** | **🖥 Screen** records the shared screen/window/tab video with its system audio (+ your mic) to one `.webm` video, saved as an encrypted attachment. |
| **Sort notes** | Sort the sidebar by **Created / Modified / Name**, ascending or descending (persisted). |
| **Biometric unlock** | Optionally re-unlock with **Touch ID / Windows Hello / a device passkey** after your session times out, instead of retyping your passphrase (per-device, opt-in; passphrase still required elsewhere). |
| **Inbox (Slack → tasks)** | Message yourself (Slack via Zapier / Make / a Cloudflare Worker) → a file lands in `DATA_DIR/inbox/` → the app turns it into a task (badged **📥**) in the target workspace, even if the Mac was asleep. See [`docs/slack-inbox.md`](docs/slack-inbox.md). |
| **Slack agenda (→ out)** | Post your due &amp; overdue tasks to a Slack channel via an Incoming Webhook — on demand or auto-daily (Settings → Slack). |
| **Favorites** | Star notes; find them in the ★ Favorites view. |
| **Tags** | Tag notes and filter search with `tag:name`. Click a tag to open a **cross-workspace tag view** of every note carrying it. |
| **Tag bookmarks** | Bookmark a tag to pin it to a sidebar section that's visible in **every** workspace. Creating a note from a tag view auto-applies the tag and asks which workspace to put it in. |
| **Templates** | Reusable meeting templates that seed the **Meeting Notes** section of new notes — ships with **1:1**, **Team standup**, **Project update**, and **Interview**, and you can add your own. Ongoing notes still come from the previous note. Set a per-workspace default or pick one from **New ▾**. |
| **Trash** | Deleted notes go to Trash and can be restored for 30 days before permanent removal. |
| **Move / duplicate** | Move a note to another workspace, or duplicate it. |
| **Export / print** | Export a note to **PDF (print), HTML, Markdown, or JSON**. |
| **Export for AI** | Export a whole **workspace** or a **tag** as clean Markdown to upload to ChatGPT / Claude as knowledge — as one combined file (with a table of contents and open tasks) or a ZIP with one file per note. |
| **Image text (OCR)** | Paste or attach a screenshot and Cove reads its text **on-device** (via a bundled, offline Tesseract engine — nothing is uploaded) so the image turns up in search. Toggle it off in Settings. |
| **Import** | Upload a previously exported JSON / HTML / Markdown note into a workspace. |
| **Encrypted backup** | Download a single encrypted backup file of everything; restore on a fresh install. Bulk-export a whole workspace as a ZIP (HTML/MD/JSON). |
| **Version history** | Every note keeps automatic snapshots (up to 20); view and restore any earlier version. |
| **Live sync** | Changes to the data directory (e.g. from another device via a synced folder) refresh open notes in real time; save conflicts can be resolved by keeping both copies. |
| **Note links & backlinks** | Link between notes (`⧉` in the editor); each note shows what links to it. Rich text also supports **tables** and **/slash commands**. |
| **Deep links** | Each note has a shareable `#note/<id>` link (**⋯ → Copy link to note**); a page refresh reopens the same note instead of jumping to the newest. |
| **User manual** | A full in-app manual at `/manual.html` (also linked from **?** Help and **⋮ → User manual**), theme-matched and available offline. |
| **Offline / installable** | Ships as a PWA — installable, with an offline app shell. |
| **Security** | AES-256-GCM **envelope encryption at rest**, scrypt key derivation, **passphrase change + recovery key**, CSRF tokens, session auth with idle auto-lock, CSP + anti-clickjacking headers, login rate-limiting. |

---

## Working off Google Drive / Box / Dropbox

All data lives in one directory, chosen with the `DATA_DIR` environment
variable. Point it at a cloud-sync folder to keep an **encrypted** copy synced:

```bash
# macOS / Linux
DATA_DIR="/Users/you/Google Drive/MeetingNotes" ./start.sh
DATA_DIR="/Users/you/Dropbox/MeetingNotes"      ./start.sh
```

```bat
:: Windows
set DATA_DIR=C:\Users\you\Box\MeetingNotes
start.bat
```

Or copy `.env.example` to `.env` and set `DATA_DIR` there. Because the files are
encrypted before they touch disk, the cloud provider only ever sees ciphertext.
Writes are atomic (write-then-rename) so sync clients never see half-written files.

You can also **view and change the data directory from the app** — **⚙️ Settings
→ Data location**. It shows the current path and lets you point it at a new one;
the change is recorded in a small `datadir.path` file and takes effect on the
next restart (move your existing data folder to the new path first if you want to
keep your notes). An explicit `DATA_DIR` environment variable always wins and
pins the location (the setting shows it read-only in that case).

---

## Updating (drop-in, keeps your notes)

The app is designed so a code update never touches your data:

- **Your data and local config live outside the code.** Notes, `vault.json`,
  `instance.json`, backups and the search index all live in your `DATA_DIR`; the
  `datadir.path` pointer and `.env` sit alongside the code but are **git-ignored**.
  Nothing under version control contains your data or keys.
- **To update:** `git pull` (cleanest — it never overwrites untracked/ignored
  files), **or** download the latest code and overwrite the app folder. As long
  as you keep your `DATA_DIR` (and `datadir.path` / `.env` if you use them), all
  your notes, settings, tasks and unlock keys carry over untouched.
- **Most future-proof:** keep `DATA_DIR` *outside* the app folder (set it once in
  Settings → Data location, or via the env var). Then the code folder is fully
  disposable — delete and replace it wholesale and your data is never at risk.
- **The on-disk format is versioned.** Encrypted files carry a format marker and
  the search index a version number; the app migrates/rebuilds derived data
  automatically on first launch after an update, so newer code reads older data.

A quick belt-and-braces habit: take an **encrypted backup** (⋮ → Backup &
restore) before a big update. It restores onto a fresh install with your existing
passphrase.

---

## Choosing the port

The listening port resolves in this order (highest first): a **`--port` flag**,
the **`PORT` env var**, a **durable pin** in `instance.json`, a port **derived
from your domain**, then the default **3000**.

```bash
node server.js --port 8080         # run on 8080 for this launch
PORT=8080 node server.js           # same, via env var
node server.js --set-port 8080     # pin 8080 durably for this data dir, then exit
./start.sh --port 8080             # the launchers forward flags too
```

`--set-port` stores the choice in `instance.json` inside the data directory, so
it travels with your data and never drifts between restarts.

## Durable local domain & running multiple instances

The port and address are **durable per instance** and never auto-change, so a
hosts-file record or a `*.localhost` domain you set up stays valid forever.

On first run, `start.sh` / `start.bat` offer to assign a durable local domain.
You can also do it explicitly:

```bash
node server.js --set-domain notes      # -> http://notes.localhost:<stable-port>
node server.js --set-domain notes --port 8443   # …with an explicit port
node server.js --print-config          # show the resolved name/domain/port
```

- A bare name becomes **`<name>.localhost`**, which resolves to `127.0.0.1`
  automatically in modern browsers — **no hosts-file edit needed**. For a custom
  domain (e.g. `notes.home.lan`) the command prints the exact `hosts` line to add.
- The choice is stored in **`instance.json` inside the data directory**, so it
  travels with your data — copy the directory to another machine and the same
  domain/port come with it.

**Multiple instances / other apps on the machine** are handled gracefully:

- Each instance gets its **own stable port** (derived from its domain, or set
  explicitly), so two instances don't fight over a port.
- If you launch a second copy against the **same data directory**, it detects the
  running instance (via a lock file) and points you to the existing URL instead
  of starting a broken second server.
- If the port is taken by **another app**, startup exits with a clear message
  telling you how to pick a different domain/port — it never crashes with a raw
  stack trace, and never silently grabs a random port (which would break your
  durable URL).

## Meeting recording & transcription

Click **🔴 Record** in the Meeting Notes section to capture the meeting as two
separate, labeled sources:

- **You** — your microphone (`getUserMedia`).
- **Them** — the other side, via a shared **tab/window with "Share audio"**
  (`getDisplayMedia`). This works great for browser calls (Google Meet, Zoom on
  the web). Capturing a *native* Zoom/Teams desktop app's system audio on macOS
  needs a virtual-audio device (e.g. BlackHole) — the UI tells you when no shared
  audio was included.

On stop, both sides are **mixed into a single `.wav` file** and saved as one
encrypted attachment (`meeting-audio-<time>.wav`) — a universally-playable format,
tuned for meeting speech. Nothing leaves your machine from recording alone.

**Transcription is optional and off by default.** Enable it from the **⚙ Transcription**
button next to Record (or **⋮ → Settings → Meeting transcription**) by
setting an **OpenAI-compatible STT endpoint**:

- **Local (private):** point it at a Whisper server on your machine, e.g.
  `http://127.0.0.1:8080/v1/audio/transcriptions` (whisper.cpp server,
  faster-whisper, LocalAI, …). Audio never leaves the device.
- **Cloud:** an external endpoint + API key (OpenAI, Deepgram, …). The app warns
  you that audio is sent there for transcription.

The browser records, chunks each source into ~6-second WAV segments, and the
**local server proxies** them to your endpoint (so the API key stays server-side
and the strict CSP is respected). The transcript appears in its **own region
below your notes** — so incoming lines never shift or disrupt what you're typing.
Each line is **timestamped** (wall-clock time) and labeled **You**/**Them**, and
lines from both sides are ordered by when they were actually spoken (captured at
chunk time, so variable transcription latency can't scramble the order).

Config (all optional; stored encrypted in settings): endpoint, API key, model.

## View on your phone (offline viewer)

Because your notes live encrypted in a synced folder (Google Drive / Box /
Dropbox), you can read them on a phone **without the Mac running and without any
network** — using the built-in offline viewer.

It's a single self-contained HTML file, `meeting-notes-viewer.html`, that
**decrypts on the device** with your passphrase (or recovery key). Everything —
the decryptor, the UI, and your *encrypted* notes — is inlined into that one
file, so it reveals nothing without your passphrase.

**Get it:**
- In the app: **⋮ → Backup / restore → Download offline viewer**, or
- `node server.js --build-viewer` (set `MN_PASSPHRASE` to also embed inline images), or
- automatically: whenever scheduled backups run (`AUTO_BACKUP_DIR`), a fresh copy
  is written into your data folder so it syncs to your phone on its own.

**Open it on iPhone/iPad:** in the Google Drive / Box / Files app, tap
`meeting-notes-viewer.html` → open in Safari → enter your passphrase. It works
as a local file with no server, because it ships a **pure-JavaScript crypto
fallback** for the case where iOS Safari doesn't expose WebCrypto on `file://`.

It's **read-only** (viewing, search, workspaces, inline images). To edit, use
the full app. The snapshot is only as current as your folder last synced, so
grab a fresh copy before you head offline.

## Portability

The app is intentionally easy to relocate:

- **No build step, no `node_modules`** — pure Node standard library + vanilla JS.
- Copy the whole folder anywhere with Node installed and run `node server.js`.
- Move your data separately by copying the `DATA_DIR` folder.
- The frontend talks to the backend only through same-origin JSON endpoints, so
  swapping the host/endpoint requires no code changes.

---

## Hosting remotely (later)

The app is built so this is a configuration change, not a rewrite:

1. Run it behind a TLS-terminating reverse proxy (nginx, Caddy, a PaaS, etc.).
2. Set `HOST=0.0.0.0` and a `PORT`, keep the proxy as the only public entry point.
3. Add the `Secure` attribute to the session cookie (one line in `sessionCookie()`
   in `server.js`) once you are always on HTTPS.
4. The encryption-at-rest model already means the server never persists the key —
   users unlock with their passphrase per session.

See the [environment / hosting docs](https://code.claude.com/docs/en/claude-code-on-the-web)
for how network policies work in managed environments.

---

## Configuration

All optional, via environment variables (or a `.env` file):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Listening port |
| `HOST` | `127.0.0.1` | Bind address (localhost-only by default) |
| `DATA_DIR` | `./data` | Encrypted data directory (point at a cloud-sync folder) |
| `MAX_BODY` | `33554432` (32 MB) | Max request body (attachments travel as JSON) |
| `SESSION_TTL` | `240` | Session lifetime in minutes |
| `COOKIE_SECURE` | `auto` | `auto` adds the `Secure` cookie flag over TLS; `always` / `never` to force |
| `INBOX_TOKEN` | _(off)_ | Enable `POST /api/inbox` for a relay/Slack push (see [`docs/slack-inbox.md`](docs/slack-inbox.md)); the folder inbox works without it |
| `SLACK_WEBHOOK_URL` | _(off)_ | Default Slack Incoming Webhook for the outbound agenda (also settable in Settings → Slack) |
| `AUTO_BACKUP_DIR` | _(off)_ | Enable scheduled encrypted backups to this directory (use a different disk/folder) |
| `AUTO_BACKUP_HOURS` | `24` | Hours between automatic backups |
| `AUTO_BACKUP_KEEP` | `7` | How many recent backups to retain |

---

## Security model

- **Envelope encryption:** a single random 32-byte **Data Encryption Key (DEK)**
  encrypts every note, workspace blob, and attachment with **AES-256-GCM**
  (authenticated; files carry a `MN1` marker). The DEK is itself wrapped in
  **key slots** — one derived from your passphrase, one from a recovery key —
  via `scrypt` (N=16384, r=8, p=1). Because data is keyed by the DEK, changing
  your passphrase or rotating the recovery key only re-wraps the DEK; data files
  are never re-encrypted.
- **Passphrase change & recovery key:** change your passphrase any time; a
  one-time recovery key (shown at setup, regenerable) is the only way back in if
  you forget it.
- **Key handling:** the DEK lives **only in server memory** while a session is
  unlocked; it is never written to disk.
- **Biometric unlock (optional, per-device):** enroll in **⚙️ Settings** to
  re-unlock with Touch ID / Windows Hello / a device passkey after your session
  times out. It adds a **key slot wrapping the DEK with a secret produced by the
  platform authenticator via the WebAuthn PRF extension** — that secret is only
  released by the authenticator after a biometric check and is never stored, so a
  copied data folder still can't unlock without your device. Your passphrase
  remains primary and is required on any un-enrolled device. Requires a
  PRF-capable browser (recent Chrome/Edge/Safari) served over **`localhost`, a
  `<name>.localhost` domain, or HTTPS** — WebAuthn refuses a bare `127.0.0.1` IP,
  so use `node server.js --set-domain notes` (→ `notes.localhost`) or `localhost`.
- **Auth:** HttpOnly, SameSite=Strict session cookie (`Secure` added
  automatically over TLS — see `COOKIE_SECURE`), **CSRF token** on every
  state-changing request, per-IP login rate-limiting, and **client-side idle
  auto-lock** after 15 minutes.
- **Hardening:** strict Content-Security-Policy, `X-Frame-Options: DENY`,
  `nosniff`, path-traversal-safe IDs, request size limits, and a small HTML
  sanitizer for imported/rendered content.
- **Trash safety:** deletes are recoverable for 30 days rather than immediate.
- **Backups & integrity:** optional scheduled encrypted backups (`AUTO_BACKUP_DIR`),
  and a decrypt-check that finds corrupt files — `node server.js --verify`
  (or the button in Backup & restore). A single damaged note is skipped rather
  than breaking the app.

If the endpoint (or a synced Drive/Box/Dropbox copy) is breached, the attacker
gets only ciphertext.

> This protects **data at rest** for a single vault. Per-user/multi-tenant
> vaults are a planned follow-up; for an internet-facing deployment, front the
> app with TLS (which flips the `Secure` cookie flag on automatically).

## Docker

```bash
docker build -t cove .
docker run -p 3000:3000 -v mn-data:/data cove
```

A `/api/health` endpoint (also used by the image's `HEALTHCHECK`) returns
`{ ok, initialized }` without auth.

---

## Running the checks

```bash
npm run check   # quality: syntax + lightweight static checks
npm test        # functional + security test suites (zero dependencies)
npm run verify  # both of the above
```

---

## Project layout

```
server.js              zero-dependency HTTP server + router
lib/crypto.js          scrypt KDF + AES-256-GCM helpers
lib/store.js           encrypted file store, note & task logic
lib/tasks.js           recurrence engine + task helpers (pure)
public/js/taskparse.js natural-language quick-add parser (no LLM)
public/                frontend (index.html, css, vanilla JS)
test/                  functional + security suites
scripts/check-quality.js  syntax + static checks
start.sh / start.bat   one-click launchers
prompt-version.md      how to regenerate this app from a prompt
```

---

## Third-party

On-device OCR is powered by [Tesseract.js](https://github.com/naptha/tesseract.js)
and the Tesseract engine (both Apache-2.0), vendored under
`public/vendor/tesseract/` (~10 MB: library, worker, a SIMD LSTM WASM core, and
the English model). Nothing is fetched from the network — it runs entirely in
your browser. These are the app's only bundled third-party assets; the server
and the rest of the client remain zero-dependency (Node core only).

## License

MIT (Cove's own code). Bundled third-party assets keep their own licenses — see
**Third-party** above.
