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
      b.addEventListener('click', function () { exec(t.cmd, editor, opts); });
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

  /* Click an inline image to select it; drag its corner (or use +/-) to resize. */
  function enableImageResize(editor) {
    editor.addEventListener('click', function (e) {
      editor.querySelectorAll('img.selected').forEach(function (i) { i.classList.remove('selected'); });
      if (e.target.tagName === 'IMG') e.target.classList.add('selected');
    });
    editor.addEventListener('keydown', function (e) {
      var img = editor.querySelector('img.selected');
      if (!img) return;
      if (e.key === '+' || e.key === '=') { resizeImg(img, 1.1); e.preventDefault(); }
      if (e.key === '-') { resizeImg(img, 0.9); e.preventDefault(); }
      if (e.key === 'Delete' || e.key === 'Backspace') { img.remove(); e.preventDefault(); fireInput(editor); }
    });
    editor.addEventListener('mousedown', function (e) {
      if (e.target.tagName !== 'IMG') return;
      var img = e.target;
      var rect = img.getBoundingClientRect();
      if (e.clientX < rect.right - 16 || e.clientY < rect.bottom - 16) return;
      e.preventDefault();
      var startX = e.clientX, startW = rect.width;
      function move(ev) { img.style.width = Math.max(40, startW + (ev.clientX - startX)) + 'px'; }
      function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); fireInput(editor); }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  function resizeImg(img, factor) { var w = img.getBoundingClientRect().width; img.style.width = Math.max(40, w * factor) + 'px'; img.dispatchEvent(new Event('input', { bubbles: true })); }

  /* Paste images inline (OneNote-like). */
  function enablePasteImages(editor, uploader) {
    editor.addEventListener('paste', function (e) {
      var items = (e.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') === 0) { e.preventDefault(); insertImageFile(editor, items[i].getAsFile(), uploader, saveRange(editor)); }
      }
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
