'use strict';

/*
 * Transcription proxy.
 *
 * The browser records audio and posts short chunks to the local server, which
 * forwards them to an OpenAI-compatible speech-to-text endpoint. This design:
 *   - keeps the API key server-side (stored encrypted in settings), and
 *   - works within the app's strict CSP (the page only talks to same-origin).
 *
 * The endpoint is whatever the user configures — a LOCAL Whisper server
 * (private, stays on the machine) or a cloud provider (opt-in). If no endpoint
 * is configured, nothing is ever sent anywhere: recording still works and is
 * stored encrypted; only transcription is disabled.
 *
 * Uses Node core http/https only (zero dependencies).
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

function buildMultipart(fields, file) {
  const boundary = '----MeetingNotes' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const k of Object.keys(fields)) {
    if (fields[k] == null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

/**
 * Send one audio chunk to the configured STT endpoint. Returns { text }.
 * @param {{endpoint:string, apiKey?:string, model?:string, language?:string}} cfg
 * @param {{audio:Buffer, mime?:string, filename?:string}} chunk
 */
function transcribe(cfg, chunk) {
  return new Promise((resolve, reject) => {
    if (!cfg || !cfg.endpoint) { reject(Object.assign(new Error('transcription endpoint not configured'), { status: 400 })); return; }
    let url;
    try { url = new URL(cfg.endpoint); } catch (_e) { reject(Object.assign(new Error('invalid transcription endpoint'), { status: 400 })); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const { boundary, body } = buildMultipart(
      { model: cfg.model || 'whisper-1', response_format: 'json', language: cfg.language || null },
      { data: chunk.audio, mime: chunk.mime || 'audio/webm', filename: chunk.filename || 'audio.webm' }
    );
    const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length };
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { reject(Object.assign(new Error('STT HTTP ' + res.statusCode + ': ' + txt.slice(0, 200)), { status: 502 })); return; }
        resolve({ text: extractText(txt) });
      });
    });
    req.on('error', (e) => reject(Object.assign(new Error('STT request failed: ' + e.message), { status: 502 })));
    req.setTimeout(45000, () => req.destroy(new Error('STT request timed out')));
    req.write(body);
    req.end();
  });
}

/** Pull the transcript text out of common STT JSON shapes (OpenAI, whisper.cpp, Deepgram). */
function extractText(raw) {
  let j;
  try { j = JSON.parse(raw); } catch (_e) { return raw.trim(); }
  if (typeof j.text === 'string') return j.text.trim();
  if (Array.isArray(j.segments)) return j.segments.map((s) => s.text || '').join(' ').trim();
  try { // Deepgram
    const alt = j.results.channels[0].alternatives[0];
    if (alt && typeof alt.transcript === 'string') return alt.transcript.trim();
  } catch (_e) { /* not deepgram */ }
  return '';
}

module.exports = { transcribe, buildMultipart, extractText };
