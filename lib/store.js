'use strict';

/*
 * File-based, encrypted data store.
 *
 * All persistent state lives under DATA_DIR, which can point at any folder —
 * including a Google Drive / Box / Dropbox sync folder — via the DATA_DIR
 * environment variable. Everything except the vault descriptor is encrypted
 * at rest.
 *
 * Layout:
 *   DATA_DIR/
 *     vault.json                 plaintext KDF descriptor (salt + verifier)
 *     index.json.enc             { workspaces:[{id,name,createdAt}], settings }
 *     ws/<id>/workspace.json.enc { id, name, reminders:[...] }
 *     ws/<id>/notes/<id>.json.enc
 *     ws/<id>/att/<id>           encrypted attachment binary
 */

const fs = require('fs');
const path = require('path');
const c = require('./crypto');

const GENERAL_WORKSPACE = 'general';

class Store {
  constructor(dataDir, key) {
    this.dir = dataDir;
    this.key = key;
  }

  // ---- low-level encrypted file helpers -------------------------------

  _writeEnc(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, c.encryptJSON(this.key, obj));
    fs.renameSync(tmp, file); // atomic replace, sync-folder friendly
  }

  _readEnc(file) {
    return c.decryptJSON(this.key, fs.readFileSync(file));
  }

  _indexPath() { return path.join(this.dir, 'index.json.enc'); }
  _wsDir(id) { return path.join(this.dir, 'ws', id); }
  _wsMetaPath(id) { return path.join(this._wsDir(id), 'workspace.json.enc'); }
  _notesDir(id) { return path.join(this._wsDir(id), 'notes'); }
  _notePath(wsId, noteId) { return path.join(this._notesDir(wsId), noteId + '.json.enc'); }
  _attDir(wsId) { return path.join(this._wsDir(wsId), 'att'); }
  _attPath(wsId, attId) { return path.join(this._attDir(wsId), attId); }

  // ---- index / settings ----------------------------------------------

  ensureInitialized() {
    if (!fs.existsSync(this._indexPath())) {
      const index = {
        workspaces: [],
        settings: { layout: 'columns' },
      };
      this._writeEnc(this._indexPath(), index);
      this.createWorkspace('General', GENERAL_WORKSPACE);
    }
  }

  _index() { return this._readEnc(this._indexPath()); }
  _saveIndex(idx) { this._writeEnc(this._indexPath(), idx); }

  getSettings() { return this._index().settings; }
  saveSettings(patch) {
    const idx = this._index();
    idx.settings = Object.assign({}, idx.settings, patch);
    this._saveIndex(idx);
    return idx.settings;
  }

  // ---- workspaces -----------------------------------------------------

  listWorkspaces() {
    return this._index().workspaces.slice().sort((a, b) => {
      if (a.id === GENERAL_WORKSPACE) return -1;
      if (b.id === GENERAL_WORKSPACE) return 1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
  }

  createWorkspace(name, forcedId) {
    const idx = this._index();
    const id = forcedId || c.randomId(8);
    if (idx.workspaces.some((w) => w.id === id)) throw httpError(409, 'workspace exists');
    const entry = { id, name: String(name || 'Untitled').slice(0, 120), createdAt: new Date().toISOString() };
    idx.workspaces.push(entry);
    this._saveIndex(idx);
    this._writeEnc(this._wsMetaPath(id), { id, name: entry.name, reminders: [] });
    fs.mkdirSync(this._notesDir(id), { recursive: true });
    return entry;
  }

  renameWorkspace(id, name) {
    const idx = this._index();
    const w = idx.workspaces.find((x) => x.id === id);
    if (!w) throw httpError(404, 'workspace not found');
    w.name = String(name).slice(0, 120);
    this._saveIndex(idx);
    const meta = this._wsMeta(id);
    meta.name = w.name;
    this._writeEnc(this._wsMetaPath(id), meta);
    return w;
  }

  deleteWorkspace(id) {
    if (id === GENERAL_WORKSPACE) throw httpError(400, 'cannot delete the General workspace');
    const idx = this._index();
    idx.workspaces = idx.workspaces.filter((w) => w.id !== id);
    this._saveIndex(idx);
    fs.rmSync(this._wsDir(id), { recursive: true, force: true });
    return { ok: true };
  }

  _wsMeta(id) {
    if (!fs.existsSync(this._wsMetaPath(id))) throw httpError(404, 'workspace not found');
    return this._readEnc(this._wsMetaPath(id));
  }

  // ---- notes ----------------------------------------------------------

  _listNoteFiles(wsId) {
    const dir = this._notesDir(wsId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json.enc'));
  }

  listNotes(wsId) {
    this._wsMeta(wsId); // validates workspace
    const notes = this._listNoteFiles(wsId).map((f) => this._readEnc(path.join(this._notesDir(wsId), f)));
    notes.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
    return notes.map(noteSummary);
  }

  latestNote(wsId) {
    const files = this._listNoteFiles(wsId);
    let latest = null;
    for (const f of files) {
      const n = this._readEnc(path.join(this._notesDir(wsId), f));
      if (!latest || n.createdAt > latest.createdAt) latest = n;
    }
    return latest;
  }

  getNote(noteId, wsHint) {
    const loc = this._locateNote(noteId, wsHint);
    if (!loc) throw httpError(404, 'note not found');
    return loc.note;
  }

  _locateNote(noteId, wsHint) {
    const wss = wsHint ? [{ id: wsHint }] : this._index().workspaces;
    for (const w of wss) {
      const p = this._notePath(w.id, noteId);
      if (fs.existsSync(p)) return { wsId: w.id, note: this._readEnc(p), path: p };
    }
    return null;
  }

  _blankNote(wsId, opts = {}) {
    const now = new Date();
    return {
      id: c.randomId(8),
      workspaceId: wsId,
      title: formatDateTitle(now),
      customTitle: opts.customTitle || null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      favorite: false,
      todos: [],
      carryover: '',
      meetingNotes: '',
      attachments: [],
      reminderOccurrences: {},
      freeform: [], // free-form (OneNote-style) text boxes: {id,x,y,w,html}
    };
  }

  /**
   * Create a new note. If the workspace already has notes, incomplete todos
   * and the carryover section are copied from the most recent note. Meeting
   * notes are intentionally NOT copied. Due reminders are injected as todos.
   */
  createNote(wsId, opts = {}) {
    this._wsMeta(wsId);
    const note = this._blankNote(wsId, opts);
    const latest = this.latestNote(wsId);
    if (latest) {
      note.todos = latest.todos
        .filter((t) => !t.done)
        .map((t) => ({ id: c.randomId(6), text: t.text, done: false, doneAt: null, sourceReminderId: t.sourceReminderId || null }));
      note.carryover = latest.carryover || '';
    }
    this._injectDueReminders(wsId, note);
    this._writeEnc(this._notePath(wsId, note.id), note);
    return note;
  }

  /**
   * Return the workspace's latest note, creating a first one if none exists,
   * and injecting any newly-due reminders as todos.
   */
  currentNote(wsId) {
    this._wsMeta(wsId);
    let note = this.latestNote(wsId);
    if (!note) {
      note = this._blankNote(wsId);
      this._injectDueReminders(wsId, note);
      this._writeEnc(this._notePath(wsId, note.id), note);
      return note;
    }
    const changed = this._injectDueReminders(wsId, note);
    if (changed) this._writeEnc(this._notePath(wsId, note.id), note);
    return note;
  }

  saveNote(noteId, patch) {
    const loc = this._locateNote(noteId, patch && patch.workspaceId);
    if (!loc) throw httpError(404, 'note not found');
    const note = loc.note;
    const allowed = ['title', 'customTitle', 'todos', 'carryover', 'meetingNotes', 'favorite', 'freeform'];
    for (const k of allowed) {
      if (patch[k] !== undefined) note[k] = patch[k];
    }
    // normalize todos: completed items sink to the bottom, preserving order
    if (Array.isArray(note.todos)) {
      note.todos = normalizeTodos(note.todos);
    }
    note.updatedAt = new Date().toISOString();
    this._writeEnc(loc.path, note);
    return note;
  }

  deleteNote(noteId) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    // remove attachment blobs owned by this note
    for (const a of loc.note.attachments || []) {
      const ap = this._attPath(loc.wsId, a.id);
      if (fs.existsSync(ap)) fs.rmSync(ap, { force: true });
    }
    fs.rmSync(loc.path, { force: true });
    return { ok: true };
  }

  setFavorite(noteId, favorite) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    loc.note.favorite = !!favorite;
    loc.note.updatedAt = new Date().toISOString();
    this._writeEnc(loc.path, loc.note);
    return loc.note;
  }

  listFavorites() {
    const out = [];
    for (const w of this._index().workspaces) {
      for (const f of this._listNoteFiles(w.id)) {
        const n = this._readEnc(path.join(this._notesDir(w.id), f));
        if (n.favorite) out.push(Object.assign(noteSummary(n), { workspaceName: w.name }));
      }
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  // ---- reminders ------------------------------------------------------

  listReminders(wsId) {
    return this._wsMeta(wsId).reminders || [];
  }

  addReminder(wsId, data) {
    const meta = this._wsMeta(wsId);
    const rem = {
      id: c.randomId(6),
      text: String(data.text || '').slice(0, 500),
      cadence: normalizeCadence(data.cadence),
      startDate: data.startDate || todayISO(),
      active: true,
      createdAt: new Date().toISOString(),
    };
    meta.reminders = meta.reminders || [];
    meta.reminders.push(rem);
    this._writeEnc(this._wsMetaPath(wsId), meta);
    return rem;
  }

  updateReminder(wsId, remId, patch) {
    const meta = this._wsMeta(wsId);
    const r = (meta.reminders || []).find((x) => x.id === remId);
    if (!r) throw httpError(404, 'reminder not found');
    if (patch.text !== undefined) r.text = String(patch.text).slice(0, 500);
    if (patch.cadence !== undefined) r.cadence = normalizeCadence(patch.cadence);
    if (patch.startDate !== undefined) r.startDate = patch.startDate;
    if (patch.active !== undefined) r.active = !!patch.active;
    this._writeEnc(this._wsMetaPath(wsId), meta);
    return r;
  }

  deleteReminder(wsId, remId) {
    const meta = this._wsMeta(wsId);
    meta.reminders = (meta.reminders || []).filter((x) => x.id !== remId);
    this._writeEnc(this._wsMetaPath(wsId), meta);
    return { ok: true };
  }

  /** Inject reminder occurrences due on/before today into the note's todos. */
  _injectDueReminders(wsId, note) {
    const meta = this._wsMeta(wsId);
    const today = todayISO();
    let changed = false;
    note.reminderOccurrences = note.reminderOccurrences || {};
    for (const r of meta.reminders || []) {
      if (!r.active) continue;
      const occ = dueOccurrenceKey(r, today);
      if (!occ) continue;
      const marker = r.id + ':' + occ;
      if (note.reminderOccurrences[marker]) continue;
      note.reminderOccurrences[marker] = true;
      note.todos = note.todos || [];
      note.todos.unshift({
        id: c.randomId(6),
        text: r.text,
        done: false,
        doneAt: null,
        sourceReminderId: r.id,
      });
      changed = true;
    }
    if (changed) note.todos = normalizeTodos(note.todos);
    return changed;
  }

  // ---- global todos ---------------------------------------------------

  /** Incomplete todos from the latest note of every workspace. */
  globalTodos() {
    const out = [];
    for (const w of this._index().workspaces) {
      const note = this.latestNote(w.id);
      if (!note) continue;
      for (const t of note.todos || []) {
        if (t.done) continue;
        out.push({
          todoId: t.id,
          text: t.text,
          noteId: note.id,
          noteTitle: displayTitle(note),
          workspaceId: w.id,
          workspaceName: w.name,
        });
      }
    }
    return out;
  }

  /** Toggle/update a single todo inside a specific note (used by global view). */
  toggleTodo(noteId, todoId, done) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    const t = (loc.note.todos || []).find((x) => x.id === todoId);
    if (!t) throw httpError(404, 'todo not found');
    t.done = !!done;
    t.doneAt = done ? new Date().toISOString() : null;
    loc.note.todos = normalizeTodos(loc.note.todos);
    loc.note.updatedAt = new Date().toISOString();
    this._writeEnc(loc.path, loc.note);
    return loc.note;
  }

  // ---- attachments ----------------------------------------------------

  addAttachment(noteId, { name, mime, dataB64 }) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    const raw = Buffer.from(dataB64, 'base64');
    const attId = c.randomId(10);
    fs.mkdirSync(this._attDir(loc.wsId), { recursive: true });
    fs.writeFileSync(this._attPath(loc.wsId, attId), c.encrypt(this.key, raw));
    const meta = {
      id: attId,
      name: String(name || 'file').slice(0, 200),
      mime: String(mime || 'application/octet-stream'),
      size: raw.length,
      createdAt: new Date().toISOString(),
    };
    loc.note.attachments = loc.note.attachments || [];
    loc.note.attachments.push(meta);
    loc.note.updatedAt = new Date().toISOString();
    this._writeEnc(loc.path, loc.note);
    return meta;
  }

  getAttachment(noteId, attId) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    const meta = (loc.note.attachments || []).find((a) => a.id === attId);
    if (!meta) throw httpError(404, 'attachment not found');
    const ap = this._attPath(loc.wsId, attId);
    if (!fs.existsSync(ap)) throw httpError(404, 'attachment blob missing');
    return { meta, data: c.decrypt(this.key, fs.readFileSync(ap)) };
  }

  deleteAttachment(noteId, attId) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    loc.note.attachments = (loc.note.attachments || []).filter((a) => a.id !== attId);
    const ap = this._attPath(loc.wsId, attId);
    if (fs.existsSync(ap)) fs.rmSync(ap, { force: true });
    loc.note.updatedAt = new Date().toISOString();
    this._writeEnc(loc.path, loc.note);
    return { ok: true };
  }

  // ---- search ---------------------------------------------------------

  search(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const results = [];
    for (const w of this._index().workspaces) {
      for (const f of this._listNoteFiles(w.id)) {
        const n = this._readEnc(path.join(this._notesDir(w.id), f));
        const hay = [
          displayTitle(n),
          ...(n.todos || []).map((t) => t.text),
          stripHtml(n.carryover),
          stripHtml(n.meetingNotes),
          ...((n.freeform || []).map((b) => stripHtml(b.html))),
        ].join('\n');
        const lc = hay.toLowerCase();
        const at = lc.indexOf(q);
        if (at >= 0) {
          results.push({
            noteId: n.id,
            workspaceId: w.id,
            workspaceName: w.name,
            title: displayTitle(n),
            createdAt: n.createdAt,
            snippet: makeSnippet(hay, at, q.length),
          });
        }
      }
    }
    results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return results;
  }

  // ---- export / import ------------------------------------------------

  exportNote(noteId, format) {
    const note = this.getNote(noteId);
    if (format === 'json') {
      return { mime: 'application/json', ext: 'json', body: Buffer.from(JSON.stringify(note, null, 2)) };
    }
    if (format === 'md' || format === 'markdown') {
      return { mime: 'text/markdown', ext: 'md', body: Buffer.from(noteToMarkdown(note)) };
    }
    // default: standalone HTML (also used as the print / PDF source)
    return { mime: 'text/html', ext: 'html', body: Buffer.from(noteToHtml(note)) };
  }

  importNote(wsId, { format, content, title }) {
    this._wsMeta(wsId);
    const note = this._blankNote(wsId, { customTitle: title || null });
    if (format === 'json') {
      let parsed;
      try { parsed = JSON.parse(content); } catch (_e) { throw httpError(400, 'invalid JSON'); }
      note.title = parsed.title || note.title;
      note.customTitle = parsed.customTitle || note.customTitle;
      note.todos = Array.isArray(parsed.todos)
        ? parsed.todos.map((t) => ({ id: c.randomId(6), text: String(t.text || ''), done: !!t.done, doneAt: t.doneAt || null, sourceReminderId: null }))
        : [];
      note.carryover = typeof parsed.carryover === 'string' ? parsed.carryover : '';
      note.meetingNotes = typeof parsed.meetingNotes === 'string' ? parsed.meetingNotes : '';
    } else if (format === 'md' || format === 'markdown') {
      note.meetingNotes = markdownToHtml(String(content || ''));
    } else {
      // html: put the (sanitized) body into meeting notes
      note.meetingNotes = sanitizeHtml(String(content || ''));
    }
    note.todos = normalizeTodos(note.todos);
    this._writeEnc(this._notePath(wsId, note.id), note);
    return note;
  }
}

// ---- pure helpers -----------------------------------------------------

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatDateTitle(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayISO() {
  const d = new Date();
  return formatDateTitle(d);
}

function displayTitle(note) {
  return note.customTitle ? `${note.title} — ${note.customTitle}` : note.title;
}

function noteSummary(n) {
  return {
    id: n.id,
    workspaceId: n.workspaceId,
    title: n.title,
    customTitle: n.customTitle,
    displayTitle: displayTitle(n),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    favorite: !!n.favorite,
    todoCount: (n.todos || []).length,
    openTodoCount: (n.todos || []).filter((t) => !t.done).length,
    attachmentCount: (n.attachments || []).length,
  };
}

function normalizeTodos(todos) {
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  return open.concat(done);
}

function normalizeCadence(cad) {
  cad = cad || {};
  const type = ['once', 'daily', 'weekly', 'monthly', 'everyNDays'].includes(cad.type) ? cad.type : 'once';
  const out = { type };
  if (type === 'everyNDays') out.n = Math.max(1, parseInt(cad.n, 10) || 1);
  if (type === 'once') out.dueDate = cad.dueDate || todayISO();
  return out;
}

function daysBetween(aISO, bISO) {
  const a = Date.parse(aISO + 'T00:00:00Z');
  const b = Date.parse(bISO + 'T00:00:00Z');
  return Math.floor((b - a) / 86400000);
}

/**
 * Return a stable occurrence key for the most recent occurrence of a reminder
 * on/before `today`, or null if none is due yet.
 */
function dueOccurrenceKey(rem, today) {
  const start = rem.startDate || today;
  const cad = rem.cadence || { type: 'once' };
  if (cad.type === 'once') {
    const due = cad.dueDate || start;
    return today >= due ? due : null;
  }
  if (start > today) return null;
  if (cad.type === 'daily') return today;
  if (cad.type === 'everyNDays') {
    const n = cad.n || 1;
    const diff = daysBetween(start, today);
    const k = Math.floor(diff / n);
    return `${start}+${k * n}`;
  }
  if (cad.type === 'weekly') {
    const diff = daysBetween(start, today);
    const k = Math.floor(diff / 7);
    return `${start}+${k * 7}`;
  }
  if (cad.type === 'monthly') {
    // occurrence keyed by year-month of today, only if past the anchor day
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ty, tm, td] = today.split('-').map(Number);
    const anchorDayReached = td >= sd || tm > sm || ty > sy; // simple guard
    if (ty === sy && tm === sm && td < sd) return null;
    void anchorDayReached;
    return `${ty}-${pad(tm)}`;
  }
  return null;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeSnippet(text, at, qlen) {
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + qlen + 40);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/**
 * Minimal HTML sanitizer for imported / rendered content. Removes script and
 * style elements, event-handler attributes, and javascript: URLs. This is a
 * defense-in-depth measure; note content is rendered only for the
 * authenticated owner.
 */
function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'");
}

function noteToHtml(note) {
  const todos = (note.todos || []).map((t) =>
    `<li class="${t.done ? 'done' : ''}">${t.done ? '☑' : '☐'} ${escapeHtml(t.text)}</li>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(displayTitle(note))}</title>
<style>
 body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#1f2430;}
 h1{font-size:22px;margin-bottom:2px;} .meta{color:#68707d;font-size:12px;margin-bottom:16px;}
 h2{font-size:15px;border-bottom:1px solid #e2e6ee;padding-bottom:4px;margin-top:24px;text-transform:uppercase;letter-spacing:.04em;color:#4a5568;}
 li.done{text-decoration:line-through;color:#98a0ad;} ul.todos{list-style:none;padding-left:0;}
 img{max-width:100%;} .section{margin-bottom:12px;}
</style></head><body>
<h1>${escapeHtml(displayTitle(note))}</h1>
<div class="meta">Created ${escapeHtml(note.createdAt)}</div>
<div class="section"><h2>To-Do</h2><ul class="todos">${todos || '<li>(none)</li>'}</ul></div>
<div class="section"><h2>Carryover Notes</h2><div>${sanitizeHtml(note.carryover) || '<em>(none)</em>'}</div></div>
<div class="section"><h2>Meeting Notes</h2><div>${sanitizeHtml(note.meetingNotes) || '<em>(none)</em>'}</div></div>
</body></html>`;
}

function noteToMarkdown(note) {
  const lines = [`# ${displayTitle(note)}`, '', `_Created ${note.createdAt}_`, '', '## To-Do', ''];
  for (const t of note.todos || []) lines.push(`- [${t.done ? 'x' : ' '}] ${t.text}`);
  lines.push('', '## Carryover Notes', '', stripHtml(note.carryover) || '(none)');
  lines.push('', '## Meeting Notes', '', stripHtml(note.meetingNotes) || '(none)');
  return lines.join('\n');
}

function markdownToHtml(md) {
  // Very small markdown → HTML: headings, bullet lists, bold/italic, paragraphs.
  const esc = escapeHtml(md);
  const blocks = esc.split(/\n{2,}/).map((block) => {
    if (/^#{1,6}\s/.test(block)) {
      const level = block.match(/^#+/)[0].length;
      return `<h${level}>${block.replace(/^#+\s/, '')}</h${level}>`;
    }
    if (/^\s*[-*]\s/m.test(block)) {
      const items = block.split(/\n/).filter(Boolean).map((l) => `<li>${l.replace(/^\s*[-*]\s/, '')}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  return blocks
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>');
}

module.exports = { Store, GENERAL_WORKSPACE, sanitizeHtml, displayTitle, dueOccurrenceKey };
