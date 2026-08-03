'use strict';

/*
 * Task helpers — pure functions for the unified Tasks module (Todoist-style).
 * Recurrence math is UTC-anchored to match lib/store.js's date helpers.
 */

function pad(n) { return String(n).padStart(2, '0'); }
function todayISO() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

// ---- Timezone-aware "wall clock" helpers (zero-dep, via Intl) ----------
// Compute the calendar date / time as seen in a given IANA timezone (e.g.
// "America/New_York"). A falsy or invalid tz falls back to the server's local
// clock, so this is always safe to call. Used so "today", daily-note dates, and
// reminder firing follow the USER's timezone even when the server runs elsewhere.
function tzParts(tz, date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(date || new Date())) p[part.type] = part.value;
  return p;
}
function todayISOInTz(tz, date) {
  if (!tz) return todayISO();
  try { const p = tzParts(tz, date); return p.year + '-' + p.month + '-' + p.day; }
  catch (_e) { return todayISO(); } // unknown tz name → server local
}
function hhmmInTz(tz, date) {
  const d = date || new Date();
  if (!tz) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  try { const p = tzParts(tz, d); return (p.hour === '24' ? '00' : p.hour) + ':' + p.minute; }
  catch (_e) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
}
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch (_e) { return false; }
}
function addDays(iso, days) { const d = new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function dowUTC(iso) { return new Date(Date.parse(iso + 'T00:00:00Z')).getUTCDay(); } // 0=Sun … 6=Sat

function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function normDate(s) { return isDate(s) ? s : null; }
function normTime(t) { const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || '').trim()); return m ? pad(m[1]) + ':' + m[2] : null; }
function normPriority(p) { p = parseInt(p, 10); return (p >= 1 && p <= 4) ? p : 4; }

const REC_TYPES = ['daily', 'weekdays', 'weekly', 'monthly', 'everyNDays'];
function normalizeRecurrence(r) {
  if (!r || !r.type || r.type === 'none' || !REC_TYPES.includes(r.type)) return null;
  const out = { type: r.type };
  if (r.type === 'everyNDays') out.n = Math.max(1, parseInt(r.n, 10) || 1);
  if (r.type === 'weekly' && Array.isArray(r.days) && r.days.length) out.days = r.days.filter((d) => d >= 0 && d <= 6);
  // Interval multiplier for weekly/monthly ("every 2 weeks", "every 3 months").
  // Stored only when > 1 so existing single-interval objects are unchanged.
  if (r.type === 'weekly' || r.type === 'monthly') {
    const n = parseInt(r.n, 10);
    if (n >= 2) out.n = n;
  }
  if (isDate(r.endDate)) out.endDate = r.endDate;
  return out;
}

/** The next due date strictly AFTER `due`, or null once a bounded recurrence ends. */
function nextDue(due, rec) {
  rec = normalizeRecurrence(rec);
  if (!rec || !isDate(due)) return null;
  let next = null;
  if (rec.type === 'daily') next = addDays(due, 1);
  else if (rec.type === 'weekdays') { let cur = addDays(due, 1); while (dowUTC(cur) === 0 || dowUTC(cur) === 6) cur = addDays(cur, 1); next = cur; }
  else if (rec.type === 'everyNDays') next = addDays(due, rec.n);
  else if (rec.type === 'weekly') {
    // A specific day-of-week list keeps the "next matching day" behaviour (at
    // interval 1); otherwise advance a whole number of weeks (n defaults to 1).
    if (rec.days && rec.days.length) { for (let i = 1; i <= 7 && !next; i++) { const c = addDays(due, i); if (rec.days.indexOf(dowUTC(c)) >= 0) next = c; } }
    if (!next) next = addDays(due, 7 * (rec.n || 1));
  } else if (rec.type === 'monthly') {
    const parts = due.split('-').map(Number); let ny = parts[0], nm = parts[1] + (rec.n || 1);
    while (nm > 12) { nm -= 12; ny++; }
    const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    next = ny + '-' + pad(nm) + '-' + pad(Math.min(parts[2], dim));
  }
  if (rec.endDate && next && next > rec.endDate) return null;
  return next;
}

function describeRecurrence(rec) {
  rec = normalizeRecurrence(rec);
  if (!rec) return '';
  if (rec.type === 'daily') return 'every day';
  if (rec.type === 'weekdays') return 'every weekday';
  if (rec.type === 'weekly') return rec.n > 1 ? 'every ' + rec.n + ' weeks' : (rec.days && rec.days.length ? 'weekly' : 'every week');
  if (rec.type === 'monthly') return rec.n > 1 ? 'every ' + rec.n + ' months' : 'every month';
  if (rec.type === 'everyNDays') return 'every ' + rec.n + ' days';
  return '';
}

/** Map a legacy reminder cadence to a task recurrence (for migration). */
function cadenceToRecurrence(cad) {
  if (!cad || cad.type === 'once') return null;
  if (cad.type === 'everyNDays') return { type: 'everyNDays', n: Math.max(1, parseInt(cad.n, 10) || 1), endDate: cad.endDate };
  if (['daily', 'weekly', 'monthly'].indexOf(cad.type) >= 0) return { type: cad.type, endDate: cad.endDate };
  return null;
}

module.exports = { todayISO, todayISOInTz, hhmmInTz, isValidTimezone, addDays, dowUTC, normDate, normTime, normPriority, normalizeRecurrence, nextDue, describeRecurrence, cadenceToRecurrence };
