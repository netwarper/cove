'use strict';
/* Meeting-summary proxy: response parsing, and the authenticated /api/summarize
 * endpoint driven against a fake OpenAI-compatible chat server. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const summarize = require('../lib/summarize');
const { makeClient, harness } = require('./helpers');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sum-'));
process.env.DATA_DIR = DATA_DIR;
process.env.HOST = '127.0.0.1';
const { server } = require('../server');
const t = harness('summarize');

// A fake chat/completions endpoint that captures the request and returns a
// JSON-object assistant message (OpenAI shape).
let received = null;
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_e) {}
    received = { auth: req.headers.authorization, ctype: req.headers['content-type'], body };
    const content = JSON.stringify({
      summary: 'Team agreed to ship the beta on Friday.',
      actionItems: [{ text: 'Send the beta invite', due: 'friday' }, { text: 'Write release notes', due: '' }],
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

(async function run() {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sumUrl = 'http://127.0.0.1:' + fake.address().port + '/v1/chat/completions';
  const c = makeClient(server.address().port);

  try {
    // ---- unit: parse the OpenAI chat shape (content is a JSON string) ----
    const chatRaw = JSON.stringify({ choices: [{ message: { content: '{"summary":"S","actionItems":[{"text":"do it","due":"mon"}]}' } }] });
    let out = summarize.extractResult(chatRaw);
    t.eq(out.summary, 'S', 'parses summary from chat content');
    t.eq(out.actionItems, [{ text: 'do it', due: 'mon' }], 'parses action items from chat content');

    // ---- unit: tolerate ```json fences around the content ----
    const fenced = JSON.stringify({ choices: [{ message: { content: '```json\n{"summary":"F","actionItems":[]}\n```' } }] });
    t.eq(summarize.extractResult(fenced).summary, 'F', 'strips ```json fences');

    // ---- unit: string action items and action_items alias normalize ----
    t.eq(summarize.normalize({ summary: 'x', action_items: ['a', 'b'] }).actionItems,
      [{ text: 'a', due: '' }, { text: 'b', due: '' }], 'normalizes string items + action_items alias');

    // ---- unit: non-JSON content falls back to a summary with no items ----
    const plain = JSON.stringify({ choices: [{ message: { content: 'just a sentence' } }] });
    t.eq(summarize.extractResult(plain), { summary: 'just a sentence', actionItems: [] }, 'plain text becomes the summary');

    // ---- unit: direct call forwards JSON with auth + model ----
    out = await summarize.summarize({ endpoint: sumUrl, apiKey: 'sk-test', model: 'gpt-4o-mini' }, { text: 'notes here', title: 'Sync' });
    t.eq(out.summary, 'Team agreed to ship the beta on Friday.', 'summarize returns the model summary');
    t.eq(out.actionItems.length, 2, 'summarize returns action items');
    t.ok(received && received.auth === 'Bearer sk-test', 'forwards the Authorization header');
    t.ok(received.ctype.indexOf('application/json') === 0 && received.body.model === 'gpt-4o-mini', 'sends JSON with the configured model');
    t.ok(/Sync/.test(JSON.stringify(received.body.messages)) && /notes here/.test(JSON.stringify(received.body.messages)), 'prompt includes title + text');

    // ---- no endpoint / empty text -> 400 ----
    let rej = null; try { await summarize.summarize({}, { text: 'x' }); } catch (e) { rej = e; }
    t.ok(rej && rej.status === 400, 'no endpoint configured rejects with 400');
    rej = null; try { await summarize.summarize({ endpoint: sumUrl }, { text: '   ' }); } catch (e) { rej = e; }
    t.ok(rej && rej.status === 400, 'empty text rejects with 400');

    // ---- full path: setup, configure endpoint, POST /api/summarize ----
    let r = await c.request('POST', '/api/setup', { passphrase: 'summarize test pass' });
    t.eq(r.status, 200, 'setup ok');
    r = await c.request('PUT', '/api/settings', { summary: { endpoint: sumUrl, apiKey: 'sk-x', model: 'gpt-4o-mini' } });
    t.ok(r.body.summary && r.body.summary.endpoint === sumUrl, 'summary settings saved (encrypted at rest)');
    r = await c.request('POST', '/api/summarize', { text: 'We discussed the roadmap.', title: 'Roadmap' });
    t.ok(r.status === 200 && /beta/.test(r.body.summary) && r.body.actionItems.length === 2, 'POST /api/summarize proxies to the chat endpoint');

    // ---- settings with empty endpoint -> 400 ----
    await c.request('PUT', '/api/settings', { summary: { endpoint: '' } });
    r = await c.request('POST', '/api/summarize', { text: 'anything' });
    t.eq(r.status, 400, 'summarize with no endpoint returns 400 (feature simply off)');
  } catch (ex) {
    t.ok(false, 'unexpected exception: ' + ex.stack);
  } finally {
    server.close(); fake.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    t.done();
  }
})();
