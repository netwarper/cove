'use strict';

/*
 * Outbound Slack — post to an Incoming Webhook.
 *
 * The browser can't POST to hooks.slack.com (strict CSP: connect-src 'self'),
 * so the server proxies it here. The webhook URL is owner-configured (settings
 * or the SLACK_WEBHOOK_URL env). Node core http/https only, zero dependencies.
 */

const http = require('http');
const https = require('https');

function postWebhook(webhookUrl, text) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(webhookUrl); } catch (_e) { reject(Object.assign(new Error('invalid Slack webhook URL'), { status: 400 })); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify({ text: String(text || '') }), 'utf8');
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { reject(Object.assign(new Error('Slack HTTP ' + res.statusCode + ': ' + t.slice(0, 200)), { status: 502 })); return; }
        resolve({ ok: true });
      });
    });
    req.on('error', (e) => reject(Object.assign(new Error('Slack post failed: ' + e.message), { status: 502 })));
    req.setTimeout(15000, () => req.destroy(new Error('Slack post timed out')));
    req.write(body);
    req.end();
  });
}

/** Build a Slack-mrkdwn agenda from global to-dos (those with due dates). */
function formatAgenda(todos, today) {
  const dated = (todos || []).filter((t) => t.due);
  const overdue = dated.filter((t) => t.due < today).sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  const due = dated.filter((t) => t.due === today);
  const lines = ['🗒️ *Meeting Notes — agenda for ' + today + '*'];
  const fmt = (t) => '• [' + t.workspaceName + '] ' + t.text + (t.due !== today ? ' _(due ' + t.due + ')_' : '');
  if (!overdue.length && !due.length) {
    lines.push('', 'No dated to-dos due. 🎉');
  } else {
    if (overdue.length) { lines.push('', '*Overdue*'); overdue.forEach((t) => lines.push(fmt(t))); }
    if (due.length) { lines.push('', '*Today*'); due.forEach((t) => lines.push(fmt(t))); }
  }
  return lines.join('\n');
}

module.exports = { postWebhook, formatAgenda };
