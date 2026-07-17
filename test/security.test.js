'use strict';
/* Security checks: auth enforcement, encryption at rest, input hardening. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeClient, harness } = require('./helpers');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sec-'));
process.env.DATA_DIR = DATA_DIR;
process.env.HOST = '127.0.0.1';
process.env.MAX_BODY = '4096'; // small, to test the 413 limit

const { server } = require('../server');
const t = harness('security');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

(async function run() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const c = makeClient(port);
  const SECRET_TODO = 'TOPSECRETtaskstring';
  const PASS = 'super secret passphrase';

  try {
    // --- protected endpoints require auth ---
    let r = await c.request('GET', '/api/workspaces');
    t.eq(r.status, 401, 'unauthenticated request is rejected (401)');

    // --- setup, then write identifiable plaintext into a note ---
    r = await c.request('POST', '/api/setup', { passphrase: PASS });
    t.eq(r.status, 200, 'setup ok');
    r = await c.request('GET', '/api/workspaces/general/current');
    const noteId = r.body.id;
    await c.request('PUT', '/api/notes/' + noteId, {
      todos: [{ id: 'z', text: SECRET_TODO, done: false, doneAt: null, sourceReminderId: null }],
      meetingNotes: '<p>' + SECRET_TODO + '</p>',
    });

    // --- encryption at rest: no plaintext of the secret on disk ---
    const files = walk(DATA_DIR, []);
    let leaked = false;
    for (const f of files) {
      const buf = fs.readFileSync(f);
      if (buf.includes(Buffer.from(SECRET_TODO))) { leaked = true; break; }
    }
    t.ok(!leaked, 'note content is encrypted at rest (no plaintext leak on disk)');

    // encrypted note blobs carry the AES-GCM format marker
    const encFile = files.find((f) => f.endsWith('.json.enc'));
    t.ok(encFile && fs.readFileSync(encFile).subarray(0, 3).toString() === 'MN1', 'note stored with encryption marker');

    // --- vault descriptor does not contain the passphrase ---
    const vault = fs.readFileSync(path.join(DATA_DIR, 'vault.json'));
    t.ok(!vault.includes(Buffer.from(PASS)), 'vault.json does not contain the passphrase');
    const vjson = JSON.parse(vault.toString()).vault;
    t.ok(vjson.salt && vjson.verifier && vjson.kdf === 'scrypt', 'vault stores salt + verifier via scrypt');

    // --- wrong passphrase rejected ---
    const c2 = makeClient(port);
    r = await c2.request('POST', '/api/login', { passphrase: 'wrong passphrase!!' });
    t.eq(r.status, 401, 'wrong passphrase rejected');

    // --- path traversal in ids is rejected ---
    r = await c.request('GET', '/api/notes/' + encodeURIComponent('../../etc/passwd'));
    t.eq(r.status, 400, 'path-traversal note id rejected (400)');

    // --- oversized body rejected (413) ---
    const big = Buffer.concat([Buffer.from('{"x":"'), Buffer.alloc(8192, 65), Buffer.from('"}')]);
    r = await c.request('PUT', '/api/notes/' + noteId, undefined, big);
    t.ok(r.status === 413, 'oversized request body rejected (413)');

    // --- security headers present ---
    r = await c.request('GET', '/api/status');
    t.ok((r.headers['content-security-policy'] || '').includes("default-src 'self'"), 'CSP header set');
    t.eq(r.headers['x-content-type-options'], 'nosniff', 'nosniff header set');
    t.eq(r.headers['x-frame-options'], 'DENY', 'clickjacking protection set');

    // --- session cookie is HttpOnly ---
    // (a successful login also clears this IP's failed-attempt counter)
    const setCookie = (await c.request('POST', '/api/login', { passphrase: PASS })).headers['set-cookie'];
    t.ok(setCookie && /HttpOnly/i.test(setCookie[0]) && /SameSite=Strict/i.test(setCookie[0]), 'session cookie is HttpOnly + SameSite=Strict');

    // --- brute-force throttling kicks in (run last: it blocks this IP) ---
    let got429 = false;
    for (let i = 0; i < 8; i++) {
      r = await c2.request('POST', '/api/login', { passphrase: 'still wrong ' + i });
      if (r.status === 429) { got429 = true; break; }
    }
    t.ok(got429, 'repeated bad logins are rate-limited (429)');
  } catch (ex) {
    t.ok(false, 'unexpected exception: ' + ex.stack);
  } finally {
    server.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    t.done();
  }
})();
