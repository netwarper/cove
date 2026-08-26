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

  // Yearly / annual recurrence.
  t.eq(parse('renew domain yearly').recurrence, { type: 'yearly' }, 'parses "yearly"');
  t.eq(parse('pay taxes annually').recurrence, { type: 'yearly' }, 'parses "annually"');
  t.eq(parse('review policy annual').recurrence, { type: 'yearly' }, 'parses "annual"');
  t.eq(parse('anniversary every year').recurrence, { type: 'yearly' }, 'parses "every year"');
  t.eq(parse('check filters every 2 years').recurrence, { type: 'yearly', n: 2 }, 'parses "every 2 years" -> yearly n=2');
  t.eq(parse('audit every other year').recurrence, { type: 'yearly', n: 2 }, 'parses "every other year" -> yearly n=2');
  t.eq(parse('renew domain yearly').text.trim(), 'renew domain', 'strips "yearly" from the text');

  // Regression: the plain phrases still parse without an interval.
  t.eq(parse('sync weekly').recurrence, { type: 'weekly' }, 'plain "weekly" stays interval-less');
  t.eq(parse('report monthly').recurrence, { type: 'monthly' }, 'plain "monthly" stays interval-less');
  t.eq(parse('water plants every 3 days').recurrence, { type: 'everyNDays', n: 3 }, 'existing "every N days" unaffected');

  // Regression: a weekday must be a whole word — a longer word that merely STARTS
  // with a day prefix ("Saturn", "Monkey", "Sunflower") must NOT set a due date.
  t.ok(parse('sat').due, '"sat" (whole word) still sets a Saturday due date');
  t.ok(parse('buy saturday').due, '"saturday" still parses');
  t.eq(parse('research Saturn').due, null, '"Saturn" does NOT parse as Saturday');
  t.eq(parse('research Saturn').text.trim(), 'research Saturn', '"Saturn" is kept in the task text');
  t.eq(parse('feed the monkey').due, null, '"monkey" does NOT parse as Monday');
  t.eq(parse('water the sunflower').due, null, '"sunflower" does NOT parse as Sunday');
  t.eq(parse('call every saturn').recurrence, null, '"every saturn" is NOT a weekly recurrence');
  t.eq(parse('gym every saturday').recurrence, { type: 'weekly', days: [6] }, '"every saturday" still recurs weekly');
  // Same fix for month names: a longer word starting with a month prefix must not match.
  t.eq(parse('call the janitor 5').due, null, '"janitor 5" does NOT parse as January 5');
  t.ok(parse('ship jan 5').due, '"jan 5" still parses as a January date');
} catch (ex) {
  t.ok(false, 'unexpected exception: ' + ex.stack);
} finally {
  t.done();
}
