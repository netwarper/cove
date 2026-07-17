'use strict';

/*
 * Meeting Notes — zero-dependency HTTP server (Node core only).
 *
 * Portability: everything here uses the Node standard library, so the whole
 * project can be copied to any machine with Node >= 18 and started with
 * `node server.js` — no `npm install`, no build step.
 *
 * Configuration (all optional, via environment variables):
 *   PORT       listening port                (default 3000)
 *   HOST       bind address                  (default 127.0.0.1 — localhost only)
 *   DATA_DIR   data directory                (default ./data)  <- point at a
 *              Google Drive / Box / Dropbox sync folder to work off the cloud.
 *   MAX_BODY   max request body bytes        (default 33554432 = 32 MB)
 *   SESSION_TTL session lifetime in minutes  (default 240)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const c = require('./lib/crypto');
const { Store } = require('./lib/store');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_BODY = parseInt(process.env.MAX_BODY, 10) || 32 * 1024 * 1024;
const SESSION_TTL = (parseInt(process.env.SESSION_TTL, 10) || 240) * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VAULT_PATH = path.join(DATA_DIR, 'vault.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- session state (in-memory only; keys never touch disk) -------------
const sessions = new Map(); // token -> { key, expires }
const loginAttempts = new Map(); // ip -> { count, until }

function newSession(key) {
  const token = c.randomToken();
  sessions.set(token, { key, expires: Date.now() + SESSION_TTL });
  return token;
}
function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  s.expires = Date.now() + SESSION_TTL; // sliding expiry
  return s;
}

// ---- vault helpers -----------------------------------------------------
function vaultExists() { return fs.existsSync(VAULT_PATH); }
function readVault() { return JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8')).vault; }
function writeVault(v) { fs.writeFileSync(VAULT_PATH, JSON.stringify({ vault: v }, null, 2)); }

// ---- tiny helpers ------------------------------------------------------
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
      if (aborted) return; // keep draining, but stop buffering
      size += ch.length;
      if (size > MAX_BODY) {
        aborted = true;
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        return;
      }
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
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---- static files ------------------------------------------------------
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
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
    if (pathname === '/api/status' && req.method === 'GET') {
      const cookies = parseCookies(req);
      const authed = !!getSession(cookies.mn_session);
      return sendJSON(res, 200, { initialized: vaultExists(), authenticated: authed });
    }

    if (pathname === '/api/setup' && req.method === 'POST') {
      if (vaultExists()) return sendJSON(res, 409, { error: 'already initialized' });
      const body = await readBody(req);
      const pass = String(body.passphrase || '');
      if (pass.length < 8) return sendJSON(res, 400, { error: 'passphrase must be at least 8 characters' });
      const { vault, key } = c.createVault(pass);
      writeVault(vault);
      const store = new Store(DATA_DIR, key);
      store.ensureInitialized();
      const token = newSession(key);
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const att = loginAttempts.get(ip);
      if (att && att.until > Date.now()) {
        return sendJSON(res, 429, { error: 'too many attempts, try again shortly' });
      }
      if (!vaultExists()) return sendJSON(res, 400, { error: 'not initialized' });
      const body = await readBody(req);
      const key = c.unlockVault(readVault(), String(body.passphrase || ''));
      if (!key) {
        const rec = att || { count: 0, until: 0 };
        rec.count += 1;
        if (rec.count >= 5) { rec.until = Date.now() + 30 * 1000; rec.count = 0; }
        loginAttempts.set(ip, rec);
        return sendJSON(res, 401, { error: 'incorrect passphrase' });
      }
      loginAttempts.delete(ip);
      const store = new Store(DATA_DIR, key);
      store.ensureInitialized();
      const token = newSession(key);
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token) });
    }

    // ---- everything below requires an unlocked session ----
    const cookies = parseCookies(req);
    const session = getSession(cookies.mn_session);
    if (!session) return sendJSON(res, 401, { error: 'unauthorized' });
    const store = new Store(DATA_DIR, session.key);

    if (pathname === '/api/logout' && req.method === 'POST') {
      sessions.delete(cookies.mn_session);
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': 'mn_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict' });
    }

    const result = await route(store, req, res, pathname, parsed.query);
    if (result !== undefined) sendJSON(res, 200, result);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('server error:', err.message);
    sendJSON(res, status, { error: err.message || 'internal error' });
  }
});

function sessionCookie(token) {
  // Secure flag omitted so it also works over http://localhost; when hosting
  // remotely behind TLS, set it via a proxy or extend this to add `Secure`.
  return `mn_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL / 1000)}`;
}

// ---- API routes (authenticated) ---------------------------------------
async function route(store, req, res, pathname, query) {
  const m = req.method;
  const seg = pathname.split('/').filter(Boolean); // e.g. ['api','notes','abc']

  // settings
  if (pathname === '/api/settings' && m === 'GET') return store.getSettings();
  if (pathname === '/api/settings' && m === 'PUT') return store.saveSettings(await readBody(req));

  // workspaces
  if (pathname === '/api/workspaces' && m === 'GET') return store.listWorkspaces();
  if (pathname === '/api/workspaces' && m === 'POST') return store.createWorkspace((await readBody(req)).name);
  if (seg[1] === 'workspaces' && seg[2]) {
    const wsId = safeId(seg[2]);
    if (seg.length === 3 && m === 'PUT') return store.renameWorkspace(wsId, (await readBody(req)).name);
    if (seg.length === 3 && m === 'DELETE') return store.deleteWorkspace(wsId);
    if (seg[3] === 'notes' && m === 'GET') return store.listNotes(wsId);
    if (seg[3] === 'current' && m === 'GET') return store.currentNote(wsId);
    if (seg[3] === 'notes' && seg[4] === 'new' && m === 'POST') return store.createNote(wsId, await readBody(req));
    if (seg[3] === 'reminders' && m === 'GET') return store.listReminders(wsId);
    if (seg[3] === 'reminders' && m === 'POST') return store.addReminder(wsId, await readBody(req));
    if (seg[3] === 'reminders' && seg[4] && m === 'PUT') return store.updateReminder(wsId, safeId(seg[4]), await readBody(req));
    if (seg[3] === 'reminders' && seg[4] && m === 'DELETE') return store.deleteReminder(wsId, safeId(seg[4]));
    if (seg[3] === 'import' && m === 'POST') return store.importNote(wsId, await readBody(req));
  }

  // notes
  if (seg[1] === 'notes' && seg[2]) {
    const noteId = safeId(seg[2]);
    if (seg.length === 3 && m === 'GET') return store.getNote(noteId);
    if (seg.length === 3 && m === 'PUT') return store.saveNote(noteId, await readBody(req));
    if (seg.length === 3 && m === 'DELETE') return store.deleteNote(noteId);
    if (seg[3] === 'favorite' && m === 'POST') return store.setFavorite(noteId, (await readBody(req)).favorite);
    if (seg[3] === 'export' && m === 'GET') {
      const out = store.exportNote(noteId, query.format);
      send(res, 200, out.body, {
        'Content-Type': out.mime,
        'Content-Disposition': `attachment; filename="note-${noteId}.${out.ext}"`,
      });
      return undefined;
    }
    if (seg[3] === 'todos' && seg[4] && m === 'PUT') {
      return store.toggleTodo(noteId, safeId(seg[4]), (await readBody(req)).done);
    }
    if (seg[3] === 'attachments' && m === 'POST') return store.addAttachment(noteId, await readBody(req));
    if (seg[3] === 'attachments' && seg[4] && m === 'GET') {
      const { meta, data } = store.getAttachment(noteId, safeId(seg[4]));
      send(res, 200, data, {
        'Content-Type': meta.mime,
        'Content-Disposition': `inline; filename="${meta.name.replace(/[^\w.\- ]/g, '_')}"`,
      });
      return undefined;
    }
    if (seg[3] === 'attachments' && seg[4] && m === 'DELETE') return store.deleteAttachment(noteId, safeId(seg[4]));
  }

  // favorites, todos, search
  if (pathname === '/api/favorites' && m === 'GET') return store.listFavorites();
  if (pathname === '/api/todos' && m === 'GET') return store.globalTodos();
  if (pathname === '/api/search' && m === 'GET') return store.search(query.q);

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
