/* Deterministic (no-LLM) quick-add parser, Todoist-style.
 *
 * parse("email Sam tomorrow p1 every friday") ->
 *   { text:"email Sam", due:"YYYY-MM-DD", time:null, priority:1,
 *     recurrence:{type:"weekly",days:[5]}, matched:{...} }
 *
 * Dates are computed in the browser's local timezone. Tokens that are recognised
 * are stripped from the text so the task name stays clean. */
(function () {
  'use strict';
  var DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  var MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function nextDow(fromDate, dow, forceNextWeek) {
    var delta = (dow - fromDate.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // "monday" means the upcoming one, not today
    if (forceNextWeek && delta <= 7) delta += (delta === 7 ? 0 : 0); // "next monday" ~ upcoming; keep simple
    return addDays(fromDate, delta);
  }

  function parse(input) {
    var text = ' ' + String(input || '') + ' ';
    var res = { text: '', due: null, time: null, priority: 4, recurrence: null, matched: {} };
    function strip(re) { text = text.replace(re, ' '); }

    // ---- priority: p1..p4 or !!1 style ----
    var pm = /\s(?:p([1-4])|!!?([1-4]))\b/i.exec(text);
    if (pm) { res.priority = parseInt(pm[1] || pm[2], 10); res.matched.priority = true; strip(pm[0]); text = ' ' + text.trim() + ' '; }

    // ---- recurrence (also sets an initial due where implied) ----
    var m;
    if ((m = /\severy\s+(\d+)\s+days?\b/i.exec(text))) { res.recurrence = { type: 'everyNDays', n: parseInt(m[1], 10) }; res.matched.recurrence = true; strip(m[0]); }
    else if ((m = /\severy\s+(\d+)\s+weeks?\b/i.exec(text))) { res.recurrence = { type: 'weekly', n: parseInt(m[1], 10) }; res.matched.recurrence = true; strip(m[0]); }
    else if ((m = /\severy\s+(\d+)\s+months?\b/i.exec(text))) { res.recurrence = { type: 'monthly', n: parseInt(m[1], 10) }; res.matched.recurrence = true; strip(m[0]); }
    else if ((m = /\severy\s+other\s+weeks?\b/i.exec(text))) { res.recurrence = { type: 'weekly', n: 2 }; res.matched.recurrence = true; strip(m[0]); }
    else if ((m = /\severy\s+other\s+months?\b/i.exec(text))) { res.recurrence = { type: 'monthly', n: 2 }; res.matched.recurrence = true; strip(m[0]); }
    else if (/\severy\s+weekday(s)?\b/i.test(text)) { res.recurrence = { type: 'weekdays' }; res.matched.recurrence = true; strip(/\severy\s+weekday(s)?\b/i); }
    else if (/\s(every\s+day|daily)\b/i.test(text)) { res.recurrence = { type: 'daily' }; res.matched.recurrence = true; strip(/\s(every\s+day|daily)\b/i); }
    else if (/\s(every\s+week|weekly)\b/i.test(text)) { res.recurrence = { type: 'weekly' }; res.matched.recurrence = true; strip(/\s(every\s+week|weekly)\b/i); }
    else if (/\s(every\s+month|monthly)\b/i.test(text)) { res.recurrence = { type: 'monthly' }; res.matched.recurrence = true; strip(/\s(every\s+month|monthly)\b/i); }
    else if ((m = /\severy\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)\b/i.exec(text))) {
      var wd = DOW[m[1].toLowerCase().slice(0, 3)];
      res.recurrence = { type: 'weekly', days: [wd] }; res.matched.recurrence = true; strip(m[0]);
      if (!res.due) res.due = iso(nextDow(today(), wd));
    }

    // ---- time (5pm, 5:30 pm, at 17:00) ----
    if ((m = /\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text))) {
      var h = parseInt(m[1], 10) % 12; if (/pm/i.test(m[3])) h += 12;
      res.time = pad(h) + ':' + (m[2] || '00'); res.matched.time = true; strip(m[0]);
    } else if ((m = /\sat\s+(\d{1,2}):(\d{2})\b/.exec(text))) {
      res.time = pad(m[1]) + ':' + m[2]; res.matched.time = true; strip(m[0]);
    }

    // ---- explicit / relative dates (only if not already implied by recurrence) ----
    if (!res.due) {
      if ((m = /\sin\s+(\d+)\s+days?\b/i.exec(text))) { res.due = iso(addDays(today(), parseInt(m[1], 10))); res.matched.due = true; strip(m[0]); }
      else if (/\stoday\b/i.test(text)) { res.due = iso(today()); res.matched.due = true; strip(/\stoday\b/i); }
      else if (/\s(tomorrow|tmr|tom)\b/i.test(text)) { res.due = iso(addDays(today(), 1)); res.matched.due = true; strip(/\s(tomorrow|tmr|tom)\b/i); }
      else if (/\snext\s+week\b/i.test(text)) { res.due = iso(addDays(today(), 7)); res.matched.due = true; strip(/\snext\s+week\b/i); }
      else if ((m = /\s(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)\b/i.exec(text))) {
        res.due = iso(nextDow(today(), DOW[m[2].toLowerCase().slice(0, 3)])); res.matched.due = true; strip(m[0]);
      } else if ((m = /\s(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?\s+(\d{1,2})\b/i.exec(text))) {
        res.due = dateFromMonth(MON[m[1].toLowerCase().slice(0, 3)], parseInt(m[2], 10)); res.matched.due = true; strip(m[0]);
      } else if ((m = /\s(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b/i.exec(text))) {
        res.due = dateFromMonth(MON[m[2].toLowerCase().slice(0, 3)], parseInt(m[1], 10)); res.matched.due = true; strip(m[0]);
      } else if ((m = /\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text))) {
        var y = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : today().getFullYear();
        var dd = new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
        if (!m[3] && dd < today()) dd = new Date(y + 1, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
        res.due = iso(dd); res.matched.due = true; strip(m[0]);
      }
    }

    res.text = text.replace(/\s{2,}/g, ' ').trim();
    return res;
  }

  function dateFromMonth(monthIdx, day) {
    var t = today(); var d = new Date(t.getFullYear(), monthIdx, day);
    if (d < t) d = new Date(t.getFullYear() + 1, monthIdx, day); // roll to next year if past
    var pad2 = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  window.TaskParse = { parse: parse };
})();
