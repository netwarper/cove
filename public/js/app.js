/* Meeting Notes — main application controller. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var API = window.API;
  var IDLE_MS = 15 * 60 * 1000;

  var state = {
    initialized: false,
    workspaces: [],
    templates: [],
    wsId: null,
    note: null,
    settings: { layout: 'columns' },
    view: 'note',
    saveTimer: null,
    freeMode: false,
    notify: false,
    dragTodoId: null,
  };

  // ---------------- Boot / auth ----------------
  async function boot() {
    var st = await API.status();
    state.initialized = st.initialized;
    state.instance = st.instance || null;
    if (st.csrf) API.setCsrf(st.csrf);
    if (st.authenticated) return startApp();
    showAuth(st.initialized);
  }

  function showAuth(initialized) {
    $('app').classList.add('hidden');
    $('authGate').classList.remove('hidden');
    $('authForm').classList.remove('hidden');
    $('recoverForm').classList.add('hidden');
    $('authSubtitle').textContent = initialized
      ? 'Enter your passphrase to unlock your notes.'
      : 'Welcome! Create a passphrase to encrypt your notes.';
    $('authLabel').textContent = initialized ? 'Passphrase' : 'Create passphrase';
    $('authSubmit').textContent = initialized ? 'Unlock' : 'Create vault';
    $('passphrase2').classList.toggle('hidden', initialized);
    $('toggleRecover').classList.toggle('hidden', !initialized);
    $('passphrase').value = ''; $('passphrase2').value = '';
  }

  $('authForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('authError'); err.classList.add('hidden');
    var pass = $('passphrase').value;
    try {
      if (!state.initialized) {
        if (pass.length < 8) throw new Error('Passphrase must be at least 8 characters.');
        if (pass !== $('passphrase2').value) throw new Error('Passphrases do not match.');
        var r = await API.setup(pass);
        if (r.csrf) API.setCsrf(r.csrf);
        await startApp();
        if (r.recoveryKey) showRecovery(r.recoveryKey);
      } else {
        var lr = await API.login(pass);
        if (lr.csrf) API.setCsrf(lr.csrf);
        await startApp();
        if (lr.migratedRecoveryKey) showRecovery(lr.migratedRecoveryKey, 'Your vault was upgraded to envelope encryption. Save this new recovery key.');
      }
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  });

  $('toggleRecover').addEventListener('click', function () {
    $('authForm').classList.toggle('hidden');
    $('recoverForm').classList.toggle('hidden');
  });
  $('recoverForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('recoverError'); err.classList.add('hidden');
    try {
      var r = await API.recover($('recoveryKeyInput').value.trim(), $('recoverNewPass').value);
      if (r.csrf) API.setCsrf(r.csrf);
      await startApp();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  });

  window.addEventListener('mn-unauthorized', function () { location.reload(); });

  async function startApp() {
    $('authGate').classList.add('hidden');
    $('app').classList.remove('hidden');
    state.settings = await API.getSettings();
    applyLayout();
    applyFontSize(state.settings.fontSize || 14);
    await loadTemplates();
    await loadWorkspaces();
    await loadCurrentNote();
    startIdleTimer();
    startReminderPolling();
    startLiveSync();
  }

  // Service worker (offline app shell + notifications)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }

  // Live-sync: refresh when note files change on disk (e.g. another device via a synced folder)
  function startLiveSync() {
    if (!('EventSource' in window)) return;
    try {
      var es = new EventSource('/api/events');
      es.addEventListener('change', function (ev) {
        var data = {}; try { data = JSON.parse(ev.data); } catch (e) {}
        // don't clobber in-progress edits
        if (state.saveTimer) return;
        if (state.view === 'note' && state.note && data.noteId && data.noteId === state.note.id) {
          API.getNote(state.note.id).then(function (fresh) {
            if (fresh.updatedAt !== state.note.updatedAt) { state.note = fresh; renderNote(); setSaveStatus('Updated from another device'); }
          }).catch(function () {});
        }
        if (state.view === 'note') renderNoteList();
      });
      es.onerror = function () { /* browser auto-reconnects */ };
    } catch (e) { /* SSE unsupported */ }
  }

  function applyFontSize(px) {
    document.documentElement.style.setProperty('--note-font', px + 'px');
  }

  // ---------------- Workspaces ----------------
  async function loadWorkspaces() {
    state.workspaces = await API.listWorkspaces();
    if (!state.wsId || !state.workspaces.some(function (w) { return w.id === state.wsId; })) state.wsId = state.workspaces[0].id;
    var sel = $('workspaceSelect'); sel.innerHTML = '';
    state.workspaces.forEach(function (w) {
      var o = document.createElement('option'); o.value = w.id; o.textContent = w.name;
      if (w.id === state.wsId) o.selected = true; sel.appendChild(o);
    });
  }
  $('workspaceSelect').addEventListener('change', async function () {
    state.wsId = $('workspaceSelect').value; showView('note'); await loadCurrentNote();
  });

  // ---------------- Note load / render ----------------
  async function loadCurrentNote() {
    state.note = await API.currentNote(state.wsId);
    renderNote();
    await Promise.all([renderNoteList(), renderReminders()]);
  }
  async function openNote(id) {
    state.note = await API.getNote(id);
    state.wsId = state.note.workspaceId; $('workspaceSelect').value = state.wsId;
    showView('note'); renderNote(); renderNoteList(); renderReminders();
  }

  function renderNote() {
    var n = state.note;
    $('noteDate').textContent = n.title;
    $('noteCustomTitle').value = n.customTitle || '';
    $('favBtn').textContent = n.favorite ? '★' : '☆';
    renderTags();
    renderTodos();
    $('carryoverEditor').innerHTML = n.carryover || '';
    $('meetingEditor').innerHTML = n.meetingNotes || '';
    setFreeMode(false);
    renderFreeform();
    renderAttachments();
    setSaveStatus('');
    updateWordCount();
    renderBacklinks();
  }

  function updateWordCount() {
    var txt = ($('carryoverEditor').textContent + ' ' + $('meetingEditor').textContent).trim();
    var n = txt ? txt.split(/\s+/).length : 0;
    $('wordCount').textContent = n + (n === 1 ? ' word' : ' words');
  }

  async function renderBacklinks() {
    try {
      var links = await API.backlinks(state.note.id);
      var wrap = $('backlinks'); var list = $('backlinksList');
      if (!links.length) { wrap.classList.add('hidden'); return; }
      list.innerHTML = '';
      links.forEach(function (l) {
        var a = document.createElement('button'); a.className = 'bl-item'; a.textContent = l.displayTitle;
        a.addEventListener('click', function () { openNote(l.id); });
        list.appendChild(a);
      });
      wrap.classList.remove('hidden');
    } catch (e) { $('backlinks').classList.add('hidden'); }
  }

  async function renderNoteList() {
    var notes = await API.listNotes(state.wsId, $('noteFilter').value);
    var ul = $('noteList'); ul.innerHTML = '';
    notes.forEach(function (nm) {
      var li = document.createElement('li');
      if (state.note && nm.id === state.note.id && state.view === 'note') li.classList.add('active');
      var tags = (nm.tags || []).length ? '<span class="nl-tags">' + nm.tags.map(function (t) { return '#' + esc(t); }).join(' ') + '</span>' : '';
      li.innerHTML =
        '<div class="nl-title">' + (nm.favorite ? '<span class="nl-fav">★</span> ' : '') + esc(nm.displayTitle) + '</div>' +
        '<div class="nl-meta"><span>' + nm.openTodoCount + ' open</span>' +
        (nm.attachmentCount ? '<span>📎 ' + nm.attachmentCount + '</span>' : '') + tags + '</div>';
      li.addEventListener('click', function () { openNote(nm.id); });
      ul.appendChild(li);
    });
  }

  // ---------------- Tags ----------------
  function renderTags() {
    var bar = $('tagBar'); bar.innerHTML = '';
    (state.note.tags || []).forEach(function (t) {
      var chip = document.createElement('span'); chip.className = 'tag-chip';
      chip.innerHTML = '#' + esc(t) + ' <button aria-label="Remove tag">✕</button>';
      chip.querySelector('button').addEventListener('click', function () {
        state.note.tags = state.note.tags.filter(function (x) { return x !== t; });
        renderTags(); scheduleSave();
      });
      bar.appendChild(chip);
    });
    var inp = document.createElement('input'); inp.className = 'tag-input'; inp.placeholder = '+ tag';
    inp.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      var v = inp.value.trim().replace(/^#/, '');
      if (v && (state.note.tags || []).indexOf(v) < 0) {
        state.note.tags = (state.note.tags || []).concat(v);
        renderTags(); scheduleSave();
      }
    });
    bar.appendChild(inp);
  }

  // ---------------- To-dos ----------------
  var todayStr = function () { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
  function p2(n) { return String(n).padStart(2, '0'); }

  function renderTodos() {
    var ul = $('todoList'); ul.innerHTML = '';
    (state.note.todos || []).forEach(function (t) {
      var li = document.createElement('li');
      li.className = t.done ? 'done' : '';
      if (!t.done && t.due && t.due < todayStr()) li.classList.add('overdue');
      if (!t.done) { li.setAttribute('draggable', 'true'); li.dataset.id = t.id; }
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!t.done;
      cb.addEventListener('change', function () { toggleTodo(t.id, cb.checked); });
      var span = document.createElement('span'); span.className = 'todo-text'; span.contentEditable = 'true'; span.textContent = t.text;
      span.addEventListener('blur', function () { t.text = span.textContent.trim(); scheduleSave(); });
      var due = document.createElement('button'); due.className = 'todo-due'; due.title = 'Set due date';
      due.textContent = t.due ? t.due.slice(5) : '📅';
      due.addEventListener('click', function () { pickDue(t); });
      var del = document.createElement('button'); del.className = 'todo-del'; del.textContent = '✕';
      del.addEventListener('click', function () {
        state.note.todos = state.note.todos.filter(function (x) { return x.id !== t.id; });
        renderTodos(); scheduleSave();
      });
      li.appendChild(cb); li.appendChild(span);
      if (t.sourceReminderId) {
        var b = document.createElement('span'); b.className = 'reminder-badge'; b.textContent = '⏰'; li.appendChild(b);
        var sn = document.createElement('button'); sn.className = 'todo-snooze'; sn.title = 'Snooze this reminder'; sn.textContent = '💤';
        sn.addEventListener('click', function () { snoozeReminderTodo(t); });
        li.appendChild(sn);
      }
      li.appendChild(due); li.appendChild(del);
      addTodoDnd(li);
      ul.appendChild(li);
    });
  }

  function pickDue(t) {
    var inp = document.createElement('input'); inp.type = 'date'; inp.value = t.due || '';
    inp.style.position = 'fixed'; inp.style.left = '-9999px'; document.body.appendChild(inp);
    inp.addEventListener('change', function () { t.due = inp.value || null; renderTodos(); scheduleSave(); inp.remove(); });
    inp.addEventListener('blur', function () { setTimeout(function () { inp.remove(); }, 200); });
    inp.focus(); if (inp.showPicker) try { inp.showPicker(); } catch (e) { inp.click(); } else inp.click();
  }

  function addTodoDnd(li) {
    if (li.getAttribute('draggable') !== 'true') return;
    li.addEventListener('dragstart', function () { state.dragTodoId = li.dataset.id; li.classList.add('dragging'); });
    li.addEventListener('dragend', function () { li.classList.remove('dragging'); state.dragTodoId = null; });
    li.addEventListener('dragover', function (e) { e.preventDefault(); });
    li.addEventListener('drop', function (e) {
      e.preventDefault();
      var from = state.dragTodoId, to = li.dataset.id;
      if (!from || from === to) return;
      var todos = state.note.todos;
      var fi = todos.findIndex(function (x) { return x.id === from; });
      var ti = todos.findIndex(function (x) { return x.id === to; });
      if (fi < 0 || ti < 0) return;
      var moved = todos.splice(fi, 1)[0];
      todos.splice(ti, 0, moved);
      state.note.todos = normalizeOrder(todos);
      renderTodos(); scheduleSave();
    });
  }
  function normalizeOrder(todos) {
    return todos.filter(function (t) { return !t.done; }).concat(todos.filter(function (t) { return t.done; }));
  }

  function toggleTodo(id, done) {
    var t = state.note.todos.find(function (x) { return x.id === id; });
    if (!t) return;
    t.done = done; t.doneAt = done ? new Date().toISOString() : null;
    state.note.todos = normalizeOrder(state.note.todos);
    renderTodos(); scheduleSave();
  }

  $('todoInput').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var text = $('todoInput').value.trim(); if (!text) return;
    state.note.todos = state.note.todos || [];
    state.note.todos.unshift({ id: rid(), text: text, done: false, doneAt: null, due: null, sourceReminderId: null });
    state.note.todos = normalizeOrder(state.note.todos);
    $('todoInput').value = ''; renderTodos(); scheduleSave();
  });

  // ---------------- Reminders ----------------
  $('reminderCadence').addEventListener('change', function () {
    var v = $('reminderCadence').value;
    $('reminderN').classList.toggle('hidden', v !== 'everyNDays');
    $('reminderDue').classList.toggle('hidden', v !== 'once');
    $('reminderEnd').classList.toggle('hidden', v === 'once'); // "repeat until" only for recurring
  });
  $('addReminderBtn').addEventListener('click', async function () {
    var text = $('reminderText').value.trim(); if (!text) return;
    var type = $('reminderCadence').value;
    var cadence = { type: type };
    if (type === 'everyNDays') cadence.n = parseInt($('reminderN').value, 10) || 1;
    if (type === 'once') cadence.dueDate = $('reminderDue').value || undefined;
    if (type !== 'once' && $('reminderEnd').value) cadence.endDate = $('reminderEnd').value;
    await API.addReminder(state.wsId, { text: text, cadence: cadence, time: $('reminderTime').value || null });
    $('reminderText').value = '';
    await renderReminders();
    await loadCurrentNote();
  });

  async function renderReminders() {
    var rems = await API.listReminders(state.wsId);
    var ul = $('reminderList'); ul.innerHTML = '';
    rems.forEach(function (r) {
      var li = document.createElement('li'); if (!r.active) li.classList.add('inactive');
      li.innerHTML =
        '<input type="checkbox" ' + (r.active ? 'checked' : '') + ' aria-label="Active">' +
        '<span class="rm-text">' + esc(r.text) + '<br><span class="rm-cadence">' + describeCadence(r.cadence) + (r.time ? ' · ' + esc(r.time) : '') + '</span></span>' +
        '<button class="rm-del" aria-label="Delete reminder">🗑</button>';
      li.querySelector('input').addEventListener('change', function (e) { API.updateReminder(state.wsId, r.id, { active: e.target.checked }).then(renderReminders); });
      li.querySelector('.rm-del').addEventListener('click', function () { API.deleteReminder(state.wsId, r.id).then(renderReminders); });
      ul.appendChild(li);
    });
  }
  function describeCadence(cad) {
    if (!cad) return '';
    if (cad.type === 'once') return 'Once' + (cad.dueDate ? ' · ' + cad.dueDate : '');
    if (cad.type === 'daily') return 'Every day';
    if (cad.type === 'weekly') return 'Every week';
    if (cad.type === 'monthly') return 'Every month';
    if (cad.type === 'everyNDays') return 'Every ' + (cad.n || 1) + ' days';
    return '';
  }

  // ---------------- Rich text ----------------
  var meetingUploader = function (file) {
    return API.addAttachment(state.note.id, { name: file.name || 'image.png', mime: file.type, dataB64: '' })
      .then(function () {}); // placeholder replaced below
  };
  // real uploader: read file -> base64 -> attachment -> return URL
  meetingUploader = async function (file) {
    var b64 = await fileToBase64(file);
    var meta = await API.addAttachment(state.note.id, { name: file.name || 'image.png', mime: file.type || 'image/png', dataB64: b64 });
    state.note.attachments = state.note.attachments || []; state.note.attachments.push(meta); renderAttachments();
    return API.attachmentUrl(state.note.id, meta.id);
  };
  window.Editor.init($('sections').querySelector('[data-target="carryoverEditor"]'), $('carryoverEditor'), { noteLinkPicker: openNotePicker });
  window.Editor.init($('sections').querySelector('[data-target="meetingEditor"]'), $('meetingEditor'), { uploader: function (f) { return meetingUploader(f); }, noteLinkPicker: openNotePicker });
  $('carryoverEditor').addEventListener('input', function () { state.note.carryover = $('carryoverEditor').innerHTML; scheduleSave(); updateWordCount(); });
  $('meetingEditor').addEventListener('input', function () { state.note.meetingNotes = $('meetingEditor').innerHTML; scheduleSave(); updateWordCount(); });
  window.addEventListener('mn-open-note', function (e) { openNote(e.detail); });

  // ---------------- Free-form ----------------
  $('modeFlow').addEventListener('click', function () { setFreeMode(false); });
  $('modeFree').addEventListener('click', function () { setFreeMode(true); });
  function setFreeMode(on) {
    state.freeMode = on;
    $('modeFlow').classList.toggle('active', !on); $('modeFree').classList.toggle('active', on);
    $('flowWrap').classList.toggle('hidden', on); $('freeWrap').classList.toggle('hidden', !on);
  }
  $('freeCanvas').addEventListener('dblclick', function (e) {
    if (e.target !== $('freeCanvas')) return;
    var rect = $('freeCanvas').getBoundingClientRect();
    var box = { id: rid(), x: e.clientX - rect.left, y: e.clientY - rect.top, w: 160, html: '' };
    state.note.freeform = state.note.freeform || []; state.note.freeform.push(box);
    renderFreeform(); scheduleSave();
    var el = $('freeCanvas').querySelector('[data-fb="' + box.id + '"] .fb-edit'); if (el) el.focus();
  });
  function renderFreeform() {
    var canvas = $('freeCanvas'); canvas.innerHTML = '';
    (state.note.freeform || []).forEach(function (box) {
      var el = document.createElement('div'); el.className = 'free-box'; el.setAttribute('data-fb', box.id);
      el.style.left = box.x + 'px'; el.style.top = box.y + 'px'; el.style.width = box.w + 'px';
      el.innerHTML = '<div class="fb-edit" contenteditable="true"></div><button class="fb-del" aria-label="Delete box">✕</button>';
      var edit = el.querySelector('.fb-edit'); edit.innerHTML = box.html || '';
      edit.addEventListener('input', function () { box.html = edit.innerHTML; scheduleSave(); });
      el.querySelector('.fb-del').addEventListener('click', function () {
        state.note.freeform = state.note.freeform.filter(function (b) { return b.id !== box.id; }); renderFreeform(); scheduleSave();
      });
      enableBoxDrag(el, edit, box); canvas.appendChild(el);
    });
  }
  function enableBoxDrag(el, edit, box) {
    el.addEventListener('mousedown', function (e) {
      if (e.target === edit || e.target.classList.contains('fb-del')) return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY, ox = box.x, oy = box.y;
      function move(ev) { box.x = Math.max(0, ox + ev.clientX - sx); box.y = Math.max(0, oy + ev.clientY - sy); el.style.left = box.x + 'px'; el.style.top = box.y + 'px'; }
      function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); scheduleSave(); }
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  // ---------------- Attachments ----------------
  $('attachInput').addEventListener('change', async function () {
    var files = Array.prototype.slice.call($('attachInput').files);
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.size > 20 * 1024 * 1024) { alert('“' + f.name + '” is too large (max 20 MB).'); continue; }
      var b64 = await fileToBase64(f);
      var meta = await API.addAttachment(state.note.id, { name: f.name, mime: f.type, dataB64: b64 });
      state.note.attachments = state.note.attachments || []; state.note.attachments.push(meta);
    }
    $('attachInput').value = ''; renderAttachments();
  });
  function renderAttachments() {
    var ul = $('attachList'); ul.innerHTML = '';
    (state.note.attachments || []).forEach(function (a) {
      var li = document.createElement('li');
      if ((a.mime || '').indexOf('image/') === 0) {
        var thumb = document.createElement('img'); thumb.className = 'at-thumb'; thumb.src = API.attachmentUrl(state.note.id, a.id); thumb.alt = a.name;
        li.appendChild(thumb);
      }
      var a1 = document.createElement('a'); a1.href = API.attachmentUrl(state.note.id, a.id); a1.textContent = a.name; a1.target = '_blank'; a1.rel = 'noopener';
      var size = document.createElement('span'); size.className = 'at-size'; size.textContent = fmtSize(a.size);
      var del = document.createElement('button'); del.className = 'at-del'; del.textContent = '✕';
      del.addEventListener('click', async function () {
        await API.deleteAttachment(state.note.id, a.id);
        state.note.attachments = state.note.attachments.filter(function (x) { return x.id !== a.id; }); renderAttachments();
      });
      li.appendChild(a1); li.appendChild(size); li.appendChild(del); ul.appendChild(li);
    });
  }

  // ---------------- Header actions ----------------
  $('noteCustomTitle').addEventListener('input', function () { state.note.customTitle = $('noteCustomTitle').value; scheduleSave(); });
  $('favBtn').addEventListener('click', async function () {
    state.note.favorite = !state.note.favorite; $('favBtn').textContent = state.note.favorite ? '★' : '☆';
    await API.setFavorite(state.note.id, state.note.favorite); renderNoteList();
  });
  $('printBtn').addEventListener('click', function () { window.print(); });

  // New-note menu
  $('newNoteBtn').addEventListener('click', function () { createNewNote({}); });
  $('newNoteCaret').addEventListener('click', function (e) { e.stopPropagation(); renderTemplatePick(); $('newNoteMenu').classList.toggle('hidden'); });
  $('newNoteMenu').addEventListener('click', function (e) {
    var kind = e.target.getAttribute('data-new'); if (!kind) return;
    $('newNoteMenu').classList.add('hidden');
    createNewNote(kind === 'blank' ? { blank: true } : {});
  });
  async function createNewNote(opts) {
    state.note = await API.newNote(state.wsId, opts); showView('note'); renderNote(); renderNoteList();
  }
  function renderTemplatePick() {
    var box = $('templatePickList'); box.innerHTML = '';
    if (!state.templates.length) { box.innerHTML = '<div class="menu-empty">No templates yet</div>'; return; }
    state.templates.forEach(function (t) {
      var b = document.createElement('button'); b.textContent = t.name;
      b.addEventListener('click', function () { $('newNoteMenu').classList.add('hidden'); createNewNote({ templateId: t.id }); });
      box.appendChild(b);
    });
  }

  // Note ⋯ menu
  $('noteMoreBtn').addEventListener('click', function (e) { e.stopPropagation(); $('noteMoreMenu').classList.toggle('hidden'); });
  $('noteMoreMenu').addEventListener('click', async function (e) {
    var act = e.target.getAttribute('data-note'); if (!act) return;
    $('noteMoreMenu').classList.add('hidden');
    if (act === 'delete') {
      if (!confirm('Move this note to trash?')) return;
      await API.deleteNote(state.note.id); await loadCurrentNote();
    } else if (act === 'copy') {
      var copy = await API.copyNote(state.note.id, null); await loadWorkspaces(); await openNote(copy.id);
    } else if (act === 'move') { openMoveModal(); }
    else if (act === 'pin') {
      state.note.pinned = !state.note.pinned;
      await API.saveNote(state.note.id, { pinned: state.note.pinned, baseUpdatedAt: state.note.updatedAt }).then(function (s) { state.note.updatedAt = s.updatedAt; });
      renderNoteList();
    } else if (act === 'archive') {
      state.note.archived = !state.note.archived;
      await API.saveNote(state.note.id, { archived: state.note.archived, baseUpdatedAt: state.note.updatedAt }).then(function (s) { state.note.updatedAt = s.updatedAt; });
      renderNoteList();
    } else if (act === 'history') { openHistory(); }
  });

  function snoozeReminderTodo(t) {
    var hours = parseFloat(prompt('Snooze this reminder for how many hours?', '24')) || 24;
    var until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    API.snoozeReminder(state.wsId, t.sourceReminderId, until).then(function () { return loadCurrentNote(); });
  }

  // Note-link picker (for the editor's "link to a note" tool)
  function openNotePicker(insert) {
    openModal('notePickerModal');
    var search = $('notePickerSearch'); search.value = '';
    API.listNotes(state.wsId, 'all').then(function (notes) {
      function draw(filter) {
        var ul = $('notePickerList'); ul.innerHTML = '';
        notes.filter(function (n) { return !filter || n.displayTitle.toLowerCase().indexOf(filter) >= 0; }).forEach(function (n) {
          var li = document.createElement('li');
          var b = document.createElement('button'); b.className = 'link-btn'; b.textContent = n.displayTitle; b.style.flex = '1'; b.style.textAlign = 'left';
          b.addEventListener('click', function () { closeModals(); insert({ id: n.id, title: n.displayTitle }); });
          li.appendChild(b); ul.appendChild(li);
        });
      }
      draw('');
      search.oninput = function () { draw(search.value.trim().toLowerCase()); };
    });
  }

  // Version history
  async function openHistory() {
    openModal('historyModal');
    var versions = await API.listVersions(state.note.id);
    var ul = $('historyList'); ul.innerHTML = '';
    if (!versions.length) { ul.innerHTML = '<li class="muted tiny">No earlier versions yet — they accumulate as you edit.</li>'; return; }
    versions.forEach(function (v) {
      var li = document.createElement('li');
      var label = document.createElement('span'); label.style.flex = '1'; label.textContent = new Date(v.savedAt).toLocaleString();
      var restore = document.createElement('button'); restore.className = 'link-btn'; restore.textContent = 'restore';
      restore.addEventListener('click', async function () {
        if (!confirm('Restore this version? The current content is snapshotted first.')) return;
        state.note = await API.restoreVersion(state.note.id, v.ts); closeModals(); renderNote();
      });
      li.appendChild(label); li.appendChild(restore); ul.appendChild(li);
    });
  }

  $('noteFilter').addEventListener('change', renderNoteList);

  // Export menu
  $('exportBtn').addEventListener('click', function (e) { e.stopPropagation(); $('exportMenu').classList.toggle('hidden'); });
  $('exportMenu').addEventListener('click', function (e) {
    var fmt = e.target.getAttribute('data-fmt'); if (!fmt) return;
    $('exportMenu').classList.add('hidden');
    if (fmt === 'pdf') { window.print(); return; }
    downloadUrl(API.exportUrl(state.note.id, fmt));
  });

  // ---------------- Save (with conflict guard) ----------------
  function scheduleSave() { setSaveStatus('Saving…'); clearTimeout(state.saveTimer); state.saveTimer = setTimeout(saveNow, 600); }
  async function saveNow() {
    if (!state.note) return;
    try {
      var saved = await API.saveNote(state.note.id, {
        customTitle: state.note.customTitle, todos: state.note.todos, carryover: state.note.carryover,
        meetingNotes: state.note.meetingNotes, freeform: state.note.freeform, favorite: state.note.favorite,
        tags: state.note.tags, baseUpdatedAt: state.note.updatedAt,
      });
      state.note.todos = saved.todos; state.note.updatedAt = saved.updatedAt;
      setSaveStatus('Saved ✓'); renderNoteList();
    } catch (ex) {
      if (ex.status === 409) {
        setSaveStatus('⚠ Changed elsewhere');
        var keepBoth = confirm('This note was changed in another tab or device.\n\nOK = keep BOTH (save your version as a conflict copy).\nCancel = discard your changes and load the latest.');
        if (keepBoth) {
          var fork = await API.forkNote(state.note.id, {
            customTitle: state.note.customTitle, todos: state.note.todos, carryover: state.note.carryover,
            meetingNotes: state.note.meetingNotes, freeform: state.note.freeform, tags: state.note.tags,
          });
          await loadWorkspaces(); await openNote(fork.id); setSaveStatus('Saved as a conflict copy ✓');
        } else if (ex.data && ex.data.current) { state.note = ex.data.current; renderNote(); }
        else await loadCurrentNote();
      } else { setSaveStatus('Save failed: ' + ex.message); }
    }
  }
  function setSaveStatus(s) { $('saveStatus').textContent = s; }
  window.addEventListener('beforeunload', function () { if (state.saveTimer) saveNow(); });

  // ---------------- Layout ----------------
  $('layoutToggle').addEventListener('click', async function () {
    state.settings.layout = state.settings.layout === 'columns' ? 'rows' : 'columns';
    applyLayout(); await API.saveSettings({ layout: state.settings.layout });
  });
  function applyLayout() { $('sections').className = 'sections ' + (state.settings.layout || 'columns'); }

  // ---------------- Views ----------------
  function showView(v) {
    state.view = v;
    ['noteView', 'todosView', 'favsView', 'trashView', 'searchView', 'agendaView'].forEach(function (id) { $(id).classList.add('hidden'); });
    $('navNote').classList.toggle('active', v === 'note');
    $('navTodos').classList.toggle('active', v === 'todos');
    $('navFavs').classList.toggle('active', v === 'favs');
    $('navAgenda').classList.toggle('active', v === 'agenda');
    var map = { note: 'noteView', todos: 'todosView', favs: 'favsView', trash: 'trashView', search: 'searchView', agenda: 'agendaView' };
    if (map[v]) $(map[v]).classList.remove('hidden');
  }
  $('navNote').addEventListener('click', function () { showView('note'); renderNoteList(); });
  $('navTodos').addEventListener('click', renderGlobalTodos);
  $('navFavs').addEventListener('click', renderFavorites);
  $('navAgenda').addEventListener('click', renderAgenda);

  async function renderAgenda() {
    showView('agenda');
    var box = $('agendaList'); box.innerHTML = '<p class="muted">Loading…</p>';
    var todos = await API.globalTodos();
    var groups = {};
    todos.filter(function (t) { return t.due; }).forEach(function (t) { (groups[t.due] = groups[t.due] || []).push(t); });
    var dates = Object.keys(groups).sort();
    box.innerHTML = '';
    if (!dates.length) { box.innerHTML = '<p class="muted">No dated to-dos. Add a due date to a to-do to see it here.</p>'; return; }
    dates.forEach(function (d) {
      var h = document.createElement('div'); h.className = 'agenda-day' + (d < todayStr() ? ' overdue' : '');
      h.innerHTML = '<div class="agenda-date">' + esc(d) + (d < todayStr() ? ' · overdue' : (d === todayStr() ? ' · today' : '')) + '</div>';
      groups[d].forEach(function (t) {
        var row = document.createElement('div'); row.className = 'agenda-item';
        row.innerHTML = '<span class="gt-ws">' + esc(t.workspaceName) + '</span> ' + esc(t.text);
        row.addEventListener('click', function () { openNote(t.noteId); });
        h.appendChild(row);
      });
      box.appendChild(h);
    });
  }

  async function renderGlobalTodos() {
    showView('todos');
    var todos = await API.globalTodos();
    var ul = $('globalTodoList'); ul.innerHTML = '';
    if (!todos.length) { ul.innerHTML = '<li class="muted">No open to-dos. 🎉</li>'; return; }
    todos.forEach(function (t) {
      var li = document.createElement('li');
      if (t.due && t.due < todayStr()) li.classList.add('overdue');
      var cb = document.createElement('input'); cb.type = 'checkbox';
      cb.addEventListener('change', async function () {
        await API.toggleTodo(t.noteId, t.todoId, cb.checked); li.classList.toggle('done', cb.checked);
        if (state.note && state.note.id === t.noteId) { state.note = await API.getNote(t.noteId); renderTodos(); }
        setTimeout(renderGlobalTodos, 400);
      });
      li.appendChild(cb);
      var ws = document.createElement('span'); ws.className = 'gt-ws'; ws.textContent = t.workspaceName;
      var text = document.createElement('span'); text.className = 'gt-text'; text.textContent = t.text;
      li.appendChild(ws); li.appendChild(text);
      if (t.due) { var d = document.createElement('span'); d.className = 'gt-due'; d.textContent = '📅 ' + t.due; li.appendChild(d); }
      var link = document.createElement('button'); link.className = 'link-btn'; link.textContent = 'open';
      link.addEventListener('click', function () { openNote(t.noteId); });
      li.appendChild(link); ul.appendChild(li);
    });
  }

  async function renderFavorites() {
    showView('favs');
    var favs = await API.favorites();
    var ul = $('favList'); ul.innerHTML = '';
    if (!favs.length) { ul.innerHTML = '<li class="muted">No favorites yet. Star a note to add it here.</li>'; return; }
    favs.forEach(function (f) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="nl-fav">★</span><span class="fv-title">' + esc(f.displayTitle) + '</span><span class="gt-ws">' + esc(f.workspaceName) + '</span>';
      li.addEventListener('click', function () { openNote(f.id); }); ul.appendChild(li);
    });
  }

  async function renderTrash() {
    showView('trash');
    var items = await API.listTrash();
    var ul = $('trashList'); ul.innerHTML = '';
    if (!items.length) { ul.innerHTML = '<li class="muted">Trash is empty.</li>'; return; }
    items.forEach(function (f) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="fv-title">' + esc(f.displayTitle) + '</span><span class="gt-ws">' + esc(f.workspaceName) + '</span>';
      var restore = document.createElement('button'); restore.className = 'link-btn'; restore.textContent = 'restore';
      restore.addEventListener('click', async function () { await API.restoreTrash(f.id); await loadWorkspaces(); renderTrash(); });
      var purge = document.createElement('button'); purge.className = 'link-btn danger'; purge.textContent = 'delete forever';
      purge.addEventListener('click', async function () { if (confirm('Permanently delete “' + f.displayTitle + '”?')) { await API.purgeTrash(f.id); renderTrash(); } });
      li.appendChild(restore); li.appendChild(purge); ul.appendChild(li);
    });
  }

  // ---------------- Search ----------------
  var searchTimer;
  $('globalSearch').addEventListener('input', function () {
    clearTimeout(searchTimer);
    var q = $('globalSearch').value.trim();
    if (!q) { if (state.view === 'search') showView('note'); return; }
    searchTimer = setTimeout(function () { runSearch(q); }, 250);
  });
  async function runSearch(q) {
    var results = await API.search(q); showView('search');
    var ul = $('searchResults'); ul.innerHTML = '';
    if (!results.length) { ul.innerHTML = '<li class="muted">No matches for “' + esc(q) + '”.</li>'; return; }
    results.forEach(function (r) {
      var li = document.createElement('li');
      var tags = (r.tags || []).length ? ' <span class="sr-tags">' + r.tags.map(function (t) { return '#' + esc(t); }).join(' ') + '</span>' : '';
      li.innerHTML = '<div class="sr-top"><span class="sr-title">' + esc(r.title) + '</span><span class="sr-ws">' + esc(r.workspaceName) + '</span></div>' +
        '<div class="sr-snippet">' + esc(r.snippet) + tags + '</div>';
      li.addEventListener('click', function () { openNote(r.noteId); $('globalSearch').value = ''; }); ul.appendChild(li);
    });
  }

  // ---------------- Templates ----------------
  async function loadTemplates() { state.templates = await API.listTemplates(); }
  function openTemplateModal() { openModal('templateModal'); clearTplEditor(); renderTemplateList(); }
  function renderTemplateList() {
    var ul = $('templateList'); ul.innerHTML = '';
    state.templates.forEach(function (t) {
      var li = document.createElement('li');
      var name = document.createElement('span'); name.className = 'wm-name'; name.textContent = t.name; name.style.flex = '1';
      var edit = document.createElement('button'); edit.className = 'link-btn'; edit.textContent = 'edit';
      edit.addEventListener('click', function () { loadTplIntoEditor(t); });
      var del = document.createElement('button'); del.className = 'wm-del'; del.textContent = '🗑';
      del.addEventListener('click', async function () { if (confirm('Delete template “' + t.name + '”?')) { await API.deleteTemplate(t.id); await loadTemplates(); renderTemplateList(); } });
      li.appendChild(name); li.appendChild(edit); li.appendChild(del); ul.appendChild(li);
    });
  }
  function clearTplEditor() { $('tplEditingId').value = ''; $('tplName').value = ''; $('tplMeeting').innerHTML = ''; $('tplTodos').value = ''; }
  function loadTplIntoEditor(t) { $('tplEditingId').value = t.id; $('tplName').value = t.name; $('tplMeeting').innerHTML = t.meetingNotes || ''; $('tplTodos').value = (t.defaultTodos || []).join('\n'); }
  $('clearTplBtn').addEventListener('click', clearTplEditor);
  $('saveTplBtn').addEventListener('click', async function () {
    var data = {
      name: $('tplName').value.trim() || 'Template',
      meetingNotes: $('tplMeeting').innerHTML,
      defaultTodos: $('tplTodos').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
    };
    var id = $('tplEditingId').value;
    if (id) await API.updateTemplate(id, data); else await API.createTemplate(data);
    await loadTemplates(); renderTemplateList(); clearTplEditor();
  });

  // ---------------- More menu + modals ----------------
  $('moreBtn').addEventListener('click', function (e) { e.stopPropagation(); $('moreMenu').classList.toggle('hidden'); });
  $('moreMenu').addEventListener('click', function (e) {
    var m = e.target.getAttribute('data-more'); if (!m) return;
    $('moreMenu').classList.add('hidden');
    if (m === 'templates') openTemplateModal();
    else if (m === 'trash') renderTrash();
    else if (m === 'backup') openModal('backupModal');
    else if (m === 'account') {
      $('acctMsg').textContent = '';
      var inst = state.instance || {};
      $('instanceInfo').innerHTML = '<b>' + esc(inst.name || 'Meeting Notes') + '</b> · v' + esc(inst.version || '') +
        '<br>URL: <code>' + esc(inst.url || location.origin) + '</code>' +
        (inst.domain ? '' : '<br><span class="muted">Tip: run <code>node server.js --set-domain notes</code> for a durable &lt;name&gt;.localhost address.</span>');
      $('fontSize').value = state.settings.fontSize || 14;
      openModal('accountModal');
    }
  });

  // Workspaces modal
  $('manageWs').addEventListener('click', openWsModal);
  function openWsModal() { openModal('wsModal'); renderWsManage(); }
  function renderWsManage() {
    var ul = $('wsManageList'); ul.innerHTML = '';
    state.workspaces.forEach(function (w) {
      var li = document.createElement('li');
      var inp = document.createElement('input'); inp.value = w.name; inp.style.flex = '1';
      inp.addEventListener('change', function () { API.renameWorkspace(w.id, inp.value).then(loadWorkspaces); });
      var tsel = document.createElement('select'); tsel.className = 'ws-tpl';
      tsel.innerHTML = '<option value="">No default template</option>' + state.templates.map(function (t) { return '<option value="' + t.id + '"' + (w.defaultTemplateId === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('');
      tsel.addEventListener('change', function () { API.setWorkspaceTemplate(w.id, tsel.value || null).then(loadWorkspaces); });
      li.appendChild(inp); li.appendChild(tsel);
      if (w.id !== 'general') {
        var del = document.createElement('button'); del.className = 'wm-del'; del.textContent = '🗑';
        del.addEventListener('click', async function () {
          if (!confirm('Delete workspace “' + w.name + '” and all its notes? (Not recoverable)')) return;
          await API.deleteWorkspace(w.id); if (state.wsId === w.id) state.wsId = 'general';
          await loadWorkspaces(); renderWsManage(); await loadCurrentNote();
        });
        li.appendChild(del);
      }
      ul.appendChild(li);
    });
  }
  $('createWsBtn').addEventListener('click', async function () {
    var name = $('newWsName').value.trim(); if (!name) return;
    var w = await API.createWorkspace(name); $('newWsName').value = '';
    await loadWorkspaces(); renderWsManage(); state.wsId = w.id; $('workspaceSelect').value = w.id; await loadCurrentNote();
  });

  // Import
  $('importBtn').addEventListener('click', function () { openModal('importModal'); });
  $('doImportBtn').addEventListener('click', async function () {
    var file = $('importFile').files[0]; if (!file) { alert('Choose a file to import.'); return; }
    var text = await file.text();
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var fmt = ext === 'json' ? 'json' : (ext === 'md' || ext === 'markdown') ? 'md' : 'html';
    var note = await API.importNote(state.wsId, { format: fmt, content: text, title: $('importTitle').value.trim() || null });
    closeModals(); await openNote(note.id);
  });

  // Move
  function openMoveModal() {
    var sel = $('moveTarget'); sel.innerHTML = '';
    state.workspaces.filter(function (w) { return w.id !== state.note.workspaceId; }).forEach(function (w) {
      var o = document.createElement('option'); o.value = w.id; o.textContent = w.name; sel.appendChild(o);
    });
    if (!sel.options.length) { alert('Create another workspace first.'); return; }
    openModal('moveModal');
  }
  $('doMoveBtn').addEventListener('click', async function () {
    var target = $('moveTarget').value; var note = await API.moveNote(state.note.id, target);
    closeModals(); await loadWorkspaces(); await openNote(note.id);
  });

  // Account: change passphrase + recovery
  $('changePassBtn').addEventListener('click', async function () {
    try {
      await API.changePassphrase($('oldPass').value, $('newPass').value);
      $('oldPass').value = ''; $('newPass').value = ''; acctMsg('Passphrase updated ✓', false);
    } catch (ex) { acctMsg(ex.message, true); }
  });
  $('regenRecoveryBtn').addEventListener('click', async function () {
    if (!confirm('Generate a new recovery key? The old one stops working.')) return;
    try { var r = await API.regenerateRecovery(); closeModals(); showRecovery(r.recoveryKey); } catch (ex) { acctMsg(ex.message, true); }
  });
  function acctMsg(s, isErr) { var el = $('acctMsg'); el.textContent = s; el.style.color = isErr ? 'var(--danger)' : 'var(--muted)'; }

  // Font size
  $('fontSize').addEventListener('input', function () {
    var px = parseInt($('fontSize').value, 10) || 14; applyFontSize(px);
    state.settings.fontSize = px; API.saveSettings({ fontSize: px });
  });

  // Backup / restore + bulk export
  $('downloadBackupBtn').addEventListener('click', function () { downloadUrl(API.backupUrl()); });
  $('bulkExportBtn').addEventListener('click', function () { downloadUrl(API.workspaceZipUrl(state.wsId, $('bulkFormat').value)); });
  $('verifyBtn').addEventListener('click', async function () {
    var msg = $('verifyMsg'); msg.textContent = 'Checking…'; msg.style.color = 'var(--muted)';
    try {
      var r = await API.verifyIntegrity();
      if (r.ok) { msg.textContent = '✓ All ' + r.checked + ' files decrypt cleanly.'; msg.style.color = 'var(--muted)'; }
      else { msg.style.color = 'var(--danger)'; msg.textContent = '⚠ ' + r.corrupt.length + ' of ' + r.checked + ' files are unreadable: ' + r.corrupt.map(function (x) { return x.path; }).join(', '); }
    } catch (ex) { msg.style.color = 'var(--danger)'; msg.textContent = 'Check failed: ' + ex.message; }
  });
  $('restoreBtn').addEventListener('click', async function () {
    var f = $('restoreFile').files[0]; if (!f) { $('restoreMsg').textContent = 'Choose a backup file.'; return; }
    try {
      var bundle = JSON.parse(await f.text());
      await API.restore(bundle);
      $('restoreMsg').textContent = 'Restored. Reloading…'; setTimeout(function () { location.reload(); }, 800);
    } catch (ex) { $('restoreMsg').textContent = 'Restore failed: ' + ex.message; }
  });

  // Recovery-key display modal
  function showRecovery(key, subtitle) {
    if (subtitle) $('recoveryModal').querySelector('p').textContent = subtitle;
    $('recoveryValue').textContent = key; openModal('recoveryModal');
  }
  $('copyRecoveryBtn').addEventListener('click', function () {
    var t = $('recoveryValue').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { $('copyRecoveryBtn').textContent = 'Copied ✓'; });
  });

  // Modal helpers
  var MODALS = ['wsModal', 'importModal', 'templateModal', 'accountModal', 'backupModal', 'moveModal', 'recoveryModal', 'historyModal', 'notePickerModal'];
  function openModal(id) {
    $('modalBackdrop').classList.remove('hidden');
    MODALS.forEach(function (m) { $(m).classList.toggle('hidden', m !== id); });
  }
  function closeModals() {
    $('modalBackdrop').classList.add('hidden');
    MODALS.forEach(function (m) { $(m).classList.add('hidden'); });
  }
  document.querySelectorAll('.modal-close').forEach(function (b) { b.addEventListener('click', closeModals); });
  $('modalBackdrop').addEventListener('click', function (e) { if (e.target === $('modalBackdrop')) closeModals(); });

  // close popovers on outside click / Escape
  document.addEventListener('click', function (e) {
    ['exportMenu', 'noteMoreMenu', 'moreMenu', 'newNoteMenu'].forEach(function (id) {
      var el = $(id); if (el && !el.contains(e.target)) el.classList.add('hidden');
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModals(); ['exportMenu', 'noteMoreMenu', 'moreMenu', 'newNoteMenu'].forEach(function (id) { $(id).classList.add('hidden'); }); }
  });

  // ---------------- Notifications + reminder polling ----------------
  $('notifyBtn').addEventListener('click', async function () {
    if (!('Notification' in window)) { alert('Notifications are not supported in this browser.'); return; }
    var perm = await Notification.requestPermission();
    state.notify = perm === 'granted';
    $('notifyBtn').textContent = state.notify ? '🔔' : '🔕';
    if (state.notify) pollReminders();
  });
  function startReminderPolling() { pollReminders(); setInterval(pollReminders, 60 * 1000); }
  async function pollReminders() {
    try {
      var surfaced = await API.processReminders();
      var refreshCurrent = false;
      surfaced.forEach(function (s) {
        if (state.notify && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('Reminder: ' + s.text, { body: s.workspaceName });
        }
        if (s.workspaceId === state.wsId) refreshCurrent = true;
      });
      if (refreshCurrent && state.view === 'note') { state.note = await API.currentNote(state.wsId); renderTodos(); }
    } catch (e) { /* ignore transient poll errors */ }
  }

  // ---------------- Idle auto-lock ----------------
  var idleTimer;
  function startIdleTimer() {
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, resetIdle, { passive: true }); });
    resetIdle();
  }
  function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(lockNow, IDLE_MS); }
  async function lockNow() { if (state.saveTimer) await saveNow(); try { await API.logout(); } catch (e) {} location.reload(); }

  // ---------------- Keyboard shortcuts ----------------
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var editable = e.target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
    if (editable || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); $('globalSearch').focus(); }
    else if (e.key === 'n') { e.preventDefault(); createNewNote({}); }
    else if (e.key === 'l') { e.preventDefault(); $('layoutToggle').click(); }
  });

  // ---------------- Logout ----------------
  $('logoutBtn').addEventListener('click', async function () {
    if (state.saveTimer) await saveNow(); await API.logout(); location.reload();
  });

  // ---------------- Utils ----------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function rid() { return Math.random().toString(36).slice(2, 10); }
  function fmtSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
  function fileToBase64(file) { return new Promise(function (resolve, reject) { var r = new FileReader(); r.onload = function () { resolve(String(r.result).split(',')[1]); }; r.onerror = reject; r.readAsDataURL(file); }); }
  function downloadUrl(u) { var a = document.createElement('a'); a.href = u; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }

  boot().catch(function (e) { console.error(e); });
})();
