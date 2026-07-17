/* Meeting Notes — main application controller. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var API = window.API;

  var state = {
    initialized: false,
    workspaces: [],
    wsId: null,
    note: null,
    settings: { layout: 'columns' },
    view: 'note',
    saveTimer: null,
    freeMode: false,
  };

  // ---------------- Auth ----------------
  async function boot() {
    var st = await API.status();
    state.initialized = st.initialized;
    if (st.authenticated) return startApp();
    showAuth(st.initialized);
  }

  function showAuth(initialized) {
    $('app').classList.add('hidden');
    $('authGate').classList.remove('hidden');
    $('authSubtitle').textContent = initialized
      ? 'Enter your passphrase to unlock your notes.'
      : 'Welcome! Create a passphrase to encrypt your notes.';
    $('authLabel').textContent = initialized ? 'Passphrase' : 'Create passphrase';
    $('authSubmit').textContent = initialized ? 'Unlock' : 'Create vault';
    $('passphrase2').classList.toggle('hidden', initialized);
    $('passphrase').value = '';
    $('passphrase2').value = '';
  }

  $('authForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('authError');
    err.classList.add('hidden');
    var pass = $('passphrase').value;
    try {
      if (!state.initialized) {
        if (pass.length < 8) throw new Error('Passphrase must be at least 8 characters.');
        if (pass !== $('passphrase2').value) throw new Error('Passphrases do not match.');
        await API.setup(pass);
      } else {
        await API.login(pass);
      }
      startApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });

  window.addEventListener('mn-unauthorized', function () {
    location.reload();
  });

  async function startApp() {
    $('authGate').classList.add('hidden');
    $('app').classList.remove('hidden');
    state.settings = await API.getSettings();
    applyLayout();
    await loadWorkspaces();
    await loadCurrentNote();
  }

  // ---------------- Workspaces ----------------
  async function loadWorkspaces() {
    state.workspaces = await API.listWorkspaces();
    if (!state.wsId || !state.workspaces.some(function (w) { return w.id === state.wsId; })) {
      state.wsId = state.workspaces[0].id;
    }
    var sel = $('workspaceSelect');
    sel.innerHTML = '';
    state.workspaces.forEach(function (w) {
      var o = document.createElement('option');
      o.value = w.id; o.textContent = w.name;
      if (w.id === state.wsId) o.selected = true;
      sel.appendChild(o);
    });
  }

  $('workspaceSelect').addEventListener('change', async function () {
    state.wsId = $('workspaceSelect').value;
    showView('note');
    await loadCurrentNote();
  });

  // ---------------- Note loading / rendering ----------------
  async function loadCurrentNote() {
    state.note = await API.currentNote(state.wsId);
    renderNote();
    await Promise.all([renderNoteList(), renderReminders()]);
  }

  async function openNote(id) {
    state.note = await API.getNote(id);
    state.wsId = state.note.workspaceId;
    $('workspaceSelect').value = state.wsId;
    showView('note');
    renderNote();
    renderNoteList();
    renderReminders();
  }

  function renderNote() {
    var n = state.note;
    $('noteDate').textContent = n.title;
    $('noteCustomTitle').value = n.customTitle || '';
    $('favBtn').textContent = n.favorite ? '★' : '☆';
    $('favBtn').classList.toggle('on', !!n.favorite);
    renderTodos();
    $('carryoverEditor').innerHTML = n.carryover || '';
    $('meetingEditor').innerHTML = n.meetingNotes || '';
    renderFreeform();
    renderAttachments();
    setSaveStatus('');
  }

  async function renderNoteList() {
    var notes = await API.listNotes(state.wsId);
    var ul = $('noteList');
    ul.innerHTML = '';
    notes.forEach(function (nm) {
      var li = document.createElement('li');
      if (state.note && nm.id === state.note.id && state.view === 'note') li.classList.add('active');
      li.innerHTML =
        '<div class="nl-title">' + (nm.favorite ? '<span class="nl-fav">★</span> ' : '') + esc(nm.displayTitle) + '</div>' +
        '<div class="nl-meta"><span>' + nm.openTodoCount + ' open</span>' +
        (nm.attachmentCount ? '<span>📎 ' + nm.attachmentCount + '</span>' : '') + '</div>';
      li.addEventListener('click', function () { openNote(nm.id); });
      ul.appendChild(li);
    });
  }

  // ---------------- To-dos ----------------
  function renderTodos() {
    var ul = $('todoList');
    ul.innerHTML = '';
    (state.note.todos || []).forEach(function (t) {
      var li = document.createElement('li');
      li.className = t.done ? 'done' : '';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!t.done;
      cb.addEventListener('change', function () { toggleTodo(t.id, cb.checked); });
      var span = document.createElement('span');
      span.className = 'todo-text'; span.contentEditable = 'true'; span.textContent = t.text;
      span.addEventListener('blur', function () { t.text = span.textContent.trim(); scheduleSave(); });
      var badge = t.sourceReminderId ? '<span class="reminder-badge">⏰</span>' : '';
      var del = document.createElement('button');
      del.className = 'todo-del'; del.textContent = '✕';
      del.addEventListener('click', function () {
        state.note.todos = state.note.todos.filter(function (x) { return x.id !== t.id; });
        renderTodos(); scheduleSave();
      });
      li.appendChild(cb); li.appendChild(span);
      if (badge) { var b = document.createElement('span'); b.innerHTML = badge; li.appendChild(b.firstChild); }
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  function toggleTodo(id, done) {
    var t = state.note.todos.find(function (x) { return x.id === id; });
    if (!t) return;
    t.done = done; t.doneAt = done ? new Date().toISOString() : null;
    // move completed to bottom
    var open = state.note.todos.filter(function (x) { return !x.done; });
    var closed = state.note.todos.filter(function (x) { return x.done; });
    state.note.todos = open.concat(closed);
    renderTodos(); scheduleSave();
  }

  $('todoInput').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var text = $('todoInput').value.trim();
    if (!text) return;
    state.note.todos = state.note.todos || [];
    state.note.todos.unshift({ id: rid(), text: text, done: false, doneAt: null, sourceReminderId: null });
    // keep completed at the bottom
    var open = state.note.todos.filter(function (x) { return !x.done; });
    var closed = state.note.todos.filter(function (x) { return x.done; });
    state.note.todos = open.concat(closed);
    $('todoInput').value = '';
    renderTodos(); scheduleSave();
  });

  // ---------------- Reminders ----------------
  $('reminderCadence').addEventListener('change', function () {
    var v = $('reminderCadence').value;
    $('reminderN').classList.toggle('hidden', v !== 'everyNDays');
    $('reminderDue').classList.toggle('hidden', v !== 'once');
  });

  $('addReminderBtn').addEventListener('click', async function () {
    var text = $('reminderText').value.trim();
    if (!text) return;
    var type = $('reminderCadence').value;
    var cadence = { type: type };
    if (type === 'everyNDays') cadence.n = parseInt($('reminderN').value, 10) || 1;
    if (type === 'once') cadence.dueDate = $('reminderDue').value || undefined;
    await API.addReminder(state.wsId, { text: text, cadence: cadence });
    $('reminderText').value = '';
    await renderReminders();
    await loadCurrentNote(); // pull in any now-due reminder as a to-do
  });

  async function renderReminders() {
    var rems = await API.listReminders(state.wsId);
    var ul = $('reminderList');
    ul.innerHTML = '';
    rems.forEach(function (r) {
      var li = document.createElement('li');
      if (!r.active) li.classList.add('inactive');
      var cadenceLabel = describeCadence(r.cadence);
      li.innerHTML =
        '<input type="checkbox" ' + (r.active ? 'checked' : '') + '>' +
        '<span class="rm-text">' + esc(r.text) + '<br><span class="rm-cadence">' + cadenceLabel + '</span></span>' +
        '<button class="rm-del">🗑</button>';
      li.querySelector('input').addEventListener('change', function (e) {
        API.updateReminder(state.wsId, r.id, { active: e.target.checked }).then(renderReminders);
      });
      li.querySelector('.rm-del').addEventListener('click', function () {
        API.deleteReminder(state.wsId, r.id).then(renderReminders);
      });
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

  // ---------------- Rich text editors ----------------
  window.Editor.init($('sections').querySelector('[data-target="carryoverEditor"]'), $('carryoverEditor'));
  window.Editor.init($('sections').querySelector('[data-target="meetingEditor"]'), $('meetingEditor'));
  $('carryoverEditor').addEventListener('input', function () { state.note.carryover = $('carryoverEditor').innerHTML; scheduleSave(); });
  $('meetingEditor').addEventListener('input', function () { state.note.meetingNotes = $('meetingEditor').innerHTML; scheduleSave(); });

  // ---------------- Free-form canvas ----------------
  $('modeFlow').addEventListener('click', function () { setFreeMode(false); });
  $('modeFree').addEventListener('click', function () { setFreeMode(true); });
  function setFreeMode(on) {
    state.freeMode = on;
    $('modeFlow').classList.toggle('active', !on);
    $('modeFree').classList.toggle('active', on);
    $('flowWrap').classList.toggle('hidden', on);
    $('freeWrap').classList.toggle('hidden', !on);
  }

  $('freeCanvas').addEventListener('dblclick', function (e) {
    if (e.target !== $('freeCanvas')) return;
    var rect = $('freeCanvas').getBoundingClientRect();
    var box = { id: rid(), x: e.clientX - rect.left, y: e.clientY - rect.top, w: 160, html: '' };
    state.note.freeform = state.note.freeform || [];
    state.note.freeform.push(box);
    renderFreeform();
    scheduleSave();
    var el = $('freeCanvas').querySelector('[data-fb="' + box.id + '"] .fb-edit');
    if (el) el.focus();
  });

  function renderFreeform() {
    var canvas = $('freeCanvas');
    canvas.innerHTML = '';
    (state.note.freeform || []).forEach(function (box) {
      var el = document.createElement('div');
      el.className = 'free-box';
      el.setAttribute('data-fb', box.id);
      el.style.left = box.x + 'px'; el.style.top = box.y + 'px'; el.style.width = box.w + 'px';
      el.innerHTML = '<div class="fb-edit" contenteditable="true"></div><button class="fb-del">✕</button>';
      var edit = el.querySelector('.fb-edit');
      edit.innerHTML = box.html || '';
      edit.addEventListener('input', function () { box.html = edit.innerHTML; scheduleSave(); });
      el.querySelector('.fb-del').addEventListener('click', function () {
        state.note.freeform = state.note.freeform.filter(function (b) { return b.id !== box.id; });
        renderFreeform(); scheduleSave();
      });
      enableBoxDrag(el, edit, box);
      canvas.appendChild(el);
    });
  }

  function enableBoxDrag(el, edit, box) {
    el.addEventListener('mousedown', function (e) {
      if (e.target === edit || e.target.classList.contains('fb-del')) return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY, ox = box.x, oy = box.y;
      function move(ev) {
        box.x = Math.max(0, ox + ev.clientX - sx);
        box.y = Math.max(0, oy + ev.clientY - sy);
        el.style.left = box.x + 'px'; el.style.top = box.y + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        scheduleSave();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
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
      state.note.attachments = state.note.attachments || [];
      state.note.attachments.push(meta);
    }
    $('attachInput').value = '';
    renderAttachments();
  });

  function renderAttachments() {
    var ul = $('attachList');
    ul.innerHTML = '';
    (state.note.attachments || []).forEach(function (a) {
      var li = document.createElement('li');
      var a1 = document.createElement('a');
      a1.href = API.attachmentUrl(state.note.id, a.id);
      a1.textContent = a.name; a1.target = '_blank'; a1.rel = 'noopener';
      var size = document.createElement('span'); size.className = 'at-size'; size.textContent = fmtSize(a.size);
      var del = document.createElement('button'); del.className = 'at-del'; del.textContent = '✕';
      del.addEventListener('click', async function () {
        await API.deleteAttachment(state.note.id, a.id);
        state.note.attachments = state.note.attachments.filter(function (x) { return x.id !== a.id; });
        renderAttachments();
      });
      li.appendChild(a1); li.appendChild(size); li.appendChild(del);
      ul.appendChild(li);
    });
  }

  // ---------------- Note header actions ----------------
  $('noteCustomTitle').addEventListener('input', function () {
    state.note.customTitle = $('noteCustomTitle').value; scheduleSave();
  });
  $('favBtn').addEventListener('click', async function () {
    state.note.favorite = !state.note.favorite;
    $('favBtn').textContent = state.note.favorite ? '★' : '☆';
    await API.setFavorite(state.note.id, state.note.favorite);
    renderNoteList();
  });
  $('newNoteBtn').addEventListener('click', async function () {
    state.note = await API.newNote(state.wsId, {});
    renderNote(); renderNoteList();
  });
  $('deleteNoteBtn').addEventListener('click', async function () {
    if (!confirm('Delete this note? This cannot be undone.')) return;
    await API.deleteNote(state.note.id);
    await loadCurrentNote();
  });

  // Export menu
  $('exportBtn').addEventListener('click', function () { $('exportMenu').classList.toggle('hidden'); });
  $('exportMenu').addEventListener('click', function (e) {
    var fmt = e.target.getAttribute('data-fmt');
    if (!fmt) return;
    $('exportMenu').classList.add('hidden');
    if (fmt === 'pdf') { window.print(); return; }
    var a = document.createElement('a');
    a.href = API.exportUrl(state.note.id, fmt); a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  });
  $('printBtn').addEventListener('click', function () { window.print(); });
  document.addEventListener('click', function (e) {
    if (!$('exportMenu').contains(e.target) && e.target !== $('exportBtn')) $('exportMenu').classList.add('hidden');
  });

  // ---------------- Save ----------------
  function scheduleSave() {
    setSaveStatus('Saving…');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, 600);
  }
  async function saveNow() {
    if (!state.note) return;
    try {
      var saved = await API.saveNote(state.note.id, {
        customTitle: state.note.customTitle,
        todos: state.note.todos,
        carryover: state.note.carryover,
        meetingNotes: state.note.meetingNotes,
        freeform: state.note.freeform,
        favorite: state.note.favorite,
      });
      state.note.todos = saved.todos; // adopt server normalization
      setSaveStatus('Saved ✓');
      renderNoteList();
    } catch (ex) {
      setSaveStatus('Save failed: ' + ex.message);
    }
  }
  function setSaveStatus(s) { $('saveStatus').textContent = s; }
  window.addEventListener('beforeunload', function () { if (state.saveTimer) saveNow(); });

  // ---------------- Layout toggle ----------------
  $('layoutToggle').addEventListener('click', async function () {
    state.settings.layout = state.settings.layout === 'columns' ? 'rows' : 'columns';
    applyLayout();
    await API.saveSettings({ layout: state.settings.layout });
  });
  function applyLayout() {
    $('sections').className = 'sections ' + (state.settings.layout || 'columns');
  }

  // ---------------- Views ----------------
  function showView(v) {
    state.view = v;
    ['noteView', 'todosView', 'favsView', 'searchView'].forEach(function (id) { $(id).classList.add('hidden'); });
    $('navNote').classList.toggle('active', v === 'note');
    $('navTodos').classList.toggle('active', v === 'todos');
    $('navFavs').classList.toggle('active', v === 'favs');
    if (v === 'note') $('noteView').classList.remove('hidden');
    if (v === 'todos') $('todosView').classList.remove('hidden');
    if (v === 'favs') $('favsView').classList.remove('hidden');
    if (v === 'search') $('searchView').classList.remove('hidden');
  }

  $('navNote').addEventListener('click', function () { showView('note'); renderNoteList(); });
  $('navTodos').addEventListener('click', renderGlobalTodos);
  $('navFavs').addEventListener('click', renderFavorites);

  async function renderGlobalTodos() {
    showView('todos');
    var todos = await API.globalTodos();
    var ul = $('globalTodoList');
    ul.innerHTML = '';
    if (!todos.length) { ul.innerHTML = '<li class="muted">No open to-dos. 🎉</li>'; return; }
    todos.forEach(function (t) {
      var li = document.createElement('li');
      var cb = document.createElement('input'); cb.type = 'checkbox';
      cb.addEventListener('change', async function () {
        await API.toggleTodo(t.noteId, t.todoId, cb.checked);
        li.classList.toggle('done', cb.checked);
        if (state.note && state.note.id === t.noteId) { state.note = await API.getNote(t.noteId); renderTodos(); }
        setTimeout(renderGlobalTodos, 400);
      });
      li.appendChild(cb);
      var ws = document.createElement('span'); ws.className = 'gt-ws'; ws.textContent = t.workspaceName;
      var text = document.createElement('span'); text.className = 'gt-text'; text.textContent = t.text;
      var link = document.createElement('button'); link.className = 'link-btn'; link.textContent = 'open';
      link.addEventListener('click', function () { openNote(t.noteId); });
      li.appendChild(ws); li.appendChild(text); li.appendChild(link);
      ul.appendChild(li);
    });
  }

  async function renderFavorites() {
    showView('favs');
    var favs = await API.favorites();
    var ul = $('favList');
    ul.innerHTML = '';
    if (!favs.length) { ul.innerHTML = '<li class="muted">No favorites yet. Star a note to add it here.</li>'; return; }
    favs.forEach(function (f) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="nl-fav">★</span><span class="fv-title">' + esc(f.displayTitle) +
        '</span><span class="gt-ws">' + esc(f.workspaceName) + '</span>';
      li.addEventListener('click', function () { openNote(f.id); });
      ul.appendChild(li);
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
    var results = await API.search(q);
    showView('search');
    var ul = $('searchResults');
    ul.innerHTML = '';
    if (!results.length) { ul.innerHTML = '<li class="muted">No matches for “' + esc(q) + '”.</li>'; return; }
    results.forEach(function (r) {
      var li = document.createElement('li');
      li.innerHTML =
        '<div class="sr-top"><span class="sr-title">' + esc(r.title) + '</span>' +
        '<span class="sr-ws">' + esc(r.workspaceName) + '</span></div>' +
        '<div class="sr-snippet">' + esc(r.snippet) + '</div>';
      li.addEventListener('click', function () { openNote(r.noteId); $('globalSearch').value = ''; });
      ul.appendChild(li);
    });
  }

  // ---------------- Modals: workspaces + import ----------------
  $('manageWs').addEventListener('click', openWsModal);
  function openWsModal() {
    $('modalBackdrop').classList.remove('hidden');
    $('wsModal').classList.remove('hidden');
    $('importModal').classList.add('hidden');
    renderWsManage();
  }
  function renderWsManage() {
    var ul = $('wsManageList');
    ul.innerHTML = '';
    state.workspaces.forEach(function (w) {
      var li = document.createElement('li');
      var inp = document.createElement('input'); inp.value = w.name;
      inp.addEventListener('change', function () { API.renameWorkspace(w.id, inp.value).then(loadWorkspaces); });
      li.appendChild(inp);
      if (w.id !== 'general') {
        var del = document.createElement('button'); del.className = 'wm-del'; del.textContent = '🗑';
        del.addEventListener('click', async function () {
          if (!confirm('Delete workspace “' + w.name + '” and all its notes?')) return;
          await API.deleteWorkspace(w.id);
          if (state.wsId === w.id) state.wsId = 'general';
          await loadWorkspaces(); renderWsManage(); await loadCurrentNote();
        });
        li.appendChild(del);
      }
      ul.appendChild(li);
    });
  }
  $('createWsBtn').addEventListener('click', async function () {
    var name = $('newWsName').value.trim();
    if (!name) return;
    var w = await API.createWorkspace(name);
    $('newWsName').value = '';
    await loadWorkspaces();
    renderWsManage();
    state.wsId = w.id; $('workspaceSelect').value = w.id;
    await loadCurrentNote();
  });

  $('importBtn').addEventListener('click', function () {
    $('modalBackdrop').classList.remove('hidden');
    $('importModal').classList.remove('hidden');
    $('wsModal').classList.add('hidden');
  });
  $('doImportBtn').addEventListener('click', async function () {
    var file = $('importFile').files[0];
    if (!file) { alert('Choose a file to import.'); return; }
    var text = await file.text();
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var fmt = ext === 'json' ? 'json' : (ext === 'md' || ext === 'markdown') ? 'md' : 'html';
    var note = await API.importNote(state.wsId, { format: fmt, content: text, title: $('importTitle').value.trim() || null });
    closeModals();
    await loadWorkspaces();
    await openNote(note.id);
  });

  document.querySelectorAll('.modal-close').forEach(function (b) { b.addEventListener('click', closeModals); });
  $('modalBackdrop').addEventListener('click', function (e) { if (e.target === $('modalBackdrop')) closeModals(); });
  function closeModals() {
    $('modalBackdrop').classList.add('hidden');
    $('wsModal').classList.add('hidden');
    $('importModal').classList.add('hidden');
  }

  // ---------------- Logout ----------------
  $('logoutBtn').addEventListener('click', async function () {
    if (state.saveTimer) await saveNow();
    await API.logout();
    location.reload();
  });

  // ---------------- Utils ----------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function rid() { return Math.random().toString(36).slice(2, 10); }
  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  boot().catch(function (e) { console.error(e); });
})();
