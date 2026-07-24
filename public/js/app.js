/* Cove — main application controller. */
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
      rp: { name: 'Cove' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'meeting-notes', displayName: 'Cove' },
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
    state.tagBookmarks = Array.isArray(state.settings.tagBookmarks) ? state.settings.tagBookmarks : [];
    state.savedSearches = Array.isArray(state.settings.savedSearches) ? state.settings.savedSearches : [];
    state.allTags = [];
    try { state.allTags = await API.allTags(); } catch (_e) { /* non-fatal */ }
    applyFontSize(state.settings.fontSize || 14);
    applyTheme(state.settings.theme || 'auto');
    applySortControl();
    renderTagBookmarks();
    renderSavedSearches();
    await loadTemplates();
    await loadWorkspaces();
    await routeFromHash();
    startIdleTimer();
    startReminderPolling();
    startLiveSync();
    maybeOnboard();
  }

  // Show the first-run tour once, but only for a genuinely new/empty vault —
  // existing users (who already have notes) are marked onboarded silently.
  async function maybeOnboard() {
    if (state.settings.onboarded) return;
    try {
      var st = await API.stats();
      if (st && st.notes > 0) { state.settings.onboarded = true; API.saveSettings({ onboarded: true }); return; }
    } catch (_e) { return; }
    setTimeout(openTour, 400);
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
  $('tourStartBtn').addEventListener('click', function () { closeHelp(); openTour(); });

  // ---------------- Command palette (⌘K / Ctrl-K) ----------------
  var palette = { open: false, items: [], active: 0 };
  function paletteActions() {
    return [
      { label: '＋ New Daily note', run: function () { createNewNote({}); } },
      { label: '✏️ New scratch note', run: function () { createNewNote({ scratch: true }); } },
      { label: 'Go to: Current note', run: function () { if (state.note) { showView('note'); renderNoteList(); } else loadCurrentNote(); } },
      { label: 'Go to: Tasks', run: renderGlobalTasks },
      { label: 'Go to: Task calendar', run: renderCalendar },
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
    // quick-add a task from anywhere (use the raw, case-preserved input)
    var rawInput = ($('paletteInput').value || '').trim();
    if (rawInput) {
      var pp = window.TaskParse ? window.TaskParse.parse(rawInput) : { text: rawInput, priority: 4 };
      var w0 = state.workspaces.filter(function (x) { return x.id === state.wsId; })[0];
      var bits = [];
      if (pp.due) bits.push(pp.due === todayStr() ? 'today' : pp.due);
      if (pp.time) bits.push(pp.time);
      if (pp.priority < 4) bits.push('P' + pp.priority);
      if (pp.recurrence) bits.push('🔁');
      items.push({
        label: '➕ Add task: ' + (pp.text || rawInput),
        sub: 'to ' + (w0 ? w0.name : 'workspace') + (bits.length ? ' · ' + bits.join(' · ') : ''),
        run: async function () {
          var p = window.TaskParse.parse(rawInput);
          applyTaskResult(await API.addTask(state.wsId, { text: p.text || rawInput, due: p.due, time: p.time, priority: p.priority, recurrence: p.recurrence }));
        },
      });
    }
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

  async function loadDataDir() {
    var info = $('dataDirInfo'), input = $('dataDirInput'), btn = $('dataDirSaveBtn');
    $('dataDirMsg').textContent = '';
    try {
      var d = await API.getDataDir();
      var src = d.source === 'env' ? 'set by the DATA_DIR environment variable'
        : d.source === 'pointer' ? 'configured here' : 'default (bundled with the app)';
      info.innerHTML = 'Current: <code>' + esc(d.path) + '</code><br><span class="muted">' + esc(src) + '</span>';
      if (d.envOverride) {
        input.value = ''; input.disabled = true; btn.disabled = true;
        input.placeholder = 'Pinned by DATA_DIR — unset that env var to change it here';
      } else {
        input.disabled = false; btn.disabled = false; input.value = d.path;
      }
    } catch (e) { info.textContent = ''; }
  }
  function dataDirMsg(s, isErr) { var el = $('dataDirMsg'); el.textContent = s; el.style.color = isErr ? 'var(--danger)' : 'var(--muted)'; }
  $('dataDirSaveBtn').addEventListener('click', async function () {
    var p = $('dataDirInput').value.trim();
    if (!p) { dataDirMsg('Enter an absolute path first.', true); return; }
    $('dataDirSaveBtn').disabled = true; dataDirMsg('Saving…', false);
    try {
      var r = await API.saveDataDir(p);
      if (r.unchanged) dataDirMsg('That is already the current location.', false);
      else dataDirMsg('Saved ✓ — restart the app to load data from ' + r.path, false);
      loadDataDir();
    } catch (ex) { dataDirMsg(ex.message, true); }
    finally { $('dataDirSaveBtn').disabled = false; }
  });

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
    $('landingWs').textContent = w ? w.name : 'Cove';
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
  // Debounced so it doesn't recount the whole note on every keystroke (typing lag).
  var wcTimer = null;
  function scheduleWordCount() { clearTimeout(wcTimer); wcTimer = setTimeout(updateWordCount, 400); }

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

  // Compact relative time, e.g. "just now", "5m ago", "3d ago".
  function relTime(iso) {
    var then = new Date(iso).getTime(); if (isNaN(then)) return '';
    var s = Math.floor((Date.now() - then) / 1000); if (s < 0) s = 0;
    if (s < 45) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24); if (d < 7) return d + 'd ago';
    var w = Math.floor(d / 7); if (w < 5) return w + 'w ago';
    var mo = Math.floor(d / 30); if (mo < 12) return mo + 'mo ago';
    return Math.floor(d / 365) + 'y ago';
  }

  async function renderNoteList() {
    var s = noteSort();
    var notes = await API.listNotes(state.wsId, { sort: s.field, dir: s.dir });
    var ul = $('noteList'); ul.innerHTML = '';
    notes.forEach(function (nm) {
      var li = document.createElement('li');
      li.setAttribute('data-note-id', nm.id);
      if (state.note && nm.id === state.note.id && state.view === 'note') li.classList.add('active');
      var tags = (nm.tags || []).length ? '<span class="nl-tags">' + nm.tags.map(function (t) { return '#' + esc(t); }).join(' ') + '</span>' : '';
      var main = document.createElement('div'); main.className = 'nl-main';
      var scratch = nm.kind === 'scratch';
      var doneHere = nm.doneTaskCount ? '<span title="Tasks completed on this note">✓ ' + nm.doneTaskCount + '</span>' : '';
      var edited = nm.updatedAt ? '<span class="nl-time" title="Edited ' + esc(new Date(nm.updatedAt).toLocaleString()) + '">' + esc(relTime(nm.updatedAt)) + '</span>' : '';
      main.innerHTML =
        '<div class="nl-title">' + (scratch ? '<span class="nl-scratch" title="Scratch note">✏️</span> ' : '') + esc(nm.displayTitle) + '</div>' +
        '<div class="nl-meta">' + edited + (scratch ? '<span>scratch</span>' : doneHere) +
        (nm.attachmentCount ? '<span>📎 ' + nm.attachmentCount + '</span>' : '') + tags + '</div>';
      if (state.selecting) {
        li.classList.toggle('sel', !!state.selected[nm.id]);
        var ck = document.createElement('input'); ck.type = 'checkbox'; ck.className = 'nl-check'; ck.checked = !!state.selected[nm.id];
        ck.addEventListener('click', function (e) { e.stopPropagation(); toggleSelect(nm.id); });
        li.appendChild(ck);
        main.addEventListener('click', function () { toggleSelect(nm.id); });
      } else {
        main.addEventListener('click', function () { openNote(nm.id); });
      }

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

  // ---------------- Bulk note selection ----------------
  state.selecting = false;
  state.selected = {};
  function selectedIds() { return Object.keys(state.selected).filter(function (k) { return state.selected[k]; }); }
  function toggleSelect(id) {
    if (state.selected[id]) delete state.selected[id]; else state.selected[id] = true;
    var li = $('noteList').querySelector('li[data-note-id="' + id + '"]');
    if (li) { li.classList.toggle('sel', !!state.selected[id]); var ck = li.querySelector('.nl-check'); if (ck) ck.checked = !!state.selected[id]; }
    updateBulkBar();
  }
  function updateBulkBar() {
    var n = selectedIds().length;
    $('bulkBar').classList.toggle('hidden', !state.selecting);
    $('bulkCount').textContent = n + ' selected';
    ['bulkMove', 'bulkTag', 'bulkDelete'].forEach(function (id) { $(id).disabled = n === 0; });
  }
  function setSelecting(on) {
    state.selecting = on; if (!on) state.selected = {};
    $('selectToggle').classList.toggle('on', on);
    renderNoteList(); updateBulkBar();
  }
  $('selectToggle').addEventListener('click', function () { setSelecting(!state.selecting); });
  $('bulkCancel').addEventListener('click', function () { setSelecting(false); });
  $('bulkDelete').addEventListener('click', async function () {
    var ids = selectedIds(); if (!ids.length) return;
    if (!(await dialog.confirm('Move ' + ids.length + ' note' + (ids.length > 1 ? 's' : '') + ' to trash?', { okText: 'Move to trash', danger: true }))) return;
    await API.batchNotes('delete', ids); setSelecting(false); await loadCurrentNote();
  });
  $('bulkMove').addEventListener('click', async function () {
    var ids = selectedIds(); if (!ids.length) return;
    var ws = await pickWorkspace('Move ' + ids.length + ' note' + (ids.length > 1 ? 's' : '') + ' to which workspace?');
    if (!ws) return;
    await API.batchNotes('move', ids, { workspaceId: ws }); setSelecting(false); await loadCurrentNote();
  });
  $('bulkTag').addEventListener('click', async function () {
    var ids = selectedIds(); if (!ids.length) return;
    var tag = await dialog.prompt('Add which tag to ' + ids.length + ' note' + (ids.length > 1 ? 's' : '') + '?', { title: 'Bulk tag' });
    if (tag == null) return;
    tag = String(tag).replace(/^#/, '').trim(); if (!tag) return;
    await API.batchNotes('tag', ids, { tags: [tag] });
    if (state.allTags.indexOf(tag) < 0) state.allTags.push(tag);
    setSelecting(false); await loadCurrentNote();
  });

  // ---------------- Tags ----------------
  function renderTags() {
    var bar = $('tagBar'); bar.innerHTML = '';
    (state.note.tags || []).forEach(function (t) {
      var chip = document.createElement('span'); chip.className = 'tag-chip';
      var lbl = document.createElement('button'); lbl.className = 'tag-open'; lbl.textContent = '#' + t; lbl.title = 'View all notes tagged #' + t;
      lbl.addEventListener('click', function () { openTagView(t); });
      var rm = document.createElement('button'); rm.className = 'tag-rm'; rm.setAttribute('aria-label', 'Remove tag'); rm.textContent = '✕';
      rm.addEventListener('click', function () {
        state.note.tags = state.note.tags.filter(function (x) { return x !== t; });
        renderTags(); scheduleSave();
      });
      chip.appendChild(lbl); chip.appendChild(rm);
      bar.appendChild(chip);
    });
    var inp = document.createElement('input'); inp.className = 'tag-input'; inp.placeholder = '+ tag';
    inp.setAttribute('list', 'tagSuggest'); inp.autocomplete = 'off';
    inp.addEventListener('focus', refreshTagSuggestions); // keep suggestions current
    inp.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      var v = inp.value.trim().replace(/^#/, '');
      if (v && (state.note.tags || []).indexOf(v) < 0) {
        state.note.tags = (state.note.tags || []).concat(v);
        if (state.allTags.indexOf(v) < 0) state.allTags.push(v);
        renderTags(); scheduleSave();
      } else if (v) { inp.value = ''; }
    });
    bar.appendChild(inp);
    fillTagSuggest();
  }

  // Discreet tag autocomplete: a native <datalist> of existing tags, minus the
  // ones already on this note. We only rebuild the <option>s when the set
  // actually changes — replacing them while the dropdown is open makes the
  // native popup flicker.
  var _tagSuggestSig = null, _tagsFetchedAt = 0;
  function fillTagSuggest() {
    var dl = $('tagSuggest'); if (!dl) return;
    var have = {}; (state.note && state.note.tags || []).forEach(function (t) { have[t.toLowerCase()] = 1; });
    var opts = (state.allTags || []).filter(function (t) { return !have[t.toLowerCase()]; });
    var sig = opts.join('\n');
    if (sig === _tagSuggestSig) return; // unchanged — don't touch the DOM
    _tagSuggestSig = sig;
    dl.innerHTML = '';
    opts.forEach(function (t) { var o = document.createElement('option'); o.value = t; dl.appendChild(o); });
  }
  async function refreshTagSuggestions() {
    // Tags change rarely; refetch at most once a minute rather than on every focus.
    if (Date.now() - _tagsFetchedAt < 60000) { fillTagSuggest(); return; }
    _tagsFetchedAt = Date.now();
    try { state.allTags = await API.allTags(); } catch (_e) { /* keep cached */ }
    fillTagSuggest();
  }

  // ---------------- Tag bookmarks (global saved tags) ----------------
  function normTag(t) { return String(t || '').replace(/^#/, '').trim(); }
  function isTagBookmarked(tag) {
    var lc = normTag(tag).toLowerCase();
    return (state.tagBookmarks || []).some(function (x) { return x.toLowerCase() === lc; });
  }
  async function saveTagBookmarks() {
    try { await API.saveSettings({ tagBookmarks: state.tagBookmarks }); } catch (_e) {}
  }
  async function toggleTagBookmark(tag) {
    tag = normTag(tag); if (!tag) return;
    if (isTagBookmarked(tag)) {
      var lc = tag.toLowerCase();
      state.tagBookmarks = state.tagBookmarks.filter(function (x) { return x.toLowerCase() !== lc; });
    } else {
      state.tagBookmarks = (state.tagBookmarks || []).concat(tag);
    }
    renderTagBookmarks();
    if (state.view === 'tag' && state.activeTag) syncTagBookmarkBtn();
    await saveTagBookmarks();
  }

  // Sidebar section — shown regardless of the current workspace, only when there
  // is at least one bookmarked tag.
  function renderTagBookmarks() {
    var wrap = $('tagBookmarks'); if (!wrap) return;
    var list = state.tagBookmarks || [];
    wrap.classList.toggle('hidden', !list.length);
    var ul = $('tagBookmarkList'); ul.innerHTML = '';
    list.slice().sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); }).forEach(function (tag) {
      var li = document.createElement('li'); li.className = 'tagbm' + (state.view === 'tag' && state.activeTag && state.activeTag.toLowerCase() === tag.toLowerCase() ? ' active' : '');
      var open = document.createElement('button'); open.className = 'tagbm-open'; open.textContent = '# ' + tag; open.title = 'View notes tagged #' + tag;
      open.addEventListener('click', function () { openTagView(tag); });
      var rm = document.createElement('button'); rm.className = 'tagbm-rm'; rm.textContent = '✕'; rm.title = 'Remove bookmark'; rm.setAttribute('aria-label', 'Remove bookmark');
      rm.addEventListener('click', function (e) { e.stopPropagation(); toggleTagBookmark(tag); });
      li.appendChild(open); li.appendChild(rm); ul.appendChild(li);
    });
  }

  function syncTagBookmarkBtn() {
    var b = $('tagBookmarkBtn'); if (!b) return;
    var on = isTagBookmarked(state.activeTag);
    b.textContent = on ? '🔖 Bookmarked' : '🔖 Bookmark tag';
    b.classList.toggle('on', on);
  }

  // ---- saved searches (pinned queries, incl. operators) ----
  function renderSavedSearches() {
    var wrap = $('savedSearches'); if (!wrap) return;
    var list = state.savedSearches || [];
    wrap.classList.toggle('hidden', !list.length);
    var ul = $('savedSearchList'); ul.innerHTML = '';
    list.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'tagbm' + (state.view === 'search' && state.lastQuery === s.query ? ' active' : '');
      var open = document.createElement('button'); open.className = 'tagbm-open'; open.textContent = '🔎 ' + s.name;
      open.title = 'Run: ' + s.query;
      open.addEventListener('click', function () { $('globalSearch').value = s.query; runSearch(s.query); });
      var rm = document.createElement('button'); rm.className = 'tagbm-rm'; rm.textContent = '✕';
      rm.title = 'Remove saved search'; rm.setAttribute('aria-label', 'Remove saved search');
      rm.addEventListener('click', function (e) { e.stopPropagation(); removeSavedSearch(s.id); });
      li.appendChild(open); li.appendChild(rm); ul.appendChild(li);
    });
  }
  async function persistSavedSearches() {
    try { await API.saveSettings({ savedSearches: state.savedSearches }); } catch (_e) { /* non-fatal */ }
  }
  async function saveCurrentSearch() {
    var q = (state.lastQuery || $('globalSearch').value || '').trim();
    if (!q) { await dialog.alert('Run a search first, then save it.'); return; }
    var name = await dialog.prompt('Name this saved search:', { title: 'Save search', default: q });
    if (name == null) return;
    name = String(name).trim().slice(0, 60) || q;
    state.savedSearches = (state.savedSearches || []).concat({ id: rid(), name: name, query: q });
    renderSavedSearches(); persistSavedSearches();
  }
  function removeSavedSearch(id) {
    state.savedSearches = (state.savedSearches || []).filter(function (x) { return x.id !== id; });
    renderSavedSearches(); persistSavedSearches();
  }
  $('saveSearchBtn').addEventListener('click', saveCurrentSearch);

  // A cross-workspace view of every note carrying a tag.
  async function openTagView(tag) {
    tag = normTag(tag); if (!tag) return;
    // Flush a pending note save so the search index reflects any just-added tag.
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; await saveNow(); }
    state.activeTag = tag;
    showView('tag');
    $('tagViewTitle').textContent = '#' + tag;
    syncTagBookmarkBtn();
    renderTagBookmarks();
    var ul = $('tagNoteList'); ul.innerHTML = '<li class="muted">Loading…</li>';
    var hits = [];
    try { hits = await API.search('tag:' + tag); } catch (_e) { hits = []; }
    $('tagViewSub').textContent = hits.length + ' note' + (hits.length === 1 ? '' : 's') + ' across all workspaces';
    ul.innerHTML = '';
    if (!hits.length) { ul.innerHTML = '<li class="muted">No notes with this tag yet. Create one with ＋ New Daily.</li>'; return; }
    hits.forEach(function (h) {
      var li = document.createElement('li'); li.className = 'tag-note';
      var ws = document.createElement('span'); ws.className = 'gt-ws'; ws.textContent = h.workspaceName || '';
      var title = document.createElement('span'); title.className = 'fv-title'; title.textContent = h.title || '(untitled)';
      li.appendChild(ws); li.appendChild(title);
      li.addEventListener('click', function () { openNote(h.noteId); });
      ul.appendChild(li);
    });
  }
  $('tagBookmarkBtn').addEventListener('click', function () { if (state.activeTag) toggleTagBookmark(state.activeTag); });
  $('tagNewNoteBtn').addEventListener('click', function () { createNewNote({}); });

  // ---------------- To-dos ----------------
  var todayStr = function () { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
  function p2(n) { return String(n).padStart(2, '0'); }

  // ---------------- Tasks (unified to-do + reminder, Todoist-style) ----------------
  state.tasks = [];
  state.qa = { due: null, time: null, priority: 4, recurrence: null };
  // Which quick-add fields the user set explicitly with a picker. Manually-set
  // fields are preserved as you keep typing the task text (only tokens the parser
  // actually finds in the text override them).
  state.qaManual = { due: false, time: false, priority: false, recurrence: false };

  async function loadTasks() {
    try { state.tasks = await API.listTasks(state.wsId); } catch (_e) { state.tasks = []; }
    renderTasks();
  }
  function applyTaskResult(res) {
    // Task changes don't alter the note list itself — only the sidebar's small
    // "completed here" badge — so we deliberately avoid rebuilding the whole
    // list here (that was a per-click cost that lagged on large workspaces).
    if (res && res.tasks && res.workspaceId === state.wsId) { state.tasks = res.tasks; renderTasks(); }
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
  var DOW_ABBR = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  function recurLabel(rec) {
    if (!rec) return '';
    if (rec.type === 'daily') return 'daily'; if (rec.type === 'weekdays') return 'weekdays';
    if (rec.type === 'weekly') {
      if (rec.days && rec.days.length) return rec.days.slice().sort(function (a, b) { return a - b; }).map(function (d) { return DOW_ABBR[d]; }).join(' ');
      return rec.n > 1 ? 'every ' + rec.n + ' wks' : 'weekly';
    }
    if (rec.type === 'monthly') return rec.n > 1 ? 'every ' + rec.n + ' mos' : 'monthly';
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
    $('qaDateLbl').textContent = state.qa.due ? fmtDueShort(state.qa.due) : 'Date';
    $('qaDate').classList.toggle('set', !!state.qa.due);
    syncRecurUI();
  }
  // Reflect the current recurrence onto the picker: the repeat <select>, the
  // "every N days/weeks/months" interval, and the weekly day-of-week chips.
  // Note: an everyNDays recurrence maps back to the "Daily" select option.
  function syncRecurUI() {
    var rec = state.qa.recurrence;
    var type = rec ? rec.type : 'none';
    $('qaRecur').value = (type === 'everyNDays') ? 'daily' : type;
    var isDaily = type === 'daily' || type === 'everyNDays';
    var isWeekly = type === 'weekly';
    var isMonthly = type === 'monthly';
    var weeklyByDays = isWeekly && rec.days && rec.days.length;
    // Interval field applies to daily/monthly and to weekly-by-interval (not
    // weekly-by-specific-days, where the interval is implicitly 1 week).
    var showEvery = isDaily || isMonthly || (isWeekly && !weeklyByDays);
    $('qaEvery').classList.toggle('hidden', !showEvery);
    if (showEvery) {
      $('qaEveryUnit').textContent = isDaily ? 'days' : isMonthly ? 'months' : 'weeks';
      $('qaRecurN').value = String((rec && rec.n) || 1);
    }
    // Day-of-week chips: weekly only.
    $('qaDows').classList.toggle('hidden', !isWeekly);
    var days = (isWeekly && rec.days) ? rec.days : [];
    Array.prototype.forEach.call($('qaDows').querySelectorAll('.qa-dow'), function (b) {
      b.classList.toggle('on', days.indexOf(parseInt(b.getAttribute('data-dow'), 10)) >= 0);
    });
  }
  function resetQa() {
    state.qa = { due: null, time: null, priority: 4, recurrence: null };
    state.qaManual = { due: false, time: false, priority: false, recurrence: false };
  }
  // The first date (>= today, local) whose day-of-week is in `days` — today only
  // if today is one of the chosen days. Used so a weekly-by-days task lands on
  // the right day instead of defaulting to today.
  function firstDueForDays(days) {
    if (!days || !days.length) return null;
    var t = new Date(), base = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    for (var off = 0; off < 7; off++) {
      var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + off);
      if (days.indexOf(d.getDay()) >= 0) return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }
    return null;
  }
  // The due date implied by the current recurrence when the user hasn't picked
  // one (currently: the next matching day of a weekly-by-days schedule).
  function recurrenceImpliedDue() {
    var r = state.qa.recurrence;
    if (r && r.type === 'weekly' && r.days && r.days.length) return firstDueForDays(r.days);
    return null;
  }
  $('taskInput').addEventListener('input', function () {
    var p = window.TaskParse.parse($('taskInput').value);
    var m = p.matched || {};
    // For each field: a token found in the text wins (and un-sticks any manual
    // value); otherwise keep a manually-picked value, else fall back to default.
    if (p.recurrence) { state.qa.recurrence = p.recurrence; state.qaManual.recurrence = false; }
    else if (!state.qaManual.recurrence) { state.qa.recurrence = null; }
    // Due: an explicit typed date wins; otherwise keep a manually picked date,
    // else fall back to whatever the current recurrence implies (e.g. the next
    // matching weekday) rather than plain "today".
    if (p.due != null) { state.qa.due = p.due; state.qaManual.due = false; }
    else if (!state.qaManual.due) { state.qa.due = recurrenceImpliedDue(); }
    if (p.time) { state.qa.time = p.time; state.qaManual.time = false; }
    else if (!state.qaManual.time) { state.qa.time = null; }
    if (m.priority) { state.qa.priority = p.priority; state.qaManual.priority = false; }
    else if (!state.qaManual.priority) { state.qa.priority = 4; }
    syncQa();
  });
  $('qaPriority').addEventListener('change', function () { state.qa.priority = parseInt($('qaPriority').value, 10) || 4; state.qaManual.priority = true; });
  $('qaRecur').addEventListener('change', function () {
    var v = $('qaRecur').value;
    var n = parseInt($('qaRecurN').value, 10) || 1;
    if (v === 'none') { state.qa.recurrence = null; }
    else if (v === 'daily') { state.qa.recurrence = n >= 2 ? { type: 'everyNDays', n: n } : { type: 'daily' }; }
    else if (v === 'weekly' || v === 'monthly') { var rec = { type: v }; if (n >= 2) rec.n = n; state.qa.recurrence = rec; }
    else { state.qa.recurrence = { type: v }; } // weekdays
    state.qaManual.recurrence = true;
    if (!state.qaManual.due) state.qa.due = recurrenceImpliedDue();
    syncQa();
  });
  $('qaRecurN').addEventListener('input', function () {
    var rec = state.qa.recurrence; if (!rec) return;
    var n = parseInt($('qaRecurN').value, 10);
    var t = rec.type;
    if (t === 'daily' || t === 'everyNDays') { if (n >= 2) { rec.type = 'everyNDays'; rec.n = n; } else { rec.type = 'daily'; delete rec.n; } }
    else if (t === 'weekly' || t === 'monthly') { if (n >= 2) rec.n = n; else delete rec.n; }
    state.qaManual.recurrence = true; syncRecurUI();
  });
  // Weekly day-of-week chips: toggling specific days switches weekly to a
  // by-days schedule (and clears any week-interval, which doesn't combine).
  $('qaDows').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.qa-dow'); if (!b) return;
    var rec = state.qa.recurrence; if (!rec || rec.type !== 'weekly') return;
    var dow = parseInt(b.getAttribute('data-dow'), 10);
    var days = rec.days ? rec.days.slice() : [];
    var i = days.indexOf(dow);
    if (i >= 0) days.splice(i, 1); else days.push(dow);
    days.sort(function (a, c) { return a - c; });
    if (days.length) { rec.days = days; delete rec.n; } else { delete rec.days; }
    state.qaManual.recurrence = true;
    // Land the task on the next matching day (not today) when the user hasn't
    // explicitly chosen a date.
    if (!state.qaManual.due) state.qa.due = recurrenceImpliedDue();
    syncQa();
  });
  $('qaDate').addEventListener('click', function () {
    openDatePicker($('qaDate'), state.qa.due, function (v) { state.qa.due = v; state.qaManual.due = true; syncQa(); });
  });
  async function addTaskFromInput() {
    var raw = $('taskInput').value.trim(); if (!raw) return;
    var p = window.TaskParse.parse(raw);
    var payload = { text: p.text || raw, due: state.qa.due || recurrenceImpliedDue(), time: state.qa.time, priority: state.qa.priority, recurrence: state.qa.recurrence };
    $('taskInput').value = ''; resetQa(); syncQa();
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
    maybeOcr(file, state.note.id, meta);
    return API.attachmentUrl(state.note.id, meta.id);
  };

  // Extract text from a pasted/attached image (on-device, offline) so it becomes
  // searchable. Runs in the background; never blocks the paste/insert.
  state.ocrBusy = {};
  async function maybeOcr(file, noteId, meta) {
    if (state.settings.ocrEnabled === false) return;
    if (!window.OCR || !file || !/^image\//.test(file.type || '')) return;
    try {
      if (!(await window.OCR.available())) return;
      state.ocrBusy[meta.id] = true; renderAttachments();
      var text = await window.OCR.recognize(file);
      delete state.ocrBusy[meta.id];
      if (text) {
        meta.ocrText = text;
        try { await API.setAttachmentOcr(noteId, meta.id, text); } catch (_e) { /* non-fatal */ }
      }
      renderAttachments();
    } catch (_e) { delete state.ocrBusy[meta.id]; renderAttachments(); }
  }
  window.Editor.init($('sections').querySelector('[data-target="carryoverEditor"]'), $('carryoverEditor'), { uploader: function (f) { return meetingUploader(f); }, noteLinkPicker: openNotePicker });
  window.Editor.init($('sections').querySelector('[data-target="meetingEditor"]'), $('meetingEditor'), { uploader: function (f) { return meetingUploader(f); }, noteLinkPicker: openNotePicker });
  $('carryoverEditor').addEventListener('input', function () { state.note.carryover = $('carryoverEditor').innerHTML; scheduleSave(); scheduleWordCount(); });
  $('meetingEditor').addEventListener('input', function () { state.note.meetingNotes = $('meetingEditor').innerHTML; scheduleSave(); scheduleWordCount(); });
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
      maybeOcr(f, state.note.id, meta);
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
      if (state.ocrBusy[a.id]) { var oc = document.createElement('span'); oc.className = 'at-ocr'; oc.textContent = '🔎 reading…'; li.appendChild(oc); }
      else if (a.ocrText) { var od = document.createElement('span'); od.className = 'at-ocr done'; od.textContent = '🔎 text'; od.title = 'Text extracted — this image is searchable'; li.appendChild(od); }
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
  $('printBtn').addEventListener('click', function (e) { e.stopPropagation(); $('exportMenu').classList.toggle('hidden'); });

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
    var wsId = state.wsId;
    var payload = {};
    if (opts.scratch) payload.scratch = true;
    if (opts.templateId) payload.templateId = opts.templateId;
    // In a tag view the note isn't tied to a workspace, so ask where it should
    // live, then auto-apply the tag.
    if (state.view === 'tag' && state.activeTag) {
      var pick = await pickWorkspace('Add a “#' + state.activeTag + '” note to which workspace?');
      if (!pick) return;
      wsId = pick; payload.tags = [state.activeTag];
    }
    state.note = await API.newNote(wsId, payload);
    state.wsId = wsId; $('workspaceSelect').value = wsId;
    showView('note'); renderNote();
    await Promise.all([renderNoteList(), loadTasks()]);
  }

  // Prompt for a target workspace; resolves to a workspace id or null if cancelled.
  async function pickWorkspace(message) {
    var buttons = state.workspaces.map(function (w, i) { return { label: w.name, returns: w.id, primary: i === 0 && w.id === state.wsId }; });
    buttons.push({ label: 'Cancel', returns: null });
    return dialog.choose(message, buttons, { title: 'Choose a workspace', cancelValue: null });
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

  // Print & export menu (opened from the printer icon)
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
        var mine = state.note;
        var theirs = (ex.data && ex.data.current) ? ex.data.current : await API.getNote(mine.id);
        var res = await resolveConflict(mine, theirs);
        if (res.action === 'merge') {
          var merged = res.merged;
          var saved2 = await API.saveNote(mine.id, {
            customTitle: merged.customTitle, todos: theirs.todos, carryover: merged.carryover,
            meetingNotes: merged.meetingNotes, favorite: mine.favorite,
            tags: merged.tags, transcript: mine.transcript, baseRev: theirs.rev,
          });
          state.note.customTitle = merged.customTitle; state.note.carryover = merged.carryover;
          state.note.meetingNotes = merged.meetingNotes; state.note.tags = merged.tags;
          state.note.todos = saved2.todos; state.note.updatedAt = saved2.updatedAt; state.note.rev = saved2.rev;
          state.lastSaveAt = Date.now();
          renderNote(); renderNoteList(); setSaveStatus('Merged & saved ✓');
        } else if (res.action === 'fork') {
          var fork = await API.forkNote(mine.id, {
            customTitle: mine.customTitle, todos: mine.todos, carryover: mine.carryover,
            meetingNotes: mine.meetingNotes, tags: mine.tags,
          });
          await loadWorkspaces(); await openNote(fork.id); setSaveStatus('Saved as a conflict copy ✓');
        } // cancel: leave the user's edits in place to retry
      } else { setSaveStatus('Save failed: ' + ex.message); }
    }
  }
  function setSaveStatus(s) { $('saveStatus').textContent = s; }

  // ---- word-level diff (LCS) for the conflict view ----
  function diffTokens(s) { return String(s || '').split(/(\s+)/).filter(function (x) { return x !== ''; }); }
  function stripTags(h) { return String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim(); }
  function wordDiff(aStr, bStr) {
    var a = diffTokens(aStr), b = diffTokens(bStr), n = a.length, m = b.length;
    var out = [], i, j;
    if (n + m > 6000) { // too large to LCS cheaply — fall back to whole-block replace
      if (aStr) out.push({ t: 'del', s: aStr });
      if (bStr) out.push({ t: 'ins', s: bStr });
      return out;
    }
    var dp = []; for (i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ t: 'same', s: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: a[i] }); i++; }
      else { out.push({ t: 'ins', s: b[j] }); j++; }
    }
    while (i < n) out.push({ t: 'del', s: a[i++] });
    while (j < m) out.push({ t: 'ins', s: b[j++] });
    return out;
  }
  function renderWordDiff(aStr, bStr) {
    var d = wordDiff(aStr, bStr);
    if (!d.length) return '<span class="muted tiny">(no text)</span>';
    return d.map(function (p) { var e = esc(p.s); return p.t === 'same' ? e : (p.t === 'del' ? '<del>' + e + '</del>' : '<ins>' + e + '</ins>'); }).join('');
  }

  // Read-only sanitize for previewing note HTML in the conflict modal.
  function sanitizeForView(html) {
    return String(html || '')
      .replace(/<\s*(script|style|iframe|object|embed|link|meta)[\s\S]*?<\/\s*\1\s*>/gi, '')
      .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '').replace(/\son\w+\s*=\s*'[^']*'/gi, '').replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
      .replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"');
  }

  // Field-by-field merge for a save conflict. Resolves to
  // {action:'merge', merged} | {action:'fork'} | {action:'cancel'}.
  function resolveConflict(mine, theirs) {
    return new Promise(function (resolve) {
      var fields = [
        { key: 'customTitle', label: 'Title', rich: false },
        { key: 'tags', label: 'Tags', rich: false, arr: true },
        { key: 'carryover', label: 'Carryover Notes', rich: true },
        { key: 'meetingNotes', label: 'Meeting Notes', rich: true },
      ];
      var box = $('conflictFields'); box.innerHTML = '';
      var picks = {};
      var anyDiff = false;
      fields.forEach(function (f) {
        var mv = mine[f.key], tv = theirs[f.key];
        var mS = f.arr ? (mv || []).join(', ') : (mv || '');
        var tS = f.arr ? (tv || []).join(', ') : (tv || '');
        if (mS === tS) return; // unchanged — auto-merge
        anyDiff = true;
        picks[f.key] = 'mine';
        var row = document.createElement('div'); row.className = 'conflict-row';
        var head = document.createElement('div'); head.className = 'conflict-fld'; head.textContent = f.label; row.appendChild(head);
        // inline word-level diff of the changed text (yours → theirs), always visible
        var aText = f.rich ? stripTags(mv) : mS, bText = f.rich ? stripTags(tv) : tS;
        var diffEl = document.createElement('div'); diffEl.className = 'conflict-diff'; diffEl.innerHTML = renderWordDiff(aText, bText);
        row.appendChild(diffEl);
        // pick which side wins (always visible)
        var pickRow = document.createElement('div'); pickRow.className = 'conflict-pick';
        [['mine', 'Keep yours'], ['theirs', 'Keep theirs (newer)']].forEach(function (opt) {
          var lab = document.createElement('label'); lab.className = 'conflict-opt' + (opt[0] === 'mine' ? ' sel' : '');
          var r = document.createElement('input'); r.type = 'radio'; r.name = 'cf-' + f.key; r.checked = opt[0] === 'mine';
          r.addEventListener('change', function () {
            picks[f.key] = opt[0];
            pickRow.querySelectorAll('.conflict-opt').forEach(function (c) { c.classList.remove('sel'); });
            lab.classList.add('sel');
          });
          lab.appendChild(r); lab.appendChild(document.createTextNode(' ' + opt[1])); pickRow.appendChild(lab);
        });
        row.appendChild(pickRow);
        // full versions, collapsed by default
        var det = document.createElement('details'); det.className = 'conflict-cols-wrap';
        var sum = document.createElement('summary'); sum.className = 'conflict-toggle'; sum.textContent = 'Show full versions'; det.appendChild(sum);
        var colsInner = document.createElement('div'); colsInner.className = 'conflict-cols'; det.appendChild(colsInner);
        [['Yours', mS, mv], ['Theirs (newer)', tS, tv]].forEach(function (side) {
          var col = document.createElement('div'); col.className = 'conflict-col';
          var cap = document.createElement('div'); cap.className = 'conflict-cap'; cap.textContent = side[0];
          var body = document.createElement('div'); body.className = 'conflict-body';
          if (f.rich) body.innerHTML = sanitizeForView(side[2]); else body.textContent = side[1] || '(empty)';
          col.appendChild(cap); col.appendChild(body); colsInner.appendChild(col);
        });
        row.appendChild(det); box.appendChild(row);
      });
      if (!anyDiff) box.innerHTML = '<p class="muted tiny">No content differences — keeping the latest is safe.</p>';
      openModal('conflictModal');
      function cleanup(result) { closeModals(); resolve(result); }
      $('conflictApply').onclick = function () {
        var merged = { customTitle: mine.customTitle, carryover: mine.carryover, meetingNotes: mine.meetingNotes, tags: mine.tags };
        Object.keys(picks).forEach(function (k) { merged[k] = picks[k] === 'theirs' ? theirs[k] : mine[k]; });
        cleanup({ action: 'merge', merged: merged });
      };
      $('conflictFork').onclick = function () { cleanup({ action: 'fork' }); };
      $('conflictCancel').onclick = function () { cleanup({ action: 'cancel' }); };
    });
  }
  window.addEventListener('beforeunload', function () { if (state.saveTimer) saveNow(); });

  // ---------------- Views ----------------
  function showView(v) {
    state.view = v;
    ['noteView', 'landingView', 'todosView', 'favsView', 'trashView', 'searchView', 'tagView', 'calendarView'].forEach(function (id) { $(id).classList.add('hidden'); });
    $('navNote').classList.toggle('active', v === 'note' || v === 'landing');
    $('navTodos').classList.toggle('active', v === 'todos');
    $('navCalendar').classList.toggle('active', v === 'calendar');
    $('navFavs').classList.toggle('active', v === 'favs');
    if (v !== 'tag') { state.activeTag = null; renderTagBookmarks(); }
    if (v !== 'search') { state.lastQuery = null; renderSavedSearches(); }
    var map = { note: 'noteView', landing: 'landingView', todos: 'todosView', favs: 'favsView', trash: 'trashView', search: 'searchView', tag: 'tagView', calendar: 'calendarView' };
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

  // ---------------- Task calendar ----------------
  function isoUTC(dt) { return dt.toISOString().slice(0, 10); }
  function advanceRec(iso, rec) {
    var pr = iso.split('-').map(Number);
    var dt = new Date(Date.UTC(pr[0], pr[1] - 1, pr[2]));
    var next = null, dow = function (d) { return d.getUTCDay(); };
    if (rec.type === 'daily') { dt.setUTCDate(dt.getUTCDate() + 1); next = isoUTC(dt); }
    else if (rec.type === 'everyNDays') { dt.setUTCDate(dt.getUTCDate() + (rec.n || 1)); next = isoUTC(dt); }
    else if (rec.type === 'weekdays') { do { dt.setUTCDate(dt.getUTCDate() + 1); } while (dow(dt) === 0 || dow(dt) === 6); next = isoUTC(dt); }
    else if (rec.type === 'weekly') {
      if (rec.days && rec.days.length) { for (var i = 1; i <= 7 && !next; i++) { var c = new Date(dt); c.setUTCDate(c.getUTCDate() + i); if (rec.days.indexOf(dow(c)) >= 0) next = isoUTC(c); } }
      if (!next) { dt.setUTCDate(dt.getUTCDate() + 7 * (rec.n || 1)); next = isoUTC(dt); }
    } else if (rec.type === 'monthly') { dt.setUTCMonth(dt.getUTCMonth() + (rec.n || 1)); next = isoUTC(dt); }
    if (rec.endDate && next && next > rec.endDate) return null;
    return next;
  }
  // Which days in [fromISO, toISO] a task lands on (projecting recurrence).
  function projectOccurrences(t, fromISO, toISO) {
    var out = [];
    if (!t.due) return out;
    if (!t.recurrence) { if (t.due >= fromISO && t.due <= toISO) out.push(t.due); return out; }
    var d = t.due, guard = 0;
    while (d && d < fromISO && guard++ < 1000) d = advanceRec(d, t.recurrence);
    while (d && d <= toISO && guard++ < 1000) { out.push(d); d = advanceRec(d, t.recurrence); }
    return out;
  }

  async function renderCalendar() {
    showView('calendar');
    if (!state.calMonth) { var n = new Date(); state.calMonth = { y: n.getFullYear(), m: n.getMonth() }; }
    var y = state.calMonth.y, mo = state.calMonth.m;
    $('calLabel').textContent = new Date(y, mo, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
    var grid = $('calGrid'); grid.innerHTML = '';
    var tasks = [];
    try { tasks = await API.globalTasks(); } catch (_e) { tasks = []; }
    // visible window: the weeks covering this month (Sun-start)
    var first = new Date(y, mo, 1);
    var start = new Date(y, mo, 1 - first.getDay());
    var cells = 42; // 6 weeks
    var last = new Date(y, mo, 1); last.setDate(last.getDate() + (cells - 1 - first.getDay()));
    var p2s = function (x) { return String(x).padStart(2, '0'); };
    var localISO = function (dt) { return dt.getFullYear() + '-' + p2s(dt.getMonth() + 1) + '-' + p2s(dt.getDate()); };
    var fromISO = localISO(start), toISO = localISO(last);
    // bucket tasks by day
    var byDay = {};
    tasks.forEach(function (t) {
      projectOccurrences(t, fromISO, toISO).forEach(function (d) { (byDay[d] = byDay[d] || []).push(t); });
    });
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (dn) {
      var h = document.createElement('div'); h.className = 'cal-dow'; h.textContent = dn; grid.appendChild(h);
    });
    var today = todayStr();
    for (var i = 0; i < cells; i++) {
      var dt = new Date(start); dt.setDate(start.getDate() + i);
      var iso = localISO(dt);
      var cell = document.createElement('div');
      cell.className = 'cal-cell' + (dt.getMonth() !== mo ? ' cal-off' : '') + (iso === today ? ' cal-today' : '');
      var dnum = document.createElement('div'); dnum.className = 'cal-date'; dnum.textContent = dt.getDate(); cell.appendChild(dnum);
      var list = byDay[iso] || [];
      list.sort(function (a, b) { return (a.priority - b.priority); }).slice(0, 4).forEach(function (t) {
        var chip = document.createElement('button'); chip.className = 'cal-task prio-p' + t.priority;
        chip.textContent = (t.recurrence ? '🔁 ' : '') + t.text;
        chip.title = t.text + ' · ' + t.workspaceName + (iso < today ? ' · overdue' : '');
        if (iso < today) chip.classList.add('overdue');
        chip.addEventListener('click', function () { openWorkspace(t.workspaceId); });
        cell.appendChild(chip);
      });
      if (list.length > 4) { var more = document.createElement('div'); more.className = 'cal-more'; more.textContent = '+' + (list.length - 4) + ' more'; cell.appendChild(more); }
      grid.appendChild(cell);
    }
  }
  function calShift(delta) {
    if (!state.calMonth) { var n = new Date(); state.calMonth = { y: n.getFullYear(), m: n.getMonth() }; }
    var m = state.calMonth.m + delta, y = state.calMonth.y;
    state.calMonth = { y: y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
    renderCalendar();
  }
  $('navCalendar').addEventListener('click', function () { renderCalendar(); });
  $('calPrev').addEventListener('click', function () { calShift(-1); });
  $('calNext').addEventListener('click', function () { calShift(1); });
  $('calToday').addEventListener('click', function () { var n = new Date(); state.calMonth = { y: n.getFullYear(), m: n.getMonth() }; renderCalendar(); });

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
    state.lastQuery = q;
    var results = await API.search(q); showView('search');
    renderSavedSearches();
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
  // escape, then highlight occurrences of the free-text query (ignoring operators)
  function hl(text, q) {
    var out = esc(text);
    var term = String(q || '')
      .replace(/\b(?:tag|in):\S+/gi, '')
      .replace(/\bis:(?:favou?rite|daily|scratch)\b/gi, '')
      .replace(/\bhas:(?:attachment|image|file)s?\b/gi, '')
      .trim();
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
    else if (m === 'conflicts') openConflicts();
    else if (m === 'backup') openModal('backupModal');
    else if (m === 'account') openAccount();
    else if (m === 'manual') openManual();
  });

  // ---------------- First-run onboarding tour ----------------
  var TOUR = [
    { t: '🗒️ Welcome to Cove', h: 'A private, end-to-end-encrypted home for your meeting notes and tasks. Everything stays on your device (or your own cloud-sync folder) — nothing is uploaded.' },
    { t: '📅 Daily notes carry forward', h: 'Hit <b>＋ New Daily</b> and your <b>Carryover</b> notes come forward from the last daily note — a running thread per workspace. <b>New scratch note</b> is a clean page that doesn’t affect the thread.' },
    { t: '✅ Tasks in plain English', h: 'In <b>Overdue &amp; Today</b>, type naturally — e.g. <code>email Sam tomorrow p1 every 2 weeks</code>. The date, priority and repeat are parsed for you, locally, with no AI.' },
    { t: '🔎 Find &amp; connect', h: 'Search with operators like <code>in:work has:attachment</code>, pin a query as a <b>saved search</b>, and type <kbd>[[</kbd> in any note to link to another. Pasted screenshots are read on-device so their text is searchable too.' },
    { t: '⌘ Do anything fast', h: 'Press <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>K</kbd> for the command palette, <kbd>?</kbd> for all keyboard shortcuts, and use the <b>⋮</b> menu for backup, export, and the offline viewer.' },
  ];
  var tourIdx = 0;
  function renderTour() {
    var s = TOUR[tourIdx];
    $('tourTitle').innerHTML = s.t;
    $('tourBody').innerHTML = s.h;
    $('tourDots').innerHTML = TOUR.map(function (_s, i) { return '<span class="tour-dot' + (i === tourIdx ? ' on' : '') + '"></span>'; }).join('');
    $('tourBack').style.visibility = tourIdx === 0 ? 'hidden' : 'visible';
    $('tourNext').textContent = tourIdx === TOUR.length - 1 ? 'Done' : 'Next';
  }
  function openTour() {
    // Never cover the one-time recovery-key modal — defer until it's dismissed.
    if (!$('recoveryModal').classList.contains('hidden')) { state.pendingTour = true; return; }
    tourIdx = 0; renderTour(); openModal('tourModal');
  }
  function finishTour() {
    closeModals();
    if (!state.settings.onboarded) { state.settings.onboarded = true; API.saveSettings({ onboarded: true }); }
  }
  $('tourNext').addEventListener('click', function () { if (tourIdx >= TOUR.length - 1) finishTour(); else { tourIdx++; renderTour(); } });
  $('tourBack').addEventListener('click', function () { if (tourIdx > 0) { tourIdx--; renderTour(); } });
  $('tourSkip').addEventListener('click', finishTour);

  // Conflict history: a log of "keep both" forks from multi-device edit clashes.
  async function openConflicts() {
    openModal('conflictLogModal');
    var ul = $('conflictLogList'); ul.innerHTML = '<li class="muted tiny">Loading…</li>';
    var items = [];
    try { items = await API.listConflicts(); } catch (_e) { items = []; }
    ul.innerHTML = '';
    if (!items.length) { ul.innerHTML = '<li class="muted tiny">No conflicts recorded — nice. This fills in only if the same note is edited on two devices at once and you choose “Keep both”.</li>'; return; }
    items.forEach(function (it) {
      var li = document.createElement('li'); li.className = 'conflict-log-item';
      var when = document.createElement('div'); when.className = 'cl-when muted tiny'; when.textContent = new Date(it.at).toLocaleString();
      var body = document.createElement('div'); body.className = 'cl-body';
      var orig = document.createElement('a'); orig.href = '#'; orig.className = 'cl-link'; orig.textContent = it.sourceTitle || 'original';
      orig.addEventListener('click', function (e) { e.preventDefault(); closeModals(); openNote(it.sourceId); });
      var copy = document.createElement('a'); copy.href = '#'; copy.className = 'cl-link'; copy.textContent = it.forkTitle || 'conflict copy';
      copy.addEventListener('click', function (e) { e.preventDefault(); closeModals(); openNote(it.forkId); });
      body.appendChild(document.createTextNode('Kept both: '));
      body.appendChild(orig); body.appendChild(document.createTextNode(' → '));
      body.appendChild(copy);
      li.appendChild(when); li.appendChild(body); ul.appendChild(li);
    });
  }
  function openAccount(focusStt) {
    $('acctMsg').textContent = '';
    var inst = state.instance || {};
    $('instanceInfo').innerHTML = '<b>' + esc(inst.name || 'Cove') + '</b> · v' + esc(inst.version || '') +
      '<br>URL: <code>' + esc(inst.url || location.origin) + '</code>' +
      (inst.domain ? '' : '<br><span class="muted">Tip: run <code>node server.js --set-domain notes</code> for a durable &lt;name&gt;.localhost address.</span>');
    $('fontSize').value = state.settings.fontSize || 14;
    $('ocrEnabled').checked = state.settings.ocrEnabled !== false;
    var tc = state.settings.transcription || {};
    $('sttEndpoint').value = tc.endpoint || ''; $('sttKey').value = tc.apiKey || ''; $('sttModel').value = tc.model || '';
    updateSttWarn();
    renderBioSettings();
    renderInboxSettings();
    renderSlackSettings();
    loadStatsInto();
    loadDataDir();
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
  $('sttLocalBtn').addEventListener('click', function () {
    $('sttEndpoint').value = 'http://127.0.0.1:8080/v1/audio/transcriptions';
    $('sttKey').value = '';
    if (!$('sttModel').value.trim()) $('sttModel').value = 'whisper-1';
    updateSttWarn();
  });
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
  // Reflect the chosen filename next to the themed "Choose file" buttons.
  function showChosenFile(inputId, labelId) {
    var f = $(inputId).files[0];
    $(labelId).textContent = f ? f.name : 'No file chosen';
  }
  $('importFile').addEventListener('change', function () { showChosenFile('importFile', 'importFileName'); });
  $('restoreFile').addEventListener('change', function () { showChosenFile('restoreFile', 'restoreFileName'); });
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
  $('ocrEnabled').addEventListener('change', function () {
    state.settings.ocrEnabled = $('ocrEnabled').checked;
    API.saveSettings({ ocrEnabled: state.settings.ocrEnabled });
    if (!state.settings.ocrEnabled && window.OCR) window.OCR.terminate();
  });

  // Backup / restore + bulk export
  $('downloadBackupBtn').addEventListener('click', function () { downloadUrl(API.backupUrl()); });
  $('bulkExportBtn').addEventListener('click', function () { downloadUrl(API.workspaceZipUrl(state.wsId, $('bulkFormat').value)); });
  $('llmScope').addEventListener('change', async function () {
    var isTag = $('llmScope').value === 'tag';
    $('llmTag').classList.toggle('hidden', !isTag);
    $('llmExportMsg').textContent = '';
    if (isTag && !$('llmTag').options.length) {
      try {
        var tags = await API.allTags();
        $('llmTag').innerHTML = (tags && tags.length)
          ? tags.map(function (t) { return '<option value="' + esc(t) + '">#' + esc(t) + '</option>'; }).join('')
          : '<option value="">(no tags yet)</option>';
      } catch (e) { $('llmTag').innerHTML = '<option value="">(couldn’t load tags)</option>'; }
    }
  });
  $('llmExportBtn').addEventListener('click', function () {
    var scope = $('llmScope').value, mode = $('llmMode').value;
    if (scope === 'tag') {
      var tag = $('llmTag').value;
      if (!tag) { $('llmExportMsg').textContent = 'Pick a tag first (or add #tags to some notes).'; return; }
      downloadUrl(API.llmExportUrl({ scope: 'tag', mode: mode, tag: tag }));
    } else {
      downloadUrl(API.llmExportUrl({ scope: 'workspace', mode: mode, id: state.wsId }));
    }
    $('llmExportMsg').textContent = 'Downloading…';
    setTimeout(function () { $('llmExportMsg').textContent = ''; }, 2500);
  });
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
  $('verifyBackupFile').addEventListener('change', function () { showChosenFile('verifyBackupFile', 'verifyBackupName'); });
  $('verifyBackupBtn').addEventListener('click', async function () {
    var f = $('verifyBackupFile').files[0]; var msg = $('verifyBackupMsg');
    if (!f) { msg.style.color = 'var(--danger)'; msg.textContent = 'Choose a backup file first.'; return; }
    msg.style.color = 'var(--muted)'; msg.textContent = 'Verifying…';
    try {
      var bundle = JSON.parse(await f.text());
      var r = await API.verifyBackup(bundle);
      if (r.ok) { msg.style.color = 'var(--muted)'; msg.textContent = '✓ Restorable — all ' + r.checked + ' encrypted entries decrypt with your key' + (r.createdAt ? ' (backup from ' + new Date(r.createdAt).toLocaleString() + ')' : '') + '.'; }
      else if (!r.hasVault) { msg.style.color = 'var(--danger)'; msg.textContent = '⚠ This file has no vault — it is not a complete backup.'; }
      else { msg.style.color = 'var(--danger)'; msg.textContent = '⚠ ' + r.corrupt.length + ' of ' + r.checked + ' entries FAILED to decrypt: ' + r.corrupt.slice(0, 5).map(function (x) { return x.path; }).join(', ') + (r.corrupt.length > 5 ? '…' : ''); }
    } catch (ex) { msg.style.color = 'var(--danger)'; msg.textContent = 'Verify failed: ' + ex.message; }
  });

  // Recovery-key display modal. The confirm button stays disabled until the
  // user clicks Copy — you can't dismiss a one-time key without saving it.
  function showRecovery(key, subtitle) {
    if (subtitle) $('recoveryModal').querySelector('p').textContent = subtitle;
    $('recoveryValue').textContent = key;
    $('copyRecoveryBtn').textContent = 'Copy';
    $('recoveryConfirmBtn').disabled = true;
    openModal('recoveryModal');
  }
  $('copyRecoveryBtn').addEventListener('click', function () {
    var t = $('recoveryValue').textContent;
    // Best-effort clipboard write; fall back to selecting the text so the user
    // can copy manually (e.g. non-secure origins where the API is unavailable).
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(selectRecovery);
    } else { selectRecovery(); }
    // The gate is "Copy was clicked", so a clipboard failure never traps the
    // user out of the one-time modal.
    $('copyRecoveryBtn').textContent = 'Copied ✓';
    $('recoveryConfirmBtn').disabled = false;
  });
  function selectRecovery() {
    try {
      var r = document.createRange(); r.selectNodeContents($('recoveryValue'));
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    } catch (_e) { /* ignore */ }
  }

  // Modal helpers
  var MODALS = ['wsModal', 'importModal', 'templateModal', 'accountModal', 'backupModal', 'moveModal', 'recoveryModal', 'historyModal', 'notePickerModal', 'conflictModal', 'conflictLogModal', 'tourModal'];
  function openModal(id) {
    $('modalBackdrop').classList.remove('hidden');
    MODALS.forEach(function (m) { $(m).classList.toggle('hidden', m !== id); });
  }
  function closeModals() {
    var recoveryWasOpen = !$('recoveryModal').classList.contains('hidden');
    $('modalBackdrop').classList.add('hidden');
    MODALS.forEach(function (m) { $(m).classList.add('hidden'); });
    // Once the recovery key is saved/dismissed, run the deferred first-run tour.
    if (recoveryWasOpen && state.pendingTour) { state.pendingTour = false; setTimeout(openTour, 350); }
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
  // Show a notification through the service worker when possible — that's the
  // only path that works in an installed PWA on mobile (iOS Safari has no
  // Notification constructor at all). Falls back to the constructor on desktop.
  function notify(title, opts) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    opts = Object.assign({ icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' }, opts || {});
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready
          .then(function (reg) { if (reg && reg.showNotification) reg.showNotification(title, opts); else new Notification(title, opts); })
          .catch(function () { try { new Notification(title, opts); } catch (_e) {} });
      } else { new Notification(title, opts); }
    } catch (_e) { /* ignore */ }
  }
  $('notifyBtn').addEventListener('click', async function () {
    if (!('Notification' in window)) { await dialog.alert('Notifications aren’t available here. On iPhone/iPad, install this app to your Home Screen first (Share → Add to Home Screen), then enable them.'); return; }
    var perm = await Notification.requestPermission();
    state.notify = perm === 'granted';
    $('notifyBtn').textContent = state.notify ? '🔔' : '🔕';
    if (state.notify) { notify('Notifications on', { body: 'You’ll get reminders for tasks with a time.', tag: 'mn-enabled' }); pollInbox(); }
  });
  function startReminderPolling() { pollInbox(); setInterval(pollInbox, 60 * 1000); }
  async function pollInbox() {
    try {
      // Drain the inbox (Slack etc. → tasks) into the target workspace.
      try {
        var inbox = await API.processInbox();
        if (inbox && inbox.added) {
          if (state.notify) {
            notify('📥 ' + inbox.added + ' new task' + (inbox.added > 1 ? 's' : '') + ' in your inbox', { tag: 'mn-inbox' });
          }
          if (inbox.workspaceId === state.wsId && state.view === 'note' && state.note) await loadTasks();
        }
      } catch (_e) { /* ignore */ }
      // Fire reminders for tasks whose time has arrived (timed tasks only).
      // Only when notifications are enabled, so we don't silently consume the
      // one-shot "notifiedFor" marker while the user can't see anything.
      if (state.notify && 'Notification' in window && Notification.permission === 'granted') {
        try {
          var due = await API.dueTasks();
          if (due && due.length) {
            due.forEach(function (d) {
              notify('⏰ ' + d.text, { body: d.workspaceName + ' · due ' + (d.time || d.due), tag: 'task-' + d.id });
            });
            if (state.view === 'note' && state.note && due.some(function (d) { return d.workspaceId === state.wsId; })) await loadTasks();
          }
        } catch (_e) { /* ignore */ }
      }
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
  // Move the sidebar selection to the next/previous note and open it.
  function moveNoteSelection(delta) {
    var lis = Array.prototype.slice.call($('noteList').querySelectorAll('li[data-note-id]'));
    if (!lis.length) return;
    var ids = lis.map(function (li) { return li.getAttribute('data-note-id'); });
    var cur = state.note ? ids.indexOf(state.note.id) : -1;
    var next = cur < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, cur + delta));
    if (ids[next]) openNote(ids[next]);
  }
  var gPending = false, gTimer = null;
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var editable = e.target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
    if (editable || e.metaKey || e.ctrlKey || e.altKey) return;
    // Two-key "g then x" jumps (Gmail-style).
    if (gPending) {
      gPending = false; clearTimeout(gTimer);
      if (e.key === 't') { e.preventDefault(); renderGlobalTasks(); return; }
      if (e.key === 'c') { e.preventDefault(); renderCalendar(); return; }
      if (e.key === 'f') { e.preventDefault(); renderFavorites(); return; }
      if (e.key === 'h') { e.preventDefault(); if (state.note) { showView('note'); renderNoteList(); } else loadCurrentNote(); return; }
    }
    if (e.key === 'g') { gPending = true; clearTimeout(gTimer); gTimer = setTimeout(function () { gPending = false; }, 1200); return; }
    if (e.key === '/') { e.preventDefault(); $('globalSearch').focus(); }
    else if (e.key === 'n') { e.preventDefault(); createNewNote({}); }
    else if (e.key === 'j') { e.preventDefault(); moveNoteSelection(1); }
    else if (e.key === 'k') { e.preventDefault(); moveNoteSelection(-1); }
    else if (e.key === 'e') { e.preventDefault(); var ed = $('meetingEditor'); if (ed) { showView('note'); ed.focus(); } }
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
