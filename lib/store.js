'use strict';

/*
 * File-based, encrypted data store.
 *
 * All persistent state lives under DATA_DIR, which can point at any folder —
 * including a Google Drive / Box / Dropbox sync folder — via the DATA_DIR
 * environment variable. Everything except the vault descriptor is encrypted
 * at rest with the DEK (see lib/crypto.js).
 *
 * Layout:
 *   DATA_DIR/
 *     vault.json                 plaintext key descriptor (wrapped DEK)
 *     index.json.enc             { workspaces, settings, templates }
 *     ws/<id>/workspace.json.enc { id, name, reminders, defaultTemplateId }
 *     ws/<id>/notes/<id>.json.enc
 *     ws/<id>/trash/<id>.json.enc soft-deleted notes (auto-purged after 30d)
 *     ws/<id>/att/<id>           encrypted attachment binary
 */

const fs = require('fs');
const path = require('path');
const c = require('./crypto');
const { zip } = require('./zip');
const viewer = require('./viewer');

const GENERAL_WORKSPACE = 'general';
const TRASH_TTL_DAYS = 30;
const MAX_VERSIONS = 20;
const VERSION_COALESCE_MS = 60 * 1000; // don't snapshot more than once a minute

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

  /**
   * Read an encrypted JSON file, returning null instead of throwing if the file
   * is corrupt or unreadable (e.g. a partial cloud-sync write or disk error).
   * Keeps the app usable when a single note is damaged; verifyIntegrity() finds
   * the culprit. Scanning loops use this and skip nulls.
   */
  _readEncSafe(file) {
    try { return this._readEnc(file); }
    catch (e) { console.error('skipping unreadable file:', file, '-', e.message); return null; }
  }

  _indexPath() { return path.join(this.dir, 'index.json.enc'); }
  _wsDir(id) { return path.join(this.dir, 'ws', id); }
  _wsMetaPath(id) { return path.join(this._wsDir(id), 'workspace.json.enc'); }
  _notesDir(id) { return path.join(this._wsDir(id), 'notes'); }
  _trashDir(id) { return path.join(this._wsDir(id), 'trash'); }
  _notePath(wsId, noteId) { return path.join(this._notesDir(wsId), noteId + '.json.enc'); }
  _trashPath(wsId, noteId) { return path.join(this._trashDir(wsId), noteId + '.json.enc'); }
  _attDir(wsId) { return path.join(this._wsDir(wsId), 'att'); }
  _attPath(wsId, attId) { return path.join(this._attDir(wsId), attId); }
  _historyDir(wsId, noteId) { return path.join(this._wsDir(wsId), 'history', noteId); }
  _searchIndexPath() { return path.join(this.dir, 'search.idx.enc'); }

  // ---- index / settings / templates -----------------------------------

  ensureInitialized() {
    if (!fs.existsSync(this._indexPath())) {
      const index = {
        workspaces: [],
        settings: {},
        templates: [],
      };
      this._writeEnc(this._indexPath(), index);
      this.createWorkspace('General', GENERAL_WORKSPACE);
    } else {
      // forward-compat: ensure new fields exist
      const idx = this._index();
      if (!idx.templates) { idx.templates = []; this._saveIndex(idx); }
    }
    this.purgeExpiredTrash();
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

  listTemplates() { return this._index().templates || []; }
  createTemplate(data) {
    const idx = this._index();
    const tpl = {
      id: c.randomId(6),
      name: String(data.name || 'Template').slice(0, 120),
      meetingNotes: typeof data.meetingNotes === 'string' ? data.meetingNotes : '',
      defaultTodos: Array.isArray(data.defaultTodos) ? data.defaultTodos.map((x) => String(x).slice(0, 500)) : [],
      defaultCarryover: typeof data.defaultCarryover === 'string' ? data.defaultCarryover : '',
      createdAt: new Date().toISOString(),
    };
    idx.templates = idx.templates || [];
    idx.templates.push(tpl);
    this._saveIndex(idx);
    return tpl;
  }
  updateTemplate(id, patch) {
    const idx = this._index();
    const tpl = (idx.templates || []).find((x) => x.id === id);
    if (!tpl) throw httpError(404, 'template not found');
    for (const k of ['name', 'meetingNotes', 'defaultCarryover']) if (patch[k] !== undefined) tpl[k] = String(patch[k]);
    if (patch.defaultTodos !== undefined) tpl.defaultTodos = (patch.defaultTodos || []).map((x) => String(x).slice(0, 500));
    this._saveIndex(idx);
    return tpl;
  }
  deleteTemplate(id) {
    const idx = this._index();
    idx.templates = (idx.templates || []).filter((x) => x.id !== id);
    this._saveIndex(idx);
    // detach from any workspace defaults
    for (const w of idx.workspaces) {
      try {
        const meta = this._wsMeta(w.id);
        if (meta.defaultTemplateId === id) { meta.defaultTemplateId = null; this._writeEnc(this._wsMetaPath(w.id), meta); }
      } catch (_e) { /* ignore */ }
    }
    return { ok: true };
  }
  _resolveTemplate(id) {
    if (!id) return null;
    return (this._index().templates || []).find((x) => x.id === id) || null;
  }

  // ---- workspaces -----------------------------------------------------

  listWorkspaces() {
    return this._index().workspaces.slice().sort((a, b) => {
      if (a.id === GENERAL_WORKSPACE) return -1;
      if (b.id === GENERAL_WORKSPACE) return 1;
      return a.createdAt < b.createdAt ? -1 : 1;
    }).map((w) => {
      let defaultTemplateId = null;
      try { defaultTemplateId = this._wsMeta(w.id).defaultTemplateId || null; } catch (_e) { /* ignore */ }
      return Object.assign({}, w, { defaultTemplateId });
    });
  }

  createWorkspace(name, forcedId) {
    const idx = this._index();
    const id = forcedId || c.randomId(8);
    if (idx.workspaces.some((w) => w.id === id)) throw httpError(409, 'workspace exists');
    const entry = { id, name: String(name || 'Untitled').slice(0, 120), createdAt: new Date().toISOString() };
    idx.workspaces.push(entry);
    this._saveIndex(idx);
    this._writeEnc(this._wsMetaPath(id), { id, name: entry.name, reminders: [], defaultTemplateId: null });
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

  setWorkspaceTemplate(id, templateId) {
    const meta = this._wsMeta(id);
    meta.defaultTemplateId = templateId || null;
    this._writeEnc(this._wsMetaPath(id), meta);
    return { ok: true, defaultTemplateId: meta.defaultTemplateId };
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

  listNotes(wsId, opts = {}) {
    this._wsMeta(wsId);
    let notes = this._listNoteFiles(wsId).map((f) => this._readEncSafe(path.join(this._notesDir(wsId), f))).filter(Boolean);
    notes.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
    if (opts.sort === 'open') notes.sort((a, b) => (b.todos || []).filter((t) => !t.done).length - (a.todos || []).filter((t) => !t.done).length);
    return notes.map(noteSummary);
  }

  latestNote(wsId) {
    const files = this._listNoteFiles(wsId);
    let latest = null;
    for (const f of files) {
      const n = this._readEncSafe(path.join(this._notesDir(wsId), f));
      if (n && (!latest || n.createdAt > latest.createdAt)) latest = n;
    }
    return latest;
  }

  /**
   * The most recent DAILY note (skips scratch notes). This is the running
   * thread that to-dos, carryover, and reminders key off — scratch notes are
   * side jottings that never affect it. Legacy notes without a `kind` count
   * as daily.
   */
  latestDailyNote(wsId) {
    const files = this._listNoteFiles(wsId);
    let latest = null;
    for (const f of files) {
      const n = this._readEncSafe(path.join(this._notesDir(wsId), f));
      if (n && n.kind !== 'scratch' && (!latest || n.createdAt > latest.createdAt)) latest = n;
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
      rev: 0, // bumps only on user content changes; used for conflict detection
      kind: opts.kind || 'daily', // 'daily' (carries forward) | 'scratch' (meeting notes only)
      favorite: false,
      tags: [],
      todos: [],
      carryover: '',
      meetingNotes: '',
      transcript: [], // [{ t, source:'you'|'them', text }]
      attachments: [],
      reminderOccurrences: {},
    };
  }

  /**
   * Create a new note.
   *
   * A SCRATCH note (opts.scratch) is a clean Meeting Notes page only — no
   * carry-forward, no template, no reminders — and it never affects the daily
   * carryover thread.
   *
   * A DAILY note (the default) carries incomplete manual todos + carryover
   * forward from the most recent DAILY note (meeting notes do not carry). A
   * template — passed explicitly or set as the workspace default — then seeds
   * the Meeting Notes section, filling To-Do / Carryover only when carry-forward
   * left them empty. Finally, due reminders are injected as todos.
   */
  createNote(wsId, opts = {}) {
    const meta = this._wsMeta(wsId);
    if (opts.scratch) {
      const scratch = this._blankNote(wsId, Object.assign({}, opts, { kind: 'scratch' }));
      this._writeEnc(this._notePath(wsId, scratch.id), scratch);
      this._indexUpsert(scratch);
      return scratch;
    }
    const note = this._blankNote(wsId, Object.assign({}, opts, { kind: 'daily' }));
    const latest = this.latestDailyNote(wsId);
    if (latest) {
      // Carry forward only manual open todos. Reminder-sourced items are NOT
      // carried — the reminder engine re-injects them if still due, so carrying
      // them too would create duplicates.
      note.todos = (latest.todos || [])
        .filter((t) => !t.done && !t.sourceReminderId)
        .map((t) => ({ id: c.randomId(6), text: t.text, done: false, doneAt: null, due: t.due || null, sourceReminderId: null }));
      note.carryover = latest.carryover || '';
    }
    const tpl = this._resolveTemplate(opts.templateId || meta.defaultTemplateId);
    if (tpl) {
      note.meetingNotes = tpl.meetingNotes || '';
      if ((!note.todos || note.todos.length === 0) && (tpl.defaultTodos || []).length) {
        note.todos = tpl.defaultTodos.map((text) => ({ id: c.randomId(6), text, done: false, doneAt: null, due: null, sourceReminderId: null }));
      }
      if ((!note.carryover || note.carryover.trim() === '') && tpl.defaultCarryover) {
        note.carryover = tpl.defaultCarryover;
      }
    }
    this._injectDueReminders(wsId, note, new Date());
    this._writeEnc(this._notePath(wsId, note.id), note);
    this._indexUpsert(note);
    return note;
  }

  /**
   * The note to show when opening a workspace: the most recent note, or null if
   * the workspace is empty (the client then shows a landing page instead of an
   * auto-created note). Due reminders are injected into the latest daily note.
   */
  currentNote(wsId) {
    this._wsMeta(wsId);
    const note = this.latestNote(wsId);
    if (!note) return null;
    if (note.kind !== 'scratch') {
      const changed = this._injectDueReminders(wsId, note, new Date());
      if (changed) { this._writeEnc(this._notePath(wsId, note.id), note); this._indexUpsert(note); }
    }
    return note;
  }

  saveNote(noteId, patch) {
    const loc = this._locateNote(noteId, patch && patch.workspaceId);
    if (!loc) throw httpError(404, 'note not found');
    const note = loc.note;
    // Optimistic-concurrency guard for cloud-sync / multi-tab safety. Compares a
    // content revision that only advances on real content edits — so background
    // housekeeping (reminder injection, favoriting) never triggers a false
    // conflict, while a genuine edit from another tab/device still does.
    if (patch.baseRev != null && note.rev != null && patch.baseRev !== note.rev) {
      throw httpError(409, 'note changed elsewhere', { current: note });
    }
    this._snapshotVersion(loc.wsId, note); // history (coalesced)
    const allowed = ['title', 'customTitle', 'todos', 'carryover', 'meetingNotes', 'favorite', 'tags', 'transcript'];
    for (const k of allowed) {
      if (patch[k] !== undefined) note[k] = patch[k];
    }
    if (Array.isArray(note.todos)) note.todos = normalizeTodos(note.todos);
    if (Array.isArray(note.tags)) note.tags = note.tags.map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 30);
    note.updatedAt = new Date().toISOString();
    note.rev = (note.rev || 0) + 1;
    this._writeEnc(loc.path, note);
    this._indexUpsert(note);
    return note;
  }

  /** Create a sibling note holding the given content (used for "keep both" on a save conflict). */
  forkNote(noteId, patch) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    const note = this._blankNote(loc.wsId, { kind: loc.note.kind || 'daily', customTitle: (patch.customTitle || loc.note.customTitle || 'Note') + ' (conflict copy)' });
    ['todos', 'carryover', 'meetingNotes', 'tags'].forEach((k) => { if (patch[k] !== undefined) note[k] = patch[k]; });
    if (Array.isArray(note.todos)) note.todos = normalizeTodos(note.todos);
    this._writeEnc(this._notePath(loc.wsId, note.id), note);
    this._indexUpsert(note);
    return note;
  }

  // ---- trash (soft delete) --------------------------------------------

  deleteNote(noteId) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    loc.note.deletedAt = new Date().toISOString();
    fs.mkdirSync(this._trashDir(loc.wsId), { recursive: true });
    this._writeEnc(this._trashPath(loc.wsId, noteId), loc.note);
    fs.rmSync(loc.path, { force: true }); // attachment blobs stay until purge
    this._indexRemove(noteId);
    return { ok: true, trashed: true };
  }

  _listTrashFiles(wsId) {
    const dir = this._trashDir(wsId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json.enc'));
  }

  listTrash() {
    const out = [];
    for (const w of this._index().workspaces) {
      for (const f of this._listTrashFiles(w.id)) {
        const n = this._readEncSafe(path.join(this._trashDir(w.id), f));
        if (n) out.push(Object.assign(noteSummary(n), { workspaceName: w.name, deletedAt: n.deletedAt }));
      }
    }
    out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
    return out;
  }

  restoreNote(noteId) {
    for (const w of this._index().workspaces) {
      const tp = this._trashPath(w.id, noteId);
      if (fs.existsSync(tp)) {
        const note = this._readEnc(tp);
        delete note.deletedAt;
        note.updatedAt = new Date().toISOString();
        this._writeEnc(this._notePath(w.id, noteId), note);
        fs.rmSync(tp, { force: true });
        this._indexUpsert(note);
        return note;
      }
    }
    throw httpError(404, 'note not in trash');
  }

  purgeNote(noteId) {
    for (const w of this._index().workspaces) {
      const tp = this._trashPath(w.id, noteId);
      if (fs.existsSync(tp)) {
        const note = this._readEnc(tp);
        for (const a of note.attachments || []) {
          const ap = this._attPath(w.id, a.id);
          if (fs.existsSync(ap)) fs.rmSync(ap, { force: true });
        }
        fs.rmSync(tp, { force: true });
        return { ok: true };
      }
    }
    throw httpError(404, 'note not in trash');
  }

  purgeExpiredTrash() {
    const cutoff = Date.now() - TRASH_TTL_DAYS * 86400000;
    for (const w of this._index().workspaces) {
      for (const f of this._listTrashFiles(w.id)) {
        try {
          const n = this._readEnc(path.join(this._trashDir(w.id), f));
          if (n.deletedAt && Date.parse(n.deletedAt) < cutoff) this.purgeNote(n.id);
        } catch (_e) { /* ignore unreadable trash entry */ }
      }
    }
  }

  // ---- move / copy ----------------------------------------------------

  moveNote(noteId, targetWsId) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    this._wsMeta(targetWsId);
    if (loc.wsId === targetWsId) return loc.note;
    const note = loc.note;
    note.workspaceId = targetWsId;
    note.updatedAt = new Date().toISOString();
    this._writeEnc(this._notePath(targetWsId, noteId), note);
    // move attachment blobs
    for (const a of note.attachments || []) {
      const from = this._attPath(loc.wsId, a.id);
      const to = this._attPath(targetWsId, a.id);
      if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); }
    }
    fs.rmSync(loc.path, { force: true });
    this._indexUpsert(note);
    return note;
  }

  copyNote(noteId, targetWsId) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    const dest = targetWsId || loc.wsId;
    this._wsMeta(dest);
    const src = loc.note;
    const copy = this._blankNote(dest, { kind: src.kind || 'daily', customTitle: (src.customTitle ? src.customTitle + ' (copy)' : 'Copy') });
    copy.tags = (src.tags || []).slice();
    copy.carryover = src.carryover || '';
    copy.meetingNotes = src.meetingNotes || '';
    copy.todos = (src.todos || []).map((t) => ({ id: c.randomId(6), text: t.text, done: t.done, doneAt: t.doneAt || null, due: t.due || null, sourceReminderId: null }));
    // copy attachment blobs under new ids
    copy.attachments = [];
    for (const a of src.attachments || []) {
      const from = this._attPath(loc.wsId, a.id);
      if (!fs.existsSync(from)) continue;
      const newId = c.randomId(10);
      fs.mkdirSync(this._attDir(dest), { recursive: true });
      fs.copyFileSync(from, this._attPath(dest, newId));
      copy.attachments.push(Object.assign({}, a, { id: newId }));
    }
    this._writeEnc(this._notePath(dest, copy.id), copy);
    this._indexUpsert(copy);
    return copy;
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
        const n = this._readEncSafe(path.join(this._notesDir(w.id), f));
        if (n && n.favorite) out.push(Object.assign(noteSummary(n), { workspaceName: w.name }));
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
      time: normalizeTime(data.time),
      startDate: data.startDate || todayISO(),
      snoozedUntil: null,
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
    if (patch.time !== undefined) r.time = normalizeTime(patch.time);
    if (patch.startDate !== undefined) r.startDate = patch.startDate;
    if (patch.active !== undefined) r.active = !!patch.active;
    if (patch.snoozedUntil !== undefined) r.snoozedUntil = patch.snoozedUntil;
    this._writeEnc(this._wsMetaPath(wsId), meta);
    return r;
  }

  /** Snooze a reminder until a given ISO time; pulls its current occurrence
   *  from the latest note so it re-surfaces cleanly once the snooze passes. */
  snoozeReminder(wsId, remId, untilISO) {
    const r = this.updateReminder(wsId, remId, { snoozedUntil: untilISO || null });
    const note = this.latestNote(wsId);
    if (note) {
      let changed = false;
      const before = (note.todos || []).length;
      note.todos = (note.todos || []).filter((t) => !(t.sourceReminderId === remId && !t.done));
      if (note.todos.length !== before) changed = true;
      for (const k of Object.keys(note.reminderOccurrences || {})) {
        if (k.startsWith(remId + ':')) { delete note.reminderOccurrences[k]; changed = true; }
      }
      if (changed) { this._writeEnc(this._notePath(wsId, note.id), note); this._indexUpsert(note); }
    }
    return r;
  }

  deleteReminder(wsId, remId) {
    const meta = this._wsMeta(wsId);
    meta.reminders = (meta.reminders || []).filter((x) => x.id !== remId);
    this._writeEnc(this._wsMetaPath(wsId), meta);
    return { ok: true };
  }

  _injectDueReminders(wsId, note, now) {
    const meta = this._wsMeta(wsId);
    const today = formatDateTitle(now);
    let changed = false;
    note.reminderOccurrences = note.reminderOccurrences || {};
    for (const r of meta.reminders || []) {
      if (!r.active) continue;
      if (r.snoozedUntil && now.toISOString() < r.snoozedUntil) continue; // snoozed
      const occ = dueOccurrenceKey(r, today, now);
      if (!occ) continue;
      const marker = r.id + ':' + occ;
      if (note.reminderOccurrences[marker]) continue;
      note.reminderOccurrences[marker] = true;
      note.todos = note.todos || [];
      note.todos.unshift({ id: c.randomId(6), text: r.text, done: false, doneAt: null, due: null, sourceReminderId: r.id });
      changed = true;
    }
    if (changed) note.todos = normalizeTodos(note.todos);
    return changed;
  }

  /**
   * Inject due reminders into every workspace's latest note. Returns the list
   * of newly-surfaced reminders so the client can raise notifications even for
   * workspaces the user is not currently viewing.
   */
  processReminders() {
    const now = new Date();
    const surfaced = [];
    for (const w of this._index().workspaces) {
      let note = this.latestDailyNote(w.id);
      if (!note) continue;
      const before = new Set(Object.keys(note.reminderOccurrences || {}));
      const changed = this._injectDueReminders(w.id, note, now);
      if (changed) {
        this._writeEnc(this._notePath(w.id, note.id), note);
        this._indexUpsert(note);
        for (const marker of Object.keys(note.reminderOccurrences)) {
          if (before.has(marker)) continue;
          const remId = marker.split(':')[0];
          const rem = (this._wsMeta(w.id).reminders || []).find((x) => x.id === remId);
          if (rem) surfaced.push({ workspaceId: w.id, workspaceName: w.name, noteId: note.id, text: rem.text });
        }
      }
    }
    return surfaced;
  }

  // ---- global todos ---------------------------------------------------

  globalTodos() {
    const out = [];
    for (const w of this._index().workspaces) {
      const note = this.latestDailyNote(w.id);
      if (!note) continue;
      for (const t of note.todos || []) {
        if (t.done) continue;
        out.push({
          todoId: t.id,
          text: t.text,
          due: t.due || null,
          noteId: note.id,
          noteTitle: displayTitle(note),
          workspaceId: w.id,
          workspaceName: w.name,
        });
      }
    }
    out.sort((a, b) => {
      if (a.due && b.due) return a.due < b.due ? -1 : 1;
      if (a.due) return -1;
      if (b.due) return 1;
      return 0;
    });
    return out;
  }

  toggleTodo(noteId, todoId, done) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    const t = (loc.note.todos || []).find((x) => x.id === todoId);
    if (!t) throw httpError(404, 'todo not found');
    t.done = !!done;
    t.doneAt = done ? new Date().toISOString() : null;
    loc.note.todos = normalizeTodos(loc.note.todos);
    loc.note.updatedAt = new Date().toISOString();
    loc.note.rev = (loc.note.rev || 0) + 1;
    this._writeEnc(loc.path, loc.note);
    this._indexUpsert(loc.note);
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

  // ---- version history ------------------------------------------------

  /** Snapshot the pre-change state of a note, coalescing rapid autosaves. */
  _snapshotVersion(wsId, note) {
    try {
      const dir = this._historyDir(wsId, note.id);
      fs.mkdirSync(dir, { recursive: true });
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json.enc')).sort();
      const last = files[files.length - 1];
      if (last) {
        const lastTs = parseInt(last.split('.')[0], 10);
        if (Date.now() - lastTs < VERSION_COALESCE_MS) return; // too soon; skip
      }
      this._writeEnc(path.join(dir, Date.now() + '.json.enc'), note);
      const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json.enc')).sort();
      while (all.length > MAX_VERSIONS) fs.rmSync(path.join(dir, all.shift()), { force: true });
    } catch (_e) { /* history is best-effort */ }
  }

  listVersions(noteId) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    const dir = this._historyDir(loc.wsId, noteId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json.enc')).map((f) => {
      const ts = parseInt(f.split('.')[0], 10);
      const v = this._readEnc(path.join(dir, f));
      return { ts, savedAt: new Date(ts).toISOString(), title: displayTitle(v) };
    }).sort((a, b) => b.ts - a.ts);
  }

  getVersion(noteId, ts) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    const p = path.join(this._historyDir(loc.wsId, noteId), ts + '.json.enc');
    if (!fs.existsSync(p)) throw httpError(404, 'version not found');
    return this._readEnc(p);
  }

  restoreVersion(noteId, ts) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    const v = this.getVersion(noteId, ts);
    this._snapshotVersion(loc.wsId, loc.note); // preserve current before overwrite
    const note = loc.note;
    ['title', 'customTitle', 'todos', 'carryover', 'meetingNotes', 'tags'].forEach((k) => { if (v[k] !== undefined) note[k] = v[k]; });
    note.updatedAt = new Date().toISOString();
    note.rev = (note.rev || 0) + 1;
    this._writeEnc(loc.path, note);
    this._indexUpsert(note);
    return note;
  }

  // ---- backlinks ------------------------------------------------------

  backlinks(noteId) {
    const out = [];
    const needle = 'data-note-id="' + noteId + '"';
    for (const w of this._index().workspaces) {
      for (const f of this._listNoteFiles(w.id)) {
        const n = this._readEncSafe(path.join(this._notesDir(w.id), f));
        if (!n || n.id === noteId) continue;
        if ((n.carryover || '').includes(needle) || (n.meetingNotes || '').includes(needle)) {
          out.push(Object.assign(noteSummary(n), { workspaceName: w.name }));
        }
      }
    }
    return out;
  }

  // ---- search (encrypted index) --------------------------------------

  _readIndex() {
    if (!fs.existsSync(this._searchIndexPath())) return this._rebuildIndex();
    try { return this._readEnc(this._searchIndexPath()); }
    catch (_e) { return this._rebuildIndex(); }
  }
  _writeIndex(idx) { this._writeEnc(this._searchIndexPath(), idx); }

  _rebuildIndex() {
    const idx = { notes: {} };
    for (const w of this._index().workspaces) {
      for (const f of this._listNoteFiles(w.id)) {
        const n = this._readEncSafe(path.join(this._notesDir(w.id), f));
        if (n) idx.notes[n.id] = indexEntry(n, w);
      }
    }
    this._writeIndex(idx);
    return idx;
  }

  _indexUpsert(note) {
    const idx = this._readIndex();
    const w = this._index().workspaces.find((x) => x.id === note.workspaceId) || { id: note.workspaceId, name: '' };
    idx.notes[note.id] = indexEntry(note, w);
    this._writeIndex(idx);
  }
  _indexRemove(noteId) {
    const idx = this._readIndex();
    if (idx.notes[noteId]) { delete idx.notes[noteId]; this._writeIndex(idx); }
  }

  search(query) {
    let q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    let tagFilter = null;
    q = q.replace(/tag:(\S+)/g, (_m, t) => { tagFilter = t.toLowerCase(); return ''; }).trim();
    const idx = this._readIndex();
    const results = [];
    for (const id of Object.keys(idx.notes)) {
      const e = idx.notes[id];
      if (tagFilter && !(e.tags || []).some((t) => t.toLowerCase() === tagFilter)) continue;
      const lc = e.text.toLowerCase();
      const at = q ? lc.indexOf(q) : 0;
      if (q === '' || at >= 0) {
        // rank: title hits and tag hits rank above body-only hits.
        const titleHit = q && e.title.toLowerCase().indexOf(q) >= 0;
        const tagHit = q && (e.tags || []).some((t) => t.toLowerCase().indexOf(q) >= 0);
        results.push({
          noteId: id, workspaceId: e.wsId, workspaceName: e.wsName, title: e.title,
          tags: e.tags || [], createdAt: e.createdAt, query: q,
          score: (titleHit ? 2 : 0) + (tagHit ? 1 : 0),
          snippet: q ? makeSnippet(e.text, at, q.length) : e.text.slice(0, 120),
        });
      }
    }
    results.sort((a, b) => (b.score - a.score) || (a.createdAt < b.createdAt ? 1 : -1));
    return results;
  }

  /** Aggregate footprint + counts for the vault (for the size indicator). */
  stats() {
    let notes = 0, attachments = 0, bytes = 0;
    const sep = path.sep;
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (p.endsWith('.tmp')) continue;
        const inAtt = p.indexOf(sep + 'att' + sep) >= 0;                 // encrypted attachment blob
        const inNotes = p.indexOf(sep + 'notes' + sep) >= 0 && p.endsWith('.json.enc');
        if (p.endsWith('.enc') || e.name === 'vault.json' || inAtt) { try { bytes += fs.statSync(p).size; } catch (_e) { /* ignore */ } }
        if (inNotes) notes++;
        else if (inAtt) attachments++;
      }
    };
    walk(this.dir);
    return { workspaces: this._index().workspaces.length, notes, attachments, bytes };
  }

  // ---- export / import ------------------------------------------------

  exportNote(noteId, format) {
    const note = this.getNote(noteId);
    if (format === 'json') return { mime: 'application/json', ext: 'json', body: Buffer.from(JSON.stringify(note, null, 2)) };
    if (format === 'md' || format === 'markdown') return { mime: 'text/markdown', ext: 'md', body: Buffer.from(noteToMarkdown(note)) };
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
      note.tags = Array.isArray(parsed.tags) ? parsed.tags.map((x) => String(x).slice(0, 40)) : [];
      note.todos = Array.isArray(parsed.todos)
        ? parsed.todos.map((t) => ({ id: c.randomId(6), text: String(t.text || ''), done: !!t.done, doneAt: t.doneAt || null, due: t.due || null, sourceReminderId: null }))
        : [];
      note.carryover = typeof parsed.carryover === 'string' ? parsed.carryover : '';
      note.meetingNotes = typeof parsed.meetingNotes === 'string' ? parsed.meetingNotes : '';
    } else if (format === 'md' || format === 'markdown') {
      note.meetingNotes = markdownToHtml(String(content || ''));
    } else {
      note.meetingNotes = sanitizeHtml(String(content || ''));
    }
    note.todos = normalizeTodos(note.todos);
    this._writeEnc(this._notePath(wsId, note.id), note);
    this._indexUpsert(note);
    return note;
  }

  // ---- offline viewer -------------------------------------------------

  /** Collect data for the standalone viewer, enriched with image attachments
   *  (which need the key to identify). All embedded blobs stay ciphertext. */
  buildViewerData() {
    const data = viewer.collectData(this.dir);
    for (const w of this._index().workspaces) {
      for (const f of this._listNoteFiles(w.id)) {
        const n = this._readEncSafe(path.join(this._notesDir(w.id), f));
        if (!n) continue;
        for (const a of n.attachments || []) {
          if ((a.mime || '').indexOf('image/') !== 0) continue;
          const ap = this._attPath(w.id, a.id);
          if (fs.existsSync(ap)) data.images[n.id + '/' + a.id] = { mime: a.mime, b64: fs.readFileSync(ap).toString('base64') };
        }
      }
    }
    return data;
  }

  // ---- integrity check ------------------------------------------------

  /**
   * Decrypt-check every encrypted file under the data directory. Reports any
   * that fail to decrypt/parse (corruption, truncation, wrong key). Read-only.
   */
  verifyIntegrity() {
    const corrupt = [];
    let checked = 0;
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.enc')) continue;
        checked++;
        try {
          const buf = c.decrypt(this.key, fs.readFileSync(p));
          if (p.endsWith('.json.enc')) JSON.parse(buf.toString('utf8'));
        } catch (err) {
          corrupt.push({ path: path.relative(this.dir, p), error: err.message });
        }
      }
    };
    walk(this.dir);
    return { checked, ok: corrupt.length === 0, corrupt };
  }

  // ---- bulk export ----------------------------------------------------

  /** Export an entire workspace as a single ZIP archive of per-note files. */
  exportWorkspaceZip(wsId, format) {
    const meta = this._wsMeta(wsId);
    const fmt = ['html', 'md', 'json'].includes(format) ? format : 'html';
    const files = [];
    const seen = {};
    for (const f of this._listNoteFiles(wsId)) {
      const n = this._readEnc(path.join(this._notesDir(wsId), f));
      const out = this.exportNote(n.id, fmt);
      let base = (displayTitle(n) || n.id).replace(/[^\w.\- ]+/g, '_').slice(0, 80);
      if (seen[base]) base += '-' + n.id.slice(0, 4);
      seen[base] = true;
      files.push({ name: base + '.' + out.ext, data: out.body });
    }
    const safeWs = (meta.name || 'workspace').replace(/[^\w.\- ]+/g, '_');
    return { mime: 'application/zip', ext: 'zip', filename: safeWs + '-' + fmt, body: zip(files) };
  }
}

// ---- full encrypted backup / restore (vault-level, no key needed) -----

function walkFiles(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

/** Bundle vault.json + every encrypted file into one portable JSON archive. */
function exportBundle(dataDir) {
  const files = {};
  for (const rel of walkFiles(dataDir, dataDir, [])) {
    if (rel.endsWith('.tmp')) continue;
    if (rel !== 'vault.json' && !rel.endsWith('.enc')) continue;
    files[rel.split(path.sep).join('/')] = fs.readFileSync(path.join(dataDir, rel)).toString('base64');
  }
  return { format: 'meeting-notes-backup', version: 1, createdAt: new Date().toISOString(), files };
}

/** Restore a bundle into an EMPTY data directory (fresh machine bootstrap). */
function restoreBundle(dataDir, bundle) {
  if (!bundle || bundle.format !== 'meeting-notes-backup' || !bundle.files) {
    throw httpError(400, 'not a valid backup bundle');
  }
  for (const rel of Object.keys(bundle.files)) {
    if (rel.includes('..') || path.isAbsolute(rel)) throw httpError(400, 'unsafe path in bundle');
    const dest = path.join(dataDir, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(bundle.files[rel], 'base64'));
  }
  return { ok: true, restored: Object.keys(bundle.files).length };
}

/**
 * Migrate a v1 vault (passphrase-derived key used directly) to v2 envelope
 * encryption by re-encrypting all data under a fresh DEK. Returns the new DEK
 * and the one-time recovery key. Callers persist the returned vault.
 */
function migrateVaultV1(dataDir, v1vault, passphrase) {
  const oldKey = c.unlockVault(v1vault, passphrase);
  if (!oldKey) return null;
  const dek = require('crypto').randomBytes(c.KEY_LEN);
  for (const rel of walkFiles(dataDir, dataDir, [])) {
    if (!rel.endsWith('.enc')) continue;
    const p = path.join(dataDir, rel);
    const plain = c.decrypt(oldKey, fs.readFileSync(p));
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, c.encrypt(dek, plain));
    fs.renameSync(tmp, p);
  }
  const built = c.createVault(passphrase); // fresh slots...
  // ...but wrap the SAME dek we just re-encrypted with
  const vault = c.rewrapPassphrase(built.vault, dek, passphrase);
  const rot = c.rotateRecovery(vault, dek);
  return { dek, vault: rot.vault, recoveryKey: rot.recoveryKey };
}

// ---- pure helpers -----------------------------------------------------

function httpError(status, msg, extra) {
  const e = new Error(msg);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function pad(n) { return String(n).padStart(2, '0'); }
function formatDateTitle(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayISO() { return formatDateTitle(new Date()); }
function displayTitle(note) { return note.customTitle ? `${note.title} — ${note.customTitle}` : note.title; }

function noteSummary(n) {
  return {
    id: n.id,
    workspaceId: n.workspaceId,
    title: n.title,
    customTitle: n.customTitle,
    displayTitle: displayTitle(n),
    kind: n.kind || 'daily',
    tags: n.tags || [],
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    favorite: !!n.favorite,
    todoCount: (n.todos || []).length,
    openTodoCount: (n.todos || []).filter((t) => !t.done).length,
    attachmentCount: (n.attachments || []).length,
  };
}

function noteSearchText(n) {
  return [
    displayTitle(n),
    (n.tags || []).join(' '),
    ...(n.todos || []).map((t) => t.text),
    stripHtml(n.carryover),
    stripHtml(n.meetingNotes),
  ].join('\n');
}

function indexEntry(n, w) {
  return {
    wsId: w.id,
    wsName: w.name,
    title: displayTitle(n),
    tags: n.tags || [],
    createdAt: n.createdAt,
    text: noteSearchText(n),
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
  if (type !== 'once' && cad.endDate) out.endDate = cad.endDate; // optional recurrence end
  return out;
}

function normalizeTime(t) {
  if (!t) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t).trim());
  return m ? `${pad(m[1])}:${m[2]}` : null;
}

function daysBetween(aISO, bISO) {
  const a = Date.parse(aISO + 'T00:00:00Z');
  const b = Date.parse(bISO + 'T00:00:00Z');
  return Math.floor((b - a) / 86400000);
}

/**
 * The occurrence key of the most recent occurrence of a reminder on/before
 * `today`, or null if none is due yet. When the reminder has a time-of-day and
 * the occurrence is today, it is only due once the wall clock passes that time.
 */
function dueOccurrenceKey(rem, today, now) {
  const start = rem.startDate || today;
  const cad = rem.cadence || { type: 'once' };
  const notYetToday = (occurDate) => {
    if (!rem.time || occurDate !== today) return false;
    const cur = pad(now.getHours()) + ':' + pad(now.getMinutes());
    return cur < rem.time;
  };
  if (cad.type === 'once') {
    const due = cad.dueDate || start;
    if (today < due) return null;
    if (notYetToday(due)) return null;
    return due;
  }
  if (start > today) return null;
  const past = (d) => cad.endDate && d > cad.endDate; // past the recurrence end
  if (cad.type === 'daily') { if (past(today) || notYetToday(today)) return null; return today; }
  if (cad.type === 'everyNDays' || cad.type === 'weekly') {
    const n = cad.type === 'weekly' ? 7 : (cad.n || 1);
    const diff = daysBetween(start, today);
    const k = Math.floor(diff / n);
    const occurDate = addDays(start, k * n);
    if (past(occurDate) || notYetToday(occurDate)) return null;
    return `${start}+${k * n}`;
  }
  if (cad.type === 'monthly') {
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ty, tm, td] = today.split('-').map(Number);
    if (ty === sy && tm === sm && td < sd) return null;
    if (td === sd && notYetToday(today)) return null;
    if (past(`${ty}-${pad(tm)}-${pad(sd)}`)) return null;
    return `${ty}-${pad(tm)}`;
  }
  return null;
}

function addDays(iso, days) {
  const d = new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function makeSnippet(text, at, qlen) {
  if (at < 0) return text.slice(0, 80);
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + qlen + 40);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

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
    `<li class="${t.done ? 'done' : ''}">${t.done ? '☑' : '☐'} ${escapeHtml(t.text)}${t.due ? ' <small>(due ' + escapeHtml(t.due) + ')</small>' : ''}</li>`).join('');
  const tags = (note.tags || []).length ? `<div class="tags">${note.tags.map((x) => '#' + escapeHtml(x)).join(' ')}</div>` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(displayTitle(note))}</title>
<style>
 body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#1f2430;}
 h1{font-size:22px;margin-bottom:2px;} .meta{color:#68707d;font-size:12px;margin-bottom:16px;}
 h2{font-size:15px;border-bottom:1px solid #e2e6ee;padding-bottom:4px;margin-top:24px;text-transform:uppercase;letter-spacing:.04em;color:#4a5568;}
 li.done{text-decoration:line-through;color:#98a0ad;} ul.todos{list-style:none;padding-left:0;}
 .tags{color:#3b6cf6;font-size:12px;margin-bottom:12px;} img{max-width:100%;} .section{margin-bottom:12px;}
</style></head><body>
<h1>${escapeHtml(displayTitle(note))}</h1>
<div class="meta">Created ${escapeHtml(note.createdAt)}</div>
${tags}
<div class="section"><h2>To-Do</h2><ul class="todos">${todos || '<li>(none)</li>'}</ul></div>
<div class="section"><h2>Carryover Notes</h2><div>${sanitizeHtml(note.carryover) || '<em>(none)</em>'}</div></div>
<div class="section"><h2>Meeting Notes</h2><div>${sanitizeHtml(note.meetingNotes) || '<em>(none)</em>'}</div></div>
</body></html>`;
}

function noteToMarkdown(note) {
  const lines = [`# ${displayTitle(note)}`, '', `_Created ${note.createdAt}_`, ''];
  if ((note.tags || []).length) lines.push(note.tags.map((x) => '#' + x).join(' '), '');
  lines.push('## To-Do', '');
  for (const t of note.todos || []) lines.push(`- [${t.done ? 'x' : ' '}] ${t.text}${t.due ? ' (due ' + t.due + ')' : ''}`);
  lines.push('', '## Carryover Notes', '', stripHtml(note.carryover) || '(none)');
  lines.push('', '## Meeting Notes', '', stripHtml(note.meetingNotes) || '(none)');
  return lines.join('\n');
}

function markdownToHtml(md) {
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
  return blocks.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>');
}

module.exports = {
  Store, GENERAL_WORKSPACE, TRASH_TTL_DAYS,
  exportBundle, restoreBundle, migrateVaultV1,
  sanitizeHtml, displayTitle, dueOccurrenceKey,
};
