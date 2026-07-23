/* Meeting Notes — main application controller. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var API = window.API;
  var IDLE_MS = 15 * 60 * 1000;

  // ---------------- In-app dialogs (replace native alert/confirm/prompt) ----------------
  function showDialog(opts) {
    return new Promise(function (resolve) {
      var layer = $('dialogLayer');
      $('dialogTitle').textContent = opts.title || '';
      $('dialogTitle').classList.toggle('hidden', !opts.title);
      $('dialogMessage').textContent = opts.message || '';
      var inp = $('dialogInput');
      if (opts.input) { inp.classList.remove('hidden'); inp.value = opts.default || ''; inp.placeholder = opts.placeholder || ''; inp.type = opts.inputType || 'text'; }
      else inp.classList.add('hidden');
      var btnWrap = $('dialogButtons'); btnWrap.innerHTML = '';
      function done(val) { layer.classList.add('hidden'); document.removeEventListener('keydown', onKey, true); resolve(val); }
      (opts.buttons || []).forEach(function (b) {
        var el = document.createElement('button');
        el.textContent = b.label;
        el.className = 'dlg-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
        el.addEventListener('click', function () { done(b.returns === 'input' ? inp.value : b.returns); });
        btnWrap.appendChild(el);
      });
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(opts.cancelValue); }
        else if (e.key === 'Enter' && opts.input) { e.preventDefault(); done(inp.value); }
        else if (e.key === 'Enter' && !opts.input) { var p = (opts.buttons || []).filter(function (b) { return b.primary; })[0]; if (p) done(p.returns); }
      }
      document.addEventListener('keydown', onKey, true);
      layer.classList.remove('hidden');
      setTimeout(function () { if (opts.input) inp.focus(); else { var pb = btnWrap.querySelector('.primary') || btnWrap.querySelector('button'); if (pb) pb.focus(); } }, 30);
    });
  }
  var dialog = {
    alert: function (message, title) { return showDialog({ title: title, message: message, buttons: [{ label: 'OK', returns: true, primary: true }], cancelValue: true }); },
    confirm: function (message, opts) {
      opts = opts || {};
      return showDialog({
        title: opts.title, message: message, cancelValue: false,
        buttons: [{ label: opts.cancelText || 'Cancel', returns: false }, { label: opts.okText || 'OK', returns: true, primary: true, danger: opts.danger }],
      });
    },
    prompt: function (message, opts) {
      opts = opts || {};
      return showDialog({
        title: opts.title, message: message, input: true, inputType: opts.inputType, default: opts.default, placeholder: opts.placeholder, cancelValue: null,
        buttons: [{ label: 'Cancel', returns: null }, { label: opts.okText || 'OK', returns: 'input', primary: true }],
      });
    },
    choose: function (message, buttons, opts) {
      opts = opts || {};
      return showDialog({ title: opts.title, message: message, cancelValue: opts.cancelValue !== undefined ? opts.cancelValue : null, buttons: buttons });
    },
  };
  window.dialog = dialog; // so editor.js can use it too

  var state = {
    initialized: false,
    workspaces: [],
    templates: [],
    wsId: null,
    note: null,
    settings: {},
    view: 'note',
    saveTimer: null,
    notify: false,
    dragTodoId: null,
  };

  // ---------------- Boot / auth ----------------
  async function boot() {
    var st = await API.status();
    state.initialized = st.initialized;
    state.instance = st.instance || null;
    state.bio = st.bio || { enrolled: false, credentials: [] };
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
    var canBio = !!(state.bio && state.bio.enrolled) && initialized && !!window.PublicKeyCredential;
    $('bioUnlockBtn').classList.toggle('hidden', !canBio);
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

  // ---------------- Biometric unlock (WebAuthn PRF) ----------------
  // A fixed, non-secret salt fed to the authenticator's PRF; the same salt at
  // enroll and unlock yields the same per-credential secret, which wraps the DEK.
  var PRF_SALT = new TextEncoder().encode('meeting-notes/webauthn-prf/v1');
  function bufToB64(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function b64ToBuf(s) { var bin = atob(s), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b.buffer; }
  function bufToB64url(buf) { return bufToB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64urlToBuf(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return b64ToBuf(s); }
  function bioDeviceLabel() { try { return (navigator.platform || 'This device'); } catch (_e) { return 'This device'; } }

  // One biometric assertion → { credentialId, secret } (the PRF output as base64).
  async function bioAssert(credentialIds) {
    var allow = (credentialIds || []).map(function (id) { return { id: b64urlToBuf(id), type: 'public-key' }; });
    var assertion = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: allow.length ? allow : undefined,
      userVerification: 'required', timeout: 60000,
      extensions: { prf: { eval: { first: PRF_SALT } } },
    } });
    var ext = assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {};
    var first = ext && ext.prf && ext.prf.results && ext.prf.results.first;
    if (!first) return null;
    return { credentialId: bufToB64url(assertion.rawId), secret: bufToB64(first) };
  }

  async function bioEnroll() {
    if (!window.PublicKeyCredential) throw new Error('WebAuthn is not available in this browser.');
    var cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Meeting Notes' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'meeting-notes', displayName: 'Meeting Notes' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      timeout: 60000, extensions: { prf: {} },
    } });
    var credId = bufToB64url(cred.rawId);
    // A follow-up assertion is the reliable cross-platform way to read the PRF output.
    var got = await bioAssert([credId]);
    if (!got || !got.secret) throw new Error('This browser/device did not return a PRF secret. Biometric unlock needs a platform passkey on a PRF-capable browser (recent Chrome/Edge/Safari) over localhost or HTTPS.');
    await API.webauthnEnroll({ credentialId: credId, prfSecret: got.secret, prfSalt: 'v1', label: bioDeviceLabel() });
  }

  async function bioUnlock(creds) {
    var got = await bioAssert((creds || []).map(function (c) { return c.credentialId; }));
    if (!got) throw new Error('no biometric secret returned');
    var r = await API.webauthnUnlock(got.credentialId, got.secret);
    if (r.csrf) API.setCsrf(r.csrf);
    await startApp();
  }

  $('bioUnlockBtn').addEventListener('click', async function () {
    var err = $('authError'); err.classList.add('hidden');
    $('bioUnlockBtn').disabled = true;
    try {
      var creds = (state.bio && state.bio.credentials) || [];
      if (!creds.length) throw new Error('no biometric credential is enrolled');
      await bioUnlock(creds);
    } catch (ex) { err.textContent = 'Biometric unlock failed: ' + ex.message; err.classList.remove('hidden'); }
    finally { $('bioUnlockBtn').disabled = false; }
  });

  window.addEventListener('mn-unauthorized', function () { location.reload(); });

  async function startApp() {
    $('authGate').classList.add('hidden');
    $('app').classList.remove('hidden');
    state.settings = await API.getSettings();
    applyFontSize(state.settings.fontSize || 14);
    applyTheme(state.settings.theme || 'auto');
    applySortControl();
    await loadTemplates();
    await loadWorkspaces();
    await routeFromHash();
    startIdleTimer();
    startReminderPolling();
    startLiveSync();
  }

  // Deep-link to a note via the URL hash (#note/<id>) so a refresh reopens the
  // same note instead of jumping to the newest one.
  function routeFromHash() {
    var m = /^#note\/([A-Za-z0-9_-]{1,64})$/.exec(location.hash || '');
    if (m) return openNote(m[1]).catch(function () { return loadCurrentNote(); });
    return loadCurrentNote();
  }
  function setNoteHash(id) {
    try { history.replaceState(null, '', location.pathname + (id ? ('#note/' + id) : location.search)); } catch (_e) { /* ignore */ }
  }

  // Service worker (offline app shell + notifications)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }

  // Live-sync: refresh when note files change on disk (e.g. another device via a
  // synced folder). Change events are COALESCED and self-echo-suppressed: when the
  // data dir lives in a cloud-sync folder, the sync client touches files
  // constantly, so reacting to every event would fire a stream of refetches and
  // keep the browser tab in a perpetual "loading" state (a flickering favicon).
  function startLiveSync() {
    if (!('EventSource' in window)) return;
    try {
      var es = new EventSource('/api/events');
      var timer = null, wantNote = false;
      function flush() {
        timer = null;
        // Ignore watcher echoes of our own recent writes (incl. cloud-sync
        // re-touching the file we just saved).
        if (Date.now() - (state.lastSaveAt || 0) < 3000) { wantNote = false; return; }
        if (state.view !== 'note') { wantNote = false; return; }
        var needNote = wantNote; wantNote = false;
        if (needNote && state.note) {
          API.getNote(state.note.id).then(function (fresh) {
            // Only re-render on a genuine content change (rev), not housekeeping.
            if ((fresh.rev || 0) !== (state.note.rev || 0)) { state.note = fresh; renderNote(); setSaveStatus('Updated from another device'); }
            else { state.note.updatedAt = fresh.updatedAt; }
          }).catch(function () {});
        }
        renderNoteList();
      }
      es.addEventListener('change', function (ev) {
        if (state.saveTimer) return; // an edit is in flight — don't clobber it
        var data = {}; try { data = JSON.parse(ev.data); } catch (e) {}
        if (data.noteId && state.note && data.noteId === state.note.id) wantNote = true;
        clearTimeout(timer); timer = setTimeout(flush, 1000); // coalesce bursts
      });
      es.onerror = function () { /* browser auto-reconnects (retry is set server-side) */ };
    } catch (e) { /* SSE unsupported */ }
  }

  function applyFontSize(px) {
    document.documentElement.style.setProperty('--note-font', px + 'px');
  }

  // ---------------- Theme (auto / light / dark) ----------------
  function applyTheme(theme) {
    state.settings.theme = theme;
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    $('themeBtn').textContent = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🌓';
    $('themeBtn').title = 'Theme: ' + theme + ' (click to change)';
  }
  $('themeBtn').addEventListener('click', function () {
    var order = { auto: 'light', light: 'dark', dark: 'auto' };
    var next = order[state.settings.theme || 'auto'];
    applyTheme(next); API.saveSettings({ theme: next });
  });

  // ---------------- Help / shortcuts overlay ----------------
  function openHelp() { $('helpLayer').classList.remove('hidden'); }
  function closeHelp() { $('helpLayer').classList.add('hidden'); }
  // Open the full user manual, matching the app's current theme.
  function openManual() {
    var t = (state.settings && state.settings.theme) || 'auto';
    var q = (t === 'light' || t === 'dark') ? ('?theme=' + t) : '';
    window.open('/manual.html' + q, '_blank', 'noopener');
  }
  $('helpBtn').addEventListener('click', openHelp);
  $('helpLayer').addEventListener('click', function (e) { if (e.target === $('helpLayer')) closeHelp(); });
  document.querySelector('.help-close').addEventListener('click', closeHelp);
  $('manualLink').addEventListener('click', function (e) { e.preventDefault(); closeHelp(); openManual(); });

  // ---------------- Command palette (⌘K / Ctrl-K) ----------------
  var palette = { open: false, items: [], active: 0 };
  function paletteActions() {
    return [
      { label: '＋ New Daily note', run: function () { createNewNote({}); } },
      { label: '✏️ New scratch note', run: function () { createNewNote({ scratch: true }); } },
      { label: 'Go to: Current note', run: function () { if (state.note) { showView('note'); renderNoteList(); } else loadCurrentNote(); } },
      { label: 'Go to: Tasks', run: renderGlobalTasks },
      { label: 'Go to: Favorites', run: renderFavorites },
      { label: 'Open: Templates', run: openTemplateModal },
      { label: 'Open: Trash', run: renderTrash },
      { label: 'Open: Backup / offline viewer', run: function () { openModal('backupModal'); } },
      { label: 'Open: Settings', run: function () { openAccount(); } },
      { label: 'Toggle theme', run: function () { $('themeBtn').click(); } },
      { label: 'Help & shortcuts', run: openHelp },
      { label: 'Open the user manual', run: openManual },
      { label: 'Lock (log out)', run: function () { $('logoutBtn').click(); } },
    ];
  }
  function openPalette() {
    palette.open = true; palette.active = 0;
    $('paletteLayer').classList.remove('hidden');
    $('paletteInput').value = '';
    buildPalette('');
    setTimeout(function () { $('paletteInput').focus(); }, 20);
  }
  function closePalette() { palette.open = false; $('paletteLayer').classList.add('hidden'); }
  async function buildPalette(q) {
    q = (q || '').trim().toLowerCase();
    var items = [];
    // workspaces
    state.workspaces.forEach(function (w) {
      if (!q || w.name.toLowerCase().indexOf(q) >= 0) items.push({ label: 'Workspace: ' + w.name, run: function () { state.wsId = w.id; $('workspaceSelect').value = w.id; showView('note'); loadCurrentNote(); } });
    });
    // actions
    paletteActions().forEach(function (a) { if (!q || a.label.toLowerCase().indexOf(q) >= 0) items.push(a); });
    // notes (via search) when there's a query
    if (q) {
      try {
        var results = await API.search(q);
        results.slice(0, 8).forEach(function (r) { items.push({ label: '📄 ' + r.title, sub: r.workspaceName, run: function () { openNote(r.noteId); } }); });
      } catch (e) { /* ignore */ }
    }
    palette.items = items;
    if (palette.active >= items.length) palette.active = 0;
    renderPalette();
  }
  function renderPalette() {
    var ul = $('paletteList'); ul.innerHTML = '';
    palette.items.forEach(function (it, i) {
      var li = document.createElement('li');
      li.className = 'palette-item' + (i === palette.active ? ' active' : '');
      li.innerHTML = '<span>' + esc(it.label) + '</span>' + (it.sub ? '<span class="pi-sub">' + esc(it.sub) + '</span>' : '');
      li.addEventListener('mousedown', function (e) { e.preventDefault(); runPalette(i); });
      li.addEventListener('mousemove', function () { palette.active = i; highlightPalette(); });
      ul.appendChild(li);
    });
  }
  function highlightPalette() {
    var lis = $('paletteList').children;
    for (var i = 0; i < lis.length; i++) lis[i].classList.toggle('active', i === palette.active);
    if (lis[palette.active]) lis[palette.active].scrollIntoView({ block: 'nearest' });
  }
  function runPalette(i) { var it = palette.items[i]; closePalette(); if (it && it.run) it.run(); }
  $('paletteInput').addEventListener('input', function () { buildPalette($('paletteInput').value); });
  $('paletteInput').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); palette.active = Math.min(palette.items.length - 1, palette.active + 1); highlightPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palette.active = Math.max(0, palette.active - 1); highlightPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(palette.active); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  $('paletteLayer').addEventListener('click', function (e) { if (e.target === $('paletteLayer')) closePalette(); });

  async function loadStatsInto() {
    try {
      var s = await API.stats();
      $('statsInfo').textContent = s.workspaces + ' workspaces · ' + s.notes + ' notes · ' + s.attachments + ' attachments · ' + fmtSize(s.bytes) + ' encrypted on disk';
      if (s.inboxDir) $('inboxInfo').textContent = 'Inbox folder: ' + s.inboxDir;
    } catch (e) { $('statsInfo').textContent = ''; }
  }

  function renderInboxSettings() {
    var sel = $('inboxWs'); sel.innerHTML = '';
    var cur = state.settings.inboxWorkspace || 'general';
    state.workspaces.forEach(function (w) {
      var o = document.createElement('option'); o.value = w.id; o.textContent = w.name;
      if (w.id === cur) o.selected = true; sel.appendChild(o);
    });
  }
  $('inboxWs').addEventListener('change', function () {
    state.settings.inboxWorkspace = $('inboxWs').value;
    API.saveSettings({ inboxWorkspace: state.settings.inboxWorkspace });
  });

  // ---------------- Slack outbound (agenda) ----------------
  function renderSlackSettings() {
    $('slackWebhook').value = state.settings.slackWebhook || '';
    $('slackDaily').checked = !!state.settings.slackDaily;
    $('slackTime').value = state.settings.slackTime || '08:00';
    $('slackMsg').textContent = '';
  }
  function slackMsg(s, isErr) { var el = $('slackMsg'); el.textContent = s; el.style.color = isErr ? 'var(--danger)' : 'var(--muted)'; }
  $('slackSaveBtn').addEventListener('click', async function () {
    state.settings.slackWebhook = $('slackWebhook').value.trim();
    state.settings.slackDaily = $('slackDaily').checked;
    state.settings.slackTime = $('slackTime').value || '08:00';
    await API.saveSettings({ slackWebhook: state.settings.slackWebhook, slackDaily: state.settings.slackDaily, slackTime: state.settings.slackTime });
    slackMsg('Saved ✓', false);
  });
  $('slackSendBtn').addEventListener('click', async function () {
    var url = $('slackWebhook').value.trim();
    if (!url) { slackMsg('Add your Slack webhook URL first.', true); return; }
    // persist the URL so the server can use it, then post
    state.settings.slackWebhook = url; await API.saveSettings({ slackWebhook: url });
    slackMsg('Posting…', false);
    try { await API.slackAgenda(); slackMsg('Agenda posted to Slack ✓', false); }
    catch (ex) { slackMsg('Post failed: ' + ex.message, true); }
  });

  // Best-effort daily auto-send while the app is open (deduped per day).
  async function maybeSendDailyAgenda() {
    var s = state.settings || {};
    if (!s.slackDaily || !s.slackWebhook) return;
    var t = todayStr();
    if (s.lastSlackDate === t) return;
    var now = new Date(); var hhmm = p2(now.getHours()) + ':' + p2(now.getMinutes());
    if (hhmm < (s.slackTime || '08:00')) return;
    try {
      await API.slackAgenda();
      state.settings.lastSlackDate = t; await API.saveSettings({ lastSlackDate: t });
    } catch (_e) { /* try again on the next poll */ }
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

  // ---------------- Note sort control ----------------
  function noteSort() { return state.settings.noteSort || { field: 'created', dir: 'desc' }; }
  function applySortControl() {
    var s = noteSort();
    $('noteSort').value = s.field;
    $('noteSortDir').textContent = s.dir === 'asc' ? '↑' : '↓';
    $('noteSortDir').title = 'Sort ' + (s.dir === 'asc' ? 'ascending' : 'descending') + ' (click to flip)';
  }
  function saveSort(next) {
    state.settings.noteSort = next;
    applySortControl();
    renderNoteList();
    API.saveSettings({ noteSort: next });
  }
  $('noteSort').addEventListener('change', function () { saveSort({ field: $('noteSort').value, dir: noteSort().dir }); });
  $('noteSortDir').addEventListener('click', function () { saveSort({ field: noteSort().field, dir: noteSort().dir === 'asc' ? 'desc' : 'asc' }); });

  // ---------------- Note load / render ----------------
  async function loadCurrentNote() {
    var n = await API.currentNote(state.wsId);
    if (!n) { state.note = null; showLanding(); await renderNoteList(); return; }
    state.note = n;
    showView('note'); renderNote();
    await Promise.all([renderNoteList(), loadTasks()]);
  }
  async function openNote(id) {
    state.note = await API.getNote(id);
    state.wsId = state.note.workspaceId; $('workspaceSelect').value = state.wsId;
    showView('note'); renderNote(); renderNoteList(); loadTasks();
  }

  function showLanding() {
    setNoteHash(null);
    var w = state.workspaces.filter(function (x) { return x.id === state.wsId; })[0];
    $('landingWs').textContent = w ? w.name : 'Meeting Notes';
    showView('landing');
  }
  $('landingNewDaily').addEventListener('click', function () { createNewNote({}); });
  $('landingNewScratch').addEventListener('click', function () { createNewNote({ scratch: true }); });

  function renderNote() {
    var n = state.note;
    var scratch = n.kind === 'scratch';
    $('noteDate').textContent = n.title;
    var kind = $('noteKind');
    kind.textContent = scratch ? '✏️ Scratch' : '';
    kind.classList.toggle('hidden', !scratch);
    // Scratch notes are just a Meeting Notes page — hide the other sections.
    $('sections').classList.toggle('scratch', scratch);
    $('noteCustomTitle').value = n.customTitle || '';
    $('favBtn').textContent = n.favorite ? '★' : '☆';
    renderTags();
    renderTasks();
    $('carryoverEditor').innerHTML = n.carryover || '';
    $('meetingEditor').innerHTML = n.meetingNotes || '';
    renderAttachments();
    setSaveStatus('');
    updateWordCount();
    renderBacklinks();
    renderTranscript();
    setNoteHash(n.id);
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
    var s = noteSort();
    var notes = await API.listNotes(state.wsId, { sort: s.field, dir: s.dir });
    var ul = $('noteList'); ul.innerHTML = '';
    notes.forEach(function (nm) {
      var li = document.createElement('li');
      if (state.note && nm.id === state.note.id && state.view === 'note') li.classList.add('active');
      var tags = (nm.tags || []).length ? '<span class="nl-tags">' + nm.tags.map(function (t) { return '#' + esc(t); }).join(' ') + '</span>' : '';
      var main = document.createElement('div'); main.className = 'nl-main';
      var scratch = nm.kind === 'scratch';
      var doneHere = nm.doneTaskCount ? '<span title="Tasks completed on this note">✓ ' + nm.doneTaskCount + '</span>' : '';
      main.innerHTML =
        '<div class="nl-title">' + (scratch ? '<span class="nl-scratch" title="Scratch note">✏️</span> ' : '') + esc(nm.displayTitle) + '</div>' +
        '<div class="nl-meta">' + (scratch ? '<span>scratch</span>' : doneHere) +
        (nm.attachmentCount ? '<span>📎 ' + nm.attachmentCount + '</span>' : '') + tags + '</div>';
      main.addEventListener('click', function () { openNote(nm.id); });

      var actions = document.createElement('div'); actions.className = 'nl-actions';
      var star = document.createElement('button');
      star.className = 'nl-act nl-star' + (nm.favorite ? ' on' : '');
      star.textContent = nm.favorite ? '★' : '☆';
      star.title = nm.favorite ? 'Unfavorite' : 'Favorite';
      star.addEventListener('click', async function (e) {
        e.stopPropagation();
        var s = await API.setFavorite(nm.id, !nm.favorite);
        if (state.note && state.note.id === nm.id) { state.note.favorite = s.favorite; state.note.updatedAt = s.updatedAt; $('favBtn').textContent = s.favorite ? '★' : '☆'; }
        renderNoteList();
      });
      var del = document.createElement('button');
      del.className = 'nl-act nl-del'; del.textContent = '🗑'; del.title = 'Delete (to trash)';
      del.addEventListener('click', async function (e) {
        e.stopPropagation();
        if (!(await dialog.confirm('Move “' + nm.displayTitle + '” to trash?', { okText: 'Move to trash', danger: true }))) return;
        await API.deleteNote(nm.id);
        if (state.note && state.note.id === nm.id) await loadCurrentNote(); else renderNoteList();
      });
      actions.appendChild(star); actions.appendChild(del);

      li.appendChild(main); li.appendChild(actions);
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

  // ---------------- Tasks (unified to-do + reminder, Todoist-style) ----------------
  state.tasks = [];
  state.qa = { due: null, time: null, priority: 4, recurrence: null };

  async function loadTasks() {
    try { state.tasks = await API.listTasks(state.wsId); } catch (_e) { state.tasks = []; }
    renderTasks();
  }
  function applyTaskResult(res) {
    if (res && res.tasks && res.workspaceId === state.wsId) { state.tasks = res.tasks; renderTasks(); renderNoteList(); }
    else loadTasks();
  }
  function addDaysStr(iso, n) { var d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function fmtDueShort(iso) {
    if (!iso) return '';
    var t = todayStr();
    if (iso === t) return 'Today';
    if (iso === addDaysStr(t, 1)) return 'Tomorrow';
    if (iso < t) return iso.slice(5);
    try { return new Date(iso + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch (e) { return iso.slice(5); }
  }
  function fmtDueLong(iso) {
    if (iso === addDaysStr(todayStr(), 1)) return 'Tomorrow';
    try { return new Date(iso + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return iso; }
  }
  function recurLabel(rec) {
    if (!rec) return '';
    if (rec.type === 'daily') return 'daily'; if (rec.type === 'weekdays') return 'weekdays';
    if (rec.type === 'weekly') return 'weekly'; if (rec.type === 'monthly') return 'monthly';
    if (rec.type === 'everyNDays') return 'every ' + rec.n + 'd'; return '';
  }
  function sortTasks(a, b) { return (a.due || '9999').localeCompare(b.due || '9999') || (a.priority - b.priority) || (a.order - b.order); }

  function taskRow(t) {
    var li = document.createElement('li');
    li.className = 'task prio-p' + t.priority + (t.done ? ' done' : '');
    var today = todayStr();
    if (!t.done && t.due && t.due < today) li.classList.add('overdue');

    var cb = document.createElement('button'); cb.className = 'task-check'; cb.setAttribute('aria-label', t.done ? 'Reopen task' : 'Complete task');
    cb.innerHTML = t.done ? '✓' : '';
    cb.addEventListener('click', async function () {
      if (t.done) applyTaskResult(await API.updateTask(t.id, { done: false }));
      else { li.classList.add('checking'); applyTaskResult(await API.completeTask(t.id, state.note ? state.note.id : null)); }
    });

    var main = document.createElement('div'); main.className = 'task-main';
    var span = document.createElement('span'); span.className = 'task-text'; span.contentEditable = t.done ? 'false' : 'true'; span.textContent = t.text;
    span.addEventListener('blur', async function () { var v = span.textContent.trim(); if (v && v !== t.text) applyTaskResult(await API.updateTask(t.id, { text: v })); });
    span.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); span.blur(); } });
    main.appendChild(span);
    var meta = document.createElement('div'); meta.className = 'task-meta';
    if (!t.done) {
      var dc = document.createElement('button');
      dc.className = 'task-due' + (t.due && t.due < today ? ' overdue' : '') + (t.due ? '' : ' nodate');
      dc.textContent = t.due ? ('📅 ' + fmtDueShort(t.due) + (t.time ? ' ' + t.time : '')) : '📅 Set date';
      dc.title = t.due ? 'Reschedule' : 'Add a due date';
      dc.addEventListener('click', function () { rescheduleTask(t, dc); });
      meta.appendChild(dc);
    } else if (t.due) {
      var dcs = document.createElement('span'); dcs.className = 'task-due'; dcs.textContent = '📅 ' + fmtDueShort(t.due); meta.appendChild(dcs);
    }
    if (t.recurrence) { var rc = document.createElement('span'); rc.className = 'task-recur'; rc.textContent = '🔁 ' + recurLabel(t.recurrence); meta.appendChild(rc); }
    if (t.sourceInbox) { var ib = document.createElement('span'); ib.className = 'inbox-badge'; ib.textContent = '📥'; ib.title = 'From your inbox (e.g. Slack)'; meta.appendChild(ib); }
    if (meta.childNodes.length) main.appendChild(meta);
    li.appendChild(cb); li.appendChild(main);

    var actions = document.createElement('div'); actions.className = 'task-actions';
    if (!t.done && t.recurrence) { var sk = document.createElement('button'); sk.className = 'task-act'; sk.title = 'Skip this occurrence'; sk.textContent = '⏭'; sk.addEventListener('click', async function () { applyTaskResult(await API.skipTask(t.id)); }); actions.appendChild(sk); }
    if (!t.done) { var pr = document.createElement('button'); pr.className = 'task-act'; pr.title = 'Cycle priority'; pr.textContent = '⚑'; pr.addEventListener('click', async function () { applyTaskResult(await API.updateTask(t.id, { priority: t.priority <= 1 ? 4 : t.priority - 1 })); }); actions.appendChild(pr); }
    var del = document.createElement('button'); del.className = 'task-act task-del'; del.title = 'Delete'; del.textContent = '✕';
    del.addEventListener('click', async function () { applyTaskResult(await API.deleteTask(t.id)); });
    actions.appendChild(del);
    li.appendChild(actions);
    return li;
  }

  function renderTasks() {
    if (!state.note) return;
    var today = todayStr();
    var open = (state.tasks || []).filter(function (t) { return !t.done; });
    var overdueToday = open.filter(function (t) { return t.due && t.due <= today; }).sort(sortTasks);
    var upcoming = open.filter(function (t) { return t.due && t.due > today; }).sort(sortTasks);
    var nodate = open.filter(function (t) { return !t.due; }).sort(function (a, b) { return (a.priority - b.priority) || (a.order - b.order); });
    var here = (state.tasks || []).filter(function (t) { return t.done && t.completedOnNoteId === state.note.id; }).sort(function (a, b) { return (b.completedAt || '').localeCompare(a.completedAt || ''); });

    var tl = $('todayList'); tl.innerHTML = '';
    if (!overdueToday.length && !nodate.length) { var e = document.createElement('li'); e.className = 'task-empty muted tiny'; e.textContent = 'Nothing due — add a task above.'; tl.appendChild(e); }
    overdueToday.forEach(function (t) { tl.appendChild(taskRow(t)); });

    $('nodateWrap').classList.toggle('hidden', !nodate.length);
    var nl = $('nodateList'); nl.innerHTML = ''; nodate.forEach(function (t) { nl.appendChild(taskRow(t)); });

    $('completedWrap').classList.toggle('hidden', !here.length);
    var cl = $('completedList'); cl.innerHTML = ''; here.forEach(function (t) { cl.appendChild(taskRow(t)); });

    var uw = $('upcomingList'); uw.innerHTML = '';
    if (!upcoming.length) { uw.innerHTML = '<div class="task-empty muted tiny">No upcoming tasks.</div>'; return; }
    var groups = {}; upcoming.forEach(function (t) { (groups[t.due] = groups[t.due] || []).push(t); });
    Object.keys(groups).sort().forEach(function (d) {
      var day = document.createElement('div'); day.className = 'upcoming-day';
      var lab = document.createElement('div'); lab.className = 'upcoming-date'; lab.textContent = fmtDueLong(d); day.appendChild(lab);
      var ul = document.createElement('ul'); ul.className = 'task-list'; groups[d].forEach(function (t) { ul.appendChild(taskRow(t)); }); day.appendChild(ul);
      uw.appendChild(day);
    });
  }

  // Opens a native date picker anchored under `anchorEl`. The throwaway <input>
  // must stay ON-SCREEN — at left:-9999px the browser opens the picker off-screen
  // (or refuses), which is why the old picker "didn't work". We keep it laid out
  // at the anchor but visually hidden, and call showPicker() inside the click's
  // user-activation window.
  function openDatePicker(anchorEl, current, cb) {
    var inp = document.createElement('input');
    inp.type = 'date';
    if (current) inp.value = current;
    var r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect() : { left: 24, bottom: 80 };
    inp.style.position = 'fixed';
    inp.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 40)) + 'px';
    inp.style.top = ((r.bottom || 80) + 2) + 'px';
    inp.style.width = '1px'; inp.style.height = '1px';
    inp.style.opacity = '0'; inp.style.border = '0'; inp.style.padding = '0'; inp.style.margin = '0';
    inp.style.zIndex = '2000'; inp.setAttribute('aria-hidden', 'true');
    document.body.appendChild(inp);
    var settled = false;
    function cleanup() { if (settled) return; settled = true; inp.remove(); }
    inp.addEventListener('change', function () { var v = inp.value || null; cleanup(); cb(v); });
    inp.addEventListener('blur', function () { setTimeout(cleanup, 200); });
    inp.focus();
    if (inp.showPicker) { try { inp.showPicker(); } catch (e) { inp.click(); } } else { inp.click(); }
  }

  function rescheduleTask(t, anchorEl) {
    openDatePicker(anchorEl, t.due, async function (v) { applyTaskResult(await API.rescheduleTask(t.id, v)); });
  }

  // ---- quick-add (natural language + pickers) ----
  function syncQa() {
    $('qaPriority').value = String(state.qa.priority || 4);
    $('qaRecur').value = state.qa.recurrence ? state.qa.recurrence.type : 'none';
    $('qaDateLbl').textContent = state.qa.due ? fmtDueShort(state.qa.due) : 'Date';
    $('qaDate').classList.toggle('set', !!state.qa.due);
  }
  $('taskInput').addEventListener('input', function () {
    var p = window.TaskParse.parse($('taskInput').value);
    state.qa = { due: p.due, time: p.time, priority: p.priority, recurrence: p.recurrence };
    syncQa();
  });
  $('qaPriority').addEventListener('change', function () { state.qa.priority = parseInt($('qaPriority').value, 10) || 4; });
  $('qaRecur').addEventListener('change', function () { var v = $('qaRecur').value; state.qa.recurrence = v === 'none' ? null : { type: v }; });
  $('qaDate').addEventListener('click', function () {
    openDatePicker($('qaDate'), state.qa.due, function (v) { state.qa.due = v; syncQa(); });
  });
  async function addTaskFromInput() {
    var raw = $('taskInput').value.trim(); if (!raw) return;
    var p = window.TaskParse.parse(raw);
    var payload = { text: p.text || raw, due: state.qa.due, time: state.qa.time, priority: state.qa.priority, recurrence: state.qa.recurrence };
    $('taskInput').value = ''; state.qa = { due: null, time: null, priority: 4, recurrence: null }; syncQa();
    applyTaskResult(await API.addTask(state.wsId, payload));
  }
  $('qaAdd').addEventListener('click', addTaskFromInput);
  $('taskInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addTaskFromInput(); } });

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

  // ---------------- Attachments ----------------
  $('attachInput').addEventListener('change', async function () {
    var files = Array.prototype.slice.call($('attachInput').files);
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.size > 20 * 1024 * 1024) { await dialog.alert('“' + f.name + '” is too large (max 20 MB).'); continue; }
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

  // ---------------- Meeting recording + live transcript ----------------
  state.recording = null;

  function renderTranscript() {
    var panel = $('transcriptPanel'), body = $('transcriptBody');
    // Sort a copy by cut-time so the two streams (you/them) interleave in the
    // order things were actually said, regardless of transcription latency.
    var lines = (state.note.transcript || []).slice().sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
    if (!lines.length && !state.recording) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    body.innerHTML = '';
    if (!lines.length && state.recording) {
      var hint = document.createElement('div');
      hint.className = 'tr-empty muted tiny';
      hint.textContent = (state.settings.transcription || {}).endpoint
        ? 'Listening… transcript lines will appear here as people speak.'
        : 'Recording — transcription is off. Add an STT endpoint under ⚙️ Settings → Meeting transcription to see live text here.';
      body.appendChild(hint);
      return;
    }
    lines.forEach(function (l) {
      var div = document.createElement('div');
      div.className = 'tr-line tr-' + (l.source === 'them' ? 'them' : 'you');
      div.innerHTML = '<span class="tr-time"></span> <span class="tr-who">' + (l.source === 'them' ? 'Them' : 'You') + '</span> <span class="tr-text"></span>';
      div.querySelector('.tr-time').textContent = fmtTranscriptTime(l.t);
      div.querySelector('.tr-text').textContent = l.text;
      body.appendChild(div);
    });
    body.scrollTop = body.scrollHeight;
  }

  // Each line's `t` is epoch-ms captured when the audio chunk was cut (i.e. when
  // it was spoken). Show it as a wall-clock time so the transcript reads like a
  // real meeting log; blank for older lines saved before timestamps existed.
  function fmtTranscriptTime(t) {
    if (!t) return '';
    try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (_e) { return ''; }
  }

  function transcribeFnFor() {
    var cfg = (state.settings.transcription) || {};
    if (!cfg.endpoint) return null; // recording only — nothing leaves the device
    return function (wavBlob, source) {
      return fileToBase64(wavBlob).then(function (b64) {
        return API.transcribe(b64, 'audio/wav', source + '.wav', source).then(function (r) { return r.text || ''; });
      });
    };
  }

  $('recordBtn').addEventListener('click', async function () {
    if (state.recording) { await stopRecording(); return; }
    if (!window.Recorder || !window.Recorder.supported()) { await dialog.alert('Audio recording is not supported in this browser.'); return; }
    var noteId = state.note.id;
    try {
      $('recordBtn').disabled = true;
      var session = await window.Recorder.start({
        transcribeFn: transcribeFnFor(),
        onStatus: function (m) { $('recStatus').textContent = m; },
        onError: function (err) { $('recStatus').textContent = 'Transcription error: ' + err.message; },
        onLine: function (line) {
          if (!state.note || state.note.id !== noteId) return; // note switched — ignore
          state.note.transcript = (state.note.transcript || []).concat(line);
          renderTranscript(); scheduleSave();
        },
      });
      state.recording = { session: session, noteId: noteId };
      $('recordBtn').textContent = '⏹ Stop'; $('recordBtn').classList.add('recording');
      $('screenBtn').disabled = true;
      renderTranscript();
    } catch (ex) {
      $('recStatus').textContent = '';
      await dialog.alert('Could not start recording: ' + ex.message + '\n\n(Grant microphone access, and to capture the other side pick a tab/window with "Share audio" enabled.)');
    } finally { $('recordBtn').disabled = false; }
  });

  async function stopRecording() {
    if (!state.recording) return;
    var rec = state.recording; state.recording = null;
    $('recordBtn').disabled = true; $('recStatus').textContent = 'Saving recording…';
    try {
      // One combined WAV holding your mic + the shared audio, mixed accurately.
      var out = await rec.session.stop();
      var blob = out.audio;
      if (blob && blob.size) {
        var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        var b64 = await fileToBase64(blob);
        var meta = await API.addAttachment(rec.noteId, { name: 'meeting-audio-' + stamp + '.wav', mime: 'audio/wav', dataB64: b64 });
        if (state.note && state.note.id === rec.noteId) { state.note.attachments = (state.note.attachments || []).concat(meta); renderAttachments(); }
        $('recStatus').textContent = 'Recording saved ✓' + (out.themActive ? ' (mic + shared audio)' : ' (mic only)');
      } else {
        $('recStatus').textContent = 'Nothing recorded.';
      }
    } catch (ex) { $('recStatus').textContent = 'Save failed: ' + ex.message; }
    finally { $('recordBtn').disabled = false; $('recordBtn').textContent = '🔴 Record'; $('recordBtn').classList.remove('recording'); $('screenBtn').disabled = false; }
  }

  // ---------------- Screen + audio recording ----------------
  state.screenRec = null;
  $('screenBtn').addEventListener('click', async function () {
    if (state.screenRec) { await stopScreen(); return; }
    if (!window.Recorder || !window.Recorder.screenSupported()) { await dialog.alert('Screen recording is not supported in this browser.'); return; }
    var noteId = state.note.id;
    try {
      $('screenBtn').disabled = true;
      var session = await window.Recorder.startScreen({
        onStatus: function (m) { $('recStatus').textContent = m; },
        onAutoStop: function () { if (state.screenRec) stopScreen(); }, // user hit the browser's "Stop sharing"
      });
      state.screenRec = { session: session, noteId: noteId };
      $('screenBtn').textContent = '⏹ Stop screen'; $('screenBtn').classList.add('recording');
      $('recordBtn').disabled = true;
    } catch (ex) {
      $('recStatus').textContent = '';
      if (!/permission|denied|cancel|dismiss|abort/i.test(ex.message || '')) await dialog.alert('Could not start screen recording: ' + ex.message);
    } finally { $('screenBtn').disabled = false; }
  });

  async function stopScreen() {
    if (!state.screenRec) return;
    var rec = state.screenRec; state.screenRec = null;
    $('screenBtn').disabled = true; $('recStatus').textContent = 'Saving screen recording…';
    try {
      var blob = await rec.session.stop();
      // A valid recording is well over a few hundred bytes; anything tiny means the
      // capture produced no frames (e.g. the share was cancelled instantly).
      if (blob && blob.size > 512) {
        var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        var ext = /mp4/.test(blob.type || '') ? 'mp4' : 'webm';
        var b64 = await fileToBase64(blob);
        var meta = await API.addAttachment(rec.noteId, { name: 'meeting-screen-' + stamp + '.' + ext, mime: blob.type || 'video/webm', dataB64: b64 });
        if (state.note && state.note.id === rec.noteId) { state.note.attachments = (state.note.attachments || []).concat(meta); renderAttachments(); }
        $('recStatus').textContent = 'Screen recording saved ✓ (' + fmtSize(blob.size) + ')';
      } else { $('recStatus').textContent = 'Nothing was captured — try again and choose a screen/window (and “Share audio” for sound).'; }
    } catch (ex) {
      $('recStatus').textContent = 'Save failed: ' + (ex.status === 413 ? 'recording too large — raise MAX_BODY or record a shorter clip' : ex.message);
    } finally { $('screenBtn').disabled = false; $('screenBtn').textContent = '🖥 Screen'; $('screenBtn').classList.remove('recording'); $('recordBtn').disabled = false; }
  }

  $('transcriptToggle').addEventListener('click', function () {
    var b = $('transcriptBody'); var hidden = b.classList.toggle('collapsed');
    $('transcriptToggle').textContent = hidden ? 'show' : 'hide';
  });

  // ---------------- Header actions ----------------
  $('noteCustomTitle').addEventListener('input', function () { state.note.customTitle = $('noteCustomTitle').value; scheduleSave(); });
  $('favBtn').addEventListener('click', async function () {
    state.note.favorite = !state.note.favorite; $('favBtn').textContent = state.note.favorite ? '★' : '☆';
    var s = await API.setFavorite(state.note.id, state.note.favorite);
    state.note.updatedAt = s.updatedAt; // adopt so the next content save isn't a false conflict
    renderNoteList();
  });
  $('printBtn').addEventListener('click', function () { window.print(); });

  // New-note menu
  $('newNoteBtn').addEventListener('click', function () { createNewNote({}); });
  $('newNoteCaret').addEventListener('click', function (e) { e.stopPropagation(); renderTemplatePick(); $('newNoteMenu').classList.toggle('hidden'); });
  $('newNoteMenu').addEventListener('click', function (e) {
    var kind = e.target.getAttribute('data-new'); if (!kind) return;
    $('newNoteMenu').classList.add('hidden');
    createNewNote(kind === 'scratch' ? { scratch: true } : {});
  });
  async function createNewNote(opts) {
    opts = opts || {};
    var payload = {};
    if (opts.scratch) payload.scratch = true;
    if (opts.templateId) payload.templateId = opts.templateId;
    state.note = await API.newNote(state.wsId, payload);
    showView('note'); renderNote();
    await Promise.all([renderNoteList(), loadTasks()]);
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
      if (!(await dialog.confirm('Move this note to trash?', { okText: 'Move to trash', danger: true }))) return;
      await API.deleteNote(state.note.id); await loadCurrentNote();
    } else if (act === 'copy') {
      var copy = await API.copyNote(state.note.id, null); await loadWorkspaces(); await openNote(copy.id);
    } else if (act === 'move') { openMoveModal(); }
    else if (act === 'link') { copyNoteLink(); }
    else if (act === 'history') { openHistory(); }
  });

  async function copyNoteLink() {
    if (!state.note) return;
    var url = location.origin + location.pathname + '#note/' + state.note.id;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(url); setSaveStatus('Link copied ✓'); }
      else await dialog.alert(url, 'Link to this note');
    } catch (_e) { await dialog.alert(url, 'Link to this note'); }
  }

  // Note-link picker (for the editor's "link to a note" tool)
  function openNotePicker(insert) {
    openModal('notePickerModal');
    var search = $('notePickerSearch'); search.value = '';
    API.listNotes(state.wsId, { sort: 'name', dir: 'asc' }).then(function (notes) {
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
        if (!(await dialog.confirm('Restore this version? The current content is snapshotted first.', { okText: 'Restore' }))) return;
        state.note = await API.restoreVersion(state.note.id, v.ts); closeModals(); renderNote();
      });
      li.appendChild(label); li.appendChild(restore); ul.appendChild(li);
    });
  }

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
        meetingNotes: state.note.meetingNotes, favorite: state.note.favorite,
        tags: state.note.tags, transcript: state.note.transcript, baseRev: state.note.rev,
      });
      state.note.todos = saved.todos; state.note.updatedAt = saved.updatedAt; state.note.rev = saved.rev;
      state.lastSaveAt = Date.now(); // suppress the live-sync echo of our own write
      setSaveStatus('Saved ✓'); renderNoteList();
    } catch (ex) {
      if (ex.status === 409) {
        setSaveStatus('⚠ Changed elsewhere');
        var choice = await dialog.choose(
          'This note was changed in another tab or device since you opened it.',
          [
            { label: 'Keep both', returns: 'fork', primary: true },
            { label: 'Discard mine', returns: 'discard', danger: true },
            { label: 'Cancel', returns: 'cancel' },
          ], { title: 'Conflicting change', cancelValue: 'cancel' });
        if (choice === 'fork') {
          var fork = await API.forkNote(state.note.id, {
            customTitle: state.note.customTitle, todos: state.note.todos, carryover: state.note.carryover,
            meetingNotes: state.note.meetingNotes, tags: state.note.tags,
          });
          await loadWorkspaces(); await openNote(fork.id); setSaveStatus('Saved as a conflict copy ✓');
        } else if (choice === 'discard') {
          if (ex.data && ex.data.current) { state.note = ex.data.current; renderNote(); }
          else await loadCurrentNote();
          setSaveStatus('Loaded the latest version');
        } // cancel: leave the user's edits in place to retry
      } else { setSaveStatus('Save failed: ' + ex.message); }
    }
  }
  function setSaveStatus(s) { $('saveStatus').textContent = s; }
  window.addEventListener('beforeunload', function () { if (state.saveTimer) saveNow(); });

  // ---------------- Views ----------------
  function showView(v) {
    state.view = v;
    ['noteView', 'landingView', 'todosView', 'favsView', 'trashView', 'searchView'].forEach(function (id) { $(id).classList.add('hidden'); });
    $('navNote').classList.toggle('active', v === 'note' || v === 'landing');
    $('navTodos').classList.toggle('active', v === 'todos');
    $('navFavs').classList.toggle('active', v === 'favs');
    var map = { note: 'noteView', landing: 'landingView', todos: 'todosView', favs: 'favsView', trash: 'trashView', search: 'searchView' };
    if (map[v]) $(map[v]).classList.remove('hidden');
  }
  $('navNote').addEventListener('click', function () { if (state.note) { showView('note'); renderNoteList(); } else loadCurrentNote(); });
  $('navTodos').addEventListener('click', renderGlobalTasks);
  $('navFavs').addEventListener('click', renderFavorites);

  function openWorkspace(wsId) {
    state.wsId = wsId; $('workspaceSelect').value = wsId; showView('note'); loadCurrentNote();
  }

  // Global Tasks page: every open task across workspaces, grouped by due date
  // (overdue dates first, then today, then upcoming, then undated), and within
  // each date sorted by priority then workspace. This replaces the old Agenda.
  async function renderGlobalTasks() {
    showView('todos');
    var box = $('globalTaskList'); box.innerHTML = '<p class="muted">Loading…</p>';
    var tasks = await API.globalTasks();
    box.innerHTML = '';
    if (!tasks.length) { box.innerHTML = '<p class="muted">No open tasks. 🎉</p>'; return; }
    var today = todayStr();
    var NODATE = '￿'; // sorts after all YYYY-MM-DD keys
    var groups = {};
    tasks.forEach(function (t) { var k = t.due || NODATE; (groups[k] = groups[k] || []).push(t); });
    Object.keys(groups).sort().forEach(function (k) {
      var isNo = k === NODATE, overdue = !isNo && k < today;
      var sec = document.createElement('div'); sec.className = 'task-group';
      var lab = document.createElement('div'); lab.className = 'upcoming-date' + (overdue ? ' overdue' : '');
      lab.textContent = isNo ? 'No date' : (fmtDueLong(k) + (overdue ? ' · overdue' : (k === today ? ' · today' : '')));
      sec.appendChild(lab);
      var ul = document.createElement('ul'); ul.className = 'task-list';
      groups[k].sort(function (a, b) { return (a.priority - b.priority) || String(a.workspaceName || '').localeCompare(String(b.workspaceName || '')); })
        .forEach(function (t) { ul.appendChild(globalTaskRow(t, today)); });
      sec.appendChild(ul); box.appendChild(sec);
    });
  }

  function globalTaskRow(t, today) {
    var li = document.createElement('li'); li.className = 'task prio-p' + t.priority;
    if (t.due && t.due < today) li.classList.add('overdue');
    var cb = document.createElement('button'); cb.className = 'task-check'; cb.setAttribute('aria-label', 'Complete task');
    cb.addEventListener('click', async function () {
      li.classList.add('checking');
      await API.completeTask(t.id, (state.note && state.note.workspaceId === t.workspaceId) ? state.note.id : null);
      if (t.workspaceId === state.wsId) await loadTasks();
      renderGlobalTasks();
    });
    var main = document.createElement('div'); main.className = 'task-main';
    var line = document.createElement('div'); line.className = 'gt-line';
    var ws = document.createElement('button'); ws.className = 'gt-ws'; ws.textContent = t.workspaceName; ws.title = 'Open ' + t.workspaceName;
    ws.addEventListener('click', function () { openWorkspace(t.workspaceId); });
    var text = document.createElement('span'); text.className = 'task-text'; text.textContent = t.text;
    line.appendChild(ws); line.appendChild(text); main.appendChild(line);
    var meta = document.createElement('div'); meta.className = 'task-meta';
    if (t.time) { var tm = document.createElement('span'); tm.className = 'task-recur'; tm.textContent = '🕑 ' + t.time; meta.appendChild(tm); }
    if (t.recurrence) { var rc = document.createElement('span'); rc.className = 'task-recur'; rc.textContent = '🔁 ' + recurLabel(t.recurrence); meta.appendChild(rc); }
    if (t.sourceInbox) { var ib = document.createElement('span'); ib.className = 'inbox-badge'; ib.textContent = '📥'; ib.title = 'From your inbox'; meta.appendChild(ib); }
    if (meta.childNodes.length) main.appendChild(meta);
    li.appendChild(cb); li.appendChild(main);
    return li;
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
      restore.addEventListener('click', async function () {
        await API.restoreTrash(f.id);
        await loadWorkspaces();
        renderNoteList(); // reflect the restored note in the sidebar if it's in the current workspace
        renderTrash();
      });
      var purge = document.createElement('button'); purge.className = 'link-btn danger'; purge.textContent = 'delete forever';
      purge.addEventListener('click', async function () { if (await dialog.confirm('Permanently delete “' + f.displayTitle + '”? This cannot be undone.', { okText: 'Delete forever', danger: true })) { await API.purgeTrash(f.id); renderTrash(); } });
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
      li.innerHTML = '<div class="sr-top"><span class="sr-title">' + hl(r.title, q) + '</span><span class="sr-ws">' + esc(r.workspaceName) + '</span></div>' +
        '<div class="sr-snippet">' + hl(r.snippet, q) + tags + '</div>';
      li.addEventListener('click', function () { openNote(r.noteId); $('globalSearch').value = ''; }); ul.appendChild(li);
    });
  }
  // escape, then highlight occurrences of the query (ignoring a leading tag: filter)
  function hl(text, q) {
    var out = esc(text);
    var term = String(q || '').replace(/tag:\S+/g, '').trim();
    if (!term) return out;
    try {
      var re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
      return out.replace(re, '<mark>$1</mark>');
    } catch (e) { return out; }
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
      del.addEventListener('click', async function () { if (await dialog.confirm('Delete template “' + t.name + '”?', { okText: 'Delete', danger: true })) { await API.deleteTemplate(t.id); await loadTemplates(); renderTemplateList(); } });
      li.appendChild(name); li.appendChild(edit); li.appendChild(del); ul.appendChild(li);
    });
  }
  function clearTplEditor() { $('tplEditingId').value = ''; $('tplName').value = ''; $('tplMeeting').innerHTML = ''; }
  function loadTplIntoEditor(t) { $('tplEditingId').value = t.id; $('tplName').value = t.name; $('tplMeeting').innerHTML = t.meetingNotes || ''; }
  $('clearTplBtn').addEventListener('click', clearTplEditor);
  $('saveTplBtn').addEventListener('click', async function () {
    var data = {
      name: $('tplName').value.trim() || 'Template',
      meetingNotes: $('tplMeeting').innerHTML,
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
    else if (m === 'account') openAccount();
    else if (m === 'manual') openManual();
  });
  function openAccount(focusStt) {
    $('acctMsg').textContent = '';
    var inst = state.instance || {};
    $('instanceInfo').innerHTML = '<b>' + esc(inst.name || 'Meeting Notes') + '</b> · v' + esc(inst.version || '') +
      '<br>URL: <code>' + esc(inst.url || location.origin) + '</code>' +
      (inst.domain ? '' : '<br><span class="muted">Tip: run <code>node server.js --set-domain notes</code> for a durable &lt;name&gt;.localhost address.</span>');
    $('fontSize').value = state.settings.fontSize || 14;
    var tc = state.settings.transcription || {};
    $('sttEndpoint').value = tc.endpoint || ''; $('sttKey').value = tc.apiKey || ''; $('sttModel').value = tc.model || '';
    updateSttWarn();
    renderBioSettings();
    renderInboxSettings();
    renderSlackSettings();
    loadStatsInto();
    openModal('accountModal');
    if (focusStt) setTimeout(function () { var el = $('sttEndpoint'); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } }, 40);
  }

  function renderBioSettings() {
    var supported = !!window.PublicKeyCredential;
    var enrolled = !!(state.bio && state.bio.enrolled);
    $('bioStatus').textContent = !supported
      ? 'Not supported in this browser.'
      : enrolled ? ('Enabled — ' + (((state.bio.credentials || [])[0] || {}).label || 'this device') + '.') : 'Not enabled on this device.';
    $('bioEnableBtn').classList.toggle('hidden', !supported || enrolled);
    $('bioRemoveBtn').classList.toggle('hidden', !enrolled);
    $('bioMsg').textContent = '';
  }
  function bioMsg(s, isErr) { var el = $('bioMsg'); el.textContent = s; el.style.color = isErr ? 'var(--danger)' : 'var(--muted)'; }
  $('bioEnableBtn').addEventListener('click', async function () {
    bioMsg('Follow your device’s prompt…', false); $('bioEnableBtn').disabled = true;
    try {
      await bioEnroll();
      var st = await API.status(); state.bio = st.bio || state.bio;
      renderBioSettings(); bioMsg('Biometric unlock enabled ✓', false);
    } catch (ex) { bioMsg(ex.message, true); }
    finally { $('bioEnableBtn').disabled = false; }
  });
  $('bioRemoveBtn').addEventListener('click', async function () {
    if (!(await dialog.confirm('Remove biometric unlock from this vault? Your passphrase still works.', { okText: 'Remove', danger: true }))) return;
    try {
      var creds = (state.bio && state.bio.credentials) || [];
      for (var i = 0; i < creds.length; i++) await API.webauthnRemove(creds[i].id);
      var st = await API.status(); state.bio = st.bio || { enrolled: false, credentials: [] };
      renderBioSettings(); bioMsg('Removed.', false);
    } catch (ex) { bioMsg(ex.message, true); }
  });
  $('sttSettingsBtn').addEventListener('click', function () { openAccount(true); });
  function isLocalEndpoint(url) { return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url || ''); }
  function updateSttWarn() {
    var ep = $('sttEndpoint').value.trim();
    $('sttWarn').textContent = (ep && !isLocalEndpoint(ep))
      ? '⚠ This is an external endpoint — meeting audio will be sent there for transcription.'
      : '';
  }
  $('sttEndpoint').addEventListener('input', updateSttWarn);
  $('saveSttBtn').addEventListener('click', async function () {
    state.settings.transcription = { endpoint: $('sttEndpoint').value.trim(), apiKey: $('sttKey').value, model: $('sttModel').value.trim() || 'whisper-1' };
    await API.saveSettings({ transcription: state.settings.transcription });
    acctMsg('Transcription settings saved ✓', false);
  });

  // Workspaces modal
  $('manageWs').addEventListener('click', openWsModal);
  function openWsModal() { openModal('wsModal'); renderWsManage(); }
  function renderWsManage() {
    var ul = $('wsManageList'); ul.innerHTML = '';
    state.workspaces.forEach(function (w) {
      var li = document.createElement('li'); li.className = 'wm-row';

      var top = document.createElement('div'); top.className = 'wm-top';
      var inp = document.createElement('input'); inp.className = 'wm-name-input'; inp.value = w.name; inp.setAttribute('aria-label', 'Workspace name');
      inp.addEventListener('change', function () { API.renameWorkspace(w.id, inp.value.trim() || w.name).then(loadWorkspaces); });
      top.appendChild(inp);
      if (w.id === 'general') {
        var badge = document.createElement('span'); badge.className = 'wm-badge'; badge.textContent = 'default'; top.appendChild(badge);
      } else {
        var del = document.createElement('button'); del.className = 'wm-del icon-btn'; del.textContent = '🗑'; del.title = 'Delete workspace';
        del.addEventListener('click', async function () {
          if (!(await dialog.confirm('Delete workspace “' + w.name + '” and all its notes? This cannot be undone.', { okText: 'Delete workspace', danger: true }))) return;
          await API.deleteWorkspace(w.id); if (state.wsId === w.id) state.wsId = 'general';
          await loadWorkspaces(); renderWsManage(); await loadCurrentNote();
        });
        top.appendChild(del);
      }

      var tplRow = document.createElement('div'); tplRow.className = 'wm-tpl-row';
      var lbl = document.createElement('label'); lbl.className = 'tiny muted'; lbl.textContent = 'Default template';
      var tsel = document.createElement('select'); tsel.className = 'ws-tpl';
      tsel.innerHTML = '<option value="">None</option>' + state.templates.map(function (t) { return '<option value="' + t.id + '"' + (w.defaultTemplateId === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('');
      tsel.addEventListener('change', function () { API.setWorkspaceTemplate(w.id, tsel.value || null).then(loadWorkspaces); });
      tplRow.appendChild(lbl); tplRow.appendChild(tsel);

      li.appendChild(top); li.appendChild(tplRow);
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
    var file = $('importFile').files[0]; if (!file) { await dialog.alert('Choose a file to import.'); return; }
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
    if (!sel.options.length) { dialog.alert('Create another workspace first.'); return; }
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
    if (!(await dialog.confirm('Generate a new recovery key? The old one stops working.', { okText: 'Regenerate' }))) return;
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
  $('viewerBtn').addEventListener('click', function () { downloadUrl(API.viewerUrl()); });
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
    // Command palette — works even while typing in a field.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (palette.open) closePalette(); else openPalette();
      return;
    }
    if (e.key === 'Escape') {
      if (palette.open) { closePalette(); return; }
      if (!$('helpLayer').classList.contains('hidden')) { closeHelp(); return; }
      closeModals(); ['exportMenu', 'noteMoreMenu', 'moreMenu', 'newNoteMenu'].forEach(function (id) { $(id).classList.add('hidden'); });
    }
  });

  // ---------------- Notifications + reminder polling ----------------
  $('notifyBtn').addEventListener('click', async function () {
    if (!('Notification' in window)) { await dialog.alert('Notifications are not supported in this browser.'); return; }
    var perm = await Notification.requestPermission();
    state.notify = perm === 'granted';
    $('notifyBtn').textContent = state.notify ? '🔔' : '🔕';
    if (state.notify) pollInbox();
  });
  function startReminderPolling() { pollInbox(); setInterval(pollInbox, 60 * 1000); }
  async function pollInbox() {
    try {
      // Drain the inbox (Slack etc. → tasks) into the target workspace.
      try {
        var inbox = await API.processInbox();
        if (inbox && inbox.added) {
          if (state.notify && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(inbox.added + ' new task' + (inbox.added > 1 ? 's' : '') + ' in your inbox');
          }
          if (inbox.workspaceId === state.wsId && state.view === 'note' && state.note) await loadTasks();
        }
      } catch (_e) { /* ignore */ }
      maybeSendDailyAgenda();
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
    else if (e.key === '?') { e.preventDefault(); openHelp(); }
  });

  // ---------------- Logout ----------------
  $('logoutBtn').addEventListener('click', async function () {
    if (state.saveTimer) await saveNow(); await API.logout(); location.reload();
  });

  // ---------------- Utils ----------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function rid() { return Math.random().toString(36).slice(2, 10); }
  function fmtSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
  // Extract the base64 payload from a data URL. Must key off the ";base64,"
  // marker, NOT the first comma — a MIME type can itself contain a comma
  // (e.g. video/webm;codecs=vp9,opus), which would otherwise truncate the data.
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result); var m = s.indexOf(';base64,'); resolve(m >= 0 ? s.slice(m + 8) : s.slice(s.indexOf(',') + 1)); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  function downloadUrl(u) { var a = document.createElement('a'); a.href = u; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }

  boot().catch(function (e) { console.error(e); });
})();
