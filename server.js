'use strict';

/*
 * Meeting Notes — zero-dependency HTTP server (Node core only).
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
const url = require('url');
const c = require('./lib/crypto');
const store = require('./lib/store');
const { Store } = store;

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_BODY = parseInt(process.env.MAX_BODY, 10) || 32 * 1024 * 1024;
const SESSION_TTL = (parseInt(process.env.SESSION_TTL, 10) || 240) * 60 * 1000;
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'auto').toLowerCase();
const PUBLIC_DIR = path.join(__dirname, 'public');
const VAULT_PATH = path.join(DATA_DIR, 'vault.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- session state (in-memory only; keys never touch disk) -------------
const sessions = new Map(); // token -> { key, csrf, expires }
const loginAttempts = new Map(); // ip -> { count, until }

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
};

function send(res, status, body, headers = {}) {
  const base = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; " +
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
function clientIp(req) { return (req.socket && req.socket.remoteAddress) || 'unknown'; }

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
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    // ---- unauthenticated endpoints ----
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, initialized: vaultExists() });
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      const cookies = parseCookies(req);
      const s = getSession(cookies.mn_session);
      return sendJSON(res, 200, { initialized: vaultExists(), authenticated: !!s, csrf: s ? s.csrf : null });
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

    // ---- everything below requires an unlocked session ----
    const cookies = parseCookies(req);
    const session = getSession(cookies.mn_session);
    if (!session) return sendJSON(res, 401, { error: 'unauthorized' });

    // CSRF protection for state-changing requests
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      if (req.headers['x-csrf-token'] !== session.csrf) return sendJSON(res, 403, { error: 'bad or missing CSRF token' });
    }

    const s = new Store(DATA_DIR, session.key);

    if (pathname === '/api/logout' && req.method === 'POST') {
      sessions.delete(cookies.mn_session);
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': 'mn_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict' });
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

    if (pathname === '/api/backup' && req.method === 'GET') {
      const bundle = store.exportBundle(DATA_DIR);
      return send(res, 200, JSON.stringify(bundle), {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="meeting-notes-backup-${Date.now()}.json"`,
      });
    }

    const result = await route(s, req, res, pathname, parsed.query);
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
    if (seg[3] === 'notes' && m === 'GET') return s.listNotes(wsId);
    if (seg[3] === 'current' && m === 'GET') return s.currentNote(wsId);
    if (seg[3] === 'notes' && seg[4] === 'new' && m === 'POST') return s.createNote(wsId, await readBody(req));
    if (seg[3] === 'reminders' && m === 'GET') return s.listReminders(wsId);
    if (seg[3] === 'reminders' && m === 'POST') return s.addReminder(wsId, await readBody(req));
    if (seg[3] === 'reminders' && seg[4] && m === 'PUT') return s.updateReminder(wsId, safeId(seg[4]), await readBody(req));
    if (seg[3] === 'reminders' && seg[4] && m === 'DELETE') return s.deleteReminder(wsId, safeId(seg[4]));
    if (seg[3] === 'import' && m === 'POST') return s.importNote(wsId, await readBody(req));
  }

  // notes
  if (seg[1] === 'notes' && seg[2]) {
    const noteId = safeId(seg[2]);
    if (seg.length === 3 && m === 'GET') return s.getNote(noteId);
    if (seg.length === 3 && m === 'PUT') return s.saveNote(noteId, await readBody(req));
    if (seg.length === 3 && m === 'DELETE') return s.deleteNote(noteId);
    if (seg[3] === 'favorite' && m === 'POST') return s.setFavorite(noteId, (await readBody(req)).favorite);
    if (seg[3] === 'move' && m === 'POST') return s.moveNote(noteId, safeId((await readBody(req)).workspaceId));
    if (seg[3] === 'copy' && m === 'POST') return s.copyNote(noteId, (await readBody(req)).workspaceId || null);
    if (seg[3] === 'export' && m === 'GET') {
      const out = s.exportNote(noteId, query.format);
      send(res, 200, out.body, { 'Content-Type': out.mime, 'Content-Disposition': `attachment; filename="note-${noteId}.${out.ext}"` });
      return undefined;
    }
    if (seg[3] === 'todos' && seg[4] && m === 'PUT') return s.toggleTodo(noteId, safeId(seg[4]), (await readBody(req)).done);
    if (seg[3] === 'attachments' && m === 'POST') return s.addAttachment(noteId, await readBody(req));
    if (seg[3] === 'attachments' && seg[4] && m === 'GET') {
      const { meta, data } = s.getAttachment(noteId, safeId(seg[4]));
      send(res, 200, data, { 'Content-Type': meta.mime, 'Content-Disposition': `inline; filename="${meta.name.replace(/[^\w.\- ]/g, '_')}"` });
      return undefined;
    }
    if (seg[3] === 'attachments' && seg[4] && m === 'DELETE') return s.deleteAttachment(noteId, safeId(seg[4]));
  }

  // trash
  if (pathname === '/api/trash' && m === 'GET') return s.listTrash();
  if (seg[1] === 'trash' && seg[2] && seg[3] === 'restore' && m === 'POST') return s.restoreNote(safeId(seg[2]));
  if (seg[1] === 'trash' && seg[2] && m === 'DELETE') return s.purgeNote(safeId(seg[2]));

  // favorites, todos, reminders processing, search
  if (pathname === '/api/favorites' && m === 'GET') return s.listFavorites();
  if (pathname === '/api/todos' && m === 'GET') return s.globalTodos();
  if (pathname === '/api/reminders/process' && m === 'POST') return s.processReminders();
  if (pathname === '/api/search' && m === 'GET') return s.search(query.q);

  throw Object.assign(new Error('not found'), { status: 404 });
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  Meeting Notes running at  http://${HOST}:${PORT}`);
    console.log(`  Data directory:           ${DATA_DIR}`);
    console.log(`  (encrypted at rest — set DATA_DIR to a Drive/Box/Dropbox folder to sync)\n`);
  });
}

module.exports = { server, DATA_DIR };
