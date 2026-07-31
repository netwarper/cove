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
const tasks = require('./tasks');

const GENERAL_WORKSPACE = 'general';
const TRASH_TTL_DAYS = 30;
const MAX_VERSIONS = 20;
const VERSION_COALESCE_MS = 60 * 1000; // don't snapshot more than once a minute
const INDEX_VERSION = 2; // bump to force a one-time rebuild when the entry shape changes

// Built-in starter templates, seeded once on first init (see _seedDefaultTemplates).
// Each seeds the Meeting Notes section of a new note with a ready-made scaffold.
const DEFAULT_TEMPLATES = [
  { name: '1:1', meetingNotes:
    '<h3>Wins &amp; progress</h3><ul><li><br></li></ul>' +
    '<h3>Challenges / blockers</h3><ul><li><br></li></ul>' +
    '<h3>Feedback (both ways)</h3><ul><li><br></li></ul>' +
    '<h3>Growth &amp; career</h3><ul><li><br></li></ul>' +
    '<h3>Action items</h3><ul><li><br></li></ul>' },
  { name: 'Team standup', meetingNotes:
    '<h3>Since last time</h3><ul><li><br></li></ul>' +
    '<h3>Today / next</h3><ul><li><br></li></ul>' +
    '<h3>Blockers</h3><ul><li><br></li></ul>' +
    '<h3>Announcements</h3><ul><li><br></li></ul>' },
  { name: 'Project update', meetingNotes:
    '<h3>Status</h3><p>🟢 On track &nbsp;·&nbsp; 🟡 At risk &nbsp;·&nbsp; 🔴 Off track</p>' +
    '<h3>Progress since last update</h3><ul><li><br></li></ul>' +
    '<h3>Risks &amp; issues</h3><ul><li><br></li></ul>' +
    '<h3>Decisions needed</h3><ul><li><br></li></ul>' +
    '<h3>Next steps</h3><ul><li><br></li></ul>' },
  { name: 'Interview', meetingNotes:
    '<h3>Candidate &amp; role</h3><p>Name: <br>Role: <br>Interviewer: </p>' +
    '<h3>Background</h3><ul><li><br></li></ul>' +
    '<h3>Questions &amp; responses</h3><ul><li><br></li></ul>' +
    '<h3>Strengths</h3><ul><li><br></li></ul>' +
    '<h3>Concerns</h3><ul><li><br></li></ul>' +
    '<h3>Recommendation</h3><p>Strong yes &nbsp;·&nbsp; Yes &nbsp;·&nbsp; No &nbsp;·&nbsp; Strong no</p>' },
];

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
  _inboxDir() { return path.join(this.dir, 'inbox'); }
  _tasksPath(wsId) { return path.join(this._wsDir(wsId), 'tasks.json.enc'); }

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
    this._seedDefaultTemplates();
    this.purgeExpiredTrash();
    this.migrateTasks();
  }

  // Seed the built-in starter templates once. Guarded by a flag so a user who
  // deletes them doesn't get them back, and existing names aren't duplicated.
  _seedDefaultTemplates() {
    const idx = this._index();
    if (idx.settings && idx.settings.templatesSeeded) return;
    idx.templates = idx.templates || [];
    const have = new Set(idx.templates.map((t) => String(t.name || '').toLowerCase()));
    for (const d of DEFAULT_TEMPLATES) {
      if (have.has(d.name.toLowerCase())) continue;
      idx.templates.push({
        id: c.randomId(6), name: d.name, meetingNotes: d.meetingNotes,
        defaultTodos: [], defaultCarryover: '', createdAt: new Date().toISOString(),
      });
    }
    idx.settings = Object.assign({}, idx.settings, { templatesSeeded: true });
    this._saveIndex(idx);
  }

  _index() { return this._readEnc(this._indexPath()); }
  _saveIndex(idx) { this._writeEnc(this._indexPath(), idx); }

  getSettings() { return this._index().settings; }
  saveSettings(patch) {
    const idx = this._index();
    // These flags are server-owned (one-time migration/seed guards); never let a
    // client clear them via the generic settings save.
    patch = Object.assign({}, patch);
    delete patch.tasksMigrated;
    delete patch.templatesSeeded;
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
    const meta = this._wsMeta(wsId);
    // The note filenames are the authoritative id set; metadata comes from the
    // search index (one decrypt) rather than decrypting every note file. Any note
    // missing from the index is self-healed by reading + indexing just that one.
    const idx = this._readIndex();
    let dirtyIndex = false;
    const ids = this._listNoteFiles(wsId).map((f) => f.replace(/\.json\.enc$/, ''));
    let notes = ids.map((id) => {
      let e = idx.notes[id];
      if (!e) {
        const n = this._readEncSafe(this._notePath(wsId, id));
        if (!n) return null;
        e = indexEntry(n, { id: wsId, name: meta.name || '' });
        idx.notes[id] = e; dirtyIndex = true;
      }
      return Object.assign({ id }, e);
    }).filter(Boolean);
    if (dirtyIndex) this._writeIndex(idx);

    const dir = opts.dir === 'asc' ? 1 : -1; // default descending (newest / Z→A first)
    const byStr = (s) => String(s || '').toLowerCase();
    const cmps = {
      created: (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0),
      modified: (a, b) => { const x = a.updatedAt || a.createdAt, y = b.updatedAt || b.createdAt; return x < y ? -1 : x > y ? 1 : 0; },
      // By date first, then within a date: named notes (by custom title) rank
      // above un-named (date-only) notes, which sink to the bottom of the group.
      name: (a, b) => {
        const da = byStr(a.title), db = byStr(b.title);
        if (da !== db) return da.localeCompare(db);
        const an = a.customTitle ? 1 : 0, bn = b.customTitle ? 1 : 0;
        if (an !== bn) return bn - an; // has-name before no-name
        if (an) return byStr(a.customTitle).localeCompare(byStr(b.customTitle));
        return 0;
      },
    };
    const cmp = cmps[opts.sort] || cmps.created;
    notes.sort((a, b) => dir * cmp(a, b) || (a.createdAt < b.createdAt ? 1 : -1));
    // Tasks are workspace-level; surface how many were completed *on* each note.
    const doneByNote = {};
    for (const t of this._readTasks(wsId).tasks) {
      if (t.done && t.completedOnNoteId) doneByNote[t.completedOnNoteId] = (doneByNote[t.completedOnNoteId] || 0) + 1;
    }
    return notes.map((e) => summaryFromIndex(e, doneByNote[e.id] || 0));
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
      tags: Array.isArray(opts.tags)
        ? opts.tags.map((t) => String(t).replace(/^#/, '').trim().slice(0, 60)).filter(Boolean).slice(0, 20)
        : [],
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
  // Copy any note-attachment images referenced in `html` into `toNote`, rewriting
  // their URLs to the new note's own copies so they keep displaying independently.
  _carryImages(html, fromNote, toNote) {
    html = html || '';
    if (html.indexOf('/attachments/') < 0) return html;
    return html.replace(/\/api\/notes\/[A-Za-z0-9_-]+\/attachments\/([A-Za-z0-9_-]+)/g, (full, attId) => {
      const from = this._attPath(fromNote.workspaceId, attId);
      if (!fs.existsSync(from)) return full; // blob gone — leave the reference as-is
      const newId = c.randomId(10);
      fs.mkdirSync(this._attDir(toNote.workspaceId), { recursive: true });
      fs.copyFileSync(from, this._attPath(toNote.workspaceId, newId));
      const meta = (fromNote.attachments || []).find((a) => a.id === attId) || {};
      toNote.attachments = toNote.attachments || [];
      toNote.attachments.push({ id: newId, name: meta.name || 'image', mime: meta.mime || 'image/png', size: meta.size || 0, createdAt: new Date().toISOString() });
      return '/api/notes/' + toNote.id + '/attachments/' + newId;
    });
  }

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
        .map((t) => ({ id: c.randomId(6), text: t.text, done: false, doneAt: null, due: t.due || null, sourceReminderId: null, sourceInbox: !!t.sourceInbox }));
      // Carry the carryover HTML forward, giving the new note its OWN copies of
      // any embedded images so they keep displaying even if the source note is
      // later deleted.
      note.carryover = this._carryImages(latest.carryover || '', latest, note);
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
    // Editable display date: a note's shown date is its `title` (YYYY-MM-DD).
    // Users can pre-/post-date a note (label it for a day they forgot, or prep a
    // future one) without moving it in the carry-forward chain, which keys on
    // createdAt (left untouched here).
    if (patch.date !== undefined) {
      const d = String(patch.date);
      const dt = new Date(d + 'T00:00:00');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(dt.getTime()) || formatDateTitle(dt) !== d) {
        throw httpError(400, 'invalid date');
      }
      note.title = d;
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
    // Record the conflict fork so multi-device edit collisions are auditable.
    try {
      this._appendConflict({
        kind: 'fork', wsId: loc.wsId,
        sourceId: noteId, sourceTitle: displayTitle(loc.note),
        forkId: note.id, forkTitle: displayTitle(note),
      });
    } catch (_e) { /* logging is best-effort */ }
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

  // Apply one action to many notes in a single request. Individual failures are
  // skipped so one bad id doesn't abort the batch.
  batchNotes(action, ids, opts = {}) {
    ids = (Array.isArray(ids) ? ids : []).slice(0, 500);
    let count = 0;
    for (const id of ids) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) continue;
      try {
        if (action === 'delete') { this.deleteNote(id); count++; }
        else if (action === 'move') { if (opts.workspaceId) { this.moveNote(id, opts.workspaceId); count++; } }
        else if (action === 'tag') {
          const loc = this._locateNote(id);
          if (!loc) continue;
          const add = (opts.tags || []).map((t) => String(t).replace(/^#/, '').trim().slice(0, 60)).filter(Boolean);
          const merged = (loc.note.tags || []).slice();
          add.forEach((t) => { if (!merged.some((x) => x.toLowerCase() === t.toLowerCase())) merged.push(t); });
          loc.note.tags = merged.slice(0, 40);
          loc.note.updatedAt = new Date().toISOString();
          this._writeEnc(loc.path, loc.note);
          this._indexUpsert(loc.note);
          count++;
        }
      } catch (_e) { /* skip individual failures */ }
    }
    return { ok: true, count };
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
    copy.todos = (src.todos || []).map((t) => ({ id: c.randomId(6), text: t.text, done: t.done, doneAt: t.doneAt || null, due: t.due || null, sourceReminderId: null }));
    // Copy every attachment blob under a new id, tracking old→new so we can
    // rewrite the embedded image URLs in the copied HTML.
    copy.attachments = [];
    const idMap = {};
    for (const a of src.attachments || []) {
      const from = this._attPath(loc.wsId, a.id);
      if (!fs.existsSync(from)) continue;
      const newId = c.randomId(10);
      fs.mkdirSync(this._attDir(dest), { recursive: true });
      fs.copyFileSync(from, this._attPath(dest, newId));
      idMap[a.id] = newId;
      copy.attachments.push(Object.assign({}, a, { id: newId }));
    }
    const rewrite = (html) => String(html || '').replace(
      /\/api\/notes\/[A-Za-z0-9_-]+\/attachments\/([A-Za-z0-9_-]+)/g,
      (full, attId) => (idMap[attId] ? '/api/notes/' + copy.id + '/attachments/' + idMap[attId] : full));
    copy.carryover = rewrite(src.carryover);
    copy.meetingNotes = rewrite(src.meetingNotes);
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

  // ---- inbox (external → to-do) --------------------------------------

  /**
   * Drain the inbox folder (DATA_DIR/inbox) into to-dos on the latest daily note
   * of the configured workspace. Files are dropped there by an external service
   * (Slack via Zapier / Make / a Cloudflare Worker, or POST /api/inbox), so a
   * to-do sent while this machine was asleep lands the next time the vault is
   * unlocked. Each .txt/.md line, or a .json {text}|[...]|{items}, becomes a
   * to-do. Consumed files are deleted (the to-do is now stored encrypted).
   */
  processInbox(opts = {}) {
    let wsId = opts.workspaceId || this.getSettings().inboxWorkspace || GENERAL_WORKSPACE;
    try { this._wsMeta(wsId); } catch (_e) { wsId = GENERAL_WORKSPACE; }
    const dir = this._inboxDir();
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return { added: 0, workspaceId: wsId }; }
    const files = fs.readdirSync(dir).filter((f) => /\.(txt|md|json)$/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
    const items = [];
    const consumed = [];
    for (const f of files) {
      const p = path.join(dir, f);
      let raw;
      try { raw = fs.readFileSync(p, 'utf8'); } catch (_e) { continue; }
      for (const it of parseInboxContent(f, raw)) if (it && it.text) items.push(it.text);
      consumed.push(p);
    }
    if (!items.length) { consumed.forEach((p) => { try { fs.rmSync(p, { force: true }); } catch (_e) { /* ignore */ } }); return { added: 0, workspaceId: wsId }; }
    const store = this._readTasks(wsId);
    for (const text of items) store.tasks.push(this._blankTask(wsId, { text: text, sourceInbox: true, due: tasks.todayISO() }));
    this._writeTasks(wsId, store);
    consumed.forEach((p) => { try { fs.rmSync(p, { force: true }); } catch (_e) { /* ignore */ } });
    return { added: items.length, workspaceId: wsId };
  }

  // ---- tasks (unified to-do + reminder, workspace-level) --------------

  _readTasks(wsId) {
    const p = this._tasksPath(wsId);
    if (!fs.existsSync(p)) return { tasks: [] };
    const d = this._readEncSafe(p);
    return d && Array.isArray(d.tasks) ? d : { tasks: [] };
  }
  _writeTasks(wsId, obj) { this._writeEnc(this._tasksPath(wsId), obj); }

  _blankTask(wsId, data = {}) {
    const now = new Date().toISOString();
    return {
      id: c.randomId(6),
      workspaceId: wsId,
      text: String(data.text || '').slice(0, 500),
      priority: tasks.normPriority(data.priority),
      due: tasks.normDate(data.due),
      time: tasks.normTime(data.time),
      recurrence: tasks.normalizeRecurrence(data.recurrence),
      done: false,
      completedAt: null,
      completedOnNoteId: null,
      sourceInbox: !!data.sourceInbox,
      createdAt: now,
      updatedAt: now,
      order: Date.now() + Math.floor(Math.random() * 1000),
    };
  }

  listTasks(wsId) { this._wsMeta(wsId); return this._readTasks(wsId).tasks; }

  addTask(wsId, data) {
    this._wsMeta(wsId);
    const store = this._readTasks(wsId);
    const t = this._blankTask(wsId, data);
    if (!t.due) t.due = tasks.todayISO(); // default to today (recurring tasks also need an anchor date)
    store.tasks.push(t);
    this._writeTasks(wsId, store);
    return { workspaceId: wsId, task: t, tasks: store.tasks };
  }

  _locateTask(taskId, wsHint) {
    const wss = wsHint ? [{ id: wsHint }] : this._index().workspaces;
    for (const w of wss) {
      const store = this._readTasks(w.id);
      const idx = store.tasks.findIndex((t) => t.id === taskId);
      if (idx >= 0) return { wsId: w.id, store, task: store.tasks[idx] };
    }
    return null;
  }

  updateTask(taskId, patch) {
    const loc = this._locateTask(taskId, patch && patch.workspaceId);
    if (!loc) throw httpError(404, 'task not found');
    const t = loc.task;
    if (patch.text !== undefined) t.text = String(patch.text).slice(0, 500);
    if (patch.priority !== undefined) t.priority = tasks.normPriority(patch.priority);
    if (patch.due !== undefined) t.due = tasks.normDate(patch.due);
    if (patch.time !== undefined) t.time = tasks.normTime(patch.time);
    if (patch.recurrence !== undefined) { t.recurrence = tasks.normalizeRecurrence(patch.recurrence); if (t.recurrence && !t.due) t.due = tasks.todayISO(); }
    if (patch.done === false) { t.done = false; t.completedAt = null; t.completedOnNoteId = null; } // reopen
    t.updatedAt = new Date().toISOString();
    this._writeTasks(loc.wsId, loc.store);
    return { workspaceId: loc.wsId, task: t, tasks: loc.store.tasks };
  }

  /** Complete a task. A recurring task logs a completed occurrence on the note
   *  and rolls forward to its next due date. */
  completeTask(taskId, opts = {}) {
    const loc = this._locateTask(taskId, opts.workspaceId);
    if (!loc) throw httpError(404, 'task not found');
    const t = loc.task;
    const now = new Date().toISOString();
    const noteId = opts.noteId || null;
    if (t.recurrence && !t.done) {
      const occ = Object.assign({}, t, {
        id: c.randomId(6), recurrence: null, done: true, completedAt: now, completedOnNoteId: noteId,
        createdAt: now, updatedAt: now, order: t.order,
      });
      loc.store.tasks.push(occ);
      const nd = tasks.nextDue(t.due || tasks.todayISO(), t.recurrence);
      if (nd) { t.due = nd; t.updatedAt = now; }
      else { t.done = true; t.completedAt = now; t.completedOnNoteId = noteId; t.updatedAt = now; } // recurrence ended
    } else {
      t.done = true; t.completedAt = now; t.completedOnNoteId = noteId; t.updatedAt = now;
    }
    this._writeTasks(loc.wsId, loc.store);
    return { workspaceId: loc.wsId, tasks: loc.store.tasks };
  }

  /** Skip the current occurrence of a recurring task (advance without completing). */
  skipTask(taskId, opts = {}) {
    const loc = this._locateTask(taskId, opts.workspaceId);
    if (!loc) throw httpError(404, 'task not found');
    const t = loc.task;
    if (t.recurrence) {
      const nd = tasks.nextDue(t.due || tasks.todayISO(), t.recurrence);
      if (nd) t.due = nd; else { t.done = true; t.completedAt = new Date().toISOString(); }
      t.updatedAt = new Date().toISOString();
      this._writeTasks(loc.wsId, loc.store);
    }
    return { workspaceId: loc.wsId, tasks: loc.store.tasks };
  }

  /** Reschedule (snooze) a task to a new due date (or clear it with null). */
  rescheduleTask(taskId, due, opts = {}) {
    const loc = this._locateTask(taskId, opts.workspaceId);
    if (!loc) throw httpError(404, 'task not found');
    loc.task.due = tasks.normDate(due);
    loc.task.updatedAt = new Date().toISOString();
    this._writeTasks(loc.wsId, loc.store);
    return { workspaceId: loc.wsId, tasks: loc.store.tasks };
  }

  deleteTask(taskId, opts = {}) {
    const loc = this._locateTask(taskId, opts.workspaceId);
    if (!loc) throw httpError(404, 'task not found');
    loc.store.tasks = loc.store.tasks.filter((t) => t.id !== taskId);
    this._writeTasks(loc.wsId, loc.store);
    return { workspaceId: loc.wsId, tasks: loc.store.tasks };
  }

  /** Move a task to another workspace, keeping its id, text, due, priority and
   *  recurrence. Returns the SOURCE workspace's remaining tasks so the caller's
   *  current view refreshes with the task removed. */
  moveTask(taskId, destWsId, opts = {}) {
    this._wsMeta(destWsId); // 404s if the destination workspace doesn't exist
    const loc = this._locateTask(taskId, opts.workspaceId);
    if (!loc) throw httpError(404, 'task not found');
    if (loc.wsId === destWsId) return { workspaceId: loc.wsId, task: loc.task, tasks: loc.store.tasks };
    loc.store.tasks = loc.store.tasks.filter((t) => t.id !== taskId);
    this._writeTasks(loc.wsId, loc.store);
    const dest = this._readTasks(destWsId);
    const moved = Object.assign({}, loc.task, {
      workspaceId: destWsId,
      order: dest.tasks.length,
      completedOnNoteId: null, // any "completed on note" lived in the old workspace
      updatedAt: new Date().toISOString(),
    });
    dest.tasks.push(moved);
    this._writeTasks(destWsId, dest);
    return { workspaceId: loc.wsId, movedTo: destWsId, task: moved, tasks: loc.store.tasks };
  }

  /** All OPEN tasks across workspaces (for the global Today / Upcoming / agenda). */
  globalTasks() {
    const out = [];
    for (const w of this._index().workspaces) {
      for (const t of this._readTasks(w.id).tasks) {
        if (t.done) continue;
        out.push(Object.assign({}, t, { workspaceName: w.name }));
      }
    }
    return out;
  }

  /**
   * Every completed task across all workspaces, newest completion first, each
   * tagged with its workspaceName. `from`/`to` (YYYY-MM-DD, inclusive) bound the
   * result by completion date so the payload stays small over years of history;
   * finer filtering (text, workspace, priority) is done live on the client.
   */
  completedTasks(opts = {}) {
    const from = opts.from || null;
    const to = opts.to || null;
    const out = [];
    for (const w of this._index().workspaces) {
      for (const t of this._readTasks(w.id).tasks) {
        if (!t.done || !t.completedAt) continue;
        const day = String(t.completedAt).slice(0, 10);
        if (from && day < from) continue;
        if (to && day > to) continue;
        out.push(Object.assign({}, t, { workspaceName: w.name }));
      }
    }
    out.sort((a, b) => (a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : 0));
    return out;
  }

  /**
   * Tasks whose reminder time has arrived and haven't been surfaced yet. Only
   * tasks with an explicit time fire — a date-only task (incl. the default
   * "today") would otherwise blast a notification the moment it's created.
   * `notifiedFor` records the due date we last notified for, so each recurrence
   * notifies once. Task files are only rewritten when something actually fired.
   */
  dueTaskNotifications() {
    const now = new Date();
    const todayIso = tasks.todayISO();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const out = [];
    for (const w of this._index().workspaces) {
      const store = this._readTasks(w.id);
      let changed = false;
      for (const t of store.tasks) {
        if (t.done || !t.due || !t.time) continue;
        const dueNow = t.due < todayIso || (t.due === todayIso && t.time <= hhmm);
        if (!dueNow || t.notifiedFor === t.due) continue;
        t.notifiedFor = t.due; changed = true;
        out.push({ id: t.id, text: t.text, workspaceId: w.id, workspaceName: w.name, due: t.due, time: t.time });
      }
      if (changed) this._writeTasks(w.id, store);
    }
    return out;
  }

  /**
   * One-time migration of legacy per-note to-dos + workspace reminders into the
   * unified tasks store. Open to-dos come from each workspace's latest daily note
   * (the live carry-forward set); completed to-dos from every note stay pinned to
   * the note they were finished on; active reminders become recurring tasks.
   */
  migrateTasks() {
    const idx = this._index();
    if (idx.settings && idx.settings.tasksMigrated) return;
    for (const w of idx.workspaces) {
      const store = this._readTasks(w.id);
      if (store.tasks.length) continue; // already has tasks — don't double-migrate
      const latest = this.latestDailyNote(w.id);
      if (latest) {
        for (const td of latest.todos || []) {
          if (td.done || td.sourceReminderId) continue; // reminders handled below
          store.tasks.push(this._blankTask(w.id, { text: td.text, due: td.due || null, sourceInbox: !!td.sourceInbox }));
        }
      }
      for (const f of this._listNoteFiles(w.id)) {
        const n = this._readEncSafe(path.join(this._notesDir(w.id), f));
        if (!n) continue;
        for (const td of n.todos || []) {
          if (!td.done) continue;
          const t = this._blankTask(w.id, { text: td.text, due: td.due || null });
          t.done = true; t.completedAt = td.doneAt || n.updatedAt || new Date().toISOString(); t.completedOnNoteId = n.id;
          store.tasks.push(t);
        }
      }
      let meta = null;
      try { meta = this._wsMeta(w.id); } catch (_e) { meta = null; }
      for (const r of (meta && meta.reminders) || []) {
        if (!r.active) continue;
        const rec = tasks.cadenceToRecurrence(r.cadence);
        const t = this._blankTask(w.id, { text: r.text, recurrence: rec, time: r.time });
        t.due = (r.cadence && r.cadence.type === 'once') ? (r.cadence.dueDate || tasks.todayISO())
          : (r.startDate && r.startDate > tasks.todayISO() ? r.startDate : tasks.todayISO());
        store.tasks.push(t);
      }
      this._writeTasks(w.id, store);
    }
    idx.settings = Object.assign({}, idx.settings, { tasksMigrated: true });
    this._saveIndex(idx);
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
    this._indexUpsert(loc.note); // keep attachmentCount (has:attachment) current
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
    this._indexUpsert(loc.note); // keep attachmentCount (has:attachment) current
    return { ok: true };
  }

  /** Store OCR-extracted text for an image attachment (makes it searchable).
   *  Does not bump `rev` — OCR is a derived enrichment, not a user content edit. */
  setAttachmentOcr(noteId, attId, text) {
    const loc = this._locateNote(noteId);
    if (!loc) throw httpError(404, 'note not found');
    const att = (loc.note.attachments || []).find((a) => a.id === attId);
    if (!att) throw httpError(404, 'attachment not found');
    att.ocrText = String(text || '').slice(0, 20000);
    this._writeEnc(loc.path, loc.note);
    this._indexUpsert(loc.note);
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
    try {
      const idx = this._readEnc(this._searchIndexPath());
      if (idx && idx.v === INDEX_VERSION && idx.notes) return idx;
      return this._rebuildIndex(); // old shape → one-time rebuild
    } catch (_e) { return this._rebuildIndex(); }
  }
  _writeIndex(idx) { idx.v = INDEX_VERSION; this._writeEnc(this._searchIndexPath(), idx); }

  _rebuildIndex() {
    const idx = { v: INDEX_VERSION, notes: {} };
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
    const entry = indexEntry(note, w);
    // Skip the (whole-index) rewrite when nothing indexed actually changed —
    // e.g. housekeeping writes that don't touch title/tags/body/updatedAt.
    if (idx.notes[note.id] && JSON.stringify(idx.notes[note.id]) === JSON.stringify(entry)) return;
    idx.notes[note.id] = entry;
    this._writeIndex(idx);
  }
  _indexRemove(noteId) {
    const idx = this._readIndex();
    if (idx.notes[noteId]) { delete idx.notes[noteId]; this._writeIndex(idx); }
  }

  search(query) {
    const raw = String(query || '').trim();
    if (!raw) return [];
    // Filter operators: tag:x  in:workspace  is:favorite|daily|scratch  has:attachment
    const f = { tag: null, ws: null, fav: false, kinds: null, hasAtt: false };
    let q = raw
      .replace(/\btag:(\S+)/gi, (_m, t) => { f.tag = t.toLowerCase(); return ' '; })
      .replace(/\bin:(\S+)/gi, (_m, w) => { f.ws = w.toLowerCase(); return ' '; })
      .replace(/\bis:favou?rite\b/gi, () => { f.fav = true; return ' '; })
      .replace(/\bis:(daily|scratch)\b/gi, (_m, k) => { (f.kinds || (f.kinds = [])).push(k.toLowerCase()); return ' '; })
      .replace(/\bhas:(?:attachment|image|file)s?\b/gi, () => { f.hasAtt = true; return ' '; })
      .trim().toLowerCase();
    const idx = this._readIndex();
    const results = [];
    for (const id of Object.keys(idx.notes)) {
      const e = idx.notes[id];
      if (f.tag && !(e.tags || []).some((t) => t.toLowerCase() === f.tag)) continue;
      if (f.fav && !e.favorite) continue;
      if (f.kinds && f.kinds.indexOf(e.kind || 'daily') < 0) continue;
      if (f.hasAtt && !((e.attachmentCount || 0) > 0)) continue;
      if (f.ws && !(String(e.wsName || '').toLowerCase().includes(f.ws) || String(e.wsId || '').toLowerCase() === f.ws)) continue;
      const lc = e.text.toLowerCase();
      const at = q ? lc.indexOf(q) : 0;
      if (q === '' || at >= 0) {
        // rank: title hits and tag hits rank above body-only hits.
        const dTitle = e.displayTitle || e.title || '';
        const titleHit = q && dTitle.toLowerCase().indexOf(q) >= 0;
        const tagHit = q && (e.tags || []).some((t) => t.toLowerCase().indexOf(q) >= 0);
        results.push({
          noteId: id, workspaceId: e.wsId, workspaceName: e.wsName, title: dTitle,
          tags: e.tags || [], createdAt: e.createdAt, query: q,
          score: (titleHit ? 2 : 0) + (tagHit ? 1 : 0),
          snippet: q ? makeSnippet(e.text, at, q.length) : e.text.slice(0, 120),
        });
      }
    }
    results.sort((a, b) => (b.score - a.score) || (a.createdAt < b.createdAt ? 1 : -1));
    return results;
  }

  /** Distinct tags across every note (from the search index), sorted A→Z. */
  allTags() {
    const idx = this._readIndex();
    const set = new Set();
    for (const id of Object.keys(idx.notes)) {
      for (const t of (idx.notes[id].tags || [])) if (t) set.add(t);
    }
    return Array.from(set).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
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
    return { workspaces: this._index().workspaces.length, notes, attachments, bytes, inboxDir: this._inboxDir() };
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
    // Drop corrupt notes from the search index so they stop appearing in the
    // sidebar (listNotes then re-reads the file, fails, and skips it).
    if (corrupt.length) {
      const idx = this._readIndex();
      let changed = false;
      for (const item of corrupt) {
        const m = /notes\/([A-Za-z0-9_-]+)\.json\.enc$/.exec(String(item.path).replace(/\\/g, '/'));
        if (m && idx.notes[m[1]]) { delete idx.notes[m[1]]; changed = true; }
      }
      if (changed) this._writeIndex(idx);
    }
    return { checked, ok: corrupt.length === 0, corrupt };
  }

  /**
   * Decrypt-check every encrypted entry in a backup BUNDLE (not the live data
   * dir) with the current session key, without importing anything. Proves a
   * backup is restorable before you actually need it. Returns the same shape as
   * verifyIntegrity.
   */
  verifyBundle(bundle) {
    if (!bundle || bundle.format !== 'meeting-notes-backup' || !bundle.files) {
      throw httpError(400, 'not a valid backup bundle');
    }
    const corrupt = [];
    let checked = 0;
    let hasVault = false;
    for (const rel of Object.keys(bundle.files)) {
      let buf;
      try { buf = Buffer.from(String(bundle.files[rel] || ''), 'base64'); }
      catch (_e) { corrupt.push({ path: rel, error: 'not valid base64' }); continue; }
      if (rel === 'vault.json') { hasVault = true; try { JSON.parse(buf.toString('utf8')); } catch (e) { corrupt.push({ path: rel, error: 'vault.json unreadable' }); } continue; }
      if (!rel.endsWith('.enc')) continue;
      checked++;
      try {
        const plain = c.decrypt(this.key, buf);
        if (rel.endsWith('.json.enc')) JSON.parse(plain.toString('utf8'));
      } catch (err) {
        corrupt.push({ path: rel, error: err.message });
      }
    }
    return { checked, ok: corrupt.length === 0 && hasVault, hasVault, corrupt, createdAt: bundle.createdAt || null };
  }

  // ---- conflict history log -------------------------------------------

  _conflictsPath() { return path.join(this.dir, 'conflicts.json.enc'); }
  _readConflicts() {
    try { if (fs.existsSync(this._conflictsPath())) { const d = this._readEnc(this._conflictsPath()); if (d && Array.isArray(d.items)) return d; } }
    catch (_e) { /* start fresh on any read/parse failure */ }
    return { items: [] };
  }
  _appendConflict(entry) {
    const log = this._readConflicts();
    log.items.unshift(Object.assign({ at: new Date().toISOString() }, entry));
    log.items = log.items.slice(0, 100); // keep the log bounded
    this._writeEnc(this._conflictsPath(), log);
  }
  /** The conflict-history log (most recent first). */
  listConflicts() { return this._readConflicts().items; }

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

  /**
   * Export a workspace or a tag as Markdown optimized for uploading to an LLM
   * (ChatGPT / Claude) as knowledge/research. `mode` is 'single' (one
   * comprehensive file with a table of contents) or 'perNote' (a ZIP of one
   * Markdown file per note plus an index). Notes are ordered oldest-first so the
   * narrative reads chronologically.
   */
  exportLLM(opts = {}) {
    const mode = opts.mode === 'perNote' ? 'perNote' : 'single';
    const collected = [];
    let title, baseName, tag = null;

    if (opts.scope === 'tag') {
      tag = String(opts.tag || '').replace(/^#/, '').trim().toLowerCase();
      if (!tag) throw httpError(400, 'a tag is required');
      for (const w of this.listWorkspaces()) {
        for (const f of this._listNoteFiles(w.id)) {
          const n = this._readEncSafe(path.join(this._notesDir(w.id), f));
          if (n && (n.tags || []).some((t) => String(t).toLowerCase() === tag)) collected.push({ n, wsName: w.name });
        }
      }
      title = 'Notes tagged #' + tag;
      baseName = 'tag-' + (tag.replace(/[^\w.\-]+/g, '_') || 'export');
    } else {
      const meta = this._wsMeta(opts.wsId);
      for (const f of this._listNoteFiles(opts.wsId)) {
        const n = this._readEncSafe(path.join(this._notesDir(opts.wsId), f));
        if (n) collected.push({ n, wsName: meta.name });
      }
      title = 'Workspace: ' + meta.name;
      baseName = (meta.name || 'workspace').replace(/[^\w.\- ]+/g, '_');
    }

    collected.sort((a, b) => (a.n.createdAt < b.n.createdAt ? -1 : a.n.createdAt > b.n.createdAt ? 1 : 0));
    const now = llmDate(new Date().toISOString());
    // In tag exports notes span workspaces, so label each with its workspace.
    const withWs = opts.scope === 'tag';

    // Open tasks give an LLM useful "what's outstanding" context (workspace scope).
    let taskLines = [];
    if (opts.scope !== 'tag') {
      const open = (this._readTasks(opts.wsId).tasks || []).filter((t) => !t.done && !t.completedAt && t.text);
      if (open.length) {
        open.sort((a, b) => String(a.due || '~').localeCompare(String(b.due || '~')));
        taskLines = ['## Open tasks', ''].concat(open.map((t) =>
          '- ' + t.text + (t.due ? ' (due ' + t.due + ')' : '') + (t.priority ? ' [' + t.priority + ']' : '')), ['']);
      }
    }

    if (mode === 'perNote') {
      const files = [];
      const seen = {};
      const idxLines = ['# ' + title, '', '> Exported from Cove on ' + now + ' · ' + collected.length +
        ' note' + (collected.length === 1 ? '' : 's') + '. One file per note; see below.', ''].concat(taskLines);
      idxLines.push('## Notes', '');
      collected.forEach((x, i) => {
        const num = String(i + 1).padStart(3, '0');
        let base = num + '-' + (displayTitle(x.n) || x.n.id).replace(/[^\w.\- ]+/g, '_').slice(0, 70);
        if (seen[base]) base += '-' + x.n.id.slice(0, 4);
        seen[base] = true;
        const fname = base + '.md';
        files.push({ name: fname, data: Buffer.from(noteToLLMMarkdown(x.n, withWs ? x.wsName : null)) });
        idxLines.push('- [' + displayTitle(x.n) + '](' + fname + ') — ' + llmDate(x.n.createdAt));
      });
      files.unshift({ name: '_index.md', data: Buffer.from(idxLines.join('\n') + '\n') });
      return { mime: 'application/zip', ext: 'zip', filename: baseName + '-knowledge', body: zip(files), mode };
    }

    // single comprehensive file
    const head = ['# ' + title, '',
      '> Exported from Cove on ' + now + ' · ' + collected.length + ' note' + (collected.length === 1 ? '' : 's') + '.',
      '> Knowledge export intended as reference material for an AI assistant.', ''].concat(taskLines);
    head.push('## Contents', '');
    collected.forEach((x, i) => head.push((i + 1) + '. ' + displayTitle(x.n) + ' — ' + llmDate(x.n.createdAt)));
    head.push('');
    const body = collected.map((x) => noteToLLMMarkdown(x.n, withWs ? x.wsName : null)).join('\n\n---\n\n');
    return { mime: 'text/markdown', ext: 'md', filename: baseName + '-knowledge', body: Buffer.from(head.join('\n') + '\n' + body + '\n'), mode };
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
    // Attachment filenames + any OCR-extracted text make images searchable.
    ...(n.attachments || []).map((a) => [a.name, a.ocrText].filter(Boolean).join(' ')),
  ].join('\n');
}

function indexEntry(n, w) {
  return {
    wsId: w.id,
    wsName: w.name,
    title: n.title,                    // raw date title (needed for name-sort)
    customTitle: n.customTitle || null,
    displayTitle: displayTitle(n),     // title + custom (for search + sidebar display)
    kind: n.kind || 'daily',
    tags: n.tags || [],
    favorite: !!n.favorite,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt || n.createdAt,
    attachmentCount: (n.attachments || []).length,
    text: noteSearchText(n),
  };
}

// Build a sidebar note-summary straight from an enriched index entry (which
// already carries `id`), avoiding a per-note decrypt.
function summaryFromIndex(e, doneTaskCount) {
  return {
    id: e.id,
    workspaceId: e.wsId,
    title: e.title,
    customTitle: e.customTitle || null,
    displayTitle: e.displayTitle,
    kind: e.kind || 'daily',
    tags: e.tags || [],
    createdAt: e.createdAt,
    updatedAt: e.updatedAt || e.createdAt,
    favorite: !!e.favorite,
    attachmentCount: e.attachmentCount || 0,
    doneTaskCount: doneTaskCount || 0,
  };
}

function normalizeTodos(todos) {
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  return open.concat(done);
}

/** Parse an inbox file into { text } items: JSON {text}|[...]|{items}, else one per line. */
function parseInboxContent(name, raw) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'json') {
    try {
      const j = JSON.parse(raw);
      const pick = (x) => ({ text: typeof x === 'string' ? x : (x && x.text) });
      if (Array.isArray(j)) return j.map(pick);
      if (j && Array.isArray(j.items)) return j.items.map(pick);
      if (j && typeof j.text === 'string') return [{ text: j.text }];
      return [];
    } catch (_e) { /* fall through to line parsing */ }
  }
  return String(raw).split(/\r?\n/).map((l) => ({ text: l.trim() })).filter((x) => x.text);
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
<div class="section"><h2>Ongoing Notes</h2><div>${sanitizeHtml(note.carryover) || '<em>(none)</em>'}</div></div>
<div class="section"><h2>Meeting Notes</h2><div>${sanitizeHtml(note.meetingNotes) || '<em>(none)</em>'}</div></div>
</body></html>`;
}

function noteToMarkdown(note) {
  const lines = [`# ${displayTitle(note)}`, '', `_Created ${note.createdAt}_`, ''];
  if ((note.tags || []).length) lines.push(note.tags.map((x) => '#' + x).join(' '), '');
  lines.push('## To-Do', '');
  for (const t of note.todos || []) lines.push(`- [${t.done ? 'x' : ' '}] ${t.text}${t.due ? ' (due ' + t.due + ')' : ''}`);
  lines.push('', '## Ongoing Notes', '', stripHtml(note.carryover) || '(none)');
  lines.push('', '## Meeting Notes', '', stripHtml(note.meetingNotes) || '(none)');
  return lines.join('\n');
}

/** Convert stored rich-text HTML to readable Markdown (lists, headings, bold,
 *  line breaks preserved). Aimed at LLM ingestion, not perfect fidelity. */
function htmlToMarkdown(html) {
  let s = String(html || '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => '\n\n' + '#'.repeat(+n) + ' ' + t.trim() + '\n\n');
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => '\n- ' + t.trim());
  s = s.replace(/<\/(ul|ol)>/gi, '\n\n');
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, t) => '**' + t.trim() + '**');
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, t) => '*' + t.trim() + '*');
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => '[' + t.trim() + '](' + href + ')');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|h[1-6]|blockquote)>/gi, '\n');
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_m, alt) => (alt ? '[image: ' + alt + ']' : '[image]'));
  s = s.replace(/<img[^>]*>/gi, '[image]');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function llmDate(iso) { return String(iso || '').slice(0, 16).replace('T', ' '); }

/** One note as an LLM-friendly Markdown section (heading + metadata + content). */
function noteToLLMMarkdown(note, wsName) {
  const L = ['## ' + displayTitle(note)];
  const meta = [];
  if (wsName) meta.push('Workspace: ' + wsName);
  meta.push('Type: ' + (note.kind === 'scratch' ? 'scratch note' : 'daily note'));
  meta.push('Created: ' + llmDate(note.createdAt));
  if (note.updatedAt && note.updatedAt !== note.createdAt) meta.push('Updated: ' + llmDate(note.updatedAt));
  if ((note.tags || []).length) meta.push('Tags: ' + note.tags.map((t) => '#' + t).join(' '));
  L.push('_' + meta.join(' · ') + '_', '');
  const todos = (note.todos || []).filter((t) => t.text);
  if (todos.length) {
    L.push('### To-Do', '');
    for (const t of todos) L.push('- [' + (t.done ? 'x' : ' ') + '] ' + t.text + (t.due ? ' (due ' + t.due + ')' : ''));
    L.push('');
  }
  const carry = htmlToMarkdown(note.carryover);
  if (carry) L.push('### Ongoing Notes', '', carry, '');
  const mn = htmlToMarkdown(note.meetingNotes);
  if (mn) L.push('### Meeting Notes', '', mn, '');
  const tr = (note.transcript || []).filter((x) => x && x.text);
  if (tr.length) {
    L.push('### Transcript', '');
    for (const x of tr) L.push('**' + (x.source === 'them' ? 'Them' : 'You') + ':** ' + x.text);
    L.push('');
  }
  return L.join('\n').trim() + '\n';
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
