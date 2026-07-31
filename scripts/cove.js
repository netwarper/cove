#!/usr/bin/env node
'use strict';
// Cross-platform start / stop / restart for the Cove server.
//
//   node scripts/cove.js start [--port N]   # launch detached (survives the terminal), wait for health
//   node scripts/cove.js stop               # stop gracefully (SIGTERM, then force only if needed)
//   node scripts/cove.js restart [--port N]  # stop + start
//
// Honors DATA_DIR and PORT (or --port) exactly like server.js. Logs the detached
// server to $LOG (platform default under the user's logs dir). This is the engine
// behind start.bat / stop.bat on Windows; the macOS/Linux shell scripts use the
// same detached-then-health-probe approach.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const readline = require('readline');

const APP_DIR = path.resolve(__dirname, '..');
const SERVER = path.join(APP_DIR, 'server.js');
const config = require(path.join(APP_DIR, 'lib', 'config'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load a local .env (KEY=VALUE) the way the shell launchers do, so DATA_DIR /
// PORT / etc. are honored on every platform. Existing env vars win.
function loadEnv() {
  let txt;
  try { txt = fs.readFileSync(path.join(APP_DIR, '.env'), 'utf8'); } catch (_e) { return; }
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function resolveDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  return config.readDataDirPointer(APP_DIR) || path.join(APP_DIR, 'data');
}

function readLock(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'instance.lock'), 'utf8')); } catch (_e) { return null; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The port to act on: a live instance's lock port wins (attach to what's running);
// otherwise the durable resolved config for this data dir, honoring --port / env.
function resolvePort(dataDir, cliPort) {
  const lock = readLock(dataDir);
  if (lock && lock.port && isAlive(lock.pid)) return lock.port;
  try {
    const cfg = config.resolve(dataDir, process.env, { port: cliPort ? config.validPort(cliPort) : null });
    if (cfg && cfg.port) return cfg.port;
  } catch (_e) { /* fall through */ }
  return (cliPort && config.validPort(cliPort)) || 3000;
}

function logFile() {
  if (process.env.LOG) return process.env.LOG;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Logs', 'cove.log');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Cove', 'cove.log');
  return path.join(os.homedir(), '.cove', 'cove.log');
}

function probe(port) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}

// True if anything is listening on the port (whether or not it's our server).
function portListening(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.setTimeout(1000, () => { s.destroy(); res(false); });
  });
}

function startDetached(dataDir, port) {
  const log = logFile();
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  const env = Object.assign({}, process.env, { DATA_DIR: dataDir, PORT: String(port) });
  const child = spawn(process.execPath, [SERVER], { cwd: APP_DIR, env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  return { pid: child.pid, log };
}

function openBrowser(url) {
  // Best effort — a missing opener (e.g. headless Linux) must never crash us, so
  // swallow both sync throws and async 'error' events.
  const noop = () => {};
  try {
    if (process.platform === 'darwin') execFile('open', [url], noop);
    else if (process.platform === 'win32') { const c = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }); c.on('error', noop); c.unref(); }
    else execFile('xdg-open', [url], noop);
  } catch (_e) { /* best effort */ }
}

function ask(question) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); res(a); });
  });
}

// First run only: offer a durable local domain so the URL/port stay stable.
async function maybePromptDomain(dataDir, cliPort) {
  const hasInstance = fs.existsSync(path.join(dataDir, 'instance.json'));
  if (hasInstance || process.env.PORT || cliPort || !process.stdin.isTTY) return;
  const name = (await ask('Pick a durable local domain for this instance [cove]: ')).trim() || 'cove';
  await new Promise((res) => {
    const c = spawn(process.execPath, [SERVER, '--set-domain', name], { cwd: APP_DIR, env: Object.assign({}, process.env, { DATA_DIR: dataDir }), stdio: 'inherit' });
    c.on('exit', () => res()); c.on('error', () => res());
  });
}

const noop = () => {};
function stopPid(pid) {
  if (process.platform === 'win32') { try { execFile('taskkill', ['/PID', String(pid), '/T'], noop); } catch (_e) {} }
  else { try { process.kill(pid, 'SIGTERM'); } catch (_e) {} }
}
function forceKill(pid) {
  if (process.platform === 'win32') { try { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], noop); } catch (_e) {} }
  else { try { process.kill(pid, 'SIGKILL'); } catch (_e) {} }
}
function clearStaleLock(dataDir) {
  const lp = path.join(dataDir, 'instance.lock');
  try { const l = JSON.parse(fs.readFileSync(lp, 'utf8')); if (!l.pid || !isAlive(l.pid)) fs.rmSync(lp, { force: true }); } catch (_e) { /* ignore */ }
}

async function start(dataDir, cliPort) {
  await maybePromptDomain(dataDir, cliPort);
  const port = resolvePort(dataDir, cliPort);
  const url = `http://127.0.0.1:${port}`;
  console.log('Cove start');
  console.log('  data dir: ' + dataDir);
  console.log('  port:     ' + port);

  if (await probe(port)) {
    console.log(`✅ Cove is already running at ${url}.`);
    openBrowser(url);
    return 0;
  }
  if (await portListening(port)) {
    console.log(`⚠ Port ${port} is in use but isn't answering /api/health.`);
    console.log('   Stop that process first, or start on another port (--port 8080).');
    return 1;
  }

  const { pid, log } = startDetached(dataDir, port);
  console.log(`  starting a detached server (logging to ${log})…`);
  for (let i = 0; i < 30; i++) {
    if (await probe(port)) {
      console.log(`✅ Cove is up (pid ${pid}) at ${url}.`);
      console.log('   You can close this window — the server keeps running.');
      openBrowser(url);
      return 0;
    }
    await sleep(500);
  }
  console.log(`⚠ The server didn't answer /api/health on port ${port} within 15s.`);
  console.log(`   Check the log:  ${log}`);
  return 1;
}

async function stop(dataDir) {
  const port = resolvePort(dataDir, null);
  const lock = readLock(dataDir);
  const pid = lock && lock.pid;
  console.log('Cove stop');
  console.log('  data dir: ' + dataDir);
  console.log('  port:     ' + port);

  if (!pid && !(await portListening(port)) && !(await probe(port))) {
    console.log(`✅ Cove doesn't appear to be running (no lock pid, nothing on port ${port}).`);
    return 0;
  }
  if (pid && isAlive(pid)) {
    console.log(`  stopping pid ${pid}…`);
    stopPid(pid);
    for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(500);
    if (isAlive(pid)) { console.log('    still running after 10s — forcing.'); forceKill(pid); await sleep(500); }
  }
  clearStaleLock(dataDir);
  if (await probe(port) || await portListening(port)) {
    console.log(`⚠ Something is still listening on port ${port} after the stop attempt.`);
    return 1;
  }
  console.log('✅ Cove stopped.');
  return 0;
}

async function restart(dataDir, cliPort) {
  // Preserve the port the server is currently on (its lock may record an
  // ephemeral --port that isn't in the durable config) unless an explicit
  // --port overrides it.
  let port = cliPort;
  if (!port) { const l = readLock(dataDir); if (l && l.port && isAlive(l.pid)) port = String(l.port); }
  await stop(dataDir);
  return start(dataDir, port);
}

async function main() {
  loadEnv();
  const cmd = (process.argv[2] || '').toLowerCase();
  const rest = process.argv.slice(3);
  let cliPort = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--port') { cliPort = rest[i + 1]; i++; }
    else if (rest[i].indexOf('--port=') === 0) cliPort = rest[i].slice('--port='.length);
  }
  const dataDir = resolveDataDir();

  let code;
  if (cmd === 'start') code = await start(dataDir, cliPort);
  else if (cmd === 'stop') code = await stop(dataDir);
  else if (cmd === 'restart') code = await restart(dataDir, cliPort);
  else {
    console.log('Usage: node scripts/cove.js <start|stop|restart> [--port N]');
    code = 2;
  }
  process.exit(code);
}

main();
