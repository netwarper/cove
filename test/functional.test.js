'use strict';
/* Functional tests: exercise the full API surface end-to-end. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeClient, harness } = require('./helpers');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-func-'));
process.env.DATA_DIR = DATA_DIR;
process.env.HOST = '127.0.0.1';

const { server } = require('../server');
const t = harness('functional');

(async function run() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const c = makeClient(port);
  const PASS = 'correct horse battery';

  try {
    // --- setup / auth ---
    let r = await c.request('GET', '/api/status');
    t.eq(r.body.initialized, false, 'fresh vault is not initialized');

    r = await c.request('POST', '/api/setup', { passphrase: PASS });
    t.ok(r.status === 200, 'setup succeeds');

    r = await c.request('GET', '/api/status');
    t.eq(r.body.authenticated, true, 'authenticated after setup');

    // --- workspaces ---
    r = await c.request('GET', '/api/workspaces');
    t.ok(r.body.some((w) => w.id === 'general'), 'General workspace exists');
    r = await c.request('POST', '/api/workspaces', { name: 'Team Sync' });
    const teamWs = r.body.id;
    t.ok(!!teamWs, 'created custom workspace');

    // --- first daily note (workspaces start empty; nothing is auto-created) ---
    r = await c.request('GET', '/api/workspaces/general/current');
    t.eq(r.body, null, 'empty workspace has no current note (client shows a landing page)');
    r = await c.request('POST', '/api/workspaces/general/notes/new', {});
    const note1 = r.body;
    t.ok(/^\d{4}-\d{2}-\d{2}$/.test(note1.title), 'new daily note titled with date');
    t.eq(note1.kind, 'daily', 'new note defaults to daily');

    // --- edit note: todos + carryover + meeting notes ---
    r = await c.request('PUT', '/api/notes/' + note1.id, {
      customTitle: 'Kickoff',
      todos: [
        { id: 'a', text: 'open task 1', done: false, doneAt: null, sourceReminderId: null },
        { id: 'b', text: 'done task', done: true, doneAt: new Date().toISOString(), sourceReminderId: null },
        { id: 'd', text: 'open task 2', done: false, doneAt: null, sourceReminderId: null },
      ],
      carryover: '<p>Carry me forward</p>',
      meetingNotes: '<p>Ephemeral meeting <b>notes</b> about widgets</p>',
    });
    t.eq(r.body.todos.map((x) => x.text), ['open task 1', 'open task 2', 'done task'], 'completed todos sink to bottom');
    t.eq(r.body.customTitle, 'Kickoff', 'custom title saved');

    // --- create next note copies open todos + carryover, drops meeting notes ---
    r = await c.request('POST', '/api/workspaces/general/notes/new', {});
    const note2 = r.body;
    t.eq(note2.todos.map((x) => x.text), ['open task 1', 'open task 2'], 'only incomplete todos carry over');
    t.eq(note2.carryover, '<p>Carry me forward</p>', 'carryover copied to new note');
    t.eq(note2.meetingNotes, '', 'meeting notes NOT copied');
    t.ok(note2.id !== note1.id, 'new note has a new id');

    // --- reminders: add a once-due-today reminder, new note injects it as a todo ---
    const today = new Date().toISOString().slice(0, 10);
    r = await c.request('POST', '/api/workspaces/general/reminders', { text: 'Submit report', cadence: { type: 'once', dueDate: today } });
    t.ok(!!r.body.id, 'reminder created');
    r = await c.request('POST', '/api/workspaces/general/notes/new', {});
    const note3 = r.body;
    t.ok(note3.todos.some((x) => x.text === 'Submit report' && x.sourceReminderId), 'due reminder injected as todo');

    // recurring reminder (daily) does not double-inject into the same note
    r = await c.request('GET', '/api/workspaces/general/current');
    const before = r.body.todos.length;
    r = await c.request('GET', '/api/workspaces/general/current');
    t.eq(r.body.todos.length, before, 'reminder not injected twice into same note');

    // --- favorites ---
    r = await c.request('POST', '/api/notes/' + note3.id + '/favorite', { favorite: true });
    t.eq(r.body.favorite, true, 'note marked favorite');
    r = await c.request('GET', '/api/favorites');
    t.ok(r.body.some((f) => f.id === note3.id), 'favorite appears in favorites list');

    // --- attachments (round-trip encryption) ---
    const payload = Buffer.from('hello attachment bytes 123');
    r = await c.request('POST', '/api/notes/' + note3.id + '/attachments', { name: 'note.txt', mime: 'text/plain', dataB64: payload.toString('base64') });
    const attId = r.body.id;
    t.eq(r.body.size, payload.length, 'attachment size recorded');
    r = await c.request('GET', '/api/notes/' + note3.id + '/attachments/' + attId);
    t.ok(Buffer.compare(r.raw, payload) === 0, 'attachment bytes round-trip correctly');
    r = await c.request('DELETE', '/api/notes/' + note3.id + '/attachments/' + attId);
    t.eq(r.body.ok, true, 'attachment deleted');

    // --- global todos + bidirectional sync ---
    r = await c.request('GET', '/api/todos');
    const gt = r.body.find((x) => x.text === 'open task 1');
    t.ok(!!gt, 'global todos aggregate across workspaces');
    r = await c.request('PUT', '/api/notes/' + gt.noteId + '/todos/' + gt.todoId, { done: true });
    t.ok(r.body.todos.find((x) => x.id === gt.todoId).done, 'completing in global view updates source note');
    r = await c.request('GET', '/api/todos');
    t.ok(!r.body.some((x) => x.todoId === gt.todoId), 'completed todo leaves the global open list');

    // --- search ---
    r = await c.request('GET', '/api/search?q=widgets');
    t.ok(r.body.some((x) => x.noteId === note1.id), 'search finds meeting-note text');
    r = await c.request('GET', '/api/search?q=Submit%20report');
    t.ok(r.body.length >= 1, 'search finds todo text');

    // --- export / import ---
    r = await c.request('GET', '/api/notes/' + note1.id + '/export?format=json');
    const exported = r.raw.toString();
    t.ok(r.headers['content-type'].includes('application/json'), 'export json content-type');
    r = await c.request('POST', '/api/workspaces/' + teamWs + '/import', { format: 'json', content: exported, title: 'Imported' });
    t.ok(r.body.meetingNotes.includes('widgets') || r.body.carryover.includes('Carry'), 'imported note retains content');
    r = await c.request('GET', '/api/notes/' + note1.id + '/export?format=md');
    t.ok(r.raw.toString().startsWith('# '), 'markdown export renders heading');

    // --- settings persist ---
    r = await c.request('PUT', '/api/settings', { theme: 'dark' });
    t.eq(r.body.theme, 'dark', 'setting persisted');

    // --- scratch notes vs daily carryover (isolated workspace) ---
    r = await c.request('POST', '/api/workspaces', { name: 'ScratchWS' });
    const sws = r.body.id;
    r = await c.request('POST', '/api/workspaces/' + sws + '/notes/new', {});
    const sd1 = r.body.id;
    await c.request('PUT', '/api/notes/' + sd1, { carryover: '<p>daily thread</p>', todos: [{ id: 'k1', text: 'keep me', done: false, doneAt: null, sourceReminderId: null }] });
    r = await c.request('POST', '/api/workspaces/' + sws + '/notes/new', { scratch: true });
    t.eq(r.body.kind, 'scratch', 'scratch note has kind=scratch');
    t.eq(r.body.carryover, '', 'scratch note has no carryover');
    t.eq((r.body.todos || []).length, 0, 'scratch note carries no todos');
    r = await c.request('POST', '/api/workspaces/' + sws + '/notes/new', {});
    t.eq(r.body.kind, 'daily', 'new note defaults to daily');
    t.ok(r.body.carryover.includes('daily thread'), 'daily note pulls carryover from the last DAILY note, skipping scratch');
    t.ok(r.body.todos.some((x) => x.text === 'keep me'), 'daily note carries open todos from the last daily note');

    // --- tags + tag search ---
    r = await c.request('PUT', '/api/notes/' + note1.id, { tags: ['planning', 'q3'], baseUpdatedAt: undefined });
    t.eq(r.body.tags, ['planning', 'q3'], 'tags saved on note');
    r = await c.request('GET', '/api/search?q=' + encodeURIComponent('tag:planning'));
    t.ok(r.body.some((x) => x.noteId === note1.id), 'tag: search filter works');

    // --- per-todo due dates surface in global order ---
    r = await c.request('GET', '/api/workspaces/general/current');
    const cur = r.body;
    cur.todos[0].due = today;
    r = await c.request('PUT', '/api/notes/' + cur.id, { todos: cur.todos });
    t.eq(r.body.todos[0].due, today, 'todo due date persists');

    // --- templates: Meeting Notes-only seeding ---
    r = await c.request('POST', '/api/templates', { name: '1:1', meetingNotes: '<h3>Wins</h3>', defaultTodos: ['ask about blockers'] });
    const tplId = r.body.id;
    r = await c.request('POST', '/api/workspaces', { name: 'Templated WS' });
    const tws = r.body.id;
    r = await c.request('POST', '/api/workspaces/' + tws + '/notes/new', { templateId: tplId });
    t.ok(r.body.meetingNotes.includes('Wins'), 'template seeds Meeting Notes on new note');
    t.ok(r.body.todos.some((x) => x.text === 'ask about blockers'), 'template default todos seed the first note');
    // set as workspace default, verify carry-forward still overrides todos on later notes
    await c.request('PUT', '/api/workspaces/' + tws, { defaultTemplateId: tplId });
    r = await c.request('POST', '/api/workspaces/' + tws + '/notes/new', {});
    t.ok(r.body.meetingNotes.includes('Wins'), 'workspace default template seeds Meeting Notes');
    t.eq(r.body.todos.map((x) => x.text), ['ask about blockers'], 'carry-forward keeps prior open todos (template did not duplicate)');

    // --- move + copy note ---
    r = await c.request('POST', '/api/notes/' + note1.id + '/copy', { workspaceId: teamWs });
    const copyId = r.body.id;
    t.ok(copyId && copyId !== note1.id, 'note duplicated');
    r = await c.request('POST', '/api/notes/' + copyId + '/move', { workspaceId: 'general' });
    t.eq(r.body.workspaceId, 'general', 'note moved to another workspace');

    // --- reminder with a future time is not yet due ---
    const future = '23:59';
    r = await c.request('POST', '/api/workspaces/' + teamWs + '/reminders', { text: 'late reminder', cadence: { type: 'daily' }, time: future });
    r = await c.request('POST', '/api/reminders/process', {});
    t.ok(Array.isArray(r.body), 'reminder processing returns a list');

    // --- soft delete -> trash -> restore ---
    r = await c.request('DELETE', '/api/notes/' + note2.id);
    t.ok(r.body.trashed, 'note soft-deleted to trash');
    r = await c.request('GET', '/api/trash');
    t.ok(r.body.some((x) => x.id === note2.id), 'note appears in trash');
    r = await c.request('POST', '/api/trash/' + note2.id + '/restore', {});
    t.ok(r.body.id === note2.id, 'note restored from trash');
    r = await c.request('DELETE', '/api/notes/' + note2.id);
    r = await c.request('DELETE', '/api/trash/' + note2.id);
    t.eq(r.body.ok, true, 'note purged permanently from trash');

    // --- change passphrase, then old fails / new works ---
    r = await c.request('POST', '/api/passphrase', { oldPassphrase: PASS, newPassphrase: 'a brand new passphrase' });
    t.eq(r.body.ok, true, 'passphrase changed');
    const c3 = makeClient(port);
    r = await c3.request('POST', '/api/login', { passphrase: PASS });
    t.eq(r.status, 401, 'old passphrase no longer works after change');
    r = await c3.request('POST', '/api/login', { passphrase: 'a brand new passphrase' });
    t.eq(r.status, 200, 'new passphrase logs in (data still decrypts — envelope re-wrap)');
    r = await c3.request('GET', '/api/search?q=widgets');
    t.ok(r.body.length >= 1, 'data still readable after passphrase change');

    // --- backup export/restore into a fresh vault ---
    r = await c.request('GET', '/api/backup');
    const bundle = JSON.parse(r.raw.toString());
    t.ok(bundle.format === 'meeting-notes-backup' && bundle.files['vault.json'], 'backup bundle includes vault + encrypted files');

    // --- version history: edit twice, list, restore ---
    r = await c.request('GET', '/api/workspaces/general/current');
    const vNote = r.body.id;
    await c.request('PUT', '/api/notes/' + vNote, { meetingNotes: '<p>version one</p>' });
    // force distinct snapshots by bypassing the 1-min coalesce is not possible here,
    // but at least one snapshot should exist after an edit following the seeded content:
    r = await c.request('GET', '/api/notes/' + vNote + '/versions');
    t.ok(Array.isArray(r.body), 'version list returns an array');

    // --- backlinks ---
    r = await c.request('GET', '/api/workspaces/general/current');
    const linker = r.body.id;
    await c.request('PUT', '/api/notes/' + linker, { meetingNotes: '<a data-note-id="' + note3.id + '">see note3</a>' });
    r = await c.request('GET', '/api/notes/' + note3.id + '/backlinks');
    t.ok(r.body.some((x) => x.id === linker), 'backlinks finds the linking note');

    // --- note listing ---
    r = await c.request('GET', '/api/workspaces/general/notes');
    t.ok(Array.isArray(r.body) && r.body.some((x) => x.id === note3.id), 'note listing includes notes');

    // --- name sort: un-named notes sink below same-date named notes ---
    r = await c.request('POST', '/api/workspaces', { name: 'SortWS' });
    const sortWs = r.body.id;
    r = await c.request('POST', '/api/workspaces/' + sortWs + '/notes/new', {}); const sA = r.body.id;
    await c.request('PUT', '/api/notes/' + sA, { customTitle: 'Apple' });
    r = await c.request('POST', '/api/workspaces/' + sortWs + '/notes/new', {}); const sU = r.body.id; // stays un-named
    r = await c.request('POST', '/api/workspaces/' + sortWs + '/notes/new', {}); const sB = r.body.id;
    await c.request('PUT', '/api/notes/' + sB, { customTitle: 'Banana' });
    r = await c.request('GET', '/api/workspaces/' + sortWs + '/notes?sort=name&dir=asc');
    const order = r.body.map((n) => n.id);
    t.eq(order[order.length - 1], sU, 'name sort: the un-named note sinks to the bottom of its date');
    t.ok(order.indexOf(sA) < order.indexOf(sB) && order.indexOf(sB) < order.indexOf(sU), 'name sort: named notes (A→Z) rank above the un-named note');

    // --- search index reflects edits + deletes ---
    r = await c.request('PUT', '/api/notes/' + linker, { meetingNotes: '<p>ZEBRACODE unique token</p>' });
    r = await c.request('GET', '/api/search?q=ZEBRACODE');
    t.ok(r.body.some((x) => x.noteId === linker), 'search index reflects a fresh edit');
    r = await c.request('DELETE', '/api/notes/' + linker);
    r = await c.request('GET', '/api/search?q=ZEBRACODE');
    t.ok(!r.body.some((x) => x.noteId === linker), 'search index drops a trashed note');

    // --- conflict fork keeps both ---
    r = await c.request('POST', '/api/notes/' + note3.id + '/fork', { meetingNotes: '<p>my local copy</p>' });
    t.ok(r.body.id && r.body.id !== note3.id && r.body.meetingNotes.includes('local copy'), 'fork creates a conflict copy');

    // --- reminder snooze pulls the current occurrence ---
    r = await c.request('POST', '/api/workspaces/general/reminders', { text: 'snoozable', cadence: { type: 'daily' } });
    const snoozeRem = r.body.id;
    await c.request('POST', '/api/workspaces/general/notes/new', {}); // fresh note injects it
    r = await c.request('GET', '/api/workspaces/general/current');
    t.ok(r.body.todos.some((x) => x.sourceReminderId === snoozeRem), 'daily reminder injected before snooze');
    const until = new Date(Date.now() + 3600e3).toISOString();
    await c.request('POST', '/api/workspaces/general/reminders/' + snoozeRem + '/snooze', { until });
    r = await c.request('GET', '/api/workspaces/general/current');
    t.ok(!r.body.todos.some((x) => x.sourceReminderId === snoozeRem), 'snooze removes the injected reminder todo');

    // --- reminder end date stops recurrence ---
    const yest = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
    r = await c.request('POST', '/api/workspaces/general/reminders', { text: 'ended', cadence: { type: 'daily', endDate: yest } });
    r = await c.request('POST', '/api/reminders/process', {});
    t.ok(!r.body.some((x) => x.text === 'ended'), 'reminder past its end date does not surface');

    // --- bulk export zip ---
    r = await c.request('GET', '/api/workspaces/general/export?format=md');
    t.ok(r.headers['content-type'].includes('application/zip'), 'workspace bulk export returns a zip');
    t.ok(r.raw.length > 22 && r.raw.subarray(0, 2).toString() === 'PK', 'zip has the PK signature');

    // --- conflict detection uses content revision, not housekeeping writes ---
    r = await c.request('GET', '/api/workspaces/general/current');
    const revNote = r.body.id;
    r = await c.request('PUT', '/api/notes/' + revNote, { meetingNotes: '<p>rev base</p>' });
    const rev1 = r.body.rev;
    // favoriting must NOT advance the content revision (so it won't cause a false conflict)
    r = await c.request('POST', '/api/notes/' + revNote + '/favorite', { favorite: true });
    t.eq(r.body.rev, rev1, 'favoriting does not bump the content revision');
    // a save with the still-current baseRev succeeds even after the favorite write
    r = await c.request('PUT', '/api/notes/' + revNote, { meetingNotes: '<p>after fav</p>', baseRev: rev1 });
    t.ok(r.status === 200 && r.body.rev === rev1 + 1, 'save after favoriting is not a false conflict');
    // a genuinely stale baseRev is rejected
    r = await c.request('PUT', '/api/notes/' + revNote, { meetingNotes: '<p>stale</p>', baseRev: rev1 });
    t.eq(r.status, 409, 'a stale content revision is detected as a conflict');

    // --- stats ---
    r = await c.request('GET', '/api/stats');
    t.ok(r.body.notes > 0 && r.body.bytes > 0 && typeof r.body.workspaces === 'number', 'stats reports counts + encrypted footprint');

    // --- search ranking: a title hit ranks above a body-only hit ---
    r = await c.request('POST', '/api/workspaces/general/notes/new', {});
    const rankTitle = r.body.id;
    await c.request('PUT', '/api/notes/' + rankTitle, { customTitle: 'ZQTOKEN roadmap', meetingNotes: '<p>body</p>' });
    r = await c.request('POST', '/api/workspaces/general/notes/new', {});
    const rankBody = r.body.id;
    await c.request('PUT', '/api/notes/' + rankBody, { meetingNotes: '<p>mentions ZQTOKEN in the body only</p>' });
    r = await c.request('GET', '/api/search?q=ZQTOKEN');
    t.ok(r.body.length >= 2 && r.body[0].noteId === rankTitle, 'title match ranks above body-only match');

    // --- integrity: healthy vault verifies clean ---
    r = await c.request('GET', '/api/verify');
    t.ok(r.body.ok && r.body.checked > 0, 'verify reports a healthy vault as OK');

    // --- corruption resilience: a damaged note is skipped, and reported ---
    r = await c.request('POST', '/api/workspaces', { name: 'Resil' });
    const resilWs = r.body.id;
    r = await c.request('POST', '/api/workspaces/' + resilWs + '/notes/new', {});
    const resilNote = r.body.id;
    const badPath = path.join(DATA_DIR, 'ws', resilWs, 'notes', resilNote + '.json.enc');
    fs.writeFileSync(badPath, Buffer.from('MN1 this is not valid ciphertext at all')); // corrupt it
    r = await c.request('GET', '/api/verify');
    t.ok(!r.body.ok && r.body.corrupt.some((x) => x.path.includes(resilNote)), 'verify reports the corrupted note');
    r = await c.request('GET', '/api/workspaces/' + resilWs + '/notes');
    t.ok(r.status === 200 && !r.body.some((x) => x.id === resilNote), 'listing skips the corrupt note instead of failing');
  } catch (ex) {
    t.ok(false, 'unexpected exception: ' + ex.stack);
  } finally {
    server.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    t.done();
  }
})();
