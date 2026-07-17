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
| **Favorites** | Star notes; find them in the ★ Favorites view. |
| **Export / print** | Export a note to **PDF (print), HTML, Markdown, or JSON**. |
| **Import** | Upload a previously exported JSON / HTML / Markdown note into a workspace. |
| **Security** | AES-256-GCM **encryption at rest**, scrypt key derivation, session auth, CSP + anti-clickjacking headers, login rate-limiting. |

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

---

## Security model

- **Key derivation:** `scrypt` (N=16384, r=8, p=1) over your passphrase + a random salt.
- **Encryption:** every note, workspace metadata blob, and attachment is
  encrypted with **AES-256-GCM** (authenticated) before being written to disk.
  Files carry a `MN1` format marker and are unreadable without the key.
- **Key handling:** the derived key lives **only in server memory** while a
  session is unlocked; it is never written to disk.
- **Auth:** HttpOnly, SameSite=Strict session cookie; failed logins are
  rate-limited per IP.
- **Hardening:** strict Content-Security-Policy, `X-Frame-Options: DENY`,
  `nosniff`, path-traversal-safe IDs, request size limits, and a small HTML
  sanitizer for imported/rendered content.

If the endpoint (or a synced Drive/Box/Dropbox copy) is breached, the attacker
gets only ciphertext.

> This protects **data at rest**. For a multi-user or internet-facing
> deployment, add TLS (the `Secure` cookie flag) and consider per-user vaults.

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
