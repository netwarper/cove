/* Standalone offline notes viewer (read-only). Decrypts window.MN_DATA on the
 * device with the passphrase (or recovery key). No network, no server. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var D = window.MNDecrypt;
  var DATA = window.MN_DATA || {};
  var state = { notes: [], wsNames: {}, images: {}, filter: 'all', query: '' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Minimal HTML sanitizer for rendering note content read-only.
  function sanitize(html) {
    return String(html || '')
      .replace(/<\s*(script|style|iframe|object|embed|link|meta)[\s\S]*?<\/\s*\1\s*>/gi, '')
      .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '').replace(/\son\w+\s*=\s*'[^']*'/gi, '').replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
      .replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"');
  }
  // Rewrite attachment image URLs to the decrypted object URLs we built on unlock.
  function withImages(html, noteId) {
    return String(html || '').replace(/\/api\/notes\/([A-Za-z0-9_-]+)\/attachments\/([A-Za-z0-9_-]+)/g, function (m, nid, aid) {
      var key = nid + '/' + aid;
      return state.images[key] || m;
    });
  }
  function displayTitle(n) { return n.customTitle ? (n.title + ' — ' + n.customTitle) : n.title; }
  function stripHtml(h) { return String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

  // ---- unlock ----
  $('unlockForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var errEl = $('err'); errEl.textContent = '';
    var secret = $('secret').value;
    if (!secret) return;
    $('unlockBtn').disabled = true; $('unlockBtn').textContent = 'Unlocking…';
    try {
      var dek = null;
      try { dek = await D.unwrapDEK(DATA.vault.passphrase, secret, DATA.scrypt); }
      catch (e1) {
        if (DATA.vault.recovery) { try { dek = await D.unwrapDEK(DATA.vault.recovery, D.normalizeRecoveryKey(secret), DATA.scrypt); } catch (e2) { dek = null; } }
      }
      if (!dek) throw new Error('Incorrect passphrase or recovery key.');
      await unlock(dek);
    } catch (ex) {
      errEl.textContent = ex.message;
      $('unlockBtn').disabled = false; $('unlockBtn').textContent = 'Unlock';
    }
  });

  async function unlock(dek) {
    // workspace names (from encrypted index)
    try { var idx = await D.decryptJSON(dek, DATA.index); (idx.workspaces || []).forEach(function (w) { state.wsNames[w.id] = w.name; }); } catch (e) { /* ignore */ }
    // decrypt notes
    var notes = [];
    for (var i = 0; i < (DATA.notes || []).length; i++) {
      try { var n = await D.decryptJSON(dek, DATA.notes[i].b64); n._ws = DATA.notes[i].ws; notes.push(n); } catch (e) { /* skip unreadable */ }
    }
    notes.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    state.notes = notes;
    // decrypt image attachments -> object URLs
    var imgs = DATA.images || {};
    for (var key in imgs) {
      if (!imgs.hasOwnProperty(key)) continue;
      try {
        var bytes = await D.decryptBytes(dek, imgs[key].b64);
        var url = URL.createObjectURL(new Blob([bytes], { type: imgs[key].mime || 'image/png' }));
        state.images[key] = url;
      } catch (e) { /* skip */ }
    }
    // build workspace filter
    var sel = $('wsFilter'); sel.innerHTML = '<option value="all">All workspaces</option>';
    Object.keys(state.wsNames).forEach(function (id) { var o = document.createElement('option'); o.value = id; o.textContent = state.wsNames[id]; sel.appendChild(o); });

    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('stamp').textContent = 'Snapshot from ' + (DATA.generatedAt ? new Date(DATA.generatedAt).toLocaleString() : 'unknown') + ' · ' + state.notes.length + ' notes · read-only';
    renderList();
  }

  // ---- list ----
  $('wsFilter').addEventListener('change', function () { state.filter = this.value; renderList(); });
  $('search').addEventListener('input', function () { state.query = this.value.trim().toLowerCase(); renderList(); });
  $('lockBtn').addEventListener('click', function () { location.reload(); });

  function noteMatches(n) {
    if (state.filter !== 'all' && n._ws !== state.filter) return false;
    if (!state.query) return true;
    var hay = [displayTitle(n), (n.tags || []).join(' '), (n.todos || []).map(function (t) { return t.text; }).join(' '), stripHtml(n.carryover), stripHtml(n.meetingNotes)].join(' ').toLowerCase();
    return hay.indexOf(state.query) >= 0;
  }

  function renderList() {
    showView('list');
    var ul = $('noteList'); ul.innerHTML = '';
    var shown = state.notes.filter(noteMatches);
    if (!shown.length) { ul.innerHTML = '<li class="muted" style="cursor:default">No notes match.</li>'; return; }
    shown.forEach(function (n) {
      var li = document.createElement('li');
      var open = (n.todos || []).filter(function (t) { return !t.done; }).length;
      li.innerHTML = '<div class="t">' + (n.favorite ? '★ ' : '') + esc(displayTitle(n)) + '</div>' +
        '<div class="m"><span class="ws">' + esc(state.wsNames[n._ws] || '') + '</span>' +
        (open ? '<span>' + open + ' open</span>' : '') +
        ((n.tags || []).length ? '<span>' + n.tags.map(function (t) { return '#' + esc(t); }).join(' ') + '</span>' : '') + '</div>';
      li.addEventListener('click', function () { renderNote(n); });
      ul.appendChild(li);
    });
  }

  // ---- note ----
  function renderNote(n) {
    showView('note');
    var todos = (n.todos || []).map(function (t) {
      return '<li class="' + (t.done ? 'done' : '') + '"><span>' + (t.done ? '☑' : '☐') + '</span><span>' + esc(t.text) + (t.due ? ' <span class="muted">· ' + esc(t.due) + '</span>' : '') + '</span></li>';
    }).join('');
    var atNames = (n.attachments || []).filter(function (a) { return (a.mime || '').indexOf('image/') !== 0; }).map(function (a) { return esc(a.name); });
    var html = '<button class="back" id="backBtn">‹ All notes</button>' +
      '<div class="note"><h2>' + esc(displayTitle(n)) + '</h2>' +
      '<div class="sub">' + esc(state.wsNames[n._ws] || '') + ' · created ' + esc((n.createdAt || '').slice(0, 10)) + '</div>' +
      ((n.tags || []).length ? '<div class="tags">' + n.tags.map(function (t) { return '#' + esc(t); }).join(' ') + '</div>' : '') +
      '<div class="sec"><h3>To-Do</h3><ul class="todos">' + (todos || '<li class="muted">None</li>') + '</ul></div>' +
      '<div class="sec"><h3>Carryover Notes</h3><div class="rich">' + (withImages(sanitize(n.carryover), n.id) || '<span class="muted">None</span>') + '</div></div>' +
      '<div class="sec"><h3>Meeting Notes</h3><div class="rich">' + (withImages(sanitize(n.meetingNotes), n.id) || '<span class="muted">None</span>') + '</div>' +
      (atNames.length ? '<div class="attach">📎 ' + atNames.join(', ') + ' <span class="muted">(open in the app to download)</span></div>' : '') +
      '</div></div>';
    $('noteView').innerHTML = html;
    $('backBtn').addEventListener('click', renderList);
    window.scrollTo(0, 0);
  }

  function showView(v) {
    $('listView').classList.toggle('hidden', v !== 'list');
    $('noteView').classList.toggle('hidden', v !== 'note');
  }

  // focus passphrase on load
  setTimeout(function () { var s = $('secret'); if (s) s.focus(); }, 50);
})();
