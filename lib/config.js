'use strict';

/*
 * Durable per-instance configuration.
 *
 * Each instance keeps a small, non-sensitive `instance.json` inside its own
 * DATA_DIR. Because the identity lives with the data, copying the data
 * directory to a new machine carries the instance's name, local domain and
 * (durable) port with it — the port never drifts, so a hosts-file record or a
 * `*.localhost` domain stays valid across restarts and moves.
 *
 * Resolution precedence (highest first): environment variable, instance.json,
 * a value derived deterministically from the domain, then the built-in default.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PORT = 3000;
// Derived ports live in a high, uncommon range to avoid clashing with typical
// dev servers (3000, 5173, 8080, …) while staying stable per domain.
const DERIVED_MIN = 20000;
const DERIVED_SPAN = 10000;

function instancePath(dataDir) { return path.join(dataDir, 'instance.json'); }
function lockPath(dataDir) { return path.join(dataDir, 'instance.lock'); }

// ---- data-directory pointer -----------------------------------------
// A small, gitignored `datadir.path` file next to the code records where the
// data lives, so the location can be changed from the web UI (or by hand)
// without editing an env var or a launcher script. Overwriting the code on an
// update never touches it. An explicit DATA_DIR env var still wins.
function dataDirPointerPath(appDir) { return path.join(appDir, 'datadir.path'); }

/** The configured data directory from the pointer file (absolute), or null. */
function readDataDirPointer(appDir) {
  try {
    const raw = fs.readFileSync(dataDirPointerPath(appDir), 'utf8').trim();
    return raw ? path.resolve(raw) : null;
  } catch (_e) { return null; }
}

/** Persist the data-directory pointer (atomic). Pass '' or null to clear it. */
function writeDataDirPointer(appDir, dir) {
  const file = dataDirPointerPath(appDir);
  if (!dir) { try { fs.rmSync(file, { force: true }); } catch (_e) { /* ignore */ } return null; }
  const abs = path.resolve(dir);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, abs + '\n');
  fs.renameSync(tmp, file);
  return abs;
}

function readInstance(dataDir) {
  try { return JSON.parse(fs.readFileSync(instancePath(dataDir), 'utf8')); }
  catch (_e) { return null; }
}

function writeInstance(dataDir, cfg) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = instancePath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, instancePath(dataDir));
  return cfg;
}

/** A bare name becomes "<slug>.localhost" (loopback with no hosts edit needed). */
function normalizeDomain(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('.')) return s.replace(/[^a-z0-9.\-]/g, '');
  return s.replace(/[^a-z0-9\-]/g, '') + '.localhost';
}

/** A valid TCP port (1–65535), or null. Accepts numbers or numeric strings. */
function validPort(p) {
  const n = parseInt(p, 10);
  return (Number.isInteger(n) && n >= 1 && n <= 65535) ? n : null;
}

/** Deterministic, stable port for a domain (so each instance gets its own). */
function derivePort(seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  return DERIVED_MIN + (h.readUInt32BE(0) % DERIVED_SPAN);
}

/**
 * Resolve the effective runtime config from env + instance.json.
 * `host` is the bind address (loopback by default); `domain` is what the user
 * types in the browser (mapped to loopback by *.localhost or a hosts record).
 */
function resolve(dataDir, env, opts) {
  env = env || process.env;
  opts = opts || {};
  const inst = readInstance(dataDir) || {};
  const domain = normalizeDomain(env.DOMAIN) || inst.domain || null;
  const host = env.HOST || inst.host || '127.0.0.1';
  // Precedence: an explicit --port for this run, then env PORT, then the durable
  // instance.json port, then a domain-derived port, then the built-in default.
  const cliPort = validPort(opts.port);
  let port = cliPort || parseInt(env.PORT, 10) || inst.port ||
    (domain ? derivePort(domain) : DEFAULT_PORT);
  return {
    name: inst.name || 'Daymark',
    domain,
    host,
    port,
    displayHost: domain || host,
    url: `http://${domain || host}:${port}`,
  };
}

// ---- single-instance lock (same data directory) ----------------------

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Returns the live lock owner if another process holds this data dir, else null. */
function readActiveLock(dataDir) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath(dataDir), 'utf8'));
    if (lock && lock.pid && lock.pid !== process.pid && isPidAlive(lock.pid)) return lock;
  } catch (_e) { /* no/broken lock */ }
  return null;
}

function writeLock(dataDir, port) {
  try {
    fs.writeFileSync(lockPath(dataDir), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
  } catch (_e) { /* best effort */ }
}
function clearLock(dataDir) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath(dataDir), 'utf8'));
    if (lock && lock.pid === process.pid) fs.rmSync(lockPath(dataDir), { force: true });
  } catch (_e) { /* ignore */ }
}

module.exports = {
  DEFAULT_PORT,
  readInstance, writeInstance, normalizeDomain, derivePort, validPort, resolve,
  readActiveLock, writeLock, clearLock, instancePath,
  readDataDirPointer, writeDataDirPointer, dataDirPointerPath,
};
