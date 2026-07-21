/* Rich-text editor helpers: toolbar, formatting, inline resizable images. */
(function () {
  'use strict';

  var TOOLS = [
    { cmd: 'bold', label: 'B', title: 'Bold', style: 'font-weight:700' },
    { cmd: 'italic', label: 'I', title: 'Italic', style: 'font-style:italic' },
    { cmd: 'underline', label: 'U', title: 'Underline', style: 'text-decoration:underline' },
    { cmd: 'strikeThrough', label: 'S', title: 'Strikethrough', style: 'text-decoration:line-through' },
    { cmd: 'insertUnorderedList', label: '•', title: 'Bullet list' },
    { cmd: 'insertOrderedList', label: '1.', title: 'Numbered list' },
    { cmd: 'formatBlock:H3', label: 'H', title: 'Heading' },
    { cmd: 'insertTable', label: '▦', title: 'Insert table' },
    { cmd: 'insertImage', label: '🖼', title: 'Insert image' },
    { cmd: 'createLink', label: '🔗', title: 'Insert link' },
    { cmd: 'noteLink', label: '⧉', title: 'Link to a note' },
    { cmd: 'removeFormat', label: '⌫', title: 'Clear formatting' },
  ];
  // Which commands are on/off toggles whose button should light up when active.
  var STATE_CMDS = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'];

  function dlg() { return window.dialog; } // provided by app.js
  function fireInput(editor) { editor.dispatchEvent(new Event('input', { bubbles: true })); }
  function insertHTML(html) { document.execCommand('insertHTML', false, html); }

  // ---- caret preservation across modal dialogs ----
  function saveRange(editor) {
    var s = window.getSelection();
    if (s && s.rangeCount && editor.contains(s.anchorNode)) return s.getRangeAt(0).cloneRange();
    return null;
  }
  function restoreRange(editor, range) {
    editor.focus();
    if (range) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
  }
  function clampInt(v, lo, hi) { var n = parseInt(v, 10); if (isNaN(n)) n = lo; return Math.max(lo, Math.min(hi, n)); }

  async function exec(command, editor, opts) {
    opts = opts || {};
    var range = saveRange(editor);

    if (command === 'insertImage') { pickImage(editor, opts.uploader, range); return; }

    if (command === 'insertTable') {
      var colsStr = await dlg().prompt('How many columns?', { title: 'Insert table', default: '2', inputType: 'number' });
      if (colsStr === null) return;
      var rowsStr = await dlg().prompt('How many rows?', { title: 'Insert table', default: '2', inputType: 'number' });
      if (rowsStr === null) return;
      var cols = clampInt(colsStr, 1, 8), rows = clampInt(rowsStr, 1, 20), cells = '';
      for (var r = 0; r < rows; r++) { var row = ''; for (var col = 0; col < cols; col++) row += '<td>&nbsp;</td>'; cells += '<tr>' + row + '</tr>'; }
      restoreRange(editor, range);
      insertHTML('<table class="rte-table"><tbody>' + cells + '</tbody></table><p><br></p>');
      fireInput(editor);
      return;
    }

    if (command === 'noteLink') {
      if (opts.noteLinkPicker) opts.noteLinkPicker(function (note) {
        restoreRange(editor, range);
        insertHTML('<a href="#note-' + note.id + '" data-note-id="' + note.id + '">' + note.title + '</a>&nbsp;');
        fireInput(editor);
      });
      return;
    }

    if (command === 'createLink') {
      var url = await dlg().prompt('Link URL:', { title: 'Insert link', placeholder: 'https://…' });
      if (!url) return;
      restoreRange(editor, range);
      document.execCommand('createLink', false, url);
      fireInput(editor);
      return;
    }

    if (command.indexOf('formatBlock:') === 0) { document.execCommand('formatBlock', false, command.split(':')[1]); fireInput(editor); return; }
    document.execCommand(command, false, null);
    fireInput(editor);
  }

  function insertImageFile(editor, f, uploader, range) {
    if (f.size > 8 * 1024 * 1024) { dlg().alert('Image too large (max 8 MB).'); return; }
    if (uploader) {
      uploader(f).then(function (src) { restoreRange(editor, range); document.execCommand('insertImage', false, src); fireInput(editor); })
        .catch(function (e) { dlg().alert('Image upload failed: ' + e.message); });
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { restoreRange(editor, range); document.execCommand('insertImage', false, reader.result); fireInput(editor); };
    reader.readAsDataURL(f);
  }

  function pickImage(editor, uploader, range) {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = function () { var f = input.files[0]; if (f) insertImageFile(editor, f, uploader, range); };
    input.click();
  }

  function updateActiveStates(toolbarEl) {
    STATE_CMDS.forEach(function (cmd) {
      var b = toolbarEl.querySelector('button[data-cmd="' + cmd + '"]');
      if (!b) return;
      var on = false; try { on = document.queryCommandState(cmd); } catch (e) { on = false; }
      b.classList.toggle('active', on);
    });
  }

  function buildToolbar(toolbarEl, editor, opts) {
    toolbarEl.innerHTML = '';
    TOOLS.forEach(function (t) {
      if (t.cmd === 'noteLink' && !(opts && opts.noteLinkPicker)) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.title = t.title;
      b.innerHTML = t.label;
      b.setAttribute('data-cmd', t.cmd);
      if (t.style) b.setAttribute('style', t.style);
      b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep editor focus/selection
      // Update the button's active state right after the command runs, so a
      // second toggle (off→on) reflects immediately instead of waiting for the
      // next keystroke/selection change.
      b.addEventListener('click', function () { Promise.resolve(exec(t.cmd, editor, opts)).then(function () { updateActiveStates(toolbarEl); }); });
      toolbarEl.appendChild(b);
    });
  }

  var SLASH = [
    { label: 'Heading', run: function () { document.execCommand('formatBlock', false, 'H3'); } },
    { label: 'Bullet list', run: function () { document.execCommand('insertUnorderedList'); } },
    { label: 'Numbered list', run: function () { document.execCommand('insertOrderedList'); } },
    { label: 'Table', run: function (editor, opts) { exec('insertTable', editor, opts); } },
    { label: 'Quote', run: function () { document.execCommand('formatBlock', false, 'BLOCKQUOTE'); } },
    { label: 'Code', run: function () { document.execCommand('formatBlock', false, 'PRE'); } },
  ];

  /* Type "/" to open a block menu at the caret. */
  function enableSlashMenu(editor, opts) {
    var menu = null;
    function close() { if (menu) { menu.remove(); menu = null; } }
    editor.addEventListener('keyup', function (e) {
      if (e.key === '/') {
        var sel = window.getSelection();
        if (!sel.rangeCount) return;
        var rect = sel.getRangeAt(0).getBoundingClientRect();
        close();
        menu = document.createElement('div');
        menu.className = 'slash-menu';
        menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        menu.style.left = (rect.left + window.scrollX) + 'px';
        SLASH.forEach(function (s) {
          var b = document.createElement('button');
          b.textContent = s.label;
          b.addEventListener('mousedown', function (ev) {
            ev.preventDefault();
            document.execCommand('delete'); // remove the "/"
            s.run(editor, opts);
            fireInput(editor);
            close();
          });
          menu.appendChild(b);
        });
        document.body.appendChild(menu);
      } else if (e.key === 'Escape') { close(); }
    });
    editor.addEventListener('blur', function () { setTimeout(close, 200); });
  }

  /* Clicking a note-link opens that note (handled by the app). */
  function enableNoteLinks(editor) {
    editor.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[data-note-id]');
      if (a) { e.preventDefault(); window.dispatchEvent(new CustomEvent('mn-open-note', { detail: a.getAttribute('data-note-id') })); }
    });
  }

  /* Click an inline image to select it; a visible corner handle (or +/-) resizes it. */
  function enableImageResize(editor) {
    var handle = document.createElement('div');
    handle.className = 'img-resize-handle';
    handle.style.display = 'none';
    handle.title = 'Drag to resize';
    document.body.appendChild(handle);
    var selImg = null;

    function place() {
      if (!selImg || !editor.contains(selImg)) { handle.style.display = 'none'; return; }
      var r = selImg.getBoundingClientRect();
      handle.style.display = 'block';
      handle.style.left = (r.right + window.scrollX - 7) + 'px';
      handle.style.top = (r.bottom + window.scrollY - 7) + 'px';
    }
    function select(img) {
      if (selImg && selImg !== img) selImg.classList.remove('selected');
      selImg = img || null;
      if (selImg) { selImg.classList.add('selected'); place(); } else handle.style.display = 'none';
    }

    editor.addEventListener('click', function (e) { select(e.target.tagName === 'IMG' ? e.target : null); });
    editor.addEventListener('keydown', function (e) {
      if (!selImg) return;
      if (e.key === '+' || e.key === '=') { resizeImg(selImg, 1.1); place(); e.preventDefault(); }
      else if (e.key === '-') { resizeImg(selImg, 0.9); place(); e.preventDefault(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { var i = selImg; select(null); i.remove(); e.preventDefault(); fireInput(editor); }
    });
    // Drag the handle to resize (keeps aspect ratio via width only).
    handle.addEventListener('mousedown', function (e) {
      if (!selImg) return;
      e.preventDefault();
      var startX = e.clientX, startW = selImg.getBoundingClientRect().width;
      function move(ev) { selImg.style.width = Math.max(40, startW + (ev.clientX - startX)) + 'px'; selImg.style.height = 'auto'; place(); }
      function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); fireInput(editor); }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    // Keep the handle glued to the image as things move/scroll/reflow.
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    editor.addEventListener('input', function () { setTimeout(place, 0); });
    // Deselect when clicking outside the editor (but not on the handle itself).
    document.addEventListener('mousedown', function (e) { if (e.target !== handle && !editor.contains(e.target)) select(null); });
  }
  function resizeImg(img, factor) { var w = img.getBoundingClientRect().width; img.style.width = Math.max(40, w * factor) + 'px'; img.style.height = 'auto'; img.dispatchEvent(new Event('input', { bubbles: true })); }

  /* Paste images inline (OneNote-like). */
  function enablePasteImages(editor, uploader) {
    editor.addEventListener('paste', function (e) {
      var items = (e.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') === 0) { e.preventDefault(); insertImageFile(editor, items[i].getAsFile(), uploader, saveRange(editor)); }
      }
    });
  }

  /* Drag & drop images / screenshots straight into a note. */
  function enableDropImages(editor, uploader) {
    function hasFiles(e) {
      var dt = e.dataTransfer; if (!dt) return false;
      if (dt.items && dt.items.length) { for (var i = 0; i < dt.items.length; i++) if (dt.items[i].kind === 'file') return true; return false; }
      return (dt.types || []).indexOf && Array.prototype.indexOf.call(dt.types, 'Files') >= 0;
    }
    editor.addEventListener('dragover', function (e) { if (hasFiles(e)) { e.preventDefault(); editor.classList.add('drop-hover'); } });
    editor.addEventListener('dragleave', function (e) { if (e.target === editor) editor.classList.remove('drop-hover'); });
    editor.addEventListener('drop', function (e) {
      var files = (e.dataTransfer && e.dataTransfer.files) || [];
      var imgs = Array.prototype.filter.call(files, function (f) { return f.type.indexOf('image/') === 0; });
      editor.classList.remove('drop-hover');
      if (!imgs.length) return;
      e.preventDefault();
      editor.focus();
      // Drop at the cursor position under the pointer when the browser supports it.
      var range = null;
      if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
      else if (document.caretPositionFromPoint) { var pos = document.caretPositionFromPoint(e.clientX, e.clientY); if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); range.collapse(true); } }
      if (range && editor.contains(range.startContainer)) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
      var saved = saveRange(editor);
      imgs.forEach(function (f) { insertImageFile(editor, f, uploader, saved); });
    });
  }

  window.Editor = {
    // opts.uploader(file) -> Promise<url>: inserted images become attachments.
    // opts.noteLinkPicker(insertFn): lets the app supply a note to link to.
    init: function (toolbarEl, editor, opts) {
      opts = opts || {};
      buildToolbar(toolbarEl, editor, opts);
      enableImageResize(editor);
      enablePasteImages(editor, opts.uploader || null);
      enableDropImages(editor, opts.uploader || null);
      enableSlashMenu(editor, opts);
      enableNoteLinks(editor);
      // Reflect the active formatter on the toolbar buttons.
      var refresh = function () { if (editor.contains(document.getSelection().anchorNode)) updateActiveStates(toolbarEl); };
      editor.addEventListener('keyup', refresh);
      editor.addEventListener('mouseup', refresh);
      editor.addEventListener('focus', refresh);
      document.addEventListener('selectionchange', refresh);
    },
  };
})();
