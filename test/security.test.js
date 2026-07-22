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
    t.ok(typeof r.body.recoveryKey === 'string' && r.body.recoveryKey.length >= 16, 'setup returns a one-time recovery key');
    const RECOVERY_KEY = r.body.recoveryKey;
    r = await c.request('POST', '/api/workspaces/general/notes/new', {});
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

    // --- vault descriptor does not contain the passphrase (envelope v2) ---
    const vault = fs.readFileSync(path.join(DATA_DIR, 'vault.json'));
    t.ok(!vault.includes(Buffer.from(PASS)), 'vault.json does not contain the passphrase');
    const vjson = JSON.parse(vault.toString()).vault;
    t.ok(vjson.version === 2 && vjson.kdf === 'scrypt', 'vault is v2 scrypt envelope');
    t.ok(vjson.passphrase && vjson.passphrase.salt && vjson.passphrase.wrapped, 'vault has a passphrase key slot (wrapped DEK)');
    t.ok(vjson.recovery && vjson.recovery.wrapped, 'vault has a recovery key slot');

    // --- CSRF: the same session succeeds with a valid token, fails with a bad one ---
    r = await c.request('POST', '/api/workspaces', { name: 'csrf-ok' });
    t.eq(r.status, 200, 'authenticated request WITH csrf token succeeds');
    const goodCsrf = c.getCsrf();
    c.setCsrf('forged-token-value');
    r = await c.request('POST', '/api/workspaces', { name: 'csrf-bad' });
    t.eq(r.status, 403, 'mutating request with a bad CSRF token is rejected (403)');
    c.setCsrf(goodCsrf);

    // --- recovery key can unlock and reset the passphrase (back to PASS) ---
    const cr = makeClient(port);
    r = await cr.request('POST', '/api/recover', { recoveryKey: 'not-the-real-key-0000', newPassphrase: 'whatever12345' });
    t.eq(r.status, 401, 'wrong recovery key rejected');
    r = await cr.request('POST', '/api/recover', { recoveryKey: RECOVERY_KEY, newPassphrase: PASS });
    t.eq(r.status, 200, 'valid recovery key unlocks and resets passphrase');

    // --- biometric unlock (WebAuthn PRF key slot) ---
    // crypto-level round-trip
    const cryptoLib = require('../lib/crypto');
    {
      const dek = require('crypto').randomBytes(32);
      const v1 = cryptoLib.addBioSlot({ bio: [] }, dek, { credentialId: 'c1', prfSecret: 'sekret', prfSalt: 'v1', label: 'x' });
      t.ok(cryptoLib.openBioSlot(v1, 'c1', 'sekret').equals(dek), 'bio slot unwraps the DEK with the right PRF secret');
      t.eq(cryptoLib.openBioSlot(v1, 'c1', 'nope'), null, 'bio slot rejects a wrong PRF secret');
      t.eq(cryptoLib.openBioSlot(v1, 'other', 'sekret'), null, 'bio slot rejects an unknown credential');
      t.eq((cryptoLib.removeBioSlot(v1, v1.bio[0].id).bio || []).length, 0, 'removeBioSlot deletes the slot');
    }
    // endpoint flow: enroll (authenticated) → unlock (fresh client) → decrypts → remove
    const CRED = 'test-credential-id';
    const PRF = require('crypto').randomBytes(32).toString('base64');
    r = await c.request('POST', '/api/webauthn/enroll', { credentialId: CRED, prfSecret: PRF, prfSalt: 'v1', label: 'Test device' });
    t.eq(r.status, 200, 'biometric enroll (authenticated) succeeds');
    const bioSlotId = (r.body.credentials.find((x) => x.credentialId === CRED) || {}).id;
    r = await c.request('GET', '/api/status');
    t.ok(r.body.bio && r.body.bio.enrolled && r.body.bio.credentials.some((x) => x.credentialId === CRED), 'status reports biometric enrolled');
    const cb = makeClient(port);
    r = await cb.request('POST', '/api/webauthn/unlock', { credentialId: CRED, prfSecret: 'the-wrong-secret' });
    t.eq(r.status, 401, 'biometric unlock with a wrong PRF secret is rejected');
    r = await cb.request('POST', '/api/webauthn/unlock', { credentialId: CRED, prfSecret: PRF });
    t.eq(r.status, 200, 'biometric unlock with the correct PRF secret succeeds');
    r = await cb.request('GET', '/api/notes/' + noteId);
    t.ok(r.status === 200 && (r.body.meetingNotes || '').includes(SECRET_TODO), 'biometric session recovered the DEK and decrypts notes');
    const vaultBio = fs.readFileSync(path.join(DATA_DIR, 'vault.json'));
    t.ok(!vaultBio.includes(Buffer.from(PRF, 'base64')), 'vault.json does not store the raw PRF secret');
    t.ok(JSON.parse(vaultBio.toString()).vault.bio[0].wrapped, 'vault has a wrapped biometric slot');
    r = await c.request('POST', '/api/webauthn/remove', { id: bioSlotId });
    t.eq(r.status, 200, 'biometric slot removed (authenticated)');
    r = await makeClient(port).request('POST', '/api/webauthn/unlock', { credentialId: CRED, prfSecret: PRF });
    t.eq(r.status, 401, 'biometric unlock fails after the slot is removed');

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
