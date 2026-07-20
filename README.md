# 🗒️ Meeting Notes

A self-contained, **encrypted** meeting-notes application that runs locally with a
one-click launcher — and is ready to be hosted remotely later. It has **zero
runtime dependencies** (Node core only), so the whole folder can be copied to
any machine with Node.js and started immediately.

The central idea: **each new note is seeded from the most recent note in the
same workspace** — your open to-dos and carryover notes come along automatically,
while the meeting-specific notes stay behind.

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

---

## Features

| Area | What it does |
|------|--------------|
| **Workspaces** | Notes are grouped into **General** plus any workspaces you create. |
| **New from latest** | “+ New” seeds the note from the workspace's most recent note. |
| **Four sections** | To-Do · Reminders · Carryover Notes · Meeting Notes — shown as **4 columns or 4 rows** (toggle in the top bar). |
| **To-Do** | Completed items strike through and sink to the bottom. **Incomplete items copy into the next new note.** |
| **Reminders** | Once / daily / weekly / monthly / every-N-days. When due, a reminder **pops into the to-do list**. |
| **Carryover Notes** | Rich text that **copies into the next new note**. |
| **Meeting Notes** | Rich text that is **not** copied over. Supports a **free-form mode** (double-click anywhere to drop a text box, OneNote-style). |
| **Rich text** | Bold, italic, underline, strikethrough, bullet & numbered lists, headings, links, and **inline images you can resize** (drag the corner, or `+`/`-`). |
| **Attachments** | Attach files (up to 20 MB) to a note; stored encrypted. |
| **Titles** | Auto-titled with the date, with an optional specific title. |
| **Global search** | Search across every note in every workspace. |
| **Global to-dos** | One view of all open to-dos across workspaces. Completing one there updates the source note, and vice-versa. |
| **Meeting recording** | Record your **mic** and the **other side** (shared tab/system audio) as two labeled streams, saved as encrypted attachments, with an optional near-live transcript that marks **You** vs **Them**. |
| **Favorites** | Star notes; find them in the ★ Favorites view. |
| **Tags** | Tag notes and filter search with `tag:name`. |
| **Templates** | Reusable meeting templates (1:1, standup, retro) that seed the **Meeting Notes** section of new notes. Carry-forward is unchanged — To-Do & Carryover still come from the previous note; a template's defaults fill them only on a workspace's first note. Set a per-workspace default or pick one from **New ▾**. |
| **Trash** | Deleted notes go to Trash and can be restored for 30 days before permanent removal. |
| **Move / duplicate** | Move a note to another workspace, or duplicate it. |
| **Reminders (time-aware)** | Optional time-of-day; a background poll surfaces due reminders and (with permission) raises **desktop notifications** even for workspaces you aren't viewing. |
| **Export / print** | Export a note to **PDF (print), HTML, Markdown, or JSON**. |
| **Import** | Upload a previously exported JSON / HTML / Markdown note into a workspace. |
| **Encrypted backup** | Download a single encrypted backup file of everything; restore on a fresh install. Bulk-export a whole workspace as a ZIP (HTML/MD/JSON). |
| **Version history** | Every note keeps automatic snapshots (up to 20); view and restore any earlier version. |
| **Live sync** | Changes to the data directory (e.g. from another device via a synced folder) refresh open notes in real time; save conflicts can be resolved by keeping both copies. |
| **Note links & backlinks** | Link between notes (`⧉` in the editor); each note shows what links to it. Rich text also supports **tables** and **/slash commands**. |
| **Pin / archive** | Pin notes to the top or archive them out of the active list; filter/sort the note list. |
| **Agenda** | A dated view of all due to-dos across workspaces. Reminders support a time-of-day, an end date, and snooze. |
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

---

## Durable local domain & running multiple instances

The port and address are **durable per instance** and never auto-change, so a
hosts-file record or a `*.localhost` domain you set up stays valid forever.

On first run, `start.sh` / `start.bat` offer to assign a durable local domain.
You can also do it explicitly:

```bash
node server.js --set-domain notes      # -> http://notes.localhost:<stable-port>
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

Both streams are **saved as encrypted attachments** on stop. Nothing leaves your
machine from recording alone.

**Transcription is optional and off by default.** Enable it in **⋮ → Passphrase &
recovery → Meeting transcription** by setting an **OpenAI-compatible STT
endpoint**:

- **Local (private):** point it at a Whisper server on your machine, e.g.
  `http://127.0.0.1:8080/v1/audio/transcriptions` (whisper.cpp server,
  faster-whisper, LocalAI, …). Audio never leaves the device.
- **Cloud:** an external endpoint + API key (OpenAI, Deepgram, …). The app warns
  you that audio is sent there for transcription.

The browser records, chunks each source into ~6-second WAV segments, and the
**local server proxies** them to your endpoint (so the API key stays server-side
and the strict CSP is respected). Transcript lines stream into the note labeled
**You**/**Them**.

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
docker build -t meeting-notes .
docker run -p 3000:3000 -v mn-data:/data meeting-notes
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
lib/store.js           encrypted file store, note/reminder/todo logic
public/                frontend (index.html, css, vanilla JS)
test/                  functional + security suites
scripts/check-quality.js  syntax + static checks
start.sh / start.bat   one-click launchers
prompt-version.md      how to regenerate this app from a prompt
```

---

## License

MIT
