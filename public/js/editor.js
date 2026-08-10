/* Rich-text editor helpers: toolbar, formatting, inline resizable images. */
(function () {
  'use strict';

  // Build stamp — app.js compares this against its own APP_BUILD so a stale,
  // separately-cached editor.js (a known installed-PWA failure mode) is detected
  // and the user is offered a cache-clearing reload instead of silently missing
  // newer editor features (auto-list, Tab/Shift+Tab indent, …).
  var EDITOR_BUILD = '1.61.0';
  window.__coveEditorBuild = EDITOR_BUILD;

  var TOOLS = [
    { cmd: 'bold', label: 'B', title: 'Bold', style: 'font-weight:700' },
    { cmd: 'italic', label: 'I', title: 'Italic', style: 'font-style:italic' },
    { cmd: 'underline', label: 'U', title: 'Underline', style: 'text-decoration:underline' },
    { cmd: 'strikeThrough', label: 'S', title: 'Strikethrough', style: 'text-decoration:line-through' },
    { cmd: 'insertUnorderedList', label: '•', title: 'Bullet list' },
    { cmd: 'insertOrderedList', label: '1.', title: 'Numbered list' },
    { cmd: 'foreColor', label: 'A', title: 'Text color', color: true, style: 'text-decoration:underline; text-decoration-color:#e5484d; text-underline-offset:2px' },
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

  // After execCommand('insertImage') some browsers leave the new <img> SELECTED,
  // so the next keystroke would replace it. Collapse the caret to just after the
  // image so typing appends text instead.
  function caretAfterInsertedImage() {
    try { var s = window.getSelection(); if (s && s.rangeCount) s.collapseToEnd(); } catch (_e) { /* ignore */ }
  }
  function insertImageFile(editor, f, uploader, range) {
    if (f.size > 8 * 1024 * 1024) { dlg().alert('Image too large (max 8 MB).'); return; }
    if (uploader) {
      uploader(f).then(function (src) { restoreRange(editor, range); document.execCommand('insertImage', false, src); caretAfterInsertedImage(); fireInput(editor); })
        .catch(function (e) { dlg().alert('Image upload failed: ' + e.message); });
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { restoreRange(editor, range); document.execCommand('insertImage', false, reader.result); caretAfterInsertedImage(); fireInput(editor); };
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
      b.addEventListener('click', function () {
        if (t.color) { openColorPalette(editor, b); return; }
        Promise.resolve(exec(t.cmd, editor, opts)).then(function () { updateActiveStates(toolbarEl); });
      });
      toolbarEl.appendChild(b);
    });
  }

  // Text-color palette. foreColor with styleWithCSS produces <span style="color:…">,
  // which the note editors render and the server keeps (only script/style/handlers
  // are stripped). "Clear formatting" (⌫) removes the color again.
  var COLOR_SWATCHES = ['#e5484d', '#e0821e', '#c99a06', '#2ea043', '#12b5b5', '#3b6cf6', '#7c5cff', '#d6409f', '#6b7280', '#e7eaf0'];
  function openColorPalette(editor, anchorBtn) {
    var range = saveRange(editor); // the selection to colorize (before the popover steals focus)
    var existing = document.querySelector('.color-pop');
    if (existing) existing.remove();
    var pop = document.createElement('div');
    pop.className = 'color-pop';
    COLOR_SWATCHES.forEach(function (col) {
      var sw = document.createElement('button');
      sw.type = 'button'; sw.className = 'color-sw'; sw.title = col;
      sw.style.background = col;
      sw.addEventListener('mousedown', function (e) { e.preventDefault(); });
      sw.addEventListener('click', function () {
        restoreRange(editor, range);
        try { document.execCommand('styleWithCSS', false, true); } catch (_e) { /* older browsers */ }
        document.execCommand('foreColor', false, col);
        fireInput(editor);
        close();
      });
      pop.appendChild(sw);
    });
    document.body.appendChild(pop);
    var r = anchorBtn.getBoundingClientRect();
    pop.style.left = Math.max(6, Math.min(r.left + window.scrollX, window.innerWidth - pop.offsetWidth - 6)) + 'px';
    pop.style.top = (r.bottom + window.scrollY + 4) + 'px';
    function close() { pop.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); }
    function onDoc(e) { if (!pop.contains(e.target) && e.target !== anchorBtn) close(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    setTimeout(function () { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
  }

  var SLASH = [
    { label: 'Heading', run: function () { document.execCommand('formatBlock', false, 'H3'); } },
    { label: 'Bullet list', run: function () { document.execCommand('insertUnorderedList'); } },
    { label: 'Numbered list', run: function () { document.execCommand('insertOrderedList'); } },
    { label: 'Table', run: function (editor, opts) { exec('insertTable', editor, opts); } },
    { label: 'Quote', run: function () { document.execCommand('formatBlock', false, 'BLOCKQUOTE'); } },
    { label: 'Code', run: function () { document.execCommand('formatBlock', false, 'PRE'); } },
  ];

  /* Type "/" at the start of a word to open a block menu at the caret. */
  function enableSlashMenu(editor, opts) {
    var menu = null, anchor = null, onScroll = null, onDocDown = null;
    // Keep the menu glued to where the "/" was typed, so it moves with the text
    // as the note scrolls (rather than floating in a fixed spot on screen).
    function place() {
      if (!menu || !anchor) return;
      var rect = anchor.getBoundingClientRect();
      if (!rect.width && !rect.height && !rect.top && !rect.left) return; // caret rect unavailable
      menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
      menu.style.left = (rect.left + window.scrollX) + 'px';
    }
    function close() {
      if (menu) { menu.remove(); menu = null; }
      anchor = null;
      if (onScroll) { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); onScroll = null; }
      if (onDocDown) { document.removeEventListener('mousedown', onDocDown, true); onDocDown = null; }
    }
    // Only treat "/" as a command trigger when it begins a word — i.e. it's at
    // the very start of the block or right after whitespace. This keeps ordinary
    // text ("and/or", "http://", "7/28") from popping the menu mid-typing.
    function slashStartsWord() {
      var sel = window.getSelection();
      if (!sel.rangeCount) return false;
      var node = sel.anchorNode, off = sel.anchorOffset;
      if (!node || node.nodeType !== 3) return true; // "/" is the block's first char
      var before = (node.nodeValue || '').charAt(off - 2); // char just before the "/"
      return before === '' || /\s| /.test(before);
    }
    editor.addEventListener('keyup', function (e) {
      if (e.key === '/' && slashStartsWord()) {
        var sel = window.getSelection();
        if (!sel.rangeCount) return;
        close();
        anchor = sel.getRangeAt(0).cloneRange(); // the caret right after the "/"
        menu = document.createElement('div');
        menu.className = 'slash-menu';
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
        var hint = document.createElement('div');
        hint.className = 'slash-hint';
        hint.textContent = 'Esc to dismiss';
        menu.appendChild(hint);
        document.body.appendChild(menu);
        place();
        // Capture-phase so scrolls inside the note container (which don't bubble)
        // also reposition the menu.
        onScroll = place;
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        // Click anywhere outside the menu (including back in the note) dismisses it.
        onDocDown = function (ev) { if (menu && !menu.contains(ev.target)) close(); };
        document.addEventListener('mousedown', onDocDown, true);
      } else if (e.key === 'Escape' && menu) { e.preventDefault(); close(); }
    });
    // Escape should still dismiss even if focus has shifted off the editor.
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu) { e.preventDefault(); close(); } });
    editor.addEventListener('blur', function () { setTimeout(close, 200); });
  }

  /* Clicking a note-link opens that note (handled by the app). */
  function enableNoteLinks(editor) {
    editor.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[data-note-id]');
      if (a) { e.preventDefault(); window.dispatchEvent(new CustomEvent('mn-open-note', { detail: a.getAttribute('data-note-id') })); }
    });
  }

  /* Wiki-style linking: typing "[[" opens the note picker and inserts a link. */
  function enableWikiLinks(editor, opts) {
    if (!opts || !opts.noteLinkPicker) return;
    editor.addEventListener('input', function () {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      var node = sel.anchorNode, off = sel.anchorOffset;
      if (!node || node.nodeType !== 3) return; // only inside a text node
      var text = node.nodeValue || '';
      if (off < 2 || text.slice(off - 2, off) !== '[[') return;
      // Strip the two brackets, then reuse the standard note-link flow.
      var r = document.createRange(); r.setStart(node, off - 2); r.setEnd(node, off); r.deleteContents();
      var caret = document.createRange(); caret.setStart(node, off - 2); caret.collapse(true);
      sel.removeAllRanges(); sel.addRange(caret);
      fireInput(editor);
      exec('noteLink', editor, opts);
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
      if (e.key === '+' || e.key === '=') { resizeImg(selImg, 1.1); place(); e.preventDefault(); return; }
      if (e.key === '-') { resizeImg(selImg, 0.9); place(); e.preventDefault(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { var i = selImg; select(null); i.remove(); e.preventDefault(); fireInput(editor); return; }
      // Ignore lone modifier keys, but any other key (typing, arrows, Enter…) means
      // the user has moved on to editing text — release the stale image selection so
      // Backspace/Delete and typing act on the TEXT, not the previously-clicked image.
      if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') select(null);
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
      editor.classList.remove('drop-hover');
      if (!files.length) return; // plain text/HTML drop — let the browser handle it
      // Any file drop is ours to handle: never let the browser navigate away from
      // the app (and lose unsaved edits) to open a dropped file.
      e.preventDefault();
      var imgs = Array.prototype.filter.call(files, function (f) { return f.type.indexOf('image/') === 0; });
      if (!imgs.length) return; // non-image files: swallow the drop, nothing to insert
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

  /* Tab / Shift+Tab indent or outdent instead of moving focus: nests list items
     and indents paragraphs. */
  function enableTabIndent(editor) {
    editor.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      document.execCommand(e.shiftKey ? 'outdent' : 'indent');
      fireInput(editor);
    });
  }

  /* Markdown-style auto lists: typing "- " / "* " / "+ " (or "1. " / "1) ") at the
     very start of a line turns it into a bullet / numbered list. Deliberately
     conservative so it isn't annoying: it only fires when the marker is the ONLY
     thing on the line, never inside an existing list item or a code block, and a
     couple of Ctrl/Cmd+Z presses undo it right back to the text you typed. */
  function ancestorTag(editor, node, tag) {
    for (var c = node; c && c !== editor; c = c.parentNode) if (c.nodeType === 1 && c.tagName === tag) return true;
    return false;
  }
  function blockOf(editor, node) {
    var b = node.nodeType === 3 ? node.parentNode : node;
    while (b && b !== editor && b.parentNode !== editor) b = b.parentNode;
    if (b && b !== editor) return b;                 // a block-level child of the editor
    return node.parentNode === editor ? node : editor; // text typed directly in the editor
  }
  // The <br> on the caret's current line that immediately precedes it, or null.
  // Lets us treat the current LINE — not the whole block — as the start point, so
  // "line one<br>- " (Shift+Enter, or note HTML that uses <br> line breaks) still
  // matches the marker instead of measuring back past the previous line.
  function lastBrBeforeCaret(block, container, offset) {
    var caret = document.createRange();
    try { caret.setStart(container, offset); caret.collapse(true); } catch (_e) { return null; }
    var brs = block.querySelectorAll ? block.querySelectorAll('br') : [];
    var found = null;
    for (var i = 0; i < brs.length; i++) {
      var after = document.createRange();
      after.setStartAfter(brs[i]); after.collapse(true);
      if (after.compareBoundaryPoints(Range.START_TO_START, caret) <= 0) found = brs[i];
      else break; // brs are in document order; once past the caret we're done
    }
    return found;
  }
  function lineRange(block, br, container, offset) {
    var r = document.createRange();
    if (br) r.setStartAfter(br); else r.setStart(block, 0);
    r.setEnd(container, offset);
    return r;
  }
  function enableAutoList(editor) {
    editor.addEventListener('input', function (e) {
      // React only to plain typing (ignore paste, formatting, deletes, our own
      // synthetic input events don't set inputType so they fall through harmlessly).
      if (e.inputType && e.inputType !== 'insertText') return;
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
      var range = sel.getRangeAt(0);
      var node = range.startContainer;
      if (ancestorTag(editor, node, 'LI') || ancestorTag(editor, node, 'PRE')) return;
      var block = blockOf(editor, node);
      if (!block) return;
      // Text from the start of the CURRENT line up to the caret.
      var br = lastBrBeforeCaret(block, node, range.startOffset);
      var before;
      try { before = lineRange(block, br, node, range.startOffset).toString(); } catch (_e) { return; }
      var bullet = /^[-*+]\s$/.test(before);
      var numbered = /^1[.)]\s$/.test(before);
      if (!bullet && !numbered) return;
      // Delete just the marker (only the current line), then make it a list.
      var del;
      try { del = lineRange(block, br, node, range.startOffset); } catch (_e) { return; }
      sel.removeAllRanges(); sel.addRange(del);
      document.execCommand('delete');
      document.execCommand(bullet ? 'insertUnorderedList' : 'insertOrderedList');
      fireInput(editor);
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
      enableWikiLinks(editor, opts);
      enableTabIndent(editor);
      enableAutoList(editor);
      // Reflect the active formatter on the toolbar buttons.
      var refresh = function () { if (editor.contains(document.getSelection().anchorNode)) updateActiveStates(toolbarEl); };
      editor.addEventListener('keyup', refresh);
      editor.addEventListener('mouseup', refresh);
      editor.addEventListener('focus', refresh);
      document.addEventListener('selectionchange', refresh);
    },
  };
})();
