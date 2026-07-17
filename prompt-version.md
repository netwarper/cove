# Prompt Version — Meeting Notes

This file captures how to re-generate this application from a prompt, so the
same app can be reproduced or evolved consistently.

- **App version:** 1.0.0 (see `package.json`)
- **Prompt version:** v1
- **Date:** 2026-07-17
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

At the time of this version: **quality 0 issues · functional 31/31 · security 14/14.**

---

## Changelog

- **v1 (1.0.0, 2026-07-17):** Initial version. All prompt requirements
  implemented and verified.
