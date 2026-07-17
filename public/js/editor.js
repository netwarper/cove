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
    { cmd: 'insertImage', label: '🖼', title: 'Insert image' },
    { cmd: 'createLink', label: '🔗', title: 'Insert link' },
    { cmd: 'removeFormat', label: '⌫', title: 'Clear formatting' },
  ];

  function exec(command, editor) {
    editor.focus();
    if (command === 'insertImage') return pickImage(editor);
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

  function pickImage(editor) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = function () {
      var f = input.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { alert('Image too large (max 8 MB).'); return; }
      var reader = new FileReader();
      reader.onload = function () {
        editor.focus();
        document.execCommand('insertImage', false, reader.result);
        // fire input so the change is persisted
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      };
      reader.readAsDataURL(f);
    };
    input.click();
  }

  function buildToolbar(toolbarEl, editor) {
    toolbarEl.innerHTML = '';
    TOOLS.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.title = t.title;
      b.innerHTML = t.label;
      if (t.style) b.setAttribute('style', t.style);
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        exec(t.cmd, editor);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      toolbarEl.appendChild(b);
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
  function enablePasteImages(editor) {
    editor.addEventListener('paste', function (e) {
      var items = (e.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') === 0) {
          e.preventDefault();
          var file = items[i].getAsFile();
          var reader = new FileReader();
          reader.onload = function () {
            document.execCommand('insertImage', false, reader.result);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
          };
          reader.readAsDataURL(file);
        }
      }
    });
  }

  window.Editor = {
    init: function (toolbarEl, editor) {
      buildToolbar(toolbarEl, editor);
      enableImageResize(editor);
      enablePasteImages(editor);
    },
  };
})();
