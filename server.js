'use strict';

/*
 * Cove — zero-dependency HTTP server (Node core only).
 *
 * Portability: everything here uses the Node standard library, so the whole
 * project can be copied to any machine with Node >= 18 and started with
 * `node server.js` — no `npm install`, no build step.
 *
 * Configuration (all optional, via environment variables):
 *   PORT          listening port                 (default 3000)
 *   HOST          bind address                   (default 127.0.0.1 — localhost)
 *   DATA_DIR      data directory                 (default ./data)  <- point at a
 *                 Google Drive / Box / Dropbox sync folder to work off the cloud.
 *   MAX_BODY      max request body bytes         (default 33554432 = 32 MB)
 *   SESSION_TTL   session lifetime in minutes    (default 240)
 *   COOKIE_SECURE auto | always | never          (default auto — Secure over TLS)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const c = require('./lib/crypto');
const store = require('./lib/store');
const config = require('./lib/config');
const backup = require('./lib/backup');
const viewer = require('./lib/viewer');
const transcribe = require('./lib/transcribe');
const slack = require('./lib/slack');
const { Store } = store;

// Where data lives. An explicit DATA_DIR env var always wins; otherwise a
// gitignored `datadir.path` pointer file (settable from the web UI) is used;
// otherwise the bundled ./data. The env override is exposed to the UI so it can
// explain why the path field is read-only when one is set.
const DATA_DIR_ENV = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
const DATA_DIR = DATA_DIR_ENV || config.readDataDirPointer(__dirname) || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// A `--port <n>` flag overrides the port for this run (highest precedence).
const CLI_PORT = (() => {
  const a = process.argv.slice(2); const i = a.indexOf('--port');
  return i >= 0 ? config.validPort(a[i + 1]) : null;
})();
// Durable, non-drifting host/port/domain resolved from env + instance.json.
const CFG = config.resolve(DATA_DIR, process.env, { port: CLI_PORT });
const PORT = CFG.port;
const HOST = CFG.host;
const MAX_BODY = parseInt(process.env.MAX_BODY, 10) || 32 * 1024 * 1024;
const SESSION_TTL = (parseInt(process.env.SESSION_TTL, 10) || 240) * 60 * 1000;
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'auto').toLowerCase();
const AUTO_BACKUP_DIR = process.env.AUTO_BACKUP_DIR ? path.resolve(process.env.AUTO_BACKUP_DIR) : null;
const AUTO_BACKUP_HOURS = parseFloat(process.env.AUTO_BACKUP_HOURS) || 24;
const AUTO_BACKUP_KEEP = parseInt(process.env.AUTO_BACKUP_KEEP, 10) || 7;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VAULT_PATH = path.join(DATA_DIR, 'vault.json');
let APP_VERSION = '0.0.0';
try { APP_VERSION = require('./package.json').version; } catch (_e) { /* ignore */ }

// ---- session state (in-memory only; keys never touch disk) -------------
const sessions = new Map(); // token -> { key, csrf, expires }
const loginAttempts = new Map(); // ip -> { count, until }

// ---- live-sync: broadcast note-file changes to connected clients -------
const sseClients = new Set();
let sseDebounce = null;
function broadcast(noteId) {
  clearTimeout(sseDebounce);
  sseDebounce = setTimeout(() => {
    const payload = `event: change\ndata: ${JSON.stringify({ noteId: noteId || null })}\n\n`;
    for (const res of sseClients) { try { res.write(payload); } catch (_e) { sseClients.delete(res); } }
  }, 250);
}
function startWatcher() {
  try {
    fs.watch(DATA_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) return broadcast(null);
      const name = String(filename).replace(/\\/g, '/');
      if (name.includes('/notes/') && name.endsWith('.json.enc')) {
        broadcast(path.basename(name).replace('.json.enc', ''));
      }
    });
  } catch (_e) {
    // recursive watch may be unsupported on some platforms — live-sync simply
    // stays off; the optimistic-concurrency guard still prevents lost writes.
  }
}

function newSession(key) {
  const token = c.randomToken();
  sessions.set(token, { key, csrf: c.randomToken(), expires: Date.now() + SESSION_TTL });
  return token;
}
function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  s.expires = Date.now() + SESSION_TTL;
  return s;
}

// ---- vault helpers -----------------------------------------------------
function vaultExists() { return fs.existsSync(VAULT_PATH); }
function readVault() { return JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8')).vault; }
function writeVault(v) {
  const tmp = VAULT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ vault: v }, null, 2));
  fs.renameSync(tmp, VAULT_PATH);
}

// ---- helpers -----------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.gz': 'application/gzip',
};

function send(res, status, body, headers = {}) {
  const base = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; " +
      "worker-src 'self' blob:; object-src 'none'; " +
      "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
  res.writeHead(status, Object.assign(base, headers));
  res.end(body);
}
function sendJSON(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (ch) => {
      if (aborted) return;
      size += ch.length;
      if (size > MAX_BODY) { aborted = true; reject(Object.assign(new Error('payload too large'), { status: 413 })); return; }
      chunks.push(ch);
    });
    req.on('end', () => {
      if (aborted) return;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_e) { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}
function safeId(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) {
    throw Object.assign(new Error('invalid id'), { status: 400 });
  }
  return id;
}
// Raw request body (for the token-gated inbox endpoint, which accepts JSON,
// form-encoded, or plain text — Slack/relays vary).
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (ch) => { size += ch.length; if (size > 65536) { reject(Object.assign(new Error('payload too large'), { status: 413 })); return; } chunks.push(ch); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (_e) { return false; }
}
function parseInboundText(raw) {
  raw = String(raw || '').trim();
  if (!raw) return '';
  try { const j = JSON.parse(raw); if (j && typeof j.text === 'string') return j.text; if (typeof j === 'string') return j; } catch (_e) { /* not json */ }
  const m = /(?:^|&)text=([^&]*)/.exec(raw); // form-encoded, e.g. a Slack slash command
  if (m) return decodeURIComponent(m[1].replace(/\+/g, '%20'));
  return raw; // plain text
}
function inboundToken(req, raw) {
  const h = req.headers['x-inbox-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (h) return h;
  try { const j = JSON.parse(raw); if (j && j.token) return String(j.token); } catch (_e) { /* ignore */ }
  const m = /(?:^|&)token=([^&]*)/.exec(String(raw || '')); return m ? decodeURIComponent(m[1]) : '';
}
function clientIp(req) { return (req.socket && req.socket.remoteAddress) || 'unknown'; }
function todayStr() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }

function isSecureReq(req) {
  if (COOKIE_SECURE === 'always') return true;
  if (COOKIE_SECURE === 'never') return false;
  return (req.socket && req.socket.encrypted) || (req.headers['x-forwarded-proto'] === 'https');
}
function sessionCookie(token, req) {
  const secure = isSecureReq(req) ? '; Secure' : '';
  return `mn_session=${token}; HttpOnly; Path=/; SameSite=Strict${secure}; Max-Age=${Math.floor(SESSION_TTL / 1000)}`;
}

// ---- static files ------------------------------------------------------
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

// ---- request router ----------------------------------------------------
const server = http.createServer(async (req, res) => {
  // WHATWG URL API (url.parse is deprecated — DEP0169). The base is a dummy;
  // only pathname + query are used.
  let reqUrl;
  try { reqUrl = new URL(req.url, 'http://localhost'); }
  catch (_e) { return send(res, 400, 'bad request'); }
  const pathname = reqUrl.pathname;
  const query = Object.fromEntries(reqUrl.searchParams);

  try {
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    // ---- unauthenticated endpoints ----
    if (pathname === '/api/health' && req.method === 'GET') {
      // `app` + `name` let another launch detect that THIS application (and
      // which instance) is already serving this port, for a graceful start.
      return sendJSON(res, 200, { ok: true, app: 'meeting-notes', name: CFG.name, version: APP_VERSION, initialized: vaultExists() });
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      const cookies = parseCookies(req);
      const s = getSession(cookies.mn_session);
      let bio = { enrolled: false, credentials: [] };
      if (vaultExists()) { try { const v = readVault(); bio = { enrolled: (v.bio || []).length > 0, credentials: c.listBioSlots(v) }; } catch (_e) { /* ignore */ } }
      return sendJSON(res, 200, {
        initialized: vaultExists(), authenticated: !!s, csrf: s ? s.csrf : null,
        bio,
        instance: { name: CFG.name, url: CFG.url, domain: CFG.domain, version: APP_VERSION, dataDir: DATA_DIR, dataDirEnv: !!DATA_DIR_ENV },
      });
    }

    // Biometric unlock (WebAuthn PRF): the client proves a biometric check by
    // supplying the PRF secret only its authenticator can reproduce; the server
    // unwraps the DEK from the matching bio slot and starts a session. Rate-
    // limited like the passphrase login.
    if (pathname === '/api/webauthn/unlock' && req.method === 'POST') {
      const ip = clientIp(req);
      const att = loginAttempts.get(ip);
      if (att && att.until > Date.now()) return sendJSON(res, 429, { error: 'too many attempts, try again shortly' });
      if (!vaultExists()) return sendJSON(res, 400, { error: 'not initialized' });
      const body = await readBody(req);
      const dek = c.openBioSlot(readVault(), String(body.credentialId || ''), String(body.prfSecret || ''));
      if (!dek) {
        const rec = att || { count: 0, until: 0 };
        rec.count += 1;
        if (rec.count >= 5) { rec.until = Date.now() + 30 * 1000; rec.count = 0; }
        loginAttempts.set(ip, rec);
        return sendJSON(res, 401, { error: 'biometric unlock failed' });
      }
      loginAttempts.delete(ip);
      new Store(DATA_DIR, dek).ensureInitialized();
      const token = newSession(dek);
      return sendJSON(res, 200, { ok: true, csrf: sessions.get(token).csrf }, { 'Set-Cookie': sessionCookie(token, req) });
    }

    if (pathname === '/api/setup' && req.method === 'POST') {
      if (vaultExists()) return sendJSON(res, 409, { error: 'already initialized' });
      const body = await readBody(req);
      const pass = String(body.passphrase || '');
      if (pass.length < 8) return sendJSON(res, 400, { error: 'passphrase must be at least 8 characters' });
      const { vault, dek, recoveryKey } = c.createVault(pass);
      writeVault(vault);
      new Store(DATA_DIR, dek).ensureInitialized();
      const token = newSession(dek);
      return sendJSON(res, 200, { ok: true, recoveryKey, csrf: sessions.get(token).csrf }, { 'Set-Cookie': sessionCookie(token, req) });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const att = loginAttempts.get(ip);
      if (att && att.until > Date.now()) return sendJSON(res, 429, { error: 'too many attempts, try again shortly' });
      if (!vaultExists()) return sendJSON(res, 400, { error: 'not initialized' });
      const body = await readBody(req);
      const pass = String(body.passphrase || '');
      let vault = readVault();
      let dek = null;
      let migratedRecoveryKey = null;
      if (vault.version === 1) {
        const mig = store.migrateVaultV1(DATA_DIR, vault, pass);
        if (mig) { writeVault(mig.vault); dek = mig.dek; migratedRecoveryKey = mig.recoveryKey; }
      } else {
        dek = c.unlockVault(vault, pass);
      }
      if (!dek) {
        const rec = att || { count: 0, until: 0 };
        rec.count += 1;
        if (rec.count >= 5) { rec.until = Date.now() + 30 * 1000; rec.count = 0; }
        loginAttempts.set(ip, rec);
        return sendJSON(res, 401, { error: 'incorrect passphrase' });
      }
      loginAttempts.delete(ip);
      new Store(DATA_DIR, dek).ensureInitialized();
      const token = newSession(dek);
      return sendJSON(res, 200, { ok: true, migratedRecoveryKey, csrf: sessions.get(token).csrf }, { 'Set-Cookie': sessionCookie(token, req) });
    }

    if (pathname === '/api/recover' && req.method === 'POST') {
      if (!vaultExists()) return sendJSON(res, 400, { error: 'not initialized' });
      const body = await readBody(req);
      const vault = readVault();
      const dek = c.unlockWithRecovery(vault, String(body.recoveryKey || ''));
      if (!dek) return sendJSON(res, 401, { error: 'invalid recovery key' });
      const newPass = String(body.newPassphrase || '');
      if (newPass.length < 8) return sendJSON(res, 400, { error: 'new passphrase must be at least 8 characters' });
      writeVault(c.rewrapPassphrase(vault, dek, newPass));
      const token = newSession(dek);
      return sendJSON(res, 200, { ok: true, csrf: sessions.get(token).csrf }, { 'Set-Cookie': sessionCookie(token, req) });
    }

    if (pathname === '/api/restore' && req.method === 'POST') {
      if (vaultExists()) return sendJSON(res, 409, { error: 'refusing to restore over an initialized vault' });
      const body = await readBody(req);
      const out = store.restoreBundle(DATA_DIR, body.bundle);
      return sendJSON(res, 200, out);
    }

    // Token-gated inbox drop (external → to-do queue). Requires the INBOX_TOKEN
    // env var; writes a plaintext queue file into DATA_DIR/inbox that the
    // authenticated client drains into an encrypted to-do. Cannot read or write
    // any encrypted data (no DEK), so a leaked token only lets someone add a
    // to-do, never read your notes.
    if (pathname === '/api/inbox' && req.method === 'POST') {
      if (!process.env.INBOX_TOKEN) return sendJSON(res, 404, { error: 'inbox HTTP endpoint is disabled (set INBOX_TOKEN to enable)' });
      const raw = await readRawBody(req);
      if (!safeEqual(inboundToken(req, raw), process.env.INBOX_TOKEN)) return sendJSON(res, 401, { error: 'bad inbox token' });
      const text = parseInboundText(raw);
      if (!text) return sendJSON(res, 400, { error: 'no text' });
      const dir = path.join(DATA_DIR, 'inbox');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.json');
      fs.writeFileSync(file, JSON.stringify({ text: String(text).slice(0, 2000), via: 'http', ts: new Date().toISOString() }));
      return sendJSON(res, 200, { ok: true });
    }

    // ---- everything below requires an unlocked session ----
    const cookies = parseCookies(req);
    const session = getSession(cookies.mn_session);
    if (!session) return sendJSON(res, 401, { error: 'unauthorized' });

    // CSRF protection for state-changing requests
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      if (req.headers['x-csrf-token'] !== session.csrf) return sendJSON(res, 403, { error: 'bad or missing CSRF token' });
    }

    // Server-Sent Events: notify the client when note files change on disk
    // (e.g. another device wrote to a synced data directory).
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_e) {} }, 25000);
      req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
      return undefined;
    }

    const s = new Store(DATA_DIR, session.key);

    if (pathname === '/api/logout' && req.method === 'POST') {
      sessions.delete(cookies.mn_session);
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': 'mn_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict' });
    }

    // Where the encrypted data lives, and how it was chosen. Lets the UI show
    // the active path and explain when it is pinned by a DATA_DIR env var.
    if (pathname === '/api/datadir' && req.method === 'GET') {
      const pointer = config.readDataDirPointer(__dirname);
      const source = DATA_DIR_ENV ? 'env' : (pointer ? 'pointer' : 'default');
      return sendJSON(res, 200, {
        path: DATA_DIR,
        source,
        envOverride: !!DATA_DIR_ENV,
        appDir: __dirname,
        pointerFile: config.dataDirPointerPath(__dirname),
      });
    }

    // Change where data lives. This only records the new location (in the
    // gitignored pointer file) and requires a restart to take effect — moving
    // an open vault live would risk corrupting locks, watchers and in-flight
    // writes. The existing data is left in place; the user copies/moves it.
    if (pathname === '/api/datadir' && req.method === 'PUT') {
      if (DATA_DIR_ENV) return sendJSON(res, 409, { error: 'data directory is pinned by the DATA_DIR environment variable; unset it to change the location from here' });
      const body = await readBody(req);
      const wanted = String(body.path || '').trim();
      if (!wanted) return sendJSON(res, 400, { error: 'a directory path is required' });
      if (!path.isAbsolute(wanted)) return sendJSON(res, 400, { error: 'please provide an absolute path' });
      const target = path.resolve(wanted);
      try {
        fs.mkdirSync(target, { recursive: true });
        fs.accessSync(target, fs.constants.W_OK);
      } catch (_e) {
        return sendJSON(res, 400, { error: 'that path is not writable (check it exists and you have permission)' });
      }
      const unchanged = target === path.resolve(DATA_DIR);
      config.writeDataDirPointer(__dirname, target);
      return sendJSON(res, 200, { ok: true, path: target, restartRequired: !unchanged, unchanged });
    }

    if (pathname === '/api/passphrase' && req.method === 'POST') {
      const body = await readBody(req);
      const vault = readVault();
      if (!c.unlockVault(vault, String(body.oldPassphrase || ''))) return sendJSON(res, 401, { error: 'current passphrase is incorrect' });
      const np = String(body.newPassphrase || '');
      if (np.length < 8) return sendJSON(res, 400, { error: 'new passphrase must be at least 8 characters' });
      writeVault(c.rewrapPassphrase(vault, session.key, np));
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/recovery/regenerate' && req.method === 'POST') {
      const rot = c.rotateRecovery(readVault(), session.key);
      writeVault(rot.vault);
      return sendJSON(res, 200, { ok: true, recoveryKey: rot.recoveryKey });
    }

    // Enroll a biometric slot for this device (wraps the current session's DEK
    // with the authenticator's PRF secret). Requires an unlocked session.
    if (pathname === '/api/webauthn/enroll' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.credentialId || !body.prfSecret) return sendJSON(res, 400, { error: 'missing credential or PRF secret' });
      const vault = c.addBioSlot(readVault(), session.key, {
        credentialId: String(body.credentialId), prfSecret: String(body.prfSecret),
        prfSalt: String(body.prfSalt || ''), label: String(body.label || 'This device'),
      });
      writeVault(vault);
      return sendJSON(res, 200, { ok: true, credentials: c.listBioSlots(vault) });
    }

    if (pathname === '/api/webauthn/remove' && req.method === 'POST') {
      const body = await readBody(req);
      const vault = c.removeBioSlot(readVault(), String(body.id || ''));
      writeVault(vault);
      return sendJSON(res, 200, { ok: true, credentials: c.listBioSlots(vault) });
    }

    if (pathname === '/api/backup' && req.method === 'GET') {
      const bundle = store.exportBundle(DATA_DIR);
      return send(res, 200, JSON.stringify(bundle), {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="meeting-notes-backup-${Date.now()}.json"`,
      });
    }

    if (pathname === '/api/viewer' && req.method === 'GET') {
      const data = new Store(DATA_DIR, session.key).buildViewerData();
      const html = viewer.renderHTML(data);
      try { viewer.writeViewer(DATA_DIR, data); } catch (_e) { /* also drop a copy in DATA_DIR to sync */ }
      return send(res, 200, html, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${viewer.OUTPUT_NAME}"`,
      });
    }

    const result = await route(s, req, res, pathname, query);
    if (result !== undefined) sendJSON(res, 200, result);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('server error:', err.message);
    const extra = (status === 409 && err.current) ? { current: err.current } : {};
    sendJSON(res, status, Object.assign({ error: err.message || 'internal error' }, extra));
  }
});

// ---- API routes (authenticated) ---------------------------------------
async function route(s, req, res, pathname, query) {
  const m = req.method;
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  if (pathname === '/api/settings' && m === 'GET') return s.getSettings();
  if (pathname === '/api/settings' && m === 'PUT') return s.saveSettings(await readBody(req));

  // templates
  if (pathname === '/api/templates' && m === 'GET') return s.listTemplates();
  if (pathname === '/api/templates' && m === 'POST') return s.createTemplate(await readBody(req));
  if (seg[1] === 'templates' && seg[2]) {
    const id = safeId(seg[2]);
    if (m === 'PUT') return s.updateTemplate(id, await readBody(req));
    if (m === 'DELETE') return s.deleteTemplate(id);
  }

  // workspaces
  if (pathname === '/api/workspaces' && m === 'GET') return s.listWorkspaces();
  if (pathname === '/api/workspaces' && m === 'POST') return s.createWorkspace((await readBody(req)).name);
  if (seg[1] === 'workspaces' && seg[2]) {
    const wsId = safeId(seg[2]);
    if (seg.length === 3 && m === 'PUT') {
      const body = await readBody(req);
      if (body.defaultTemplateId !== undefined) return s.setWorkspaceTemplate(wsId, body.defaultTemplateId);
      return s.renameWorkspace(wsId, body.name);
    }
    if (seg.length === 3 && m === 'DELETE') return s.deleteWorkspace(wsId);
    if (seg[3] === 'notes' && m === 'GET') return s.listNotes(wsId, { sort: query.sort, dir: query.dir });
    if (seg[3] === 'current' && m === 'GET') return s.currentNote(wsId);
    if (seg[3] === 'notes' && seg[4] === 'new' && m === 'POST') return s.createNote(wsId, await readBody(req));
    if (seg[3] === 'reminders' && seg.length === 4 && m === 'GET') return s.listReminders(wsId);
    if (seg[3] === 'reminders' && seg.length === 4 && m === 'POST') return s.addReminder(wsId, await readBody(req));
    if (seg[3] === 'reminders' && seg[4] && seg[5] === 'snooze' && m === 'POST') return s.snoozeReminder(wsId, safeId(seg[4]), (await readBody(req)).until);
    if (seg[3] === 'reminders' && seg[4] && m === 'PUT') return s.updateReminder(wsId, safeId(seg[4]), await readBody(req));
    if (seg[3] === 'reminders' && seg[4] && m === 'DELETE') return s.deleteReminder(wsId, safeId(seg[4]));
    if (seg[3] === 'tasks' && seg.length === 4 && m === 'GET') return s.listTasks(wsId);
    if (seg[3] === 'tasks' && seg.length === 4 && m === 'POST') return s.addTask(wsId, await readBody(req));
    if (seg[3] === 'import' && m === 'POST') return s.importNote(wsId, await readBody(req));
    if (seg[3] === 'export' && m === 'GET') {
      const out = s.exportWorkspaceZip(wsId, query.format);
      send(res, 200, out.body, { 'Content-Type': out.mime, 'Content-Disposition': `attachment; filename="${out.filename}.zip"` });
      return undefined;
    }
  }

  // notes
  if (pathname === '/api/notes/batch' && m === 'POST') {
    const body = await readBody(req);
    return s.batchNotes(String(body.action || ''), body.ids, { workspaceId: body.workspaceId ? safeId(body.workspaceId) : null, tags: body.tags });
  }
  if (seg[1] === 'notes' && seg[2] && seg[2] !== 'batch') {
    const noteId = safeId(seg[2]);
    if (seg.length === 3 && m === 'GET') return s.getNote(noteId);
    if (seg.length === 3 && m === 'PUT') return s.saveNote(noteId, await readBody(req));
    if (seg.length === 3 && m === 'DELETE') return s.deleteNote(noteId);
    if (seg[3] === 'favorite' && m === 'POST') return s.setFavorite(noteId, (await readBody(req)).favorite);
    if (seg[3] === 'move' && m === 'POST') return s.moveNote(noteId, safeId((await readBody(req)).workspaceId));
    if (seg[3] === 'copy' && m === 'POST') return s.copyNote(noteId, (await readBody(req)).workspaceId || null);
    if (seg[3] === 'fork' && m === 'POST') return s.forkNote(noteId, await readBody(req));
    if (seg[3] === 'backlinks' && m === 'GET') return s.backlinks(noteId);
    if (seg[3] === 'versions' && seg.length === 4 && m === 'GET') return s.listVersions(noteId);
    if (seg[3] === 'versions' && seg[4] && seg[5] === 'restore' && m === 'POST') return s.restoreVersion(noteId, parseInt(seg[4], 10));
    if (seg[3] === 'versions' && seg[4] && m === 'GET') return s.getVersion(noteId, parseInt(seg[4], 10));
    if (seg[3] === 'export' && m === 'GET') {
      const out = s.exportNote(noteId, query.format);
      send(res, 200, out.body, { 'Content-Type': out.mime, 'Content-Disposition': `attachment; filename="note-${noteId}.${out.ext}"` });
      return undefined;
    }
    if (seg[3] === 'todos' && seg[4] && m === 'PUT') return s.toggleTodo(noteId, safeId(seg[4]), (await readBody(req)).done);
    if (seg[3] === 'attachments' && seg.length === 4 && m === 'POST') return s.addAttachment(noteId, await readBody(req));
    if (seg[3] === 'attachments' && seg[4] && seg[5] === 'ocr' && m === 'POST') return s.setAttachmentOcr(noteId, safeId(seg[4]), (await readBody(req)).text);
    if (seg[3] === 'attachments' && seg[4] && m === 'GET') {
      const { meta, data } = s.getAttachment(noteId, safeId(seg[4]));
      send(res, 200, data, { 'Content-Type': meta.mime, 'Content-Disposition': `inline; filename="${meta.name.replace(/[^\w.\- ]/g, '_')}"` });
      return undefined;
    }
    if (seg[3] === 'attachments' && seg[4] && seg[5] === 'ocr' && m === 'POST') return s.setAttachmentOcr(noteId, safeId(seg[4]), (await readBody(req)).text);
    if (seg[3] === 'attachments' && seg[4] && m === 'DELETE') return s.deleteAttachment(noteId, safeId(seg[4]));
  }

  // tasks (unified to-do + reminder)
  if (pathname === '/api/tasks' && m === 'GET') return s.globalTasks();
  if (pathname === '/api/tasks/due' && m === 'POST') return s.dueTaskNotifications();
  if (seg[1] === 'tasks' && seg[2]) {
    const taskId = safeId(seg[2]);
    if (seg.length === 3 && m === 'PUT') return s.updateTask(taskId, await readBody(req));
    if (seg.length === 3 && m === 'DELETE') return s.deleteTask(taskId);
    if (seg[3] === 'complete' && m === 'POST') return s.completeTask(taskId, { noteId: (await readBody(req)).noteId });
    if (seg[3] === 'skip' && m === 'POST') return s.skipTask(taskId);
    if (seg[3] === 'reschedule' && m === 'POST') return s.rescheduleTask(taskId, (await readBody(req)).due);
  }

  // trash
  if (pathname === '/api/trash' && m === 'GET') return s.listTrash();
  if (seg[1] === 'trash' && seg[2] && seg[3] === 'restore' && m === 'POST') return s.restoreNote(safeId(seg[2]));
  if (seg[1] === 'trash' && seg[2] && m === 'DELETE') return s.purgeNote(safeId(seg[2]));

  // favorites, todos, reminders processing, search, integrity
  if (pathname === '/api/favorites' && m === 'GET') return s.listFavorites();
  if (pathname === '/api/todos' && m === 'GET') return s.globalTodos();
  if (pathname === '/api/reminders/process' && m === 'POST') return s.processReminders();
  if (pathname === '/api/inbox/process' && m === 'POST') return s.processInbox();
  if (pathname === '/api/slack/agenda' && m === 'POST') {
    const url = (s.getSettings().slackWebhook || process.env.SLACK_WEBHOOK_URL || '').trim();
    if (!url) throw Object.assign(new Error('no Slack webhook configured (Settings → Slack)'), { status: 400 });
    await slack.postWebhook(url, slack.formatAgenda(s.globalTasks(), todayStr()));
    return { ok: true, posted: true };
  }
  if (pathname === '/api/search' && m === 'GET') return s.search(query.q);
  if (pathname === '/api/tags' && m === 'GET') return s.allTags();
  // LLM knowledge export: a workspace or a tag as Markdown, either one
  // comprehensive file or a ZIP of one file per note.
  if (pathname === '/api/export/llm' && m === 'GET') {
    const scope = query.scope === 'tag' ? 'tag' : 'workspace';
    const mode = query.mode === 'perNote' ? 'perNote' : 'single';
    const out = s.exportLLM({ scope, mode, wsId: query.id ? safeId(query.id) : null, tag: query.tag });
    send(res, 200, out.body, {
      'Content-Type': out.mime + '; charset=utf-8',
      'Content-Disposition': `attachment; filename="${out.filename}.${out.ext}"`,
    });
    return undefined;
  }
  if (pathname === '/api/verify' && m === 'GET') return s.verifyIntegrity();
  if (pathname === '/api/conflicts' && m === 'GET') return s.listConflicts();
  if (pathname === '/api/backup/verify' && m === 'POST') return s.verifyBundle((await readBody(req)).bundle);
  if (pathname === '/api/stats' && m === 'GET') return s.stats();
  if (pathname === '/api/transcribe' && m === 'POST') {
    const body = await readBody(req);
    const cfg = (s.getSettings().transcription) || {};
    const out = await transcribe.transcribe(cfg, { audio: Buffer.from(body.audioB64 || '', 'base64'), mime: body.mime, filename: body.filename });
    return { text: out.text };
  }

  throw Object.assign(new Error('not found'), { status: 404 });
}

// ---- CLI: durable-domain setup & config inspection --------------------
function runCli(argv) {
  const args = argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

  if (has('--help') || has('-h')) {
    console.log(`Cove ${APP_VERSION}
Usage: node server.js [options]

  (no options)            Start the server (durable host/port from instance.json + env)
  --port <n>              Run on port <n> for this launch (overrides env/instance).
  --set-port <n>          Pin port <n> durably for THIS data directory, then exit.
  --set-domain <name>     Assign a durable local domain (bare name -> <name>.localhost)
                          and a stable port for THIS data directory, then exit.
                          Combine with --port <n> to pin an explicit port.
  --print-config          Print the resolved host/port/domain for this data directory.
  --verify                Decrypt-check every file and report any corruption.
                          Reads the passphrase from MN_PASSPHRASE, or from stdin.
  --build-viewer          Write a standalone, read-only offline viewer HTML into
                          the data directory (opens on a phone, no server needed).
                          With MN_PASSPHRASE set it also embeds inline images.
  --help                  Show this help.

Environment: DATA_DIR, PORT, HOST, DOMAIN, MAX_BODY, SESSION_TTL, COOKIE_SECURE.
`);
    return true;
  }

  if (has('--print-config')) {
    console.log(JSON.stringify(CFG, null, 2));
    return true;
  }

  if (has('--set-port')) {
    const port = config.validPort(val('--set-port'));
    if (!port) { console.error('Provide a port 1–65535, e.g. --set-port 8080'); process.exitCode = 1; return true; }
    const existing = config.readInstance(DATA_DIR) || {};
    config.writeInstance(DATA_DIR, Object.assign({ name: 'Cove', host: '127.0.0.1', createdAt: new Date().toISOString() }, existing, { port }));
    console.log(`\n  Port pinned to ${port} for this data directory (saved in instance.json).`);
    console.log(`  Every "node server.js" here now uses it. Override once with --port or PORT=.\n`);
    return true;
  }

  if (has('--verify')) {
    if (!vaultExists()) { console.error('Not initialized — no vault in ' + DATA_DIR); process.exitCode = 1; return true; }
    let pass = process.env.MN_PASSPHRASE;
    if (!pass) { try { pass = fs.readFileSync(0, 'utf8').split('\n')[0].trim(); } catch (_e) { pass = ''; } }
    const dek = c.unlockVault(readVault(), String(pass || ''));
    if (!dek) { console.error('Could not unlock: set MN_PASSPHRASE or pipe the passphrase to --verify.'); process.exitCode = 1; return true; }
    const report = new Store(DATA_DIR, dek).verifyIntegrity();
    console.log(`Checked ${report.checked} encrypted files — ${report.ok ? 'all OK ✓' : report.corrupt.length + ' corrupt:'}`);
    for (const c2 of report.corrupt) console.log(`  ✗ ${c2.path}: ${c2.error}`);
    if (!report.ok) process.exitCode = 2;
    return true;
  }

  if (has('--build-viewer')) {
    if (!vaultExists()) { console.error('Not initialized — no vault in ' + DATA_DIR); process.exitCode = 1; return true; }
    let data = null;
    let pass = process.env.MN_PASSPHRASE;
    if (!pass) { try { pass = fs.readFileSync(0, 'utf8').split('\n')[0].trim(); } catch (_e) { pass = ''; } }
    if (pass) {
      const dek = c.unlockVault(readVault(), String(pass));
      if (dek) data = new Store(DATA_DIR, dek).buildViewerData();
    }
    if (!data) { data = viewer.collectData(DATA_DIR); console.log('(no/invalid passphrase — building without inline images)'); }
    const out = viewer.writeViewer(DATA_DIR, data);
    console.log('Offline viewer written: ' + out);
    return true;
  }

  if (has('--set-domain')) {
    const domain = config.normalizeDomain(val('--set-domain'));
    if (!domain) { console.error('Provide a name, e.g. --set-domain notes'); process.exitCode = 1; return true; }
    const existing = config.readInstance(DATA_DIR) || {};
    const port = parseInt(val('--port'), 10) || existing.port || config.derivePort(domain);
    config.writeInstance(DATA_DIR, {
      name: existing.name || 'Cove',
      domain, host: existing.host || '127.0.0.1', port,
      createdAt: existing.createdAt || new Date().toISOString(),
    });
    console.log(`\n  Durable domain set for this data directory:\n`);
    console.log(`    URL:   http://${domain}:${port}`);
    console.log(`    Port:  ${port}  (fixed — will not change between restarts)\n`);
    if (domain.endsWith('.localhost')) {
      console.log(`  ${domain} resolves to 127.0.0.1 automatically in modern browsers —`);
      console.log(`  no hosts-file changes needed. Just run "node server.js" and open the URL.\n`);
    } else {
      console.log(`  Add this line to your hosts file so the domain resolves locally:`);
      console.log(`    127.0.0.1   ${domain}`);
      console.log(`  (/etc/hosts on macOS/Linux, C:\\Windows\\System32\\drivers\\etc\\hosts on Windows)\n`);
    }
    return true;
  }
  return false;
}

function startServer() {
  // Refuse to run two instances against the SAME data directory.
  const activeLock = config.readActiveLock(DATA_DIR);
  if (activeLock) {
    console.error(`\n  This data directory is already in use by a running instance`);
    console.error(`  (pid ${activeLock.pid}, http://${CFG.displayHost}:${activeLock.port}).`);
    console.error(`  Open that URL, or start a separate instance with its own DATA_DIR.\n`);
    process.exit(0);
  }

  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') { console.error('server error:', err.message); process.exit(1); }
    // Port taken — figure out gracefully whether it's us or another app.
    const opts = { host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1500 };
    const probe = http.get(opts, (r) => {
      let body = '';
      r.on('data', (d) => (body += d));
      r.on('end', () => {
        let info = null; try { info = JSON.parse(body); } catch (_e) {}
        if (info && info.app === 'meeting-notes') {
          console.error(`\n  Cove ("${info.name}") is already running at ${CFG.url}.`);
          console.error(`  Open it in your browser, or give this instance its own durable domain:`);
          console.error(`    node server.js --set-domain <another-name>\n`);
          process.exit(0); // graceful: it's already up
        } else {
          reportPortBusy();
        }
      });
    });
    probe.on('error', reportPortBusy);
    probe.on('timeout', () => { probe.destroy(); reportPortBusy(); });
  });

  function reportPortBusy() {
    console.error(`\n  Port ${PORT} is already in use by another application.`);
    console.error(`  Run on a different port:      node server.js --port 8080`);
    console.error(`  …or pin one durably:          node server.js --set-port 8080\n`);
    process.exit(1);
  }

  server.listen(PORT, HOST, () => {
    config.writeLock(DATA_DIR, PORT);
    startWatcher();
    startAutoBackup();
    console.log(`\n  Cove ${APP_VERSION} running at  ${CFG.url}`);
    if (CFG.domain) console.log(`  (also reachable at        http://${HOST}:${PORT})`);
    console.log(`  Data directory:           ${DATA_DIR}`);
    if (AUTO_BACKUP_DIR) console.log(`  Auto-backup:              every ${AUTO_BACKUP_HOURS}h → ${AUTO_BACKUP_DIR} (keep ${AUTO_BACKUP_KEEP})`);
    console.log(`  (encrypted at rest — set DATA_DIR to a Drive/Box/Dropbox folder to sync)\n`);
  });

  function startAutoBackup() {
    if (!AUTO_BACKUP_DIR) return;
    const run = () => {
      try {
        const r = backup.runAutoBackup(DATA_DIR, AUTO_BACKUP_DIR, AUTO_BACKUP_KEEP);
        console.log(`auto-backup written: ${path.basename(r.file)}${r.removed.length ? ` (pruned ${r.removed.length})` : ''}`);
      } catch (e) { console.error('auto-backup failed:', e.message); }
      // Keep a fresh offline viewer in the (synced) data dir. Keyless build, so
      // it omits inline attachment images; the in-app download includes them.
      try { viewer.writeViewer(DATA_DIR, viewer.collectData(DATA_DIR)); } catch (_e) { /* best effort */ }
    };
    setTimeout(run, 5000).unref(); // first backup shortly after startup
    setInterval(run, AUTO_BACKUP_HOURS * 3600 * 1000).unref();
  }

  const shutdown = () => { config.clearLock(DATA_DIR); try { server.close(); } catch (_e) {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => config.clearLock(DATA_DIR));
}

if (require.main === module) {
  if (!runCli(process.argv)) startServer();
}

module.exports = { server, DATA_DIR, CFG };
