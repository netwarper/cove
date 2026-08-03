'use strict';

/*
 * Meeting summary proxy.
 *
 * The browser sends a note's meeting text (notes + transcript) to the local
 * server, which forwards it to an OpenAI-compatible /chat/completions endpoint
 * and returns a short summary plus extracted action items. Like transcription
 * this design:
 *   - keeps the API key server-side (stored encrypted in settings), and
 *   - works within the app's strict CSP (the page only talks to same-origin).
 *
 * The endpoint is whatever the user configures — a LOCAL LLM server (private,
 * stays on the machine) or a cloud provider (opt-in). If nothing is configured,
 * the feature is simply hidden and no text is ever sent anywhere.
 *
 * Uses Node core http/https only (zero dependencies).
 */

const http = require('http');
const https = require('https');

const MAX_INPUT = 24000; // clamp very long meetings so a request can't balloon

const SYSTEM_PROMPT =
  'You summarize meeting notes and transcripts. Reply with ONLY a JSON object, no prose, ' +
  'no markdown fences, of the form: ' +
  '{"summary": string, "actionItems": [{"text": string, "due": string}]}. ' +
  'The summary is a concise plain-text recap (a few sentences or short bullet lines, no markdown). ' +
  'actionItems lists concrete follow-ups/tasks mentioned or implied; "text" is a short imperative task, ' +
  'and "due" is a due date if one was stated (natural language like "friday" or "2026-08-10" is fine), ' +
  'otherwise an empty string. Return an empty actionItems array if there are none.';

/**
 * Summarize meeting text via the configured chat endpoint.
 * @param {{endpoint:string, apiKey?:string, model?:string}} cfg
 * @param {{text:string, title?:string}} input
 * @returns {Promise<{summary:string, actionItems:Array<{text:string, due:string}>}>}
 */
function summarize(cfg, input) {
  return new Promise((resolve, reject) => {
    if (!cfg || !cfg.endpoint) { reject(Object.assign(new Error('summary endpoint not configured'), { status: 400 })); return; }
    const text = String((input && input.text) || '').slice(0, MAX_INPUT).trim();
    if (!text) { reject(Object.assign(new Error('nothing to summarize'), { status: 400 })); return; }
    let url;
    try { url = new URL(cfg.endpoint); } catch (_e) { reject(Object.assign(new Error('invalid summary endpoint'), { status: 400 })); return; }
    const lib = url.protocol === 'https:' ? https : http;

    const title = String((input && input.title) || '').trim();
    const userContent = (title ? ('Meeting: ' + title + '\n\n') : '') + text;
    const payload = JSON.stringify({
      model: cfg.model || 'gpt-4o-mini',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    const body = Buffer.from(payload, 'utf8');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': body.length };
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;

    const request = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { reject(Object.assign(new Error('summary HTTP ' + res.statusCode + ': ' + raw.slice(0, 200)), { status: 502 })); return; }
        resolve(extractResult(raw));
      });
    });
    request.on('error', (e) => reject(Object.assign(new Error('summary request failed: ' + e.message), { status: 502 })));
    request.setTimeout(60000, () => request.destroy(new Error('summary request timed out')));
    request.write(body);
    request.end();
  });
}

/** Pull {summary, actionItems} out of an OpenAI-compatible chat response (or a direct shape). */
function extractResult(raw) {
  let j;
  try { j = JSON.parse(raw); } catch (_e) { return normalize({ summary: raw }); }
  // OpenAI/local chat shape: choices[0].message.content holds our JSON string.
  let content = null;
  try { content = j.choices[0].message.content; } catch (_e) { /* not chat shape */ }
  if (content == null) {
    // Some proxies return the object directly.
    if (typeof j.summary === 'string' || Array.isArray(j.actionItems)) return normalize(j);
    return normalize({ summary: '' });
  }
  if (typeof content !== 'string') return normalize({ summary: '' });
  return normalize(parseLoose(content));
}

/** Parse a model's content string into an object, tolerating ```json fences / stray prose. */
function parseLoose(content) {
  const s = String(content || '').trim();
  try { return JSON.parse(s); } catch (_e) { /* try to salvage */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_e) { /* fall through */ }
  }
  return { summary: s, actionItems: [] };
}

function normalize(o) {
  o = o || {};
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  const rawItems = Array.isArray(o.actionItems) ? o.actionItems : (Array.isArray(o.action_items) ? o.action_items : []);
  const actionItems = rawItems.map((it) => {
    if (typeof it === 'string') return { text: it.trim(), due: '' };
    const text = String((it && (it.text || it.task || it.title)) || '').trim();
    const due = String((it && (it.due || it.dueDate || it.when)) || '').trim();
    return { text, due };
  }).filter((it) => it.text);
  return { summary, actionItems };
}

module.exports = { summarize, extractResult, parseLoose, normalize };
