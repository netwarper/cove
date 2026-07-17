'use strict';
/* Tiny zero-dependency test helpers: an HTTP client with a cookie jar and
 * a minimal assertion harness. */
const http = require('http');

function makeClient(port) {
  let cookie = '';
  function request(method, path, body, rawBodyBuf) {
    return new Promise((resolve, reject) => {
      let data = null;
      const headers = {};
      if (rawBodyBuf) { data = rawBodyBuf; headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      else if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      if (cookie) headers.Cookie = cookie;
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const sc = res.headers['set-cookie'];
          if (sc) cookie = sc.map((s) => s.split(';')[0]).join('; ');
          const buf = Buffer.concat(chunks);
          const ct = res.headers['content-type'] || '';
          let parsed = buf;
          if (ct.includes('application/json')) { try { parsed = JSON.parse(buf.toString()); } catch (_e) { parsed = buf.toString(); } }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw: buf });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  return { request, clearCookie: () => { cookie = ''; } };
}

function harness(name) {
  let pass = 0, fail = 0;
  const fails = [];
  function ok(cond, msg) {
    if (cond) { pass++; }
    else { fail++; fails.push(msg); console.log('  ✗ ' + msg); }
  }
  function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ')'); }
  function done() {
    console.log('\n' + name + ': ' + pass + ' passed, ' + fail + ' failed');
    if (fail) { process.exitCode = 1; }
    return fail === 0;
  }
  return { ok, eq, done };
}

module.exports = { makeClient, harness };
