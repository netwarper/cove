/* Cove — main application controller. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var API = window.API;
  // Bumped with the service-worker cache; logged at load so you can confirm the
  // browser is actually running the latest build (not a stale cached app.js).
  var APP_BUILD = '1.67.0'; // keep in sync with package.json version on each release
  try { console.log('Cove app build ' + APP_BUILD + ' @ ' + location.host); } catch (_e) { /* no console */ }
  var IDLE_DEFAULT_MIN = 15;
  // Idle-lock delay in ms from settings; 0 (or "Never") disables auto-lock.
  function idleMs() {
    var m = state.settings && state.settings.idleLockMinutes;
    if (m === 0) return 0;
    m = parseInt(m, 10);
    return (m > 0 ? m : IDLE_DEFAULT_MIN) * 60 * 1000;
  }

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
  // A searchable, keyboard-navigable single-select list — better than a wall of
  // buttons when the choices are "pick one of these things" (e.g. a destination
  // workspace). Rows scroll; ↑/↓ move the highlight, Enter picks it, Esc cancels,
  // and typing filters once there are enough items to warrant a search box.
  function showListPicker(opts) {
    opts = opts || {};
    var items = opts.items || [];
    var SEARCH_AT = opts.searchThreshold == null ? 7 : opts.searchThreshold;
    return new Promise(function (resolve) {
      var layer = $('dialogLayer');
      $('dialogTitle').textContent = opts.title || '';
      $('dialogTitle').classList.toggle('hidden', !opts.title);
      $('dialogMessage').textContent = opts.message || '';
      $('dialogMessage').classList.toggle('hidden', !opts.message);
      $('dialogInput').classList.add('hidden');
      var box = $('dialogList'); box.classList.remove('hidden');
      var search = $('dialogListSearch');
      var ul = $('dialogListItems'); ul.innerHTML = '';
      var useSearch = items.length > SEARCH_AT;
      search.classList.toggle('hidden', !useSearch);
      search.value = ''; search.placeholder = opts.searchPlaceholder || 'Filter…';
      var btnWrap = $('dialogButtons'); btnWrap.innerHTML = '';

      function cleanup() {
        layer.classList.add('hidden'); box.classList.add('hidden');
        $('dialogMessage').classList.remove('hidden');
        document.removeEventListener('keydown', onKey, true);
        search.removeEventListener('input', onFilter);
      }
      function done(val) { cleanup(); resolve(val); }

      var rows = items.map(function (it, i) {
        var li = document.createElement('li');
        li.className = 'dl-row' + (it.current ? ' current' : '');
        li.setAttribute('role', 'option'); li.dataset.i = String(i);
        var main = document.createElement('span'); main.className = 'dl-name'; main.textContent = it.label;
        li.appendChild(main);
        if (it.sublabel) { var sub = document.createElement('span'); sub.className = 'dl-sub'; sub.textContent = it.sublabel; li.appendChild(sub); }
        if (it.current) { var tag = document.createElement('span'); tag.className = 'dl-current'; tag.textContent = 'current'; li.appendChild(tag); }
        li.addEventListener('click', function () { done(it.value); });
        li.addEventListener('mousemove', function () { setActive(i, false); });
        ul.appendChild(li);
        return { li: li, item: it, i: i };
      });

      var active = -1;
      function visibleRows() { return rows.filter(function (r) { return !r.li.classList.contains('hidden'); }); }
      function setActive(i, scroll) {
        rows.forEach(function (r) { r.li.classList.toggle('active', r.i === i); });
        active = i;
        if (scroll && i >= 0 && rows[i]) rows[i].li.scrollIntoView({ block: 'nearest' });
      }
      function moveActive(delta) {
        var vis = visibleRows(); if (!vis.length) return;
        var pos = vis.findIndex(function (r) { return r.i === active; });
        pos = pos < 0 ? (delta > 0 ? 0 : vis.length - 1) : pos + delta;
        if (pos < 0) pos = vis.length - 1; if (pos >= vis.length) pos = 0;
        setActive(vis[pos].i, true);
      }
      function onFilter() {
        var q = search.value.trim().toLowerCase();
        rows.forEach(function (r) {
          var hay = (r.item.label + ' ' + (r.item.sublabel || '')).toLowerCase();
          r.li.classList.toggle('hidden', !!q && hay.indexOf(q) < 0);
        });
        var vis = visibleRows();
        ul.classList.toggle('no-matches', !vis.length);
        setActive(vis.length ? vis[0].i : -1, true);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(opts.cancelValue == null ? null : opts.cancelValue); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && rows[active] && !rows[active].li.classList.contains('hidden')) done(rows[active].item.value); }
      }

      btnWrap.appendChild((function () {
        var c = document.createElement('button'); c.className = 'dlg-btn'; c.textContent = opts.cancelLabel || 'Cancel';
        c.addEventListener('click', function () { done(opts.cancelValue == null ? null : opts.cancelValue); });
        return c;
      })());

      if (useSearch) search.addEventListener('input', onFilter);
      document.addEventListener('keydown', onKey, true);
      layer.classList.remove('hidden');
      // Start the highlight on the first item (or the "current" one if present).
      var startIdx = rows.length ? (rows.filter(function (r) { return r.item.current; })[0] || rows[0]).i : -1;
      setActive(startIdx, true);
      setTimeout(function () { if (useSearch) search.focus(); else ul.focus(); }, 30);
    });
  }
  window.showListPicker = showListPicker;

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
  // When the PWA opens from its cached shell but the local server is down,
  // /api/status rejects with a network error (no HTTP status). Show a screen
  // explaining it and keep re-checking so the app continues once it's back.
  var serverDownTimer = null;
  async function boot() {
    var st;
    try {
      st = await API.status();
    } catch (e) {
      if (e && e.status) { console.error(e); return; } // a real HTTP error, not connectivity
      $('serverDown').classList.remove('hidden');
      $('serverDownRetry').disabled = false;
      updateOfflineReaderButton();
      clearTimeout(serverDownTimer);
      serverDownTimer = setTimeout(boot, 3000); // auto-continue when the server returns
      return;
    }
    clearTimeout(serverDownTimer);
    $('serverDown').classList.add('hidden');
    state.initialized = st.initialized;
    state.instance = st.instance || null;
    state.bio = st.bio || { enrolled: false, credentials: [] };
    if (st.csrf) API.setCsrf(st.csrf);
    if (st.authenticated) return startApp();
    showAuth(st.initialized);
  }
  $('serverDownRetry').addEventListener('click', function () {
    $('serverDownRetry').disabled = true;
    $('serverDownStatus').textContent = 'Checking…';
    clearTimeout(serverDownTimer);
    boot();
  });
  // A regained network connection is a good moment to re-check the local server.
  window.addEventListener('online', function () { if (!$('serverDown').classList.contains('hidden')) boot(); });

  // ---------------- Offline read cache (opt-in) ----------------
  // Keep readable copies of opened notes in this browser so they can be read when
  // the server is unreachable. Stored UNENCRYPTED (hence opt-in, off by default);
  // a localStorage flag mirrors the setting so the pre-auth server-down screen can
  // decide whether to offer the reader without reaching the server.
  var OFFLINE_CACHE_KEY = 'cove.noteCache';
  var OFFLINE_FLAG_KEY = 'cove.offlineCache';
  var OFFLINE_CACHE_MAX = 40;
  function offlineCacheEnabled() { return !!(state.settings && state.settings.offlineCache); }
  function setOfflineFlag(on) { try { if (on) localStorage.setItem(OFFLINE_FLAG_KEY, '1'); else localStorage.removeItem(OFFLINE_FLAG_KEY); } catch (_e) { /* storage off */ } }
  function loadNoteCache() { try { return JSON.parse(localStorage.getItem(OFFLINE_CACHE_KEY) || '{}'); } catch (_e) { return {}; } }
  function writeNoteCache(m) { try { localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(m)); } catch (_e) { /* full/off */ } }
  function clearNoteCache() { try { localStorage.removeItem(OFFLINE_CACHE_KEY); } catch (_e) { /* off */ } }
  function cacheNoteForOffline(n) {
    if (!offlineCacheEnabled() || !n || !n.id) return;
    var m = loadNoteCache();
    m[n.id] = {
      id: n.id, title: n.title || '', customTitle: n.customTitle || null,
      displayTitle: n.customTitle ? (n.title + ' — ' + n.customTitle) : (n.title || 'Untitled'),
      tags: n.tags || [], carryover: n.carryover || '', meetingNotes: n.meetingNotes || '',
      todos: (n.todos || []).map(function (t) { return { text: t.text, done: !!t.done }; }),
      updatedAt: n.updatedAt || null, cachedAt: Date.now(),
    };
    var ids = Object.keys(m);
    if (ids.length > OFFLINE_CACHE_MAX) { // evict oldest by cache time
      ids.sort(function (a, b) { return (m[a].cachedAt || 0) - (m[b].cachedAt || 0); });
      while (ids.length > OFFLINE_CACHE_MAX) delete m[ids.shift()];
    }
    writeNoteCache(m);
  }
  function updateOfflineReaderButton() {
    var btn = $('serverDownCached'); if (!btn) return;
    var on = false; try { on = localStorage.getItem(OFFLINE_FLAG_KEY) === '1'; } catch (_e) { /* off */ }
    var count = on ? Object.keys(loadNoteCache()).length : 0;
    btn.classList.toggle('hidden', count === 0);
    btn.textContent = '📖 Read cached notes (' + count + ')';
  }
  function openOfflineReader() {
    var m = loadNoteCache();
    var items = Object.keys(m).map(function (id) { return m[id]; })
      .sort(function (a, b) { return (b.updatedAt || '') < (a.updatedAt || '') ? -1 : 1; });
    var ul = $('orList'); ul.innerHTML = '';
    $('orContent').innerHTML = '<p class="muted">Select a note to read.</p>';
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'or-item';
      li.textContent = it.displayTitle || 'Untitled';
      li.addEventListener('click', function () {
        Array.prototype.forEach.call(ul.children, function (c) { c.classList.remove('active'); });
        li.classList.add('active'); renderOfflineNote(it);
      });
      ul.appendChild(li);
    });
    if (items.length) { ul.children[0].classList.add('active'); renderOfflineNote(items[0]); }
    else $('orContent').innerHTML = '<p class="muted">No cached notes yet.</p>';
    $('offlineReader').classList.remove('hidden');
  }
  function renderOfflineNote(it) {
    var parts = ['<h2>' + esc(it.displayTitle || 'Untitled') + '</h2>'];
    if (it.tags && it.tags.length) parts.push('<div class="or-tags muted tiny">' + it.tags.map(function (t) { return '#' + esc(t); }).join(' ') + '</div>');
    var open = (it.todos || []).filter(function (t) { return !t.done; });
    if (open.length) parts.push('<h3>To-do</h3><ul>' + open.map(function (t) { return '<li>' + esc(t.text) + '</li>'; }).join('') + '</ul>');
    // carryover/meetingNotes are our own server-sanitized HTML.
    if (it.carryover) parts.push('<h3>Ongoing notes</h3><div class="or-rte">' + it.carryover + '</div>');
    if (it.meetingNotes) parts.push('<h3>Meeting notes</h3><div class="or-rte">' + it.meetingNotes + '</div>');
    if (it.updatedAt) parts.push('<p class="muted tiny">Cached copy · last edited ' + esc(String(it.updatedAt).slice(0, 10)) + '</p>');
    $('orContent').innerHTML = parts.join('');
  }
  $('serverDownCached').addEventListener('click', openOfflineReader);
  $('orBack').addEventListener('click', function () { $('offlineReader').classList.add('hidden'); });

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
    var canBio = !!(state.bio && state.bio.enrolled) && initialized && !!window.PublicKeyCredential && bioHostOk();
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
  // WebAuthn RP IDs must be domain names — an IP address (the default
  // 127.0.0.1:3000 URL) can't be one, so passkeys simply don't work there.
  // localhost, *.localhost (e.g. cove.localhost) and real HTTPS hosts are fine.
  function bioHostOk() {
    var h = location.hostname || '';
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // IPv4
    if (h.indexOf(':') >= 0 || h.indexOf('[') >= 0) return false; // IPv6
    return true;
  }

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
    console.log('[bio] enroll start; build ' + APP_BUILD + '; host ' + location.hostname);
    if (!window.PublicKeyCredential) throw new Error('WebAuthn is not available in this browser.');
    if (!bioHostOk()) throw new Error('Passkeys need a hostname, not an IP address. Open Cove at localhost:' + (location.port || '3000') + ' (or a cove.localhost address) instead of 127.0.0.1, then enable biometric unlock.');
    var cred;
    try {
      cred = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Cove' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'cove', displayName: 'Cove' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        // Evaluate the PRF at create() so a PRF-capable authenticator can return the
        // secret in the SAME prompt (no second Touch ID). Authenticators that don't
        // support PRF-at-create fall through to the assertion below.
        timeout: 60000, extensions: { prf: { eval: { first: PRF_SALT } } },
      } });
    } catch (ex) { console.error('[bio] create() failed:', ex && ex.name, ex && ex.message, ex); throw webauthnError(ex); }
    var credId = bufToB64url(cred.rawId);
    var secret = null;
    var ext = {};
    try { ext = (cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}) || {}; } catch (_e) { ext = {}; }
    var prfEnabled = ext.prf ? ext.prf.enabled : undefined;
    console.log('[bio] passkey created; prf.enabled=' + prfEnabled, ext);
    // Fast path: some authenticators hand back the PRF secret straight from create()
    // — one prompt, no second Touch ID.
    try { var f0 = ext.prf && ext.prf.results && ext.prf.results.first; if (f0) { secret = bufToB64(f0); console.log('[bio] PRF secret obtained from create() (single prompt)'); } } catch (_e) { /* fall through */ }
    // If registration explicitly reports PRF unsupported, don't fire a second
    // (doomed) Touch ID prompt — fail now with guidance.
    var noPrfMsg = 'The passkey was created but its provider doesn’t support the PRF/hmac-secret extension Cove needs, so biometric unlock can’t use it. On a Mac, Chrome’s built-in “this device” passkey provider is the usual culprit — it can’t do PRF; iCloud Keychain can. Fix: open Cove in a normal Chrome browser tab (not the installed app window), click “Enable biometric unlock”, and in the passkey prompt choose “Save another way” → iCloud Keychain (or your iPhone). On Windows, pick Windows Hello. Then delete the leftover “Cove” passkey (chrome://settings/passkeys) and try again. Your passphrase still works meanwhile.';
    if (!secret && prfEnabled === false) {
      console.warn('[bio] prf.enabled=false — provider does not support PRF; not prompting again.');
      throw new Error(noPrfMsg);
    }
    if (!secret) {
      // Provider may only surface PRF on an assertion — do a get() to fetch it.
      var got = null;
      try { got = await bioAssert([credId]); } catch (ex) { console.error('[bio] assertion get() failed:', ex && ex.name, ex && ex.message, ex); throw webauthnError(ex); }
      console.log('[bio] assertion done; secret ' + (got && got.secret ? 'obtained' : 'MISSING'));
      if (got && got.secret) secret = got.secret;
    }
    if (!secret) {
      console.warn('[bio] no PRF secret. create() ext=', ext, '(prf.enabled=' + prfEnabled + ')');
      throw new Error(noPrfMsg);
    }
    console.log('[bio] enrolling credential with server');
    await API.webauthnEnroll({ credentialId: credId, prfSecret: secret, prfSalt: 'v1', label: bioDeviceLabel() });
    console.log('[bio] enroll complete ✓');
  }
  // Turn a WebAuthn DOMException into a message that names the actual failure.
  function webauthnError(ex) {
    var name = (ex && ex.name) || 'Error';
    console.warn('[bio] webauthn error mapped:', name, ex && ex.message);
    if (name === 'NotAllowedError') return new Error('The passkey request was cancelled or timed out. Try again and approve the Touch ID / passkey prompt.');
    if (name === 'InvalidStateError') return new Error('A passkey for Cove already exists on this device. Remove it in your browser/OS passkey settings, then try again.');
    if (name === 'SecurityError') return new Error('The browser blocked the passkey for this address. Biometric unlock needs localhost or an HTTPS origin (a “cove.localhost” style host counts as secure in Chrome).');
    if (name === 'NotSupportedError') return new Error('This device has no PRF-capable platform authenticator, so biometric unlock isn’t available here. Your passphrase still works.');
    return new Error((ex && ex.message) ? (name + ': ' + ex.message) : ('Passkey error (' + name + ').'));
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

  // A 401 means our session ended (expired, or the server restarted and lost its
  // in-memory sessions). Do NOT reload — that used to loop forever, hammering the
  // server and pinning the CPU. Instead lock back to the auth gate in place and
  // stop every background request. Guarded so a burst of 401s locks only once.
  var unauthHandling = false;
  function handleUnauthorized() {
    if (unauthHandling) return;
    unauthHandling = true;
    stopBackground();
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    API.setCsrf(null);
    showAuth(state.initialized !== false);
    $('authSubtitle').textContent = 'Your session ended — enter your passphrase to unlock again.';
  }
  window.addEventListener('mn-unauthorized', handleUnauthorized);
  function stopBackground() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.sse) { try { state.sse.close(); } catch (_e) {} state.sse = null; }
  }

  async function startApp() {
    unauthHandling = false;
    $('authGate').classList.add('hidden');
    $('app').classList.remove('hidden');
    state.settings = await API.getSettings();
    // First run: adopt this device's timezone so server-side dates/reminders match
    // the user's wall clock out of the box (they can change it in Settings).
    if (!state.settings.timezone) {
      try {
        var detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (detected) { state.settings.timezone = detected; API.saveSettings({ timezone: detected }); }
      } catch (_e) { /* leave unset → server local */ }
    }
    state.tagBookmarks = Array.isArray(state.settings.tagBookmarks) ? state.settings.tagBookmarks : [];
    state.savedSearches = Array.isArray(state.settings.savedSearches) ? state.settings.savedSearches : [];
    state.allTags = [];
    try { state.allTags = await API.allTags(); } catch (_e) { /* non-fatal */ }
    setOfflineFlag(offlineCacheEnabled()); // mirror to localStorage for the pre-auth server-down screen
    applyFontSize(state.settings.fontSize || 14);
    applyListCaps();
    applyEditorSizes();
    initSticky();
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
    // If a page was already controlled by a service worker at load, a later
    // controllerchange means a NEW version took over while the app stayed open —
    // its freshly-loaded JS/CSS is stale until reload, so offer a reload.
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController) showUpdateToast();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').then(function (reg) {
        var check = function () { reg.update().catch(function () {}); };
        // Check right away, hourly, and whenever the app regains focus — an
        // installed PWA that's left open otherwise keeps its stale JS in memory
        // for up to an hour before the "New version — reload" prompt appears.
        check();
        setInterval(check, 60 * 60 * 1000);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
      }).catch(function () {});
    });
  }
  function showUpdateToast() {
    var t = $('updateToast');
    if (!t || !t.classList.contains('hidden')) return;
    t.classList.remove('hidden');
  }
  // A plain reload can keep serving a stale, separately-cached script (this is
  // exactly how an installed PWA ends up on a new app.js but an old editor.js).
  // Unregister the service worker and drop its caches first, so the reload
  // refetches every shell file from the server.
  async function hardReload() {
    try {
      if ('serviceWorker' in navigator) {
        var regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(function (r) { return r.unregister(); }));
      }
      if (window.caches && caches.keys) {
        var keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }
    } catch (_e) { /* best effort */ }
    location.reload();
  }
  // Detect a script-version split: editor.js is cached separately from app.js.
  // With the network-first SW and the server's revalidation headers the two
  // normally stay in lockstep, so we DON'T pop the reload toast for this on its
  // own (that just felt like a spurious "reload" nag after an update). We only
  // log it, surface a passive note + Force-refresh in Settings, and — if a real
  // split does exist when the genuine update toast shows — make its Reload
  // button clear caches instead of a plain reload.
  function editorBuild() { return window.__coveEditorBuild || null; }
  function scriptsOutOfSync() { var eb = editorBuild(); return !!eb && eb !== APP_BUILD; }
  if (scriptsOutOfSync()) {
    try { console.warn('Cove: editor.js build ' + editorBuild() + ' != app build ' + APP_BUILD + ' — cached script mismatch (use Settings → Force refresh if features look missing)'); } catch (_e) {}
  }
  if ($('updateReloadBtn')) {
    // If scripts are out of sync a normal reload won't help — clear caches.
    $('updateReloadBtn').addEventListener('click', function () { if (scriptsOutOfSync()) hardReload(); else location.reload(); });
    $('updateDismissBtn').addEventListener('click', function () { $('updateToast').classList.add('hidden'); });
  }

  // ---------------- Global sticky note ----------------
  // A small, window-pinned, draggable scratch pad (classic Stickies). Content is
  // encrypted in settings (synced); its position + collapsed state are per-device
  // UI in localStorage. Collapses to a corner pin (FAB) so it's never in the way,
  // and defaults to collapsed on phones.
  var stickySaveTimer = null;
  var STICKY_COLORS = ['yellow', 'pink', 'orange', 'green', 'blue', 'purple'];
  var STICKY_SWATCH = { yellow: '#f7e27a', pink: '#f2a7c2', orange: '#f3bd83', green: '#a6db97', blue: '#9dc3f4', purple: '#bfa9f1' };
  function stickyEnabled() { return state.settings.stickyEnabled !== false; } // default on
  function stickyColor() { var c = state.settings.stickyColor; return STICKY_COLORS.indexOf(c) >= 0 ? c : 'yellow'; }
  function stickyPos() { try { return JSON.parse(localStorage.getItem('cove.stickyPos') || 'null'); } catch (_e) { return null; } }
  function setStickyPos(x, y) { try { localStorage.setItem('cove.stickyPos', JSON.stringify({ x: x, y: y })); } catch (_e) {} }
  function stickyCollapsed() { try { return localStorage.getItem('cove.stickyCollapsed') === '1'; } catch (_e) { return false; } }
  function setStickyCollapsed(v) { try { localStorage.setItem('cove.stickyCollapsed', v ? '1' : '0'); } catch (_e) {} }
  function stickySize() { try { return JSON.parse(localStorage.getItem('cove.stickySize') || 'null'); } catch (_e) { return null; } }
  function setStickySize(w, h) { try { localStorage.setItem('cove.stickySize', JSON.stringify({ w: w, h: h })); } catch (_e) {} }
  function stickyMaxW() { return Math.max(180, Math.round(window.innerWidth * 0.9)); }
  function stickyMaxH() { return Math.max(120, Math.round(window.innerHeight * 0.9)); }
  function applyStickySize() {
    var el = $('sticky'); if (!el) return;
    var s = stickySize() || { w: 240, h: 210 };
    el.style.width = Math.max(180, Math.min(s.w, stickyMaxW())) + 'px';
    el.style.height = Math.max(120, Math.min(s.h, stickyMaxH())) + 'px';
  }
  function stickyReduceMotion() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_e) { return false; } }
  function clampSticky(x, y, w, h) {
    var m = 8, maxX = Math.max(m, window.innerWidth - w - m), maxY = Math.max(m, window.innerHeight - h - m);
    return { x: Math.min(Math.max(m, x), maxX), y: Math.min(Math.max(m, y), maxY) };
  }
  function placeSticky() {
    var el = $('sticky'); if (!el) return;
    applyStickySize();
    var w = el.offsetWidth || 240, h = el.offsetHeight || 200;
    var p = stickyPos() || { x: window.innerWidth - w - 20, y: 84 };
    var c = clampSticky(p.x, p.y, w, h);
    el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; el.style.right = 'auto';
  }
  // Where the minimized pin lives (bottom-right corner) — the animation target.
  function stickyFabCenter() { return { x: window.innerWidth - 18 - 21, y: window.innerHeight - 18 - 21 }; }
  function applyStickyColor(name, save) {
    if (STICKY_COLORS.indexOf(name) < 0) name = 'yellow';
    [$('sticky'), $('stickyFab')].forEach(function (el) {
      if (!el) return;
      STICKY_COLORS.forEach(function (c) { el.classList.remove('c-' + c); });
      el.classList.add('c-' + name);
    });
    var row = $('stickyColors');
    if (row) Array.prototype.forEach.call(row.children, function (b) { b.classList.toggle('active', b.getAttribute('data-color') === name); });
    if (save) { state.settings.stickyColor = name; API.saveSettings({ stickyColor: name }).catch(function () {}); }
  }
  function buildStickySwatches() {
    var row = $('stickyColors'); if (!row || row.children.length) return;
    STICKY_COLORS.forEach(function (name) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'sticky-sw'; b.setAttribute('data-color', name);
      b.title = name.charAt(0).toUpperCase() + name.slice(1); b.setAttribute('aria-label', b.title);
      b.style.background = STICKY_SWATCH[name];
      b.addEventListener('click', function () { applyStickyColor(name, true); row.classList.add('hidden'); });
      row.appendChild(b);
    });
  }
  function finalizeCollapse() {
    setStickyCollapsed(true);
    var el = $('sticky');
    el.classList.add('hidden');
    el.style.transition = ''; el.style.transform = ''; el.style.opacity = '';
    if (stickyEnabled()) { var fab = $('stickyFab'); fab.classList.remove('hidden'); fab.classList.remove('pop'); void fab.offsetWidth; fab.classList.add('pop'); }
  }
  function collapseSticky(animate) {
    var el = $('sticky');
    $('stickyColors').classList.add('hidden');
    if (!animate || el.classList.contains('hidden') || stickyReduceMotion()) { finalizeCollapse(); return; }
    var r = el.getBoundingClientRect(), fc = stickyFabCenter();
    var dx = fc.x - (r.left + r.width / 2), dy = fc.y - (r.top + r.height / 2);
    var done = function () { el.removeEventListener('transitionend', done); finalizeCollapse(); };
    el.addEventListener('transitionend', done);
    el.style.transformOrigin = 'center';
    el.style.transition = 'transform .28s cubic-bezier(.4,0,.2,1), opacity .28s ease';
    requestAnimationFrame(function () { el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.15)'; el.style.opacity = '0'; });
    setTimeout(function () { if (!el.classList.contains('hidden')) { el.removeEventListener('transitionend', done); finalizeCollapse(); } }, 420); // safety
  }
  function showStickyPanel(animate) {
    if (!stickyEnabled()) return;
    var el = $('sticky'), wasHidden = el.classList.contains('hidden');
    setStickyCollapsed(false);
    $('stickyFab').classList.add('hidden');
    el.classList.remove('hidden');
    placeSticky();
    if (!animate || !wasHidden || stickyReduceMotion()) { el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; return; }
    var r = el.getBoundingClientRect(), fc = stickyFabCenter();
    var dx = fc.x - (r.left + r.width / 2), dy = fc.y - (r.top + r.height / 2);
    el.style.transformOrigin = 'center'; el.style.transition = 'none';
    el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.15)'; el.style.opacity = '0';
    requestAnimationFrame(function () {
      el.style.transition = 'transform .3s cubic-bezier(.2,.9,.3,1), opacity .28s ease';
      el.style.transform = ''; el.style.opacity = '';
    });
    var clear = function () { el.removeEventListener('transitionend', clear); el.style.transition = ''; };
    el.addEventListener('transitionend', clear);
  }
  function applyStickyVisibility() {
    if (!$('sticky')) return;
    if (!stickyEnabled()) { $('sticky').classList.add('hidden'); $('stickyFab').classList.add('hidden'); return; }
    // Phones start collapsed so the panel never covers the editor.
    var startCollapsed = stickyCollapsed() || window.matchMedia('(max-width: 760px)').matches;
    if (startCollapsed) collapseSticky(false); else showStickyPanel(false);
  }
  function initSticky() {
    var el = $('sticky'); if (!el) return;
    $('stickyText').value = state.settings.stickyText || '';
    buildStickySwatches();
    applyStickyColor(stickyColor(), false);
    applyStickyVisibility();
    // Autosave (debounced) to encrypted settings.
    $('stickyText').addEventListener('input', function () {
      state.settings.stickyText = $('stickyText').value;
      clearTimeout(stickySaveTimer);
      stickySaveTimer = setTimeout(function () { API.saveSettings({ stickyText: state.settings.stickyText }).catch(function () {}); }, 500);
    });
    $('stickyCollapse').addEventListener('click', function () { collapseSticky(true); });
    $('stickyFab').addEventListener('click', function () { showStickyPanel(true); });
    $('stickyColorBtn').addEventListener('click', function () { $('stickyColors').classList.toggle('hidden'); });
    // Drag by the header via Pointer Events (mouse + touch).
    var head = $('stickyHead'), drag = null;
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.sticky-x')) return; // let the header buttons click
      var r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { head.setPointerCapture(e.pointerId); } catch (_e) {}
      e.preventDefault();
    });
    head.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var w = el.offsetWidth, h = el.offsetHeight;
      var c = clampSticky(e.clientX - drag.dx, e.clientY - drag.dy, w, h);
      el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; el.style.right = 'auto';
    });
    var end = function (e) { if (!drag) return; drag = null; try { head.releasePointerCapture(e.pointerId); } catch (_e) {} setStickyPos(parseInt(el.style.left, 10) || 0, parseInt(el.style.top, 10) || 0); };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
    // Resize from the bottom-right grip (width + height), remembered per device.
    var grip = $('stickyResize'), rz = null;
    grip.addEventListener('pointerdown', function (e) {
      var r = el.getBoundingClientRect();
      rz = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
      try { grip.setPointerCapture(e.pointerId); } catch (_e) {}
      e.preventDefault(); e.stopPropagation();
    });
    grip.addEventListener('pointermove', function (e) {
      if (!rz) return;
      var w = Math.max(180, Math.min(rz.w + (e.clientX - rz.x), stickyMaxW()));
      var h = Math.max(120, Math.min(rz.h + (e.clientY - rz.y), stickyMaxH()));
      el.style.width = w + 'px'; el.style.height = h + 'px';
    });
    var rzEnd = function (e) { if (!rz) return; rz = null; try { grip.releasePointerCapture(e.pointerId); } catch (_e) {} setStickySize(parseInt(el.style.width, 10) || 240, parseInt(el.style.height, 10) || 210); placeSticky(); };
    grip.addEventListener('pointerup', rzEnd);
    grip.addEventListener('pointercancel', rzEnd);
    // Keep it on-screen if the window is resized smaller.
    window.addEventListener('resize', function () { if (!$('sticky').classList.contains('hidden')) placeSticky(); });
  }

  // Live-sync: refresh when note files change on disk (e.g. another device via a
  // synced folder). Change events are COALESCED and self-echo-suppressed: when the
  // data dir lives in a cloud-sync folder, the sync client touches files
  // constantly, so reacting to every event would fire a stream of refetches and
  // keep the browser tab in a perpetual "loading" state (a flickering favicon).
  function startLiveSync() {
    if (!('EventSource' in window)) return;
    if (state.sse) { try { state.sse.close(); } catch (_e) {} state.sse = null; }
    try {
      var es = new EventSource('/api/events');
      state.sse = es;
      var timer = null, wantNote = false, sseErrs = 0;
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
      es.addEventListener('open', function () { sseErrs = 0; });
      es.onerror = function () {
        // Normally the browser just auto-reconnects. But if our session ended,
        // /api/events keeps 401-ing forever — after a few failures, confirm via
        // status and lock instead of looping.
        if (++sseErrs >= 3) {
          sseErrs = 0;
          API.status().then(function (st) { if (st && !st.authenticated) handleUnauthorized(); }).catch(function () {});
        }
      };
    } catch (e) { /* SSE unsupported */ }
  }

  function applyFontSize(px) {
    document.documentElement.style.setProperty('--note-font', px + 'px');
  }

  // Adjustable, persisted height caps for the note's task lists. Below the cap a
  // list sizes naturally; above it, it scrolls. A grip (shown only on overflow)
  // lets users resize the window, and the height persists per device.
  var RESIZE_MIN = 140, RESIZE_MAX = 1400, RESIZE_DEFAULT = 340;
  function makeResizableList(o) {
    // o: { scrollId, gripId, cssVar, settingKey }
    function cur() {
      var h = parseInt(state.settings && state.settings[o.settingKey], 10);
      return h >= RESIZE_MIN && h <= RESIZE_MAX ? h : RESIZE_DEFAULT;
    }
    function apply(px) { document.documentElement.style.setProperty(o.cssVar, Math.round(px) + 'px'); }
    function refresh() {
      var sc = $(o.scrollId), grip = $(o.gripId);
      if (!sc || !grip) return;
      grip.classList.toggle('hidden', sc.scrollHeight <= sc.clientHeight + 1);
    }
    var saveT;
    function save(px) {
      px = Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, Math.round(px)));
      apply(px); state.settings[o.settingKey] = px;
      clearTimeout(saveT);
      saveT = setTimeout(function () { var p = {}; p[o.settingKey] = px; API.saveSettings(p); }, 300);
      (o.onChange || refresh)();
    }
    var grip = $(o.gripId);
    if (grip) {
      var dragging = false, startY = 0, startH = 0;
      grip.addEventListener('pointerdown', function (e) {
        dragging = true; startY = e.clientY; startH = $(o.scrollId).getBoundingClientRect().height;
        try { grip.setPointerCapture(e.pointerId); } catch (_e) { /* synthetic pointer */ }
        e.preventDefault();
      });
      grip.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        apply(Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, startH + (e.clientY - startY))));
      });
      var end = function () { if (!dragging) return; dragging = false; save($(o.scrollId).getBoundingClientRect().height); };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
      grip.addEventListener('dblclick', function () { save(RESIZE_DEFAULT); });
      grip.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowUp') { save(cur() - 24); e.preventDefault(); }
        else if (e.key === 'ArrowDown') { save(cur() + 24); e.preventDefault(); }
      });
    }
    return { refresh: refresh, applyStored: function () { apply(cur()); } };
  }
  // Both task lists share one height: dragging either grip resizes both, and the
  // single value persists (taskListMaxHeight → --task-list-max). After a resize,
  // re-check both grips since the change may make the other list start/stop
  // overflowing.
  // The Today column's quick-add box pushes its list down; measure that offset so
  // the Upcoming list can be exactly that much taller and the two column bottoms
  // (and grips) line up. Stable regardless of the lists' own heights.
  function updateQaOffset() {
    var td = $('taskScroll'), up = $('upcomingScroll');
    if (!td || !up) return;
    var a = td.getBoundingClientRect(), b = up.getBoundingClientRect();
    if (!a.height && !b.height) return; // note view not visible — skip
    var d = Math.round(a.top - b.top);
    document.documentElement.style.setProperty('--qa-h', (d > 0 ? d : 0) + 'px');
  }
  function refreshTaskLists() { todayResizer.refresh(); upcomingResizer.refresh(); }
  var todayResizer = makeResizableList({ scrollId: 'taskScroll', gripId: 'taskResize', cssVar: '--task-list-max', settingKey: 'taskListMaxHeight', onChange: refreshTaskLists });
  var upcomingResizer = makeResizableList({ scrollId: 'upcomingScroll', gripId: 'upcomingResize', cssVar: '--task-list-max', settingKey: 'taskListMaxHeight', onChange: refreshTaskLists });
  function applyListCaps() { todayResizer.applyStored(); }

  // The two main editors (Ongoing Notes, Meeting Notes) are drag-resizable
  // (native `resize: vertical`) scrolling boxes whose height persists in
  // settings. applyEditorSizes() sets the stored height; a ResizeObserver saves
  // a new one after the user drags. Programmatic sets are suppressed so they
  // don't echo back as a save.
  var EDITOR_MIN = 90, EDITOR_MAX = 2000, editorSuppressUntil = 0;
  var EDITORS = [['carryoverEditor', 'ongoingEditorHeight', 200], ['meetingEditor', 'meetingEditorHeight', 260]];
  function applyEditorSizes() {
    editorSuppressUntil = Date.now() + 900;
    EDITORS.forEach(function (e) {
      var el = $(e[0]); if (!el) return;
      var h = parseInt(state.settings && state.settings[e[1]], 10);
      el.style.height = ((h >= EDITOR_MIN && h <= EDITOR_MAX) ? h : e[2]) + 'px';
    });
  }
  (function initEditorResize() {
    if (typeof ResizeObserver === 'undefined') return;
    EDITORS.forEach(function (e) {
      var el = $(e[0]); if (!el) return;
      var lastH = 0, t;
      new ResizeObserver(function () {
        var h = Math.round(el.getBoundingClientRect().height);
        if (!h) return;
        if (Date.now() < editorSuppressUntil || !lastH || Math.abs(h - lastH) < 2) { lastH = h; return; }
        lastH = h;
        clearTimeout(t);
        t = setTimeout(function () {
          var clamped = Math.max(EDITOR_MIN, Math.min(EDITOR_MAX, h));
          if (clamped === parseInt(state.settings[e[1]], 10)) return;
          state.settings[e[1]] = clamped;
          var patch = {}; patch[e[1]] = clamped; API.saveSettings(patch);
        }, 400);
      }).observe(el);
    });
  })();
  // Drag grips below each editor set its height directly; the ResizeObserver above
  // then persists it. Works with mouse and touch (native corner handles don't).
  (function initEditorGrips() {
    var GRIPS = [['carryoverEditor', 'carryoverResize', 'ongoingEditorHeight', 200], ['meetingEditor', 'meetingResize', 'meetingEditorHeight', 260]];
    GRIPS.forEach(function (g) {
      var el = $(g[0]), grip = $(g[1]); if (!el || !grip) return;
      function setH(px) { el.style.height = Math.max(EDITOR_MIN, Math.min(EDITOR_MAX, Math.round(px))) + 'px'; }
      var dragging = false, startY = 0, startH = 0;
      grip.addEventListener('pointerdown', function (e) {
        dragging = true; startY = e.clientY; startH = el.getBoundingClientRect().height;
        try { grip.setPointerCapture(e.pointerId); } catch (_e) { /* synthetic */ }
        e.preventDefault();
      });
      grip.addEventListener('pointermove', function (e) { if (dragging) setH(startH + (e.clientY - startY)); });
      var end = function () { dragging = false; };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
      grip.addEventListener('dblclick', function () { setH(g[3]); });
      grip.addEventListener('keydown', function (e) {
        var h = el.getBoundingClientRect().height;
        if (e.key === 'ArrowUp') { setH(h - 24); e.preventDefault(); }
        else if (e.key === 'ArrowDown') { setH(h + 24); e.preventDefault(); }
      });
    });
  })();
  // Recompute the quick-add offset when the layout reflows (e.g. width changes
  // wrap the quick-add controls), so the columns stay bottom-aligned.
  window.addEventListener('resize', function () {
    clearTimeout(updateQaOffset._t);
    updateQaOffset._t = setTimeout(function () { updateQaOffset(); refreshTaskLists(); }, 150);
  });

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

  // ---------------- Mobile sidebar drawer ----------------
  // The sidebar is an off-canvas drawer below 760px (see styles.css). These helpers
  // slide it in/out and are no-ops visually on desktop (the media query keeps it inline).
  function sidebarEl() { return document.querySelector('.sidebar'); }
  function setDrawer(open) {
    sidebarEl().classList.toggle('open', open);
    $('sidebarBackdrop').classList.toggle('hidden', !open);
    $('menuBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function closeDrawer() { setDrawer(false); }
  $('menuBtn').addEventListener('click', function () { setDrawer(!sidebarEl().classList.contains('open')); });
  $('sidebarBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sidebarEl().classList.contains('open')) closeDrawer();
  });

  // ---------------- Help / shortcuts overlay ----------------
  function openHelp() { $('helpVersion').textContent = versionLabel(); $('helpLayer').classList.remove('hidden'); }
  // Human-readable version for "about"-style surfaces. Shows the server app version
  // and the client build so a stale cached UI is easy to spot when they differ.
  function versionLabel() {
    var sv = (state.instance && state.instance.version) || '';
    var mism = scriptsOutOfSync() ? ' · ⚠ editor.js cached at ' + editorBuild() + ' — reload to update' : '';
    return 'Cove' + (sv ? ' v' + sv : '') + ' · app build ' + APP_BUILD + mism;
  }
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
      { label: 'Sticky note: open / focus', run: function () { if (!stickyEnabled()) { state.settings.stickyEnabled = true; API.saveSettings({ stickyEnabled: true }); } showStickyPanel(true); try { $('stickyText').focus(); } catch (_e) {} } },
      { label: 'Go to: Tasks', run: openTasksPage },
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
        label: '➕ Add task: ' + rawInput,
        sub: 'to ' + (w0 ? w0.name : 'workspace') + (bits.length ? ' · ' + bits.join(' · ') : ''),
        run: async function () {
          var p = window.TaskParse.parse(rawInput);
          applyTaskResult(await API.addTask(state.wsId, { text: rawInput, due: p.due, time: p.time, priority: p.priority, recurrence: p.recurrence }));
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

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  async function loadStatsInto() {
    try {
      var s = await API.stats();
      $('statsInfo').textContent = plural(s.workspaces, 'workspace') + ' · ' + plural(s.notes, 'note') + ' · ' + plural(s.attachments, 'attachment') + ' · ' + fmtSize(s.bytes) + ' encrypted on disk';
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
    refreshQaLink();
  }
  $('workspaceSelect').addEventListener('change', async function () {
    state.wsId = $('workspaceSelect').value; state.qaLinks = []; refreshQaLink();
    showView('note'); closeDrawer(); await loadCurrentNote();
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
    showView('note'); renderNote(); renderNoteList(); loadTasks(); closeDrawer();
    cacheNoteForOffline(state.note);
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
    if (/^\d{4}-\d{2}-\d{2}$/.test(n.title || '')) $('noteDateInput').value = n.title;
    $('noteDateInput').classList.add('hidden');
    $('noteDate').classList.remove('hidden');
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
    updateSummaryAvailability();
    setNoteHash(n.id);
    armDailyNudge();
  }

  // Gentle, once-a-day nudge: if you've been working in a note for a while and
  // haven't started today's daily note (in a workspace you do use dailies in),
  // show a small dismissible banner — at most once per day, per device.
  var DAILY_NUDGE_DEFAULT_SEC = 10;
  var dailyNudge = { timer: null, forNoteId: null };
  // The configured delay in seconds (0 = off). Prefers the seconds pref, falls
  // back to the older minutes pref for anyone who set it before, else default.
  function dailyNudgeSeconds() {
    var s = state.settings && state.settings.dailyNudgeSeconds;
    if (s == null && state.settings && state.settings.dailyNudgeMinutes != null) s = state.settings.dailyNudgeMinutes * 60;
    return s == null ? DAILY_NUDGE_DEFAULT_SEC : s;
  }
  // Resolves to the delay in ms, or 0 when off. The test hook wins when present.
  function dailyNudgeDelayMs() {
    if (typeof window !== 'undefined' && window.__coveNudgeMs) return window.__coveNudgeMs;
    var s = dailyNudgeSeconds();
    if (s <= 0) return 0;              // Never
    if (s <= 1) return 250;            // "Immediately" — just enough for the note to render
    return s * 1000;
  }
  function dailyNudgeShownToday() { try { return localStorage.getItem('cove.dailyNudge') === todayStr(); } catch (_e) { return false; } }
  function armDailyNudge() {
    var n = state.note;
    if (!n || dailyNudge.forNoteId === n.id) return; // only (re)arm when the note changes
    dailyNudge.forNoteId = n.id;
    dailyNudge.armedDay = todayStr();
    clearTimeout(dailyNudge.timer); dailyNudge.timer = null;
    $('dailyNudge').classList.add('hidden');
    var delay = dailyNudgeDelayMs();
    if (delay <= 0) return; // reminder turned off
    if (dailyNudgeShownToday()) return;
    var today = todayStr();
    if (n.kind !== 'scratch' && n.title === today) return; // already on today's daily
    var wsId = state.wsId;
    dailyNudge.timer = setTimeout(function () {
      if (dailyNudgeShownToday() || state.view !== 'note' || state.wsId !== wsId || !state.note) return;
      if (state.note.kind !== 'scratch' && state.note.title === today) return;
      API.listNotes(wsId, { sort: 'created', dir: 'desc' }).then(function (notes) {
        var dailies = (notes || []).filter(function (x) { return (x.kind || 'daily') !== 'scratch'; });
        var hasToday = dailies.some(function (x) { return x.title === today; });
        // Only nudge people who actually use daily notes here, and only when
        // there's still no daily for today.
        if (dailies.length && !hasToday && state.wsId === wsId && state.view === 'note') {
          try { localStorage.setItem('cove.dailyNudge', todayStr()); } catch (_e) {}
          $('dailyNudge').classList.remove('hidden');
        }
      }).catch(function () {});
    }, delay);
  }
  $('dailyNudgeNew').addEventListener('click', function () { $('dailyNudge').classList.add('hidden'); createNewNote({}); });
  $('dailyNudgeDismiss').addEventListener('click', function () { $('dailyNudge').classList.add('hidden'); });
  // If the app was left open past midnight (common for an installed PWA), re-evaluate
  // the nudge when the tab becomes visible again on a NEW day — otherwise it would
  // never re-arm until you switched notes.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && dailyNudge.armedDay && dailyNudge.armedDay !== todayStr()) {
      dailyNudge.forNoteId = null; armDailyNudge();
    }
  });

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
  // fields are preserved as you keep typing the task text (only a token the parser
  // newly finds — or changes — in the text overrides them).
  state.qaManual = { due: false, time: false, priority: false, recurrence: false };
  // Last value the PARSER produced for each field. Lets us tell a *newly typed*
  // token (which should win and un-stick a manual pick) from an unchanged token
  // still sitting in the text while you edit elsewhere (which must NOT clobber a
  // date/priority you picked in the picker).
  state.qaLast = { due: null, time: null, priority: null, recurrence: null };

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
  function wsName(id) { var w = (state.workspaces || []).find(function (x) { return x.id === id; }); return (w && w.name) || 'workspace'; }
  // Share a task into additional workspaces. The task keeps a single home record,
  // so completing it (and its completed date) reflects in every shared space.
  function openShareDialog(t) {
    var home = t.workspaceId;
    var others = (state.workspaces || []).filter(function (w) { return w.id !== home; });
    if (!others.length) { dialog.alert('You only have one workspace — create another to share tasks with it.'); return; }
    var shared = {}; (t.sharedWith || []).forEach(function (id) { shared[id] = true; });
    var back = document.createElement('div'); back.className = 'modal-backdrop';
    var modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    var h = document.createElement('h3'); h.textContent = 'Share task with workspaces'; modal.appendChild(h);
    var p = document.createElement('p'); p.className = 'muted tiny';
    p.textContent = '“' + t.text + '” lives in ' + wsName(home) + '. Tick other workspaces to show it there too — it stays one task, so completing it (and its date) is reflected in all of them.';
    modal.appendChild(p);
    var list = document.createElement('div'); list.className = 'share-ws-list';
    others.forEach(function (w) {
      var lab = document.createElement('label'); lab.className = 'share-ws-item';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = w.id; cb.checked = !!shared[w.id];
      lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + w.name));
      list.appendChild(lab);
    });
    modal.appendChild(list);
    var acts = document.createElement('div'); acts.className = 'modal-actions';
    var save = document.createElement('button'); save.className = 'primary'; save.textContent = 'Save';
    var cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    acts.appendChild(save); acts.appendChild(cancel); modal.appendChild(acts);
    back.appendChild(modal); document.body.appendChild(back);
    function close() { back.remove(); }
    cancel.addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    save.addEventListener('click', async function () {
      var ids = Array.prototype.slice.call(list.querySelectorAll('input:checked')).map(function (c) { return c.value; });
      try { applyTaskResult(await API.shareTask(t.id, ids)); setSaveStatus(ids.length ? 'Shared ✓' : 'Sharing removed ✓'); }
      catch (ex) { await dialog.alert('Could not update sharing: ' + ex.message); }
      close();
    });
  }
  // Guard against a stale cached app tab where API.moveTask isn't defined yet —
  // surface a clear "reload" message instead of a silent failure.
  function moveTaskTo(taskId, dest) {
    if (!API || typeof API.moveTask !== 'function') return Promise.reject(new Error('This app tab is out of date — reload the page (or reopen the installed app) to enable moving tasks.'));
    return API.moveTask(taskId, dest);
  }
  // A "not found" on move means this tab's list was stale (the task or workspace
  // changed elsewhere). Refresh both so the view reflects reality, and explain.
  async function handleMoveError(ex) {
    var msg = (ex && ex.message) || 'move failed';
    try { await loadWorkspaces(); } catch (_e) { /* non-fatal */ }
    try { await loadTasks(); } catch (_e) { /* non-fatal */ }
    if (state.view === 'todos') { try { await refreshActiveTasks(); } catch (_e) {} }
    if (/task not found/i.test(msg)) return dialog.alert('That task is no longer on the server — your list was out of date. It’s been refreshed; if the task is still shown, reload the page.');
    if (/workspace not found/i.test(msg)) return dialog.alert('That workspace no longer exists — the workspace list has been refreshed. Please pick another.');
    // A bare "not found" is the server's unmatched-route error: the running
    // server is older than this page and has no move endpoint yet.
    if (/^\s*not found\s*$/i.test(msg)) return dialog.alert('The Cove server doesn’t recognize the move request — it’s running an older version than this page. Restart the server (stop and re-run “node server.js”, or restart the Cove app / login service), then try again.');
    return dialog.alert('Couldn’t move the task: ' + msg);
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
    li.dataset.id = t.id;
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
    // Shared-across-workspaces indicator: shows either which spaces this task is
    // shared INTO (when viewed in its home) or that it's borrowed FROM another space.
    var sw = t.sharedWith || [];
    if (sw.length || (t.workspaceId && t.workspaceId !== state.wsId)) {
      var shb = document.createElement('span'); shb.className = 'task-shared'; shb.textContent = '🔗';
      if (t.workspaceId !== state.wsId) shb.title = 'Shared here from ' + wsName(t.workspaceId);
      else shb.title = 'Shared with ' + sw.map(wsName).join(', ');
      meta.appendChild(shb);
    }
    if (meta.childNodes.length) main.appendChild(meta);
    li.appendChild(cb); li.appendChild(main);

    var actions = document.createElement('div'); actions.className = 'task-actions';
    if (!t.done && t.recurrence) { var sk = document.createElement('button'); sk.className = 'task-act'; sk.title = 'Skip this occurrence'; sk.textContent = '⏭'; sk.addEventListener('click', async function () { applyTaskResult(await API.skipTask(t.id)); }); actions.appendChild(sk); }
    if (!t.done) { var pr = document.createElement('button'); pr.className = 'task-act'; pr.title = 'Cycle priority'; pr.textContent = '⚑'; pr.addEventListener('click', async function () { applyTaskResult(await API.updateTask(t.id, { priority: t.priority <= 1 ? 4 : t.priority - 1 })); }); actions.appendChild(pr); }
    if (!t.done && (state.workspaces || []).length > 1) {
      var mv = document.createElement('button'); mv.className = 'task-act'; mv.title = 'Move to another workspace'; mv.textContent = '➜';
      mv.addEventListener('click', async function () {
        var dest = await pickWorkspace('Move “' + t.text + '” to which workspace?', state.wsId);
        if (!dest || dest === state.wsId) return;
        try {
          applyTaskResult(await moveTaskTo(t.id, dest));
          setSaveStatus('Moved to ' + wsName(dest) + ' ✓');
        } catch (ex) { await handleMoveError(ex); }
      });
      actions.appendChild(mv);
      // Share (link) to additional workspaces — keeps the Move button for relocating.
      var shl = document.createElement('button'); shl.className = 'task-act'; shl.title = 'Share with other workspaces'; shl.textContent = '🔗';
      shl.addEventListener('click', function () { openShareDialog(t); });
      actions.appendChild(shl);
    }
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
    updateQaOffset();
    todayResizer.refresh();

    var uw = $('upcomingList'); uw.innerHTML = '';
    if (!upcoming.length) {
      uw.innerHTML = '<div class="task-empty muted tiny">No upcoming tasks.</div>';
    } else {
      var groups = {}; upcoming.forEach(function (t) { (groups[t.due] = groups[t.due] || []).push(t); });
      Object.keys(groups).sort().forEach(function (d) {
        var day = document.createElement('div'); day.className = 'upcoming-day';
        var lab = document.createElement('div'); lab.className = 'upcoming-date'; lab.textContent = fmtDueLong(d); day.appendChild(lab);
        var ul = document.createElement('ul'); ul.className = 'task-list'; groups[d].forEach(function (t) { ul.appendChild(taskRow(t)); }); day.appendChild(ul);
        uw.appendChild(day);
      });
    }
    upcomingResizer.refresh();
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
    state.qaLast = { due: null, time: null, priority: null, recurrence: null };
    state.qaLinks = [];
  }
  // Quick-add "🔗 Link" control: pick other workspaces to link the new task into
  // at creation time (it's created here, then shared to the ticked workspaces).
  function updateQaLinkLabel() {
    var n = (state.qaLinks || []).length;
    if ($('qaLinkLbl')) $('qaLinkLbl').textContent = n ? ('Link · ' + n) : 'Link';
    if ($('qaLink')) $('qaLink').classList.toggle('set', n > 0);
  }
  function qaLinkOthers() { return (state.workspaces || []).filter(function (w) { return w.id !== state.wsId; }); }
  function refreshQaLink() {
    if (!$('qaLink')) return;
    var others = qaLinkOthers();
    $('qaLink').classList.toggle('hidden', others.length === 0);
    // Keep only still-valid selections (drop any that became the current ws or vanished).
    state.qaLinks = (state.qaLinks || []).filter(function (id) { return others.some(function (w) { return w.id === id; }); });
    updateQaLinkLabel();
    if ($('qaLinkMenu') && !$('qaLinkMenu').classList.contains('hidden')) buildQaLinkMenu();
  }
  function buildQaLinkMenu() {
    var menu = $('qaLinkMenu'); if (!menu) return;
    menu.innerHTML = '';
    var others = qaLinkOthers();
    if (!others.length) { var e = document.createElement('div'); e.className = 'qa-link-empty'; e.textContent = 'No other workspaces'; menu.appendChild(e); return; }
    var sel = {}; (state.qaLinks || []).forEach(function (id) { sel[id] = true; });
    others.forEach(function (w) {
      var lab = document.createElement('label'); lab.className = 'qa-link-item';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = w.id; cb.checked = !!sel[w.id];
      cb.addEventListener('change', function () {
        if (cb.checked) { if (state.qaLinks.indexOf(w.id) < 0) state.qaLinks.push(w.id); }
        else { state.qaLinks = state.qaLinks.filter(function (id) { return id !== w.id; }); }
        updateQaLinkLabel();
      });
      lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + w.name));
      menu.appendChild(lab);
    });
  }
  if ($('qaLink')) $('qaLink').addEventListener('click', function (e) {
    e.stopPropagation();
    var menu = $('qaLinkMenu');
    if (menu.classList.contains('hidden')) { buildQaLinkMenu(); menu.classList.remove('hidden'); }
    else menu.classList.add('hidden');
  });
  document.addEventListener('click', function (e) {
    var menu = $('qaLinkMenu');
    if (menu && !menu.classList.contains('hidden') && !e.target.closest('.qa-link-wrap')) menu.classList.add('hidden');
  });
  function qaEq(a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }
  // Reconcile one parsed field against the picker state. A token whose value
  // CHANGED since the last keystroke wins (and clears the manual flag); an
  // unchanged token leaves a manual pick alone; no token falls back to the
  // default unless the user picked one.
  function reconcileQa(field, present, val, dflt) {
    if (present) {
      if (!qaEq(val, state.qaLast[field])) { state.qa[field] = val; state.qaManual[field] = false; }
      else if (!state.qaManual[field]) { state.qa[field] = val; }
      state.qaLast[field] = val;
    } else {
      if (!state.qaManual[field]) state.qa[field] = dflt;
      state.qaLast[field] = null;
    }
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
    // Recurrence first: the due default (recurrenceImpliedDue) depends on it.
    reconcileQa('recurrence', !!p.recurrence, p.recurrence || null, null);
    reconcileQa('due', p.due != null, p.due != null ? p.due : null, recurrenceImpliedDue());
    reconcileQa('time', !!p.time, p.time || null, null);
    reconcileQa('priority', !!m.priority, m.priority ? p.priority : null, 4);
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
    // Keep the task text exactly as typed (e.g. "on Monday do x") — the parsed
    // date/priority/recurrence still drive scheduling via the chips, but we no
    // longer strip those words out of the title.
    var payload = { text: raw, due: state.qa.due || recurrenceImpliedDue(), time: state.qa.time, priority: state.qa.priority, recurrence: state.qa.recurrence };
    var links = (state.qaLinks || []).slice();
    $('taskInput').value = ''; if ($('qaLinkMenu')) $('qaLinkMenu').classList.add('hidden');
    resetQa(); syncQa(); updateQaLinkLabel();
    var res = await API.addTask(state.wsId, payload);
    applyTaskResult(res);
    // Link the just-created task into any workspaces picked in the 🔗 dropdown.
    if (links.length && res && res.task && res.task.id) {
      try { res = await API.shareTask(res.task.id, links); applyTaskResult(res); }
      catch (_e) { /* task was still created; sharing is best-effort */ }
    }
    announceNewTask(res && res.task);
  }

  // A new task usually lands lower in the list (sorted by date/priority), where a
  // capped-height scroll box can hide it. Scroll it into view, flash it, and show a
  // brief toast that says where it went — so adding a task always gives feedback.
  var miniToastTimer = null;
  function showMiniToast(msg) {
    var t = $('miniToast');
    if (!t) { t = document.createElement('div'); t.id = 'miniToast'; t.className = 'mini-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    // restart the enter transition even on rapid repeats
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(miniToastTimer);
    miniToastTimer = setTimeout(function () { t.classList.remove('show'); }, 1900);
  }
  function announceNewTask(task) {
    if (!task || !task.id) return;
    requestAnimationFrame(function () {
      var el = document.querySelector('#noteView .task[data-id="' + task.id + '"]');
      if (el) {
        try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_e) { el.scrollIntoView(); }
        el.classList.remove('task-flash'); void el.offsetWidth; el.classList.add('task-flash');
        setTimeout(function () { el.classList.remove('task-flash'); }, 1300);
      }
    });
    var where = !task.due ? 'no date' : (task.due <= todayStr() ? 'Overdue & Today' : ('due ' + fmtDueShort(task.due)));
    showMiniToast('✓ Task added · ' + where);
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

  // Editable display date: click the date to reveal a picker. Changing it re-dates
  // the note for display/grouping only — its place in the carry-forward chain
  // (keyed on creation order) is untouched.
  function showDateEditor() {
    if (!state.note) return;
    if (/^\d{4}-\d{2}-\d{2}$/.test(state.note.title || '')) $('noteDateInput').value = state.note.title;
    $('noteDate').classList.add('hidden');
    $('noteDateInput').classList.remove('hidden');
    $('noteDateInput').focus();
    if ($('noteDateInput').showPicker) { try { $('noteDateInput').showPicker(); } catch (_e) {} }
  }
  function hideDateEditor() { $('noteDateInput').classList.add('hidden'); $('noteDate').classList.remove('hidden'); }
  var committingDate = false;
  async function commitNoteDate() {
    var d = $('noteDateInput').value;
    if (committingDate) return;
    if (!state.note || !d || d === state.note.title) { hideDateEditor(); return; }
    committingDate = true;
    setSaveStatus('Saving…');
    try {
      var saved = await API.saveNote(state.note.id, { date: d });
      state.note.title = saved.title; state.note.updatedAt = saved.updatedAt; state.note.rev = saved.rev;
      $('noteDate').textContent = saved.title;
      setSaveStatus('Saved ✓'); renderNoteList();
    } catch (ex) { setSaveStatus('Date change failed: ' + ex.message); }
    committingDate = false;
    hideDateEditor();
  }
  $('noteDate').addEventListener('click', showDateEditor);
  $('noteDateInput').addEventListener('change', commitNoteDate);
  $('noteDateInput').addEventListener('blur', commitNoteDate);
  $('noteDateInput').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); hideDateEditor(); } });
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
    // Don't silently make a second daily note for a day you already have — it'd
    // carry the same thread forward twice. Offer to open the existing one first.
    // (Scratch notes are always fresh; a chosen template is a deliberate new note.)
    if (!opts.scratch && !opts.templateId) {
      var existing = null;
      try {
        var today = todayStr();
        existing = (await API.listNotes(wsId, { sort: 'created', dir: 'desc' }) || [])
          .filter(function (n) { return (n.kind || 'daily') !== 'scratch' && typeof n.title === 'string' && n.title >= today; })
          .sort(function (a, b) { return a.title < b.title ? -1 : a.title > b.title ? 1 : 0; })[0];
      } catch (_e) { existing = null; }
      if (existing) {
        var when = existing.title === todayStr() ? 'today' : 'dated ' + existing.title;
        var choice = await dialog.choose(
          'You already have a daily note ' + when + '. Open it instead of starting another?',
          [
            { label: 'Open it', returns: 'open', primary: true },
            { label: 'Create another', returns: 'create' },
            { label: 'Cancel', returns: null },
          ], { title: 'Daily note already exists', cancelValue: null });
        if (choice === null) return;
        if (choice === 'open') { state.wsId = wsId; $('workspaceSelect').value = wsId; await openNote(existing.id); return; }
      }
    }
    state.note = await API.newNote(wsId, payload);
    state.wsId = wsId; $('workspaceSelect').value = wsId;
    showView('note'); renderNote();
    await Promise.all([renderNoteList(), loadTasks()]);
  }

  // Prompt for a target workspace; resolves to a workspace id or null if cancelled.
  async function pickWorkspace(message, excludeId) {
    var items = state.workspaces
      .filter(function (w) { return w.id !== excludeId; })
      .map(function (w) { return { label: w.name, value: w.id, current: w.id === state.wsId }; });
    return showListPicker({
      title: 'Move to workspace', message: message, items: items,
      searchPlaceholder: 'Filter workspaces…', cancelValue: null,
    });
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

  // ---- Durable save queue: never silently drop edits on a flaky/offline network ----
  // A failed save (network down, server 5xx) parks the note payload in localStorage
  // and keeps retrying — on reconnect, on an interval, when the tab becomes visible,
  // and warns via beforeunload while anything is still unsynced. Survives reloads.
  var PENDING_KEY = 'cove.pendingSaves';
  var flushTimer = null;
  function loadPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}'); } catch (_e) { return {}; } }
  function writePending(map) {
    try {
      if (map && Object.keys(map).length) localStorage.setItem(PENDING_KEY, JSON.stringify(map));
      else localStorage.removeItem(PENDING_KEY);
    } catch (_e) { /* storage full / disabled — best effort */ }
  }
  function queuePending(id, payload) { var m = loadPending(); m[id] = payload; writePending(m); }
  function clearPending(id) { var m = loadPending(); if (m[id]) { delete m[id]; writePending(m); } }
  function hasPending() { return Object.keys(loadPending()).length > 0; }
  function isTransient(ex) { return !ex.status || ex.status >= 500; } // offline or server hiccup — retriable
  function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flushPending, ms || 8000); }

  async function flushPending() {
    clearTimeout(flushTimer); flushTimer = null;
    if (navigator.onLine === false) return; // wait for the 'online' event
    if (!hasPending()) return;
    // The active note (if queued) goes through saveNow so conflicts get the full UI
    // and the freshest in-memory edits win.
    if (state.note && loadPending()[state.note.id]) { await saveNow(); }
    // Any other parked notes (user navigated away before reconnecting): push them
    // directly, and on a conflict fork to a copy so nothing is lost.
    var m = loadPending();
    var ids = Object.keys(m).filter(function (id) { return !state.note || id !== state.note.id; });
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      try { await API.saveNote(id, m[id]); clearPending(id); }
      catch (ex) {
        if (ex.status === 409) { try { await API.forkNote(id, m[id]); } catch (_e) {} clearPending(id); }
        else if (isTransient(ex)) { scheduleFlush(); return; }
        else { clearPending(id); }
      }
    }
    if (hasPending()) scheduleFlush();
  }

  async function saveNow() {
    if (!state.note) return;
    var payload = {
      customTitle: state.note.customTitle, todos: state.note.todos, carryover: state.note.carryover,
      meetingNotes: state.note.meetingNotes, favorite: state.note.favorite,
      tags: state.note.tags, transcript: state.note.transcript, baseRev: state.note.rev,
    };
    try {
      var saved = await API.saveNote(state.note.id, payload);
      state.note.todos = saved.todos; state.note.updatedAt = saved.updatedAt; state.note.rev = saved.rev;
      state.lastSaveAt = Date.now(); // suppress the live-sync echo of our own write
      clearPending(state.note.id);
      cacheNoteForOffline(state.note);
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
      } else if (isTransient(ex)) {
        // Offline or server unreachable — park the edit and keep trying; don't lose it.
        queuePending(state.note.id, payload);
        setSaveStatus('Offline — save pending ⏳');
        scheduleFlush(4000);
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
        { key: 'carryover', label: 'Ongoing Notes', rich: true },
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
  window.addEventListener('beforeunload', function (e) {
    if (state.saveTimer) saveNow();
    // If a save couldn't reach the server, edits are safe in localStorage but not yet
    // synced — warn so the user knows to reconnect before relying on another device.
    if (hasPending()) { e.preventDefault(); e.returnValue = ''; return ''; }
  });
  // Retry parked saves whenever we plausibly regain connectivity.
  window.addEventListener('online', function () { flushPending(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && hasPending()) flushPending();
  });
  setInterval(function () { if (hasPending()) flushPending(); }, 15000);

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
  $('navTodos').addEventListener('click', openTasksPage);
  $('tasksTabOpen').addEventListener('click', function () { setTasksTab('open'); });
  $('tasksTabDone').addEventListener('click', function () { setTasksTab('completed'); });
  $('doneSearch').addEventListener('input', applyDoneFilters);
  $('doneWs').addEventListener('change', applyDoneFilters);
  $('donePrio').addEventListener('change', applyDoneFilters);
  $('doneRange').addEventListener('change', renderCompletedTasks);
  $('doneFrom').addEventListener('change', function () { if ($('doneRange').value === 'custom') renderCompletedTasks(); });
  $('doneTo').addEventListener('change', function () { if ($('doneRange').value === 'custom') renderCompletedTasks(); });
  $('doneClear').addEventListener('click', function () {
    $('doneSearch').value = ''; $('doneWs').value = ''; $('donePrio').value = '';
    applyDoneFilters();
  });
  $('navFavs').addEventListener('click', renderFavorites);

  function openWorkspace(wsId) {
    state.wsId = wsId; $('workspaceSelect').value = wsId; showView('note'); loadCurrentNote();
  }

  // Global Tasks page: every open task across workspaces, grouped by due date
  // (overdue dates first, then today, then upcoming, then undated), and within
  // each date sorted by priority then workspace. This replaces the old Agenda.
  // ---- Tasks page: Open / Completed tabs ----
  function openTasksPage() { showView('todos'); setTasksTab(state.tasksTab || 'open'); }
  function setTasksTab(tab) {
    state.tasksTab = tab;
    var isOpen = tab !== 'completed';
    $('tasksTabOpen').classList.toggle('active', isOpen);
    $('tasksTabOpen').setAttribute('aria-selected', String(isOpen));
    $('tasksTabDone').classList.toggle('active', !isOpen);
    $('tasksTabDone').setAttribute('aria-selected', String(!isOpen));
    $('tasksOpenPane').classList.toggle('hidden', !isOpen);
    $('tasksDonePane').classList.toggle('hidden', isOpen);
    if (isOpen) renderGlobalTasksList(); else renderCompletedTasks();
  }
  // Refresh whichever Tasks tab is showing (after a complete/move/reopen).
  function refreshActiveTasks() { if (state.view === 'todos') { if (state.tasksTab === 'completed') renderCompletedTasks(); else renderGlobalTasksList(); } }

  async function renderGlobalTasksList() {
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
      refreshActiveTasks();
    });
    var main = document.createElement('div'); main.className = 'task-main';
    var line = document.createElement('div'); line.className = 'gt-line';
    var text = document.createElement('span'); text.className = 'task-text'; text.textContent = t.text;
    appendWsLabels(line, t); line.appendChild(text); main.appendChild(line);
    var meta = document.createElement('div'); meta.className = 'task-meta';
    if (t.time) { var tm = document.createElement('span'); tm.className = 'task-recur'; tm.textContent = '🕑 ' + t.time; meta.appendChild(tm); }
    if (t.recurrence) { var rc = document.createElement('span'); rc.className = 'task-recur'; rc.textContent = '🔁 ' + recurLabel(t.recurrence); meta.appendChild(rc); }
    if (t.sourceInbox) { var ib = document.createElement('span'); ib.className = 'inbox-badge'; ib.textContent = '📥'; ib.title = 'From your inbox'; meta.appendChild(ib); }
    if (meta.childNodes.length) main.appendChild(meta);
    li.appendChild(cb); li.appendChild(main);
    if ((state.workspaces || []).length > 1) {
      var actions = document.createElement('div'); actions.className = 'task-actions';
      var mv = document.createElement('button'); mv.className = 'task-act'; mv.title = 'Move to another workspace'; mv.textContent = '➜';
      mv.addEventListener('click', async function () {
        var dest = await pickWorkspace('Move “' + t.text + '” from ' + t.workspaceName + ' to which workspace?', t.workspaceId);
        if (!dest || dest === t.workspaceId) return;
        try {
          await moveTaskTo(t.id, dest);
          if (t.workspaceId === state.wsId || dest === state.wsId) await loadTasks();
          refreshActiveTasks();
        } catch (ex) { await handleMoveError(ex); }
      });
      actions.appendChild(mv); li.appendChild(actions);
    }
    return li;
  }

  // ---- Completed tasks (history) ----
  // Translate the range preset into inclusive from/to dates (by completion day).
  function doneRangeDates(preset) {
    var today = todayStr();
    if (preset === 'all') return { from: '', to: '' };
    if (preset === 'month') return { from: today.slice(0, 8) + '01', to: today };
    if (preset === 'year') return { from: today.slice(0, 4) + '-01-01', to: today };
    if (preset === 'custom') return { from: $('doneFrom').value || '', to: $('doneTo').value || '' };
    var n = parseInt(preset, 10) || 30;
    return { from: addDaysStr(today, -(n - 1)), to: today };
  }
  function populateDoneWsFilter() {
    var sel = $('doneWs'); var cur = sel.value;
    sel.innerHTML = '<option value="">All workspaces</option>';
    (state.workspaces || []).forEach(function (w) {
      var o = document.createElement('option'); o.value = w.id; o.textContent = w.name; sel.appendChild(o);
    });
    sel.value = cur;
  }
  // Fetch the completed set for the chosen date range (server-bounded), then hand
  // off to the live client-side filters. Only re-fetches when the range changes.
  async function renderCompletedTasks() {
    populateDoneWsFilter();
    var preset = $('doneRange').value;
    $('doneCustom').classList.toggle('hidden', preset !== 'custom');
    var range = doneRangeDates(preset);
    var box = $('completedTaskList');
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      state.doneItems = await API.completedTasks({ from: range.from, to: range.to });
    } catch (ex) {
      state.doneItems = [];
      // A 404 / "not found" here means the running server predates this endpoint
      // (routes load at startup) — the page updated but the server didn't. Say so.
      var stale = ex && (ex.status === 404 || /not found/i.test(ex.message || ''));
      box.innerHTML = stale
        ? '<p class="muted">The Cove server is running an older version than this page, so it doesn’t have the completed-tasks endpoint yet. Restart it — <code>scripts/restart.sh</code> (or <code>./stop.sh</code> then <code>./start.sh</code>) — and reload.</p>'
        : '<p class="muted">Couldn’t load completed tasks: ' + esc((ex && ex.message) || 'error') + '</p>';
      return;
    }
    applyDoneFilters();
  }
  function applyDoneFilters() {
    var items = state.doneItems || [];
    var q = ($('doneSearch').value || '').trim().toLowerCase();
    var ws = $('doneWs').value;
    var prio = $('donePrio').value;
    var filtered = items.filter(function (t) {
      if (ws && t.workspaceId !== ws) return false;
      if (prio && String(t.priority) !== prio) return false;
      if (q && (t.text + ' ' + (t.workspaceName || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var hasFilter = !!(q || ws || prio);
    $('doneClear').classList.toggle('hidden', !hasFilter);
    $('doneCount').textContent = filtered.length + (filtered.length === 1 ? ' completed task' : ' completed tasks')
      + (hasFilter ? ' (of ' + items.length + ' in range)' : '');
    renderCompletedList(filtered);
  }
  function fmtDoneDay(iso) {
    if (iso === todayStr()) return 'Today';
    if (iso === addDaysStr(todayStr(), -1)) return 'Yesterday';
    try {
      var opts = { weekday: 'short', month: 'short', day: 'numeric' };
      if (iso.slice(0, 4) !== todayStr().slice(0, 4)) opts.year = 'numeric';
      return new Date(iso + 'T00:00:00').toLocaleDateString([], opts);
    } catch (e) { return iso; }
  }
  function fmtDoneTime(isoTs) {
    try { return new Date(isoTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function renderCompletedList(items) {
    var box = $('completedTaskList'); box.innerHTML = '';
    if (!items.length) { box.innerHTML = '<p class="muted">No completed tasks match.</p>'; return; }
    // `items` is already newest-first, so day keys appear in descending order.
    var groups = {}; var order = [];
    items.forEach(function (t) {
      var day = String(t.completedAt).slice(0, 10);
      if (!groups[day]) { groups[day] = []; order.push(day); }
      groups[day].push(t);
    });
    order.forEach(function (day) {
      var sec = document.createElement('div'); sec.className = 'task-group';
      var lab = document.createElement('div'); lab.className = 'upcoming-date';
      lab.textContent = fmtDoneDay(day) + ' · ' + groups[day].length;
      sec.appendChild(lab);
      var ul = document.createElement('ul'); ul.className = 'task-list';
      groups[day].forEach(function (t) { ul.appendChild(completedTaskRow(t)); });
      sec.appendChild(ul); box.appendChild(sec);
    });
  }
  // Workspace label chip(s) for a global/completed task row: the owning
  // workspace, then a "🔗 name" chip for every workspace the task is linked into.
  function wsLabelChip(name, wsId, linked) {
    var b = document.createElement('button');
    b.className = 'gt-ws' + (linked ? ' gt-ws-linked' : '');
    b.textContent = (linked ? '🔗 ' : '') + name;
    b.title = 'Open ' + name + (linked ? ' (linked here)' : '');
    b.addEventListener('click', function () { openWorkspace(wsId); });
    return b;
  }
  function appendWsLabels(line, t) {
    line.appendChild(wsLabelChip(t.workspaceName, t.workspaceId, false));
    (t.sharedNames || []).forEach(function (s) { line.appendChild(wsLabelChip(s.name, s.id, true)); });
  }
  function completedTaskRow(t) {
    var li = document.createElement('li'); li.className = 'task done prio-p' + t.priority;
    var cb = document.createElement('button'); cb.className = 'task-check checked';
    cb.title = 'Reopen this task'; cb.setAttribute('aria-label', 'Reopen task');
    cb.addEventListener('click', async function () {
      li.classList.add('checking');
      try { await API.updateTask(t.id, { done: false, workspaceId: t.workspaceId }); }
      catch (ex) { li.classList.remove('checking'); return dialog.alert('Couldn’t reopen: ' + ((ex && ex.message) || 'error')); }
      setSaveStatus('Reopened ✓');
      state.doneItems = (state.doneItems || []).filter(function (x) { return x.id !== t.id; });
      if (t.workspaceId === state.wsId) loadTasks();
      applyDoneFilters();
    });
    var main = document.createElement('div'); main.className = 'task-main';
    var line = document.createElement('div'); line.className = 'gt-line';
    var text = document.createElement('span'); text.className = 'task-text'; text.textContent = t.text;
    appendWsLabels(line, t); line.appendChild(text); main.appendChild(line);
    var meta = document.createElement('div'); meta.className = 'task-meta';
    var done = document.createElement('span'); done.className = 'task-recur'; done.textContent = '✓ ' + fmtDoneTime(t.completedAt); meta.appendChild(done);
    if (t.due) { var du = document.createElement('span'); du.className = 'task-due'; du.textContent = '📅 was due ' + fmtDueShort(t.due); meta.appendChild(du); }
    if (t.sourceInbox) { var ib = document.createElement('span'); ib.className = 'inbox-badge'; ib.textContent = '📥'; ib.title = 'From your inbox'; meta.appendChild(ib); }
    main.appendChild(meta);
    li.appendChild(cb); li.appendChild(main);
    var actions = document.createElement('div'); actions.className = 'task-actions';
    var del = document.createElement('button'); del.className = 'task-act task-del'; del.title = 'Delete permanently'; del.textContent = '✕';
    del.addEventListener('click', async function () {
      if (!(await dialog.confirm('Delete this completed task permanently?', { okText: 'Delete', danger: true }))) return;
      try { await API.deleteTask(t.id); } catch (ex) { return dialog.alert('Couldn’t delete: ' + ((ex && ex.message) || 'error')); }
      state.doneItems = (state.doneItems || []).filter(function (x) { return x.id !== t.id; });
      applyDoneFilters();
    });
    actions.appendChild(del); li.appendChild(actions);
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
    { t: '📅 Daily notes carry forward', h: 'Hit <b>＋ New Daily</b> and your <b>Ongoing</b> notes come forward from the last daily note — a running thread per workspace. <b>New scratch note</b> is a clean page that doesn’t affect the thread.' },
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
    $('instanceInfo').innerHTML = '<b>' + esc(inst.name || 'Cove') + '</b> · server v' + esc(inst.version || '') + ' · app build ' + esc(APP_BUILD) +
      (scriptsOutOfSync()
        ? '<br><span class="warn">⚠ editor.js is cached at build ' + esc(editorBuild()) + ' — click <b>Force refresh</b> to clear cached scripts.</span> <button type="button" id="forceRefreshBtn" class="btn-sm">Force refresh</button>'
        : '') +
      '<br>URL: <code>' + esc(inst.url || location.origin) + '</code>' +
      (inst.domain ? '' : '<br><span class="muted">Tip: run <code>node server.js --set-domain notes</code> for a durable &lt;name&gt;.localhost address.</span>');
    if ($('forceRefreshBtn')) $('forceRefreshBtn').addEventListener('click', function () { hardReload(); });
    $('fontSize').value = state.settings.fontSize || 14;
    $('ocrEnabled').checked = state.settings.ocrEnabled !== false;
    $('dailyNudgeDelay').value = String(dailyNudgeSeconds());
    $('stickyEnabled').checked = stickyEnabled();
    $('idleLock').value = String(state.settings.idleLockMinutes != null ? state.settings.idleLockMinutes : IDLE_DEFAULT_MIN);
    var ttlDefault = (state.instance && state.instance.sessionTtlDefaultMin) || 240;
    $('sessionTtl').value = String(state.settings.sessionTtlMinutes != null ? state.settings.sessionTtlMinutes : ttlDefault);
    var tc = state.settings.transcription || {};
    $('sttEndpoint').value = tc.endpoint || ''; $('sttKey').value = tc.apiKey || ''; $('sttModel').value = tc.model || '';
    updateSttWarn();
    var sc = state.settings.summary || {};
    $('sumEndpoint').value = sc.endpoint || ''; $('sumKey').value = sc.apiKey || ''; $('sumModel').value = sc.model || '';
    updateSumWarn();
    $('tzInput').value = state.settings.timezone || '';
    $('tzMsg').textContent = '';
    $('completedKeep').value = String(state.settings.completedKeep || 0);
    $('offlineCache').checked = offlineCacheEnabled();
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
    var hostOk = bioHostOk();
    var enrolled = !!(state.bio && state.bio.enrolled);
    $('bioStatus').textContent = !supported
      ? 'Not supported in this browser.'
      : !hostOk
        ? 'Passkeys need a hostname, not an IP. Open Cove at localhost:' + (location.port || '3000') + ' or a cove.localhost address — biometric unlock can’t work on 127.0.0.1.'
        : enrolled ? ('Enabled — ' + (((state.bio.credentials || [])[0] || {}).label || 'this device') + '.') : 'Not enabled on this device.';
    $('bioEnableBtn').classList.toggle('hidden', !supported || !hostOk || enrolled);
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
    } catch (ex) {
      console.error('[bio] enroll failed:', ex && ex.name, ex && ex.message, ex);
      bioMsg(ex.message, true);
    } finally { $('bioEnableBtn').disabled = false; }
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

  // AI meeting summary (opt-in) — same pattern as transcription: key stays server-side.
  function updateSumWarn() {
    var ep = $('sumEndpoint').value.trim();
    $('sumWarn').textContent = (ep && !isLocalEndpoint(ep))
      ? '⚠ This is an external endpoint — your meeting notes & transcript will be sent there to summarize.'
      : '';
  }
  $('sumEndpoint').addEventListener('input', updateSumWarn);
  $('sumLocalBtn').addEventListener('click', function () {
    $('sumEndpoint').value = 'http://127.0.0.1:1234/v1/chat/completions';
    $('sumKey').value = '';
    if (!$('sumModel').value.trim()) $('sumModel').value = 'gpt-4o-mini';
    updateSumWarn();
  });
  $('saveSumBtn').addEventListener('click', async function () {
    state.settings.summary = { endpoint: $('sumEndpoint').value.trim(), apiKey: $('sumKey').value, model: $('sumModel').value.trim() || 'gpt-4o-mini' };
    await API.saveSettings({ summary: state.settings.summary });
    updateSummaryAvailability();
    acctMsg('Summary settings saved ✓', false);
  });

  // ---------------- Time zone ----------------
  function tzMsg(s, isErr) { var el = $('tzMsg'); el.textContent = s; el.style.color = isErr ? 'var(--danger)' : 'var(--muted)'; }
  $('tzDeviceBtn').addEventListener('click', function () {
    try { $('tzInput').value = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_e) {}
    tzMsg('', false);
  });
  $('tzSaveBtn').addEventListener('click', async function () {
    var tz = $('tzInput').value.trim();
    // Validate locally first so the user gets instant feedback (the server also checks).
    if (tz) { try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch (_e) { tzMsg('That isn’t a valid time zone name.', true); return; } }
    try {
      await API.saveSettings({ timezone: tz });
      state.settings.timezone = tz;
      tzMsg(tz ? ('Saved — dates now follow ' + tz + ' ✓') : 'Cleared — using the server’s local time ✓', false);
    } catch (ex) { tzMsg(ex.message || 'Could not save time zone', true); }
  });

  // ---------------- AI meeting summary ----------------
  function hasSummaryEndpoint() { return !!((state.settings.summary || {}).endpoint); }
  function updateSummaryAvailability() {
    var btn = $('summarizeBtn');
    if (btn) btn.classList.toggle('hidden', !hasSummaryEndpoint());
  }
  // Build the plain-text context to summarize: the meeting notes plus any transcript.
  function gatherMeetingText() {
    var parts = [];
    var notes = ($('meetingEditor').innerText || '').trim();
    if (notes) parts.push('=== Notes ===\n' + notes);
    var lines = (state.note && state.note.transcript || []).slice().sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
    if (lines.length) {
      parts.push('=== Transcript ===\n' + lines.map(function (l) {
        return (l.source === 'them' ? 'Them: ' : 'You: ') + (l.text || '');
      }).join('\n'));
    }
    return parts.join('\n\n');
  }
  $('summarizeBtn').addEventListener('click', async function () {
    if (!state.note) return;
    var text = gatherMeetingText();
    if (!text) { await dialog.alert('There are no meeting notes or transcript to summarize yet.'); return; }
    $('summaryBody').innerHTML = ''; $('summaryActions').innerHTML = '';
    $('summaryActionsWrap').classList.add('hidden');
    $('insertSummaryBtn').classList.add('hidden'); $('addAllActionsBtn').classList.add('hidden');
    $('summaryStatus').textContent = 'Summarizing…';
    openModal('summaryModal');
    try {
      var res = await API.summarize(text, ($('noteCustomTitle').value || (state.note && state.note.title) || '').trim());
      renderSummary(res);
    } catch (ex) {
      $('summaryStatus').textContent = 'Summary failed: ' + ex.message;
    }
  });
  function renderSummary(res) {
    res = res || {};
    $('summaryStatus').textContent = '';
    var body = $('summaryBody');
    body.textContent = res.summary || '(no summary returned)';
    var items = res.actionItems || [];
    var ul = $('summaryActions'); ul.innerHTML = '';
    if (items.length) {
      $('summaryActionsWrap').classList.remove('hidden');
      items.forEach(function (it) { ul.appendChild(actionItemRow(it)); });
      $('addAllActionsBtn').classList.remove('hidden');
    } else {
      $('summaryActionsWrap').classList.add('hidden');
      $('addAllActionsBtn').classList.add('hidden');
    }
    $('insertSummaryBtn').classList.toggle('hidden', !res.summary);
  }
  function actionItemRow(it) {
    var li = document.createElement('li');
    li.className = 'summary-action';
    var label = document.createElement('span');
    label.className = 'sa-text';
    label.textContent = it.text + (it.due ? ('  (' + it.due + ')') : '');
    var add = document.createElement('button');
    add.className = 'sm'; add.textContent = '＋ Add task';
    add.addEventListener('click', async function () {
      add.disabled = true;
      try { await addActionItemTask(it); add.textContent = '✓ Added'; }
      catch (ex) { add.disabled = false; await dialog.alert('Could not add task: ' + ex.message); }
    });
    li.appendChild(label); li.appendChild(add);
    return li;
  }
  // Turn an action item into a task, letting the NL parser pick up any inline date
  // (and honoring an explicit "due" field the model returned).
  async function addActionItemTask(it) {
    var raw = it.text + (it.due ? (' ' + it.due) : '');
    var p = window.TaskParse ? window.TaskParse.parse(raw) : { text: raw, priority: 4 };
    applyTaskResult(await API.addTask(state.wsId, {
      text: p.text || it.text, due: p.due, time: p.time, priority: p.priority, recurrence: p.recurrence,
    }));
  }
  $('addAllActionsBtn').addEventListener('click', async function () {
    var btn = this; btn.disabled = true;
    var rows = $('summaryActions').querySelectorAll('.summary-action button');
    for (var i = 0; i < rows.length; i++) { if (!rows[i].disabled) rows[i].click(); }
    setTimeout(function () { btn.textContent = '✓ Added all'; }, 300);
  });
  $('insertSummaryBtn').addEventListener('click', function () {
    var summary = $('summaryBody').textContent || '';
    if (!summary) return;
    var html = '<p><b>Summary</b></p><p>' + esc(summary).replace(/\n/g, '<br>') + '</p>';
    $('meetingEditor').innerHTML = html + $('meetingEditor').innerHTML;
    state.note.meetingNotes = $('meetingEditor').innerHTML;
    scheduleSave();
    closeModals();
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
  $('idleLock').addEventListener('change', function () {
    state.settings.idleLockMinutes = parseInt($('idleLock').value, 10) || 0;
    API.saveSettings({ idleLockMinutes: state.settings.idleLockMinutes });
    resetIdle(); // apply the new timeout immediately
  });
  $('sessionTtl').addEventListener('change', function () {
    state.settings.sessionTtlMinutes = parseInt($('sessionTtl').value, 10) || 240;
    API.saveSettings({ sessionTtlMinutes: state.settings.sessionTtlMinutes });
  });
  $('offlineCache').addEventListener('change', function () {
    var on = $('offlineCache').checked;
    state.settings.offlineCache = on;
    API.saveSettings({ offlineCache: on });
    setOfflineFlag(on);
    if (on) cacheNoteForOffline(state.note); // seed with the current note right away
    else clearNoteCache();                   // turning off clears the stored copies
  });
  $('dailyNudgeDelay').addEventListener('change', function () {
    state.settings.dailyNudgeSeconds = parseInt($('dailyNudgeDelay').value, 10) || 0;
    API.saveSettings({ dailyNudgeSeconds: state.settings.dailyNudgeSeconds });
    dailyNudge.forNoteId = null; armDailyNudge(); // re-arm the current note with the new delay
  });
  if ($('stickyEnabled')) $('stickyEnabled').addEventListener('change', function () {
    state.settings.stickyEnabled = $('stickyEnabled').checked;
    API.saveSettings({ stickyEnabled: state.settings.stickyEnabled });
    if (state.settings.stickyEnabled) { setStickyCollapsed(false); applyStickyVisibility(); } else applyStickyVisibility();
  });
  if ($('dailyNudgeTest')) $('dailyNudgeTest').addEventListener('click', async function () {
    // Force-show the banner now (bypassing the once-a-day + "already have today's
    // daily" guards) so the reminder can be verified on demand, and explain what
    // the automatic rule would have decided — the usual reason it "doesn't show"
    // is simply that today's daily already exists or it already fired today.
    var msg = $('dailyNudgeTestMsg');
    closeModals();
    if (!state.note) { try { await loadCurrentNote(); } catch (_e) {} }
    showView('note');
    var el = $('dailyNudge');
    el.classList.remove('hidden');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    if (!msg) return;
    try {
      var today = todayStr();
      var notes = await API.listNotes(state.wsId, { sort: 'created', dir: 'desc' });
      var dailies = (notes || []).filter(function (x) { return (x.kind || 'daily') !== 'scratch'; });
      var hasToday = dailies.some(function (x) { return x.title === today; });
      var why = 'Shown above. ';
      if (dailyNudgeDelayMs() <= 0) why += 'Note: the reminder is set to “Never”, so it won’t appear on its own.';
      else if (!dailies.length) why += 'Automatically it appears once you have at least one daily note here.';
      else if (hasToday) why += 'Automatically it stays hidden right now because today’s daily (' + today + ') already exists.';
      else if (dailyNudgeShownToday()) why += 'Automatically it already fired once today (it shows at most once a day per device).';
      else why += 'Automatically it will appear ' + $('dailyNudgeDelay').selectedOptions[0].textContent.toLowerCase() + ' after you open an older note.';
      msg.textContent = why;
    } catch (_e) { msg.textContent = 'Shown above.'; }
  });
  $('completedKeep').addEventListener('change', function () {
    state.settings.completedKeep = parseInt($('completedKeep').value, 10) || 0;
    API.saveSettings({ completedKeep: state.settings.completedKeep });
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
  var MODALS = ['wsModal', 'importModal', 'templateModal', 'accountModal', 'backupModal', 'moveModal', 'recoveryModal', 'historyModal', 'notePickerModal', 'conflictModal', 'conflictLogModal', 'tourModal', 'summaryModal'];
  var modalReturnFocus = null;
  // Visible, tabbable elements inside a container — for the focus trap / initial focus.
  function focusablesIn(el) {
    var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.slice.call(el.querySelectorAll(sel)).filter(function (n) { return n.offsetParent !== null; });
  }
  function currentModalEl() {
    for (var i = 0; i < MODALS.length; i++) { var el = $(MODALS[i]); if (el && !el.classList.contains('hidden')) return el; }
    return null;
  }
  function openModal(id) {
    modalReturnFocus = document.activeElement;
    $('modalBackdrop').classList.remove('hidden');
    MODALS.forEach(function (m) { $(m).classList.toggle('hidden', m !== id); });
    // Mark it up as a dialog and label it by its heading for screen readers.
    var el = $(id);
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    var h = el.querySelector('h3, h2');
    if (h) { if (!h.id) h.id = id + 'Title'; el.setAttribute('aria-labelledby', h.id); }
    // Move focus into the dialog so keyboard + screen-reader users land inside it.
    setTimeout(function () { var f = focusablesIn(el); if (f.length) f[0].focus(); }, 0);
  }
  function closeModals() {
    var recoveryWasOpen = !$('recoveryModal').classList.contains('hidden');
    $('modalBackdrop').classList.add('hidden');
    MODALS.forEach(function (m) { $(m).classList.add('hidden'); });
    // Return focus to whatever opened the modal (keyboard users don't lose their place).
    if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') { try { modalReturnFocus.focus(); } catch (_e) { /* element gone */ } }
    modalReturnFocus = null;
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
    // Trap Tab within an open modal so focus can't escape to the page behind it.
    if (e.key === 'Tab') {
      var mel = currentModalEl();
      if (mel) {
        var f = focusablesIn(mel);
        if (f.length) {
          var first = f[0], last = f[f.length - 1];
          if (!mel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
          else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
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
  function startReminderPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    pollInbox();
    state.pollTimer = setInterval(pollInbox, 60 * 1000);
  }
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
  function resetIdle() { clearTimeout(idleTimer); var ms = idleMs(); if (ms > 0) idleTimer = setTimeout(lockNow, ms); }
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
      if (e.key === 't') { e.preventDefault(); openTasksPage(); return; }
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
