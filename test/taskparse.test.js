'use strict';
/* Natural-language quick-add parser (public/js/taskparse.js) — recurrence.
 * The parser is browser code (an IIFE that assigns window.TaskParse); we load
 * it here with a minimal `window` shim so the pure parsing logic can be tested
 * in Node without a browser. */
const fs = require('fs');
const path = require('path');
const { harness } = require('./helpers');

const t = harness('taskparse');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'taskparse.js'), 'utf8');
const win = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const parse = win.TaskParse.parse;

try {
  let r = parse('email Sam every 2 weeks');
  t.eq(r.recurrence, { type: 'weekly', n: 2 }, 'parses "every 2 weeks" -> weekly n=2');
  t.eq(r.text.trim(), 'email Sam', 'strips the recurrence phrase from the text');

  r = parse('pay rent every 3 months');
  t.eq(r.recurrence, { type: 'monthly', n: 3 }, 'parses "every 3 months" -> monthly n=3');

  r = parse('standup every other week');
  t.eq(r.recurrence, { type: 'weekly', n: 2 }, 'parses "every other week" -> weekly n=2');

  r = parse('review every other month');
  t.eq(r.recurrence, { type: 'monthly', n: 2 }, 'parses "every other month" -> monthly n=2');

  // Regression: the plain phrases still parse without an interval.
  t.eq(parse('sync weekly').recurrence, { type: 'weekly' }, 'plain "weekly" stays interval-less');
  t.eq(parse('report monthly').recurrence, { type: 'monthly' }, 'plain "monthly" stays interval-less');
  t.eq(parse('water plants every 3 days').recurrence, { type: 'everyNDays', n: 3 }, 'existing "every N days" unaffected');
} catch (ex) {
  t.ok(false, 'unexpected exception: ' + ex.stack);
} finally {
  t.done();
}
