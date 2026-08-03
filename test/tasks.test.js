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

    // --- timezone-aware "today"/time helpers (fixed instant) ---
    const inst = new Date('2026-03-10T05:30:00Z'); // NY 01:30 EDT, Tokyo 14:30, Honolulu 19:30 (prev day)
    t.eq(tasksLib.todayISOInTz('America/New_York', inst), '2026-03-10', 'todayISOInTz: NY date at 01:30 local');
    t.eq(tasksLib.todayISOInTz('Asia/Tokyo', inst), '2026-03-10', 'todayISOInTz: Tokyo date (14:30 local)');
    t.eq(tasksLib.todayISOInTz('Pacific/Honolulu', new Date('2026-03-10T05:30:00Z')), '2026-03-09', 'todayISOInTz: Honolulu still previous day (19:30)');
    t.eq(tasksLib.hhmmInTz('America/New_York', inst), '01:30', 'hhmmInTz: NY wall clock (EDT)');
    t.eq(tasksLib.hhmmInTz('Asia/Tokyo', inst), '14:30', 'hhmmInTz: Tokyo wall clock');
    t.eq(tasksLib.todayISOInTz('Not/AZone', inst), tasksLib.todayISO(), 'invalid tz falls back to server-local today');
    t.eq(tasksLib.isValidTimezone('America/New_York'), true, 'isValidTimezone accepts a real zone');
    t.eq(tasksLib.isValidTimezone('Nope/Nope'), false, 'isValidTimezone rejects a bad zone');

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

    // --- completed-tasks history view ---
    const cA = store.addTask(ws.id, { text: 'ship the thing', priority: 1, due: '2026-07-10' }).task.id;
    const cB = store.addTask(wsB.id, { text: 'email finance', priority: 3, due: '2026-07-11' }).task.id;
    store.completeTask(cA, {});
    store.completeTask(cB, {});
    const allDone = store.completedTasks();
    t.ok(allDone.length >= 2, 'completedTasks returns finished tasks across workspaces');
    t.ok(allDone.every((x) => x.done && x.completedAt), 'every completed entry has done + completedAt');
    t.ok(allDone.every((x) => x.workspaceName), 'completed entries are tagged with workspaceName');
    // newest-first ordering
    for (let i = 1; i < allDone.length; i++) t.ok(allDone[i - 1].completedAt >= allDone[i].completedAt, 'completed sorted newest-first');
    t.eq(store.completedTasks().some((x) => x.id === cA), true, 'a just-completed task appears in the history');
    // date-range bound (completion happened today → an ancient window excludes it)
    t.eq(store.completedTasks({ to: '2000-01-01' }).length, 0, 'to-bound in the past excludes today’s completions');
    t.ok(store.completedTasks({ from: '2000-01-01' }).length >= 2, 'from-bound in the past includes today’s completions');
    // reopening removes it from history
    store.updateTask(cA, { done: false });
    t.eq(store.completedTasks().some((x) => x.id === cA), false, 'reopened task leaves the completed history');
  } catch (ex) {
    t.ok(false, 'unexpected exception: ' + ex.stack);
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
    t.done();
  }
})();
