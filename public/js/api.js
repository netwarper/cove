/* Thin fetch wrapper around the JSON API, with CSRF handling. */
(function () {
  'use strict';

  var csrf = null;

  async function req(method, path, body) {
    var opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (csrf && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
      opts.headers['X-CSRF-Token'] = csrf;
    }
    var res = await fetch(path, opts);
    if (res.status === 401 && !/\/(login|setup|recover)$/.test(path)) {
      window.dispatchEvent(new CustomEvent('mn-unauthorized'));
    }
    var ct = res.headers.get('content-type') || '';
    var data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      var err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  window.API = {
    setCsrf: function (t) { csrf = t; },

    status: () => req('GET', '/api/status'),
    setup: (passphrase) => req('POST', '/api/setup', { passphrase }),
    login: (passphrase) => req('POST', '/api/login', { passphrase }),
    recover: (recoveryKey, newPassphrase) => req('POST', '/api/recover', { recoveryKey, newPassphrase }),
    logout: () => req('POST', '/api/logout'),
    changePassphrase: (oldPassphrase, newPassphrase) => req('POST', '/api/passphrase', { oldPassphrase, newPassphrase }),
    regenerateRecovery: () => req('POST', '/api/recovery/regenerate'),
    backupUrl: () => '/api/backup',
    restore: (bundle) => req('POST', '/api/restore', { bundle }),

    getSettings: () => req('GET', '/api/settings'),
    saveSettings: (patch) => req('PUT', '/api/settings', patch),

    listTemplates: () => req('GET', '/api/templates'),
    createTemplate: (data) => req('POST', '/api/templates', data),
    updateTemplate: (id, patch) => req('PUT', '/api/templates/' + id, patch),
    deleteTemplate: (id) => req('DELETE', '/api/templates/' + id),

    listWorkspaces: () => req('GET', '/api/workspaces'),
    createWorkspace: (name) => req('POST', '/api/workspaces', { name }),
    renameWorkspace: (id, name) => req('PUT', '/api/workspaces/' + id, { name }),
    setWorkspaceTemplate: (id, defaultTemplateId) => req('PUT', '/api/workspaces/' + id, { defaultTemplateId }),
    deleteWorkspace: (id) => req('DELETE', '/api/workspaces/' + id),

    listNotes: (wsId) => req('GET', '/api/workspaces/' + wsId + '/notes'),
    currentNote: (wsId) => req('GET', '/api/workspaces/' + wsId + '/current'),
    newNote: (wsId, opts) => req('POST', '/api/workspaces/' + wsId + '/notes/new', opts || {}),
    getNote: (id) => req('GET', '/api/notes/' + id),
    saveNote: (id, patch) => req('PUT', '/api/notes/' + id, patch),
    deleteNote: (id) => req('DELETE', '/api/notes/' + id),
    moveNote: (id, workspaceId) => req('POST', '/api/notes/' + id + '/move', { workspaceId }),
    copyNote: (id, workspaceId) => req('POST', '/api/notes/' + id + '/copy', { workspaceId }),
    setFavorite: (id, favorite) => req('POST', '/api/notes/' + id + '/favorite', { favorite }),
    toggleTodo: (noteId, todoId, done) => req('PUT', '/api/notes/' + noteId + '/todos/' + todoId, { done }),

    listReminders: (wsId) => req('GET', '/api/workspaces/' + wsId + '/reminders'),
    addReminder: (wsId, data) => req('POST', '/api/workspaces/' + wsId + '/reminders', data),
    updateReminder: (wsId, id, patch) => req('PUT', '/api/workspaces/' + wsId + '/reminders/' + id, patch),
    deleteReminder: (wsId, id) => req('DELETE', '/api/workspaces/' + wsId + '/reminders/' + id),
    processReminders: () => req('POST', '/api/reminders/process', {}),

    addAttachment: (noteId, data) => req('POST', '/api/notes/' + noteId + '/attachments', data),
    deleteAttachment: (noteId, attId) => req('DELETE', '/api/notes/' + noteId + '/attachments/' + attId),
    attachmentUrl: (noteId, attId) => '/api/notes/' + noteId + '/attachments/' + attId,

    favorites: () => req('GET', '/api/favorites'),
    globalTodos: () => req('GET', '/api/todos'),
    search: (q) => req('GET', '/api/search?q=' + encodeURIComponent(q)),
    importNote: (wsId, payload) => req('POST', '/api/workspaces/' + wsId + '/import', payload),
    exportUrl: (noteId, fmt) => '/api/notes/' + noteId + '/export?format=' + fmt,

    listTrash: () => req('GET', '/api/trash'),
    restoreTrash: (id) => req('POST', '/api/trash/' + id + '/restore', {}),
    purgeTrash: (id) => req('DELETE', '/api/trash/' + id),
  };
})();
