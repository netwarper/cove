'use strict';

/*
 * Builds the standalone, read-only offline viewer: one self-contained HTML file
 * with the decryptor, the UI, and the *encrypted* note data all inlined. Opened
 * from a Google Drive / Box / Files app on a phone, it decrypts on-device with
 * the passphrase — no server, no network.
 *
 * The embedded data is entirely ciphertext (plus the vault's public key slots),
 * so the file reveals nothing without the passphrase — same guarantee as the
 * data directory itself.
 */

const fs = require('fs');
const path = require('path');

const VIEWER_DIR = path.join(__dirname, '..', 'public', 'viewer');
const OUTPUT_NAME = 'meeting-notes-viewer.html';

/** Keyless collection: everything needed except attachment images (which need
 *  the key to enumerate). Safe to run without an unlocked session. */
function collectData(dataDir) {
  const vaultPath = path.join(dataDir, 'vault.json');
  if (!fs.existsSync(vaultPath)) throw Object.assign(new Error('not initialized'), { status: 400 });
  const vault = JSON.parse(fs.readFileSync(vaultPath, 'utf8')).vault;
  if (vault.version !== 2) throw Object.assign(new Error('viewer needs a v2 vault — open the app once to upgrade'), { status: 400 });

  const b64 = (p) => fs.readFileSync(p).toString('base64');
  const notes = [];
  const tasks = {}; // wsId -> ciphertext of tasks.json.enc
  const wsRoot = path.join(dataDir, 'ws');
  if (fs.existsSync(wsRoot)) {
    for (const wsId of fs.readdirSync(wsRoot)) {
      const notesDir = path.join(wsRoot, wsId, 'notes');
      if (fs.existsSync(notesDir)) {
        for (const f of fs.readdirSync(notesDir)) {
          if (!f.endsWith('.json.enc')) continue;
          notes.push({ id: f.replace('.json.enc', ''), ws: wsId, b64: b64(path.join(notesDir, f)) });
        }
      }
      const tp = path.join(wsRoot, wsId, 'tasks.json.enc');
      if (fs.existsSync(tp)) tasks[wsId] = b64(tp);
    }
  }
  const indexPath = path.join(dataDir, 'index.json.enc');
  return {
    generatedAt: new Date().toISOString(),
    scrypt: vault.scrypt || { N: 16384, r: 8, p: 1 },
    vault: { passphrase: vault.passphrase, recovery: vault.recovery || null },
    index: fs.existsSync(indexPath) ? b64(indexPath) : null,
    notes,
    tasks,
    images: {},
  };
}

/** Assemble the final HTML from the static assets + collected data. */
function renderHTML(data) {
  const decryptJs = fs.readFileSync(path.join(VIEWER_DIR, 'decrypt.js'), 'utf8');
  const viewerJs = fs.readFileSync(path.join(VIEWER_DIR, 'viewer.js'), 'utf8');
  const css = fs.readFileSync(path.join(VIEWER_DIR, 'viewer.css'), 'utf8');
  // Escape "<" so note titles / workspace names can never break out of the script.
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#3b6cf6">
<title>Cove — Offline Viewer</title>
<style>${css}</style>
</head>
<body>
<div id="gate"><div class="card">
  <h1><svg class="brand-logo" viewBox="0 0 512 512" width="26" height="26" style="vertical-align:-5px" aria-hidden="true"><rect width="512" height="512" rx="96" fill="#3b6cf6"/><rect x="120" y="96" width="272" height="320" rx="20" fill="#fff"/><rect x="96" y="150" width="60" height="24" rx="12" fill="#1f2430"/><rect x="96" y="244" width="60" height="24" rx="12" fill="#1f2430"/><rect x="96" y="338" width="60" height="24" rx="12" fill="#1f2430"/><rect x="180" y="150" width="176" height="20" rx="10" fill="#3b6cf6"/><rect x="180" y="190" width="140" height="16" rx="8" fill="#c7d2fe"/><rect x="180" y="244" width="176" height="20" rx="10" fill="#3b6cf6"/><rect x="180" y="284" width="120" height="16" rx="8" fill="#c7d2fe"/><rect x="180" y="338" width="176" height="20" rx="10" fill="#3b6cf6"/></svg> Cove</h1>
  <p class="muted">Read-only offline viewer. Unlock with your passphrase or recovery key.</p>
  <form id="unlockForm">
    <input id="secret" type="password" placeholder="Passphrase or recovery key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
    <div id="err" class="err" role="alert"></div>
    <button id="unlockBtn" type="submit">Unlock</button>
  </form>
  <p class="small muted">Everything is decrypted on this device. Nothing is sent anywhere.</p>
</div></div>

<div id="app" class="hidden">
  <header class="top">
    <div class="row">
      <h1>Notes</h1>
      <select id="wsFilter" aria-label="Workspace"></select>
      <button id="lockBtn" class="lockbtn">Lock</button>
    </div>
    <input id="search" type="search" placeholder="Search notes…" aria-label="Search">
    <p class="stamp" id="stamp"></p>
  </header>
  <section id="listView"><ul id="noteList" class="list"></ul></section>
  <section id="noteView" class="hidden"></section>
  <p class="ro-note">Read-only snapshot · edit in the full app</p>
</div>

<script>window.MN_DATA=${json};</script>
<script>${decryptJs}</script>
<script>${viewerJs}</script>
</body>
</html>`;
}

/** Write the viewer file into `dir` (defaults to the data dir). Returns path. */
function writeViewer(dir, data) {
  const html = renderHTML(data);
  const out = path.join(dir, OUTPUT_NAME);
  const tmp = out + '.tmp';
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, out);
  return out;
}

module.exports = { collectData, renderHTML, writeViewer, OUTPUT_NAME };
