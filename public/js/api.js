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
    webauthnUnlock: (credentialId, prfSecret) => req('POST', '/api/webauthn/unlock', { credentialId, prfSecret }),
    webauthnEnroll: (data) => req('POST', '/api/webauthn/enroll', data),
    webauthnRemove: (id) => req('POST', '/api/webauthn/remove', { id }),
    backupUrl: () => '/api/backup',
    viewerUrl: () => '/api/viewer',
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

    listNotes: (wsId, opts) => {
      opts = opts || {};
      var qs = [];
      if (opts.sort) qs.push('sort=' + encodeURIComponent(opts.sort));
      if (opts.dir) qs.push('dir=' + encodeURIComponent(opts.dir));
      return req('GET', '/api/workspaces/' + wsId + '/notes' + (qs.length ? '?' + qs.join('&') : ''));
    },
    backlinks: (id) => req('GET', '/api/notes/' + id + '/backlinks'),
    listVersions: (id) => req('GET', '/api/notes/' + id + '/versions'),
    restoreVersion: (id, ts) => req('POST', '/api/notes/' + id + '/versions/' + ts + '/restore', {}),
    forkNote: (id, patch) => req('POST', '/api/notes/' + id + '/fork', patch),
    snoozeReminder: (wsId, id, until) => req('POST', '/api/workspaces/' + wsId + '/reminders/' + id + '/snooze', { until }),
    workspaceZipUrl: (wsId, fmt) => '/api/workspaces/' + wsId + '/export?format=' + fmt,
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
    processInbox: () => req('POST', '/api/inbox/process', {}),
    slackAgenda: () => req('POST', '/api/slack/agenda', {}),

    addAttachment: (noteId, data) => req('POST', '/api/notes/' + noteId + '/attachments', data),
    deleteAttachment: (noteId, attId) => req('DELETE', '/api/notes/' + noteId + '/attachments/' + attId),
    attachmentUrl: (noteId, attId) => '/api/notes/' + noteId + '/attachments/' + attId,

    favorites: () => req('GET', '/api/favorites'),
    globalTodos: () => req('GET', '/api/todos'),

    // Tasks (unified to-do + reminder)
    listTasks: (wsId) => req('GET', '/api/workspaces/' + wsId + '/tasks'),
    addTask: (wsId, data) => req('POST', '/api/workspaces/' + wsId + '/tasks', data),
    updateTask: (id, patch) => req('PUT', '/api/tasks/' + id, patch),
    deleteTask: (id) => req('DELETE', '/api/tasks/' + id),
    completeTask: (id, noteId) => req('POST', '/api/tasks/' + id + '/complete', { noteId: noteId }),
    skipTask: (id) => req('POST', '/api/tasks/' + id + '/skip', {}),
    rescheduleTask: (id, due) => req('POST', '/api/tasks/' + id + '/reschedule', { due: due }),
    globalTasks: () => req('GET', '/api/tasks'),
    dueTasks: () => req('POST', '/api/tasks/due', {}),
    search: (q) => req('GET', '/api/search?q=' + encodeURIComponent(q)),
    allTags: () => req('GET', '/api/tags'),
    importNote: (wsId, payload) => req('POST', '/api/workspaces/' + wsId + '/import', payload),
    exportUrl: (noteId, fmt) => '/api/notes/' + noteId + '/export?format=' + fmt,

    verifyIntegrity: () => req('GET', '/api/verify'),
    stats: () => req('GET', '/api/stats'),
    transcribe: (audioB64, mime, filename, source) => req('POST', '/api/transcribe', { audioB64, mime, filename, source }),
    listTrash: () => req('GET', '/api/trash'),
    restoreTrash: (id) => req('POST', '/api/trash/' + id + '/restore', {}),
    purgeTrash: (id) => req('DELETE', '/api/trash/' + id),
  };
})();
