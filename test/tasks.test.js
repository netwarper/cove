'use strict';
/* Tasks module: recurrence math + legacy migration (store-level). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../lib/crypto');
const { Store } = require('../lib/store');
const tasksLib = require('../lib/tasks');
const { harness } = require('./helpers');

const t = harness('tasks');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-tasks-'));

(function run() {
  try {
    // --- recurrence math ---
    t.eq(tasksLib.nextDue('2026-07-22', { type: 'daily' }), '2026-07-23', 'nextDue daily = +1');
    t.eq(tasksLib.nextDue('2026-07-22', { type: 'everyNDays', n: 3 }), '2026-07-25', 'nextDue everyNDays = +n');
    t.eq(tasksLib.nextDue('2026-07-31', { type: 'monthly' }), '2026-08-31', 'nextDue monthly keeps day');
    t.eq(tasksLib.nextDue('2026-01-31', { type: 'monthly' }), '2026-02-28', 'nextDue monthly clamps to month length');
    t.eq(tasksLib.nextDue('2026-07-22', { type: 'daily', endDate: '2026-07-22' }), null, 'bounded recurrence ends');
    t.eq(tasksLib.normalizeRecurrence({ type: 'none' }), null, 'none recurrence normalizes to null');

    // --- migration of legacy to-dos + reminders ---
    const built = c.createVault('pw');
    const store = new Store(DIR, built.dek);
    store.ensureInitialized();
    const ws = store.createWorkspace('Proj');
    const n1 = store.createNote(ws.id, {});
    store.saveNote(n1.id, { todos: [
      { id: 'a', text: 'open A', done: false, doneAt: null, due: null, sourceReminderId: null },
      { id: 'b', text: 'done B', done: true, doneAt: new Date().toISOString(), due: null, sourceReminderId: null },
    ] });
    const n2 = store.createNote(ws.id, {}); // carries 'open A' forward
    store.saveNote(n2.id, { todos: [
      { id: 'a2', text: 'open A', done: false, doneAt: null, due: null, sourceReminderId: null },
      { id: 'cc', text: 'done C', done: true, doneAt: new Date().toISOString(), due: null, sourceReminderId: null },
    ] });
    store.addReminder(ws.id, { text: 'weekly sync', cadence: { type: 'weekly' } });

    // force re-migration (setup already flagged the empty vault as migrated)
    const idx = store._index(); idx.settings.tasksMigrated = false; store._saveIndex(idx);
    store.migrateTasks();

    const tks = store.listTasks(ws.id);
    const open = tks.filter((x) => !x.done);
    const done = tks.filter((x) => x.done);
    t.eq(open.filter((x) => x.text === 'open A').length, 1, 'open to-do migrated once (from the latest note, not duplicated across carry-forward)');
    t.ok(done.some((x) => x.text === 'done B' && x.completedOnNoteId === n1.id), 'completed to-do stays pinned to the note it was finished on (n1)');
    t.ok(done.some((x) => x.text === 'done C' && x.completedOnNoteId === n2.id), 'completed to-do stays pinned to its note (n2)');
    t.ok(open.some((x) => x.text === 'weekly sync' && x.recurrence && x.recurrence.type === 'weekly'), 'active reminder migrated to a recurring task');

    // migration is idempotent
    store.migrateTasks();
    t.eq(store.listTasks(ws.id).length, tks.length, 'migration does not run twice');
  } catch (ex) {
    t.ok(false, 'unexpected exception: ' + ex.stack);
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
    t.done();
  }
})();
