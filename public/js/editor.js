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

  function insertHTML(html) { document.execCommand('insertHTML', false, html); }

  function exec(command, editor, opts) {
    editor.focus();
    var uploader = opts && opts.uploader;
    if (command === 'insertImage') return pickImage(editor, uploader);
    if (command === 'insertTable') {
      var cols = Math.max(1, Math.min(8, parseInt(prompt('Columns?', '2'), 10) || 2));
      var rows = Math.max(1, Math.min(20, parseInt(prompt('Rows?', '2'), 10) || 2));
      var cells = '';
      for (var r = 0; r < rows; r++) {
        var row = '';
        for (var col = 0; col < cols; col++) row += '<td>&nbsp;</td>';
        cells += '<tr>' + row + '</tr>';
      }
      insertHTML('<table class="rte-table"><tbody>' + cells + '</tbody></table><p><br></p>');
      return;
    }
    if (command === 'noteLink') {
      if (opts && opts.noteLinkPicker) opts.noteLinkPicker(function (note) {
        editor.focus();
        insertHTML('<a href="#note-' + note.id + '" data-note-id="' + note.id + '">' + note.title + '</a>&nbsp;');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return;
    }
    if (command === 'createLink') {
      var url = prompt('Link URL:');
      if (url) document.execCommand('createLink', false, url);
      return;
    }
    if (command.indexOf('formatBlock:') === 0) {
      document.execCommand('formatBlock', false, command.split(':')[1]);
      return;
    }
    document.execCommand(command, false, null);
  }

  function insertImageFile(editor, f, uploader) {
    if (f.size > 8 * 1024 * 1024) { alert('Image too large (max 8 MB).'); return; }
    if (uploader) {
      // store as an encrypted attachment and reference by URL (keeps note lean)
      uploader(f).then(function (src) {
        editor.focus();
        document.execCommand('insertImage', false, src);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }).catch(function (e) { alert('Image upload failed: ' + e.message); });
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      editor.focus();
      document.execCommand('insertImage', false, reader.result); // inline data URL (self-contained)
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    };
    reader.readAsDataURL(f);
  }

  function pickImage(editor, uploader) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = function () {
      var f = input.files[0];
      if (f) insertImageFile(editor, f, uploader);
    };
    input.click();
  }

  function buildToolbar(toolbarEl, editor, opts) {
    toolbarEl.innerHTML = '';
    TOOLS.forEach(function (t) {
      if (t.cmd === 'noteLink' && !(opts && opts.noteLinkPicker)) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.title = t.title;
      b.innerHTML = t.label;
      if (t.style) b.setAttribute('style', t.style);
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        exec(t.cmd, editor, opts);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      toolbarEl.appendChild(b);
    });
  }

  var SLASH = [
    { key: 'h', label: 'Heading', run: function () { document.execCommand('formatBlock', false, 'H3'); } },
    { key: 'b', label: 'Bullet list', run: function () { document.execCommand('insertUnorderedList'); } },
    { key: 'n', label: 'Numbered list', run: function () { document.execCommand('insertOrderedList'); } },
    { key: 't', label: 'Table', run: function (editor, opts) { exec('insertTable', editor, opts); } },
    { key: 'q', label: 'Quote', run: function () { document.execCommand('formatBlock', false, 'BLOCKQUOTE'); } },
    { key: 'c', label: 'Code', run: function () { document.execCommand('formatBlock', false, 'PRE'); } },
  ];

  /* Type "/" at the start of an empty line to open a block menu. */
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
            editor.dispatchEvent(new Event('input', { bubbles: true }));
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
      var imgs = editor.querySelectorAll('img.selected');
      imgs.forEach(function (i) { i.classList.remove('selected'); });
      if (e.target.tagName === 'IMG') {
        e.target.classList.add('selected');
      }
    });
    editor.addEventListener('keydown', function (e) {
      var img = editor.querySelector('img.selected');
      if (!img) return;
      if (e.key === '+' || e.key === '=') { resizeImg(img, 1.1); e.preventDefault(); }
      if (e.key === '-') { resizeImg(img, 0.9); e.preventDefault(); }
      if (e.key === 'Delete' || e.key === 'Backspace') { img.remove(); e.preventDefault(); editor.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    // drag-resize from bottom-right corner
    editor.addEventListener('mousedown', function (e) {
      if (e.target.tagName !== 'IMG') return;
      var img = e.target;
      var rect = img.getBoundingClientRect();
      if (e.clientX < rect.right - 16 || e.clientY < rect.bottom - 16) return; // only corner
      e.preventDefault();
      var startX = e.clientX, startW = rect.width;
      function move(ev) { img.style.width = Math.max(40, startW + (ev.clientX - startX)) + 'px'; }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  function resizeImg(img, factor) {
    var w = img.getBoundingClientRect().width;
    img.style.width = Math.max(40, w * factor) + 'px';
    img.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* Paste images inline (OneNote-like). */
  function enablePasteImages(editor, uploader) {
    editor.addEventListener('paste', function (e) {
      var items = (e.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') === 0) {
          e.preventDefault();
          insertImageFile(editor, items[i].getAsFile(), uploader);
        }
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
    },
  };
})();
