'use strict';
/* Transcription proxy: multipart forwarding, response parsing, and the
 * authenticated /api/transcribe endpoint driven against a fake STT server. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const transcribe = require('../lib/transcribe');
const { makeClient, harness } = require('./helpers');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-tr-'));
process.env.DATA_DIR = DATA_DIR;
process.env.HOST = '127.0.0.1';
const { server } = require('../server');
const t = harness('transcribe');

// A fake OpenAI-compatible STT endpoint that echoes what it received.
let received = null;
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    received = { auth: req.headers.authorization, ctype: req.headers['content-type'], hasModel: body.includes(Buffer.from('name="model"')), hasFile: body.includes(Buffer.from('filename=')), bytes: body.length };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'hello from stt' }));
  });
});

(async function run() {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sttUrl = 'http://127.0.0.1:' + fake.address().port + '/v1/audio/transcriptions';
  const port = server.address().port;
  const c = makeClient(port);

  try {
    // ---- unit: response shape parsing ----
    t.eq(transcribe.extractText('{"text":"a b"}'), 'a b', 'parses OpenAI {text}');
    t.eq(transcribe.extractText('{"segments":[{"text":"a"},{"text":"b"}]}'), 'a b', 'parses whisper.cpp segments');
    t.eq(transcribe.extractText('{"results":{"channels":[{"alternatives":[{"transcript":"deep"}]}]}}'), 'deep', 'parses Deepgram shape');

    // ---- unit: direct call forwards multipart with auth + model + file ----
    const audio = Buffer.from('fake-opus-bytes-1234567890');
    const out = await transcribe.transcribe({ endpoint: sttUrl, apiKey: 'sk-test', model: 'whisper-1' }, { audio, mime: 'audio/webm', filename: 'you.webm' });
    t.eq(out.text, 'hello from stt', 'transcribe returns the STT text');
    t.ok(received && received.auth === 'Bearer sk-test', 'forwards the Authorization header');
    t.ok(received.ctype.indexOf('multipart/form-data') === 0 && received.hasModel && received.hasFile, 'sends multipart with model + file');

    // ---- no endpoint configured -> rejects 400 ----
    let rej = null; try { await transcribe.transcribe({}, { audio }); } catch (e) { rej = e; }
    t.ok(rej && rej.status === 400, 'no endpoint configured rejects with 400');

    // ---- full path: setup, configure endpoint, POST /api/transcribe ----
    let r = await c.request('POST', '/api/setup', { passphrase: 'transcribe test pass' });
    t.eq(r.status, 200, 'setup ok');
    r = await c.request('PUT', '/api/settings', { transcription: { endpoint: sttUrl, apiKey: 'sk-x', model: 'whisper-1' } });
    t.ok(r.body.transcription && r.body.transcription.endpoint === sttUrl, 'transcription settings saved (encrypted at rest)');
    r = await c.request('POST', '/api/transcribe', { audioB64: audio.toString('base64'), mime: 'audio/webm', filename: 'them.webm', source: 'them' });
    t.ok(r.status === 200 && r.body.text === 'hello from stt', 'POST /api/transcribe proxies to the STT endpoint');

    // ---- transcript persists on the note ----
    r = await c.request('POST', '/api/workspaces/general/notes/new', {});
    const noteId = r.body.id;
    r = await c.request('PUT', '/api/notes/' + noteId, { transcript: [{ t: 1, source: 'you', text: 'hi' }, { t: 2, source: 'them', text: 'hello' }] });
    t.eq(r.body.transcript.length, 2, 'transcript is stored on the note');
    t.eq(r.body.transcript[1].source, 'them', 'transcript keeps the source label');

    // ---- settings config that leaves endpoint empty -> transcribe 400 ----
    await c.request('PUT', '/api/settings', { transcription: { endpoint: '' } });
    r = await c.request('POST', '/api/transcribe', { audioB64: audio.toString('base64') });
    t.eq(r.status, 400, 'transcribe with no endpoint returns 400 (recording still works, nothing sent)');
  } catch (ex) {
    t.ok(false, 'unexpected exception: ' + ex.stack);
  } finally {
    server.close(); fake.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    t.done();
  }
})();
