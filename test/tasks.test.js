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

    // --- interval recurrence: every N weeks / N months ---
    t.eq(tasksLib.nextDue('2026-07-22', { type: 'weekly', n: 2 }), '2026-08-05', 'nextDue every 2 weeks = +14d');
    t.eq(tasksLib.nextDue('2026-07-15', { type: 'monthly', n: 2 }), '2026-09-15', 'nextDue every 2 months = +2 months');
    t.eq(tasksLib.nextDue('2026-07-22', { type: 'weekly' }), '2026-07-29', 'nextDue plain weekly still = +7d');
    t.eq(tasksLib.normalizeRecurrence({ type: 'weekly', n: 2 }).n, 2, 'weekly keeps interval n>=2');
    t.eq(tasksLib.normalizeRecurrence({ type: 'weekly', n: 1 }).n, undefined, 'weekly drops n=1 (backward-compatible)');
    t.eq(tasksLib.normalizeRecurrence({ type: 'monthly', n: 3 }).n, 3, 'monthly keeps interval n>=2');
    t.eq(tasksLib.describeRecurrence({ type: 'weekly', n: 2 }), 'every 2 weeks', 'describes every-2-weeks');

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

    // --- move a task between workspaces ---
    const wsB = store.createWorkspace('Other');
    const movingId = store.addTask(ws.id, { text: 'relocate me', priority: 2, due: '2026-08-01', recurrence: { type: 'weekly' } }).task.id;
    const mv = store.moveTask(movingId, wsB.id);
    t.eq(mv.workspaceId, ws.id, 'move returns the SOURCE workspace (so its view refreshes with the task gone)');
    t.eq(store.listTasks(ws.id).some((x) => x.id === movingId), false, 'task removed from the source workspace');
    const inDest = store.listTasks(wsB.id).find((x) => x.id === movingId);
    t.ok(inDest, 'task now lives in the destination workspace');
    t.eq(inDest && inDest.text, 'relocate me', 'moved task keeps its text');
    t.eq(inDest && inDest.due, '2026-08-01', 'moved task keeps its due date');
    t.eq(inDest && inDest.priority, 2, 'moved task keeps its priority');
    t.ok(inDest && inDest.recurrence && inDest.recurrence.type === 'weekly', 'moved task keeps its recurrence');
    t.eq(inDest && inDest.workspaceId, wsB.id, 'moved task workspaceId updated to the destination');
    let threw = false; try { store.moveTask(movingId, 'nope-xyz'); } catch (e) { threw = e.status === 404; }
    t.ok(threw, 'move to a missing workspace 404s');
    store.moveTask(movingId, wsB.id); // same-workspace
    t.eq(store.listTasks(wsB.id).filter((x) => x.id === movingId).length, 1, 'move to the same workspace does not duplicate');
  } catch (ex) {
    t.ok(false, 'unexpected exception: ' + ex.stack);
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
    t.done();
  }
})();
