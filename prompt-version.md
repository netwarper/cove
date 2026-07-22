# Prompt Version — Meeting Notes

This file captures how to re-generate this application from a prompt, so the
same app can be reproduced or evolved consistently.

- **App version:** 1.5.0 (see `package.json`)
- **Prompt version:** v6
- **Date:** 2026-07-19
- **Stack chosen:** Node.js standard library only (zero runtime dependencies) +
  vanilla HTML/CSS/JS frontend (no build step).

---

## The reprompt

Paste the prompt below to reproduce this application from an empty repository.

> Create a new self-contained application that can run locally with, ideally, a
> one-click setup. We should be prepared for the desire to host remotely at some
> point. We should ensure portability such that it's easy to copy and paste the
> files into a different endpoint if needed. We should also be able to place data
> files into local drives for Google Drive, Box, Dropbox, etc and be able to use
> that as a working directory.
>
> This application will be for meeting notes. Notes shall be grouped into a
> general workspace or into other user-created workspaces. The main purpose of
> this notes application is to be able to create a new note based on the most
> recently created note in the same workspace. It should have 4 sections that can
> either be displayed in a horizontal fashion or as 4 columns. The first section
> will be a to-do list. Once an item is marked as complete, it moves to the bottom
> and is crossed out. All incomplete items are copied into the next new note for
> the workspace. The notes will automatically be titled with the date, with the
> option for a more specific title as well. Beneath the todos will be a reminders
> section. Users can create new reminders at various cadences. Once a reminder is
> due, it pops into the to-do list. The next section is our carryover notes, any
> notes we want to be copied into the next new note for the section. The last
> section is the notes for the meeting that will not be copied over. For both notes
> sections, we should support a rich text editor so the user can underline, bold,
> italicize, create bullet or numbered lists, etc. We should also support
> attachments of a reasonable size to each note. Also allowing inline pictures
> which we can resize as needed. If possible, support free-form notes like OneNote,
> where you can type anywhere in the note area.
>
> We should support a global search and have a global view to manage all
> incomplete todos across all workspaces -- if marked as complete in the global
> view, it should reflect in the most recent note in the workspace and vice versa.
> We should support exporting the notes to various formats, like PDF, and/or the
> ability to print notes. We should be able to upload notes that were exported into
> a workspace as well.
>
> We should also have a favorite notes section.
>
> There should be some level of security and encryption of data at rest, since
> notes should be private, so if the endpoint is breached, there's some protection
> for the data.
>
> Once done, run functional, quality, and security checks. Let's version this.
> Create a prompt-version.md file to capture how to reprompt to create the same
> application.

---

## Architecture decisions (the "why", so regeneration is deterministic)

These constraints resolve the ambiguity in the prompt. Keep them when
regenerating unless intentionally changing direction.

1. **Zero runtime dependencies.** The server uses only Node core (`http`, `crypto`,
   `fs`, `path`, `url`). The frontend is vanilla JS with no framework and no build
   step. This is what makes it copy-paste portable and one-click (`node server.js`,
   no `npm install`).
2. **File-based store under a single `DATA_DIR`.** Configurable via the `DATA_DIR`
   env var so it can point at a Google Drive / Box / Dropbox sync folder. Atomic
   write-then-rename to stay sync-safe.
3. **Encryption at rest.** scrypt (passphrase + random salt) → 32-byte key;
   AES-256-GCM for every note, workspace-metadata blob, and attachment. The key
   lives only in server memory during an unlocked session; never persisted. A
   plaintext `vault.json` holds the salt + an encrypted verifier for login.
4. **Auth = per-session unlock.** HttpOnly + SameSite=Strict cookie mapped to an
   in-memory key; login rate-limited per IP.
5. **"New from latest" logic lives server-side** (`store.createNote`): copies
   incomplete to-dos + carryover; drops meeting notes; injects due reminders.
6. **Global to-dos ↔ note sync is automatic** because the global view edits the
   same underlying latest-note records (no duplicated state).
7. **Rich text** via `contentEditable` + `document.execCommand`; inline images as
   data URLs (resizable); attachments as base64 JSON (kept simple, no multipart).
8. **Free-form mode** = absolutely-positioned, draggable text boxes on a canvas,
   stored in `note.freeform`.
9. **Export/print** = server renders standalone HTML/Markdown/JSON; PDF via browser
   print. Import parses JSON/HTML/Markdown back into a workspace.
10. **Remote-hosting readiness** without a rewrite: bind `HOST=0.0.0.0` behind a
    TLS proxy and add the `Secure` cookie flag.

---

## Deliverables checklist (what a correct regeneration produces)

- `server.js` — HTTP server + router + sessions + security headers
- `lib/crypto.js` — scrypt KDF, AES-256-GCM encrypt/decrypt, vault create/unlock
- `lib/store.js` — encrypted store: workspaces, notes, reminders, todos,
  favorites, search, export/import, attachments, "new from latest"
- `public/` — `index.html`, `css/styles.css`, `js/{api,editor,app}.js`
- `test/functional.test.js`, `test/security.test.js`, `test/helpers.js`
- `scripts/check-quality.js`
- `start.sh`, `start.bat`, `.env.example`, `.gitignore`
- `package.json` (version, scripts: `start`, `test`, `check`, `verify`)
- `README.md`, `prompt-version.md`

---

## Verification the regeneration must pass

```bash
npm run check   # 0 issues
npm test        # functional + security suites, 0 failures
```

At the latest version: **quality 0 issues · functional 67/67 · security 21/21 · config 14/14 · backup 10/10 · viewer 17/17.**

---

## Follow-up prompt (v2 → 1.1.0)

The v2 batch was requested with "let's do it all" plus two design decisions
captured via a clarifying question:

- **Templates seed Meeting Notes only.** Carry-forward is unchanged and always
  sources from the most recently created note; a template fills the (non-carried)
  Meeting Notes section, and fills To-Do / Carryover only when carry-forward left
  them empty (i.e. the first note in a workspace). Templates are a per-workspace
  default and/or picked ad-hoc from "New ▾".
- **Multi-user vaults deferred** to a later phase (single-passphrase model kept).

Everything else in the batch was implemented:

1. **Envelope encryption** (`lib/crypto.js`): random DEK encrypts data; DEK
   wrapped in passphrase + recovery key slots via scrypt. Enables **passphrase
   change** and **recovery key** without re-encrypting data. Includes a
   transparent **v1→v2 migration** (`migrateVaultV1`) that re-encrypts existing
   data under a fresh DEK on first login.
2. **Sync-conflict safety:** `saveNote` takes `baseUpdatedAt` and returns `409`
   with the server copy on a stale write; the client offers to reload.
3. **Soft-delete trash** with 30-day auto-purge, restore, and permanent delete.
4. **CSRF tokens** on all mutating requests; **Secure cookie** via `COOKIE_SECURE`;
   **client idle auto-lock** (15 min).
5. **Time-aware reminders** + `/api/reminders/process` polling + desktop
   notifications across all workspaces.
6. **Per-todo due dates**, **drag-to-reorder** todos, **tags** + `tag:` search.
7. **Move / duplicate** notes; **encrypted backup export + restore**.
8. **Keyboard shortcuts** (`/`, `n`, `l`), **attachment image thumbnails**,
   inline Meeting-Notes images stored as attachments (Carryover keeps self-
   contained data URLs so carried images travel with the note).
9. **Accessibility** passes (ARIA labels, `aria-live`, Escape-to-close).
10. **Dockerfile** + `/api/health` health check.

## Follow-up prompt (v3 → 1.2.0)

"Do it all, but keep deferring multi-user vaults" — plus a mid-stream
durability requirement: no port conflicts, graceful start, and a durable
local domain per instance.

Deferred (with reasoning, like multi-user): **WebAuthn/passkey second factor** —
can't be built responsibly or verified in a headless, non-HTTPS environment, and
the browser PRF extension needed to make a passkey contribute to *encryption* is
too thinly supported to base the data key on. **Closed-app push notifications**
are a browser platform limit (need a push service); the service worker shows
notifications while the browser runs.

Implemented:

1. **Durability / graceful start** (`lib/config.js`): durable `instance.json`
   (name + `*.localhost` domain + stable derived port) stored in the data dir so
   identity travels with the data. `--set-domain` / `--print-config` CLI. On a
   port clash, probe `/api/health` to detect our own app vs. another program and
   exit gracefully; a lock file prevents two instances on one data directory.
   Launchers prompt for a domain on first run.
2. **PWA**: manifest, icon, service worker (offline shell + notifications).
3. **Live sync** (SSE + `fs.watch`) + conflict "keep both" (`forkNote`).
4. **Per-note version history** (coalesced snapshots, list/view/restore).
5. **Encrypted search index** (`search.idx.enc`) replacing the O(n) scan, kept
   in sync across every mutation.
6. **Reminders**: time-of-day, end date, and snooze.
7. **Tables, note links + backlinks, slash commands** in the editor.
8. **Pin/archive**, note-list filter/sort, **agenda** view, word count,
   font-size, **bulk workspace export (zero-dep ZIP)**.
9. Fixed two latent bugs found via tests: a greedy reminder route that turned
   `/snooze` into an empty reminder, and reminder-sourced todos being both
   carried forward and re-injected (duplicates).

## Follow-up prompt (v4 → 1.3.0) — data-safety batch

Small, high-value hardening: scheduled backups, corruption resilience, CI.

1. **Scheduled encrypted backups** (`lib/backup.js` + server timer): if
   `AUTO_BACKUP_DIR` is set, write the portable encrypted bundle on an interval
   (`AUTO_BACKUP_HOURS`) and keep the newest `AUTO_BACKUP_KEEP`. No key needed —
   it copies already-encrypted files.
2. **Corruption resilience**: a `_readEncSafe` reader lets every scanning loop
   skip a damaged `.enc` file (partial cloud-sync write, disk error) instead of
   throwing, so one bad note never breaks the app. `verifyIntegrity()` decrypt-
   checks every file; exposed as `GET /api/verify`, a Backup-modal button, and a
   `node server.js --verify` CLI (passphrase via `MN_PASSPHRASE` or stdin).
3. **CI**: `.github/workflows/ci.yml` runs `npm run check` + `npm test` on Node
   18/20/22 — no install step (zero dependencies).

## Follow-up prompt (v5 → 1.4.0) — UX pass

1. **In-app dialogs** replace every native `alert`/`confirm`/`prompt` (a
   promise-based `dialog.alert/confirm/prompt/choose`, exposed on `window` so
   `editor.js` uses it too). Editor insertions save/restore the caret Range so
   they still land correctly after a modal takes focus.
2. **Workspace picker** moved into the sidebar under a "WORKSPACE" label (clearer
   than the unlabelled top-bar dropdown).
3. **Sidebar quick actions**: hover a note to favorite (★) or delete (🗑) it.
4. **Removed** pin/unpin and the free-form note mode + its Flow/Free-form toggle.
5. **Conflict detection fixed** (the single-tab false 409): notes now carry a
   `rev` that advances only on real content edits. Housekeeping writes
   (reminder injection, favoriting) bump `updatedAt` but not `rev`, so they no
   longer trigger a conflict; the save guard and SSE refresh compare `rev`. The
   conflict dialog is now a 3-way choice (Keep both / Discard mine / Cancel).
6. **Due-date affordance** clarified: 📅 hint reveals on hover when empty, shows
   "📅 MM-DD" as a chip when set, with explanatory tooltips.
7. **Active formatters**: toolbar buttons light up via `queryCommandState` as the
   selection's bold/italic/underline/strike/list state changes.
8. **Layouts**: kept the stacked "rows" layout; the other is now To-Do +
   Reminders on one row, then Carryover (full width), then Meeting Notes (full).

## Follow-up prompt (v6 → 1.5.0) — offline phone viewer

Goal: read notes on an iPhone when the server only runs locally on a Mac but
data syncs to Google Drive / Box. Chosen approach: a single self-contained,
read-only `meeting-notes-viewer.html` that decrypts on-device.

- `public/viewer/decrypt.js` reimplements the server's crypto for the browser:
  scrypt (N=16384,r=8,p=1), AES-256-GCM (MN1 layout), envelope unwrap. Uses
  WebCrypto when available, but ships a **pure-JS fallback** (SHA-256, HMAC,
  PBKDF2, AES-256, GCM/GHASH) because **iOS Safari doesn't expose
  `crypto.subtle` on `file://`** — the exact context when opening the file from
  Files/Drive. Both paths are proven byte-identical to `lib/crypto.js` in tests.
- `public/viewer/{viewer.js,viewer.css}` — mobile read-only UI (unlock, list,
  search, note view, inline images decrypted to blob URLs).
- `lib/viewer.js` — `collectData` (keyless: bundles vault key-slots + index +
  note ciphertext) and `renderHTML` (inlines assets + escaped `MN_DATA`).
  `Store.buildViewerData()` enriches with image-attachment ciphertext.
  The embedded payload is all ciphertext — nothing readable without the passphrase.
- Server: `GET /api/viewer` (also writes a copy into DATA_DIR to sync),
  `--build-viewer` CLI, and auto-refresh on each scheduled-backup run.

## Changelog

- **1.11.0 (2026-07-22):** Inbox source badge + outbound Slack agenda.
  - Inbox-added to-dos now show a **📥 badge** (`sourceInbox`), carried forward into
    the next daily note, so Slack items are distinguishable from typed ones.
  - **Outbound Slack:** post your due/overdue to-dos to a Slack **Incoming Webhook**
    — on demand ("Send agenda now") or best-effort **auto-daily** while the app is
    open (Settings → Slack). Server proxies the post (CSP), webhook stored encrypted
    in settings or `SLACK_WEBHOOK_URL`. New `lib/slack.js` (`postWebhook`,
    `formatAgenda`) + `POST /api/slack/agenda`. Verified: quality 0 · functional
    88/88 (adds formatAgenda + a stub-webhook post incl. a due to-do) · security
    35/35 · config 14/14 · backup 10/10 · viewer 17/17 · transcribe 13/13; browser
    test confirmed the 📥 badge and a successful agenda post to a stub webhook.
- **1.10.0 (2026-07-22):** Inbox — send yourself to-dos (e.g. from Slack).
  The app drains a `DATA_DIR/inbox/` folder (`.txt`/`.md` one-per-line, or
  `.json` `{text}|[...]|{items}`) into to-dos on the latest daily note of a
  workspace chosen in Settings, about once a minute while unlocked (and on
  unlock) — so a to-do sent while the Mac was asleep lands on next unlock,
  buffered by the cloud-sync folder. Any glue works: Zapier/Make (no-code, write
  a file to the synced inbox folder) or a Cloudflare Worker. Optional token-gated
  `POST /api/inbox` (`INBOX_TOKEN` env) for a relay/tunnel push — off by default,
  constant-time token compare, and it can only queue a to-do (no DEK, so it can
  never read/modify encrypted data). New: `store.processInbox()`, `stats().inboxDir`,
  `POST /api/inbox` + `POST /api/inbox/process`, a Settings “Inbox” block, and
  `docs/slack-inbox.md` with a recipe per service. Verified: quality 0 · functional
  83/83 (adds token-push + folder-drop → drain → to-do) · security 35/35 (adds
  “endpoint off without INBOX_TOKEN”) · config 14/14 · backup 10/10 · viewer 17/17
  · transcribe 13/13; browser test drove a token push → drain → visible to-do.
- **1.9.1 (2026-07-22):** Name sort — within the same date, named notes rank
  above un-named (date-only) notes, which now sink to the bottom of that date
  group instead of sorting above by the shorter date prefix.
- **1.9.0 (2026-07-22):** Sorting, screen recording, biometric unlock.
  - **Note sorting** — sidebar control for Created / Modified / Name in either
    direction, persisted in settings; server `listNotes` sorts accordingly.
  - **Screen + audio recording** — a 🖥 Screen button captures the shared
    screen/window video + system audio, mixed with the mic, to one encrypted
    `.webm` (meeting-screen-<time>.webm); auto-stops with the browser's share bar
    and disables/ is disabled by the audio recorder.
  - **Biometric unlock (opt-in, per-device)** — a new vault `bio` key-slot wraps
    the DEK with a secret produced by the platform authenticator via the WebAuthn
    **PRF** extension (Touch ID / Windows Hello / device passkey). On idle lock the
    auth screen offers “Unlock with biometrics”; the passphrase stays primary and
    required on un-enrolled devices. The PRF secret is never stored — a copied data
    dir still can't unlock without the device. New endpoints: `/api/webauthn/{enroll,
    unlock,remove}` + bio info in `/api/status`; `lib/crypto` gains `addBioSlot/
    openBioSlot/listBioSlots/removeBioSlot`. Requires a PRF-capable browser over
    localhost / a `.localhost` domain / HTTPS (WebAuthn rejects bare 127.0.0.1).
  - **Also:** renamed “Passphrase & recovery” → “Settings”, refreshed the sidebar
    on trash-restore, 💾 backup icon, PWA PNG icons, removed the low-value note
    filter.
  - Verified: quality 0 · functional 76/76 · security 34/34 (incl. bio crypto +
    enroll/unlock/decrypt/remove endpoint flow) · config 14/14 · backup 10/10 ·
    viewer 17/17 · transcribe 13/13. Browser tests drove name-sort asc/desc +
    persistence, a saved screen `.webm`, and the **full biometric ceremony**
    (enroll → simulated timeout → PRF unlock → decrypts notes → remove) with a
    virtual PRF authenticator over localhost.
- **1.8.0 (2026-07-21):** Notes model + UX overhaul.
  - **Daily vs scratch notes.** The sidebar button is now **New Daily** (carries
    open to-dos + carryover forward from the last *daily* note). **New scratch
    note** is a clean Meeting-Notes-only page that never affects the carryover
    thread. Removed the old "carry forward"/"blank" note items.
  - **Landing page.** Workspaces no longer auto-create a note; an empty workspace
    shows a landing page with tips + New Daily / New scratch shortcuts.
  - **Deep links.** Notes carry a `#note/<id>` URL hash — a refresh reopens the
    same note, and **⋯ → Copy link to note** copies a shareable link.
  - **Recording is one common file.** Mic + shared audio are now **mixed into a
    single `.wav`** (Web Audio, mono 16 kHz) instead of two `.webm` files.
  - **Transcription discoverability.** A **⚙ Transcription** button sits next to
    Record; the transcript region shows a clear record-only placeholder when no
    STT endpoint is set. AudioContext is resumed on start so live chunks flow.
  - **Editor fixes.** Toolbar toggle buttons reflect state immediately on
    re-toggle (no stray keystroke needed); inline images have a **visible resize
    handle**; images can be **dragged & dropped** into a note.
  - **Save indicator** moved to a pinned footer at the bottom of the sidebar.
  - **Removed** the layout toggle (single columns layout), the archive feature,
    and dead code (free-form notes, pin/archive fields, `settings.layout`).
  - **Service worker** now serves the app shell **network-first** (cache bumped
    to v3) so updates take effect on reload instead of being pinned to a stale
    cached version.
  - **Workspace modal** redesigned (card rows, DEFAULT badge, clearer create).
  - Verified: quality 0 · functional 76/76 · security 21/21 · config 14/14 ·
    backup 10/10 · viewer 17/17 · transcribe 13/13; a 24-check browser test drove
    the landing page, daily/scratch flow, combined `.wav` recording, live
    transcription (stub STT), decorator re-toggle, image handle, hash persistence,
    and the redesigned workspace modal — zero console errors.
- **1.7.1 (2026-07-21):** Transcript refinements. Moved the live transcript into
  its **own region below the note sections** so incoming lines no longer shift or
  disrupt the editor while you take notes. Each line now shows a **wall-clock
  timestamp**, and lines from both streams are **ordered by when they were spoken**
  — the chunk cut-time is captured before the STT round-trip (previously stamped at
  response time, so differing transcription latency between the two streams could
  scramble the order). Added a record-only placeholder in the transcript region.
  Verified: quality 0 · functional 69/69 · security 21/21 · config 14/14 · backup
  10/10 · viewer 17/17 · transcribe 13/13; browser test confirmed the transcript
  sits below the sections, renders chronologically ordered + timestamped, saved 2
  encrypted audio attachments, zero console errors. Comprehensive security review of
  the recording/transcription surface found no reportable vulnerabilities (route is
  session+CSRF gated; transcript rendered via textContent; STT key stays server-side;
  strict CSP intact).
- **1.7.0 (2026-07-20):** Granola-style meeting recording — dual-stream capture
  (mic = "You" via getUserMedia, other side = "Them" via getDisplayMedia
  tab/system audio), each saved as an encrypted attachment. Optional near-live
  transcription via an OpenAI-compatible STT endpoint (local Whisper for privacy
  or cloud), proxied through the local server (`/api/transcribe`, `lib/transcribe.js`)
  so the API key stays server-side and the CSP is respected; transcript lines
  labeled You/Them stream into the note. Off by default (recording never leaves
  the device). Also: modals now scroll when tall. Verified: quality 0 ·
  functional 69/69 · security 21/21 · config 14/14 · backup 10/10 · viewer 17/17
  · transcribe 13/13; browser test drove real dual-stream capture (fake devices)
  → 2 encrypted audio attachments + labeled transcript, zero console errors.
- **1.6.0 (2026-07-19):** Discoverability + quality-of-life — command palette
  (⌘K/Ctrl-K) to jump to notes/workspaces/actions, a `?` help & shortcuts
  overlay, manual theme toggle (auto/light/dark), encrypted-footprint stats,
  and search-result ranking + match highlighting. Verified: quality 0 ·
  functional 69/69 · security 21/21 · config 14/14 · backup 10/10 · viewer 17/17.
- **1.5.1 (2026-07-19):** Replace deprecated `url.parse()` (DEP0169) with the
  WHATWG `URL` API in the request router; path-traversal protection unchanged.
- **v6 (1.5.0, 2026-07-19):** Offline phone viewer — self-contained, read-only
  `meeting-notes-viewer.html` that decrypts on-device (WebCrypto + pure-JS
  fallback for iOS `file://`), with inline images; download button, `--build-viewer`
  CLI, and auto-refresh with scheduled backups. Verified: quality 0 · functional
  67/67 · security 21/21 · config 14/14 · backup 10/10 · viewer 17/17.
- **v5 (1.4.0, 2026-07-19):** UX pass — in-app dialogs replace native popups;
  sidebar workspace picker + quick favorite/delete; removed pin and free-form;
  content-revision conflict detection (fixes single-tab false conflicts) with a
  3-way resolver; clearer due-date control; active formatter states; revised
  two-row layout. Verified: quality 0 · functional 67/67 · security 21/21 ·
  config 14/14 · backup 10/10.
- **v4 (1.3.0, 2026-07-18):** Scheduled encrypted backups; corruption
  resilience + `verifyIntegrity` (endpoint, UI, `--verify` CLI); GitHub Actions
  CI. Verified: quality 0 · functional 64/64 · security 21/21 · config 14/14 ·
  backup 10/10.
- **v3 (1.2.0, 2026-07-18):** Durable per-instance domain/port + graceful
  multi-instance start; PWA/offline; live-sync (SSE) + keep-both conflict
  resolution; version history; encrypted search index; reminder time/end/snooze;
  editor tables, note links, backlinks, slash commands; pin/archive, agenda,
  bulk ZIP export, word count, font size. Verified: quality 0 · functional 61/61
  · security 21/21 · config 14/14.
- **v2 (1.1.0, 2026-07-18):** Envelope encryption + passphrase rotation +
  recovery key; sync-conflict guard; trash; CSRF + idle-lock + Secure cookie;
  time-aware reminders + notifications; per-todo due dates, drag-reorder, tags;
  templates (Meeting-Notes-only); move/duplicate; encrypted backup/restore;
  keyboard shortcuts; Docker + health check. Verified: quality 0 · functional
  49/49 · security 21/21.
- **v1 (1.0.0, 2026-07-17):** Initial version. All prompt requirements
  implemented and verified.
