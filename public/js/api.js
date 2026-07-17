/* Thin fetch wrapper around the JSON API. */
(function () {
  'use strict';

  async function req(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (res.status === 401 && !path.endsWith('/login') && !path.endsWith('/setup')) {
      window.dispatchEvent(new CustomEvent('mn-unauthorized'));
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  window.API = {
    status: () => req('GET', '/api/status'),
    setup: (passphrase) => req('POST', '/api/setup', { passphrase }),
    login: (passphrase) => req('POST', '/api/login', { passphrase }),
    logout: () => req('POST', '/api/logout'),

    getSettings: () => req('GET', '/api/settings'),
    saveSettings: (patch) => req('PUT', '/api/settings', patch),

    listWorkspaces: () => req('GET', '/api/workspaces'),
    createWorkspace: (name) => req('POST', '/api/workspaces', { name }),
    renameWorkspace: (id, name) => req('PUT', '/api/workspaces/' + id, { name }),
    deleteWorkspace: (id) => req('DELETE', '/api/workspaces/' + id),

    listNotes: (wsId) => req('GET', '/api/workspaces/' + wsId + '/notes'),
    currentNote: (wsId) => req('GET', '/api/workspaces/' + wsId + '/current'),
    newNote: (wsId, opts) => req('POST', '/api/workspaces/' + wsId + '/notes/new', opts || {}),
    getNote: (id) => req('GET', '/api/notes/' + id),
    saveNote: (id, patch) => req('PUT', '/api/notes/' + id, patch),
    deleteNote: (id) => req('DELETE', '/api/notes/' + id),
    setFavorite: (id, favorite) => req('POST', '/api/notes/' + id + '/favorite', { favorite }),
    toggleTodo: (noteId, todoId, done) => req('PUT', '/api/notes/' + noteId + '/todos/' + todoId, { done }),

    listReminders: (wsId) => req('GET', '/api/workspaces/' + wsId + '/reminders'),
    addReminder: (wsId, data) => req('POST', '/api/workspaces/' + wsId + '/reminders', data),
    updateReminder: (wsId, id, patch) => req('PUT', '/api/workspaces/' + wsId + '/reminders/' + id, patch),
    deleteReminder: (wsId, id) => req('DELETE', '/api/workspaces/' + wsId + '/reminders/' + id),

    addAttachment: (noteId, data) => req('POST', '/api/notes/' + noteId + '/attachments', data),
    deleteAttachment: (noteId, attId) => req('DELETE', '/api/notes/' + noteId + '/attachments/' + attId),
    attachmentUrl: (noteId, attId) => '/api/notes/' + noteId + '/attachments/' + attId,

    favorites: () => req('GET', '/api/favorites'),
    globalTodos: () => req('GET', '/api/todos'),
    search: (q) => req('GET', '/api/search?q=' + encodeURIComponent(q)),
    importNote: (wsId, payload) => req('POST', '/api/workspaces/' + wsId + '/import', payload),
    exportUrl: (noteId, fmt) => '/api/notes/' + noteId + '/export?format=' + fmt,
  };
})();
