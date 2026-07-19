'use strict';
/* Offline viewer: build the self-contained HTML and prove it decrypts back. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../lib/crypto');
const { Store } = require('../lib/store');
const viewer = require('../lib/viewer');
const D = require('../public/viewer/decrypt.js');
const { harness } = require('./helpers');

const t = harness('viewer');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-view-'));
const PASS = 'offline viewer passphrase';
// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

(async () => {
  try {
    const { vault, dek } = c.createVault(PASS);
    fs.writeFileSync(path.join(DIR, 'vault.json'), JSON.stringify({ vault }, null, 2));
    const store = new Store(DIR, dek);
    store.ensureInitialized();
    const ws = store.createWorkspace('Product');

    const note = store.currentNote('general');
    store.saveNote(note.id, { customTitle: 'Kickoff', meetingNotes: '<p>UNIQUE-VIEW-TOKEN</p>', tags: ['demo'], todos: [{ id: 't1', text: 'ship it', done: false, doneAt: null, due: null, sourceReminderId: null }] });
    const att = store.addAttachment(note.id, { name: 'pic.png', mime: 'image/png', dataB64: PNG.toString('base64') });
    const n2 = store.currentNote(ws.id);
    store.saveNote(n2.id, { meetingNotes: '<p>second workspace note</p>' });

    // --- build data + HTML ---
    const data = store.buildViewerData();
    t.ok(data.vault && data.vault.passphrase && data.vault.recovery, 'viewer data carries the vault key slots');
    t.ok(data.notes.length >= 2, 'viewer data includes the notes (as ciphertext)');
    t.ok(data.images[note.id + '/' + att.id], 'image attachment embedded');

    const html = viewer.renderHTML(data);
    t.ok(html.indexOf('window.MN_DATA=') >= 0, 'HTML embeds MN_DATA');
    t.ok(html.indexOf('MNDecrypt') >= 0 && html.indexOf('unlockForm') >= 0, 'HTML inlines the decryptor + UI');
    t.ok(html.indexOf('UNIQUE-VIEW-TOKEN') < 0, 'note content is NOT present in plaintext in the HTML');
    t.ok(!/src\s*=\s*["']https?:/i.test(html) && html.indexOf('<script src') < 0, 'HTML is self-contained (no external resources)');

    // --- decrypt round-trip, exactly as a phone would ---
    const dek2 = await D.unwrapDEK(data.vault.passphrase, PASS, data.scrypt);
    t.ok(Buffer.from(dek2).equals(dek), 'passphrase unwraps the DEK in the viewer');
    const idx = await D.decryptJSON(dek2, data.index);
    t.ok(idx.workspaces.some((w) => w.name === 'Product'), 'index decrypts to workspace names');
    let found = null;
    for (const nrec of data.notes) { const dn = await D.decryptJSON(dek2, nrec.b64); if (dn.id === note.id) found = dn; }
    t.ok(found && found.meetingNotes.indexOf('UNIQUE-VIEW-TOKEN') >= 0, 'a note decrypts to its real content');
    const imgBytes = await D.decryptBytes(dek2, data.images[note.id + '/' + att.id].b64);
    t.ok(Buffer.from(imgBytes).equals(PNG), 'embedded image decrypts to the original bytes');

    // --- pure-JS path (what iOS Safari uses on file://, no crypto.subtle) ---
    globalThis.MN_FORCE_PURE = true;
    try {
      const dekP = await D.unwrapDEK(data.vault.passphrase, PASS, data.scrypt);
      t.ok(Buffer.from(dekP).equals(dek), 'pure-JS fallback unwraps the DEK (iOS file:// path)');
      let foundP = null;
      for (const nrec of data.notes) { const dn = await D.decryptJSON(dekP, nrec.b64); if (dn.id === note.id) foundP = dn; }
      t.ok(foundP && foundP.meetingNotes.indexOf('UNIQUE-VIEW-TOKEN') >= 0, 'pure-JS fallback decrypts a note');
      let rejected = false; try { await D.unwrapDEK(data.vault.passphrase, 'wrong', data.scrypt); } catch (e) { rejected = true; }
      t.ok(rejected, 'pure-JS fallback rejects a wrong passphrase (GCM tag mismatch)');
    } finally { delete globalThis.MN_FORCE_PURE; }

    // --- keyless collectData (no session) works, minus images ---
    const keyless = viewer.collectData(DIR);
    t.ok(keyless.notes.length >= 2 && Object.keys(keyless.images).length === 0, 'keyless build has notes but no inline images');
    const dekK = await D.unwrapDEK(keyless.vault.passphrase, PASS, keyless.scrypt);
    t.ok(Buffer.from(dekK).equals(dek), 'keyless build still unlocks with the passphrase');

    // writeViewer drops the file into the dir
    const out = viewer.writeViewer(DIR, keyless);
    t.ok(fs.existsSync(out) && out.endsWith('meeting-notes-viewer.html'), 'writeViewer writes the html file');
  } catch (ex) {
    t.ok(false, 'unexpected exception: ' + ex.stack);
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
    t.done();
  }
})();
