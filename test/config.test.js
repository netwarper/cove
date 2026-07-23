'use strict';
/* Durability / instance-config tests. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../lib/config');
const { harness } = require('./helpers');

const t = harness('config');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-cfg-'));

try {
  // defaults on a fresh directory
  let cfg = config.resolve(DIR, {});
  t.eq(cfg.host, '127.0.0.1', 'default bind host is loopback');
  t.eq(cfg.port, config.DEFAULT_PORT, 'default port is 3000 when nothing is set');

  // bare name -> <name>.localhost
  t.eq(config.normalizeDomain('My Notes'), 'mynotes.localhost', 'bare name becomes <slug>.localhost');
  t.eq(config.normalizeDomain('notes.home.lan'), 'notes.home.lan', 'dotted domain is kept as-is');

  // derived port is deterministic and in range
  const p1 = config.derivePort('notes.localhost');
  const p2 = config.derivePort('notes.localhost');
  const p3 = config.derivePort('other.localhost');
  t.eq(p1, p2, 'derived port is stable for the same domain');
  t.ok(p1 !== p3, 'different domains derive different ports');
  t.ok(p1 >= 20000 && p1 < 30000, 'derived port sits in the high range');

  // writing instance.json makes the port durable
  config.writeInstance(DIR, { name: 'Meeting Notes', domain: 'notes.localhost', host: '127.0.0.1', port: p1, createdAt: new Date().toISOString() });
  cfg = config.resolve(DIR, {});
  t.eq(cfg.port, p1, 'resolved port comes from instance.json');
  t.eq(cfg.url, 'http://notes.localhost:' + p1, 'resolved URL uses the durable domain + port');

  // env overrides instance.json
  cfg = config.resolve(DIR, { PORT: '4567' });
  t.eq(cfg.port, 4567, 'PORT env overrides instance.json');

  // --- explicit port controls (deployer-chosen port) ---
  t.eq(config.validPort('8080'), 8080, 'validPort accepts a numeric string');
  t.eq(config.validPort('0'), null, 'validPort rejects 0');
  t.eq(config.validPort('70000'), null, 'validPort rejects > 65535');
  t.eq(config.validPort('abc'), null, 'validPort rejects non-numeric');
  // opts.port (a --port flag) wins over env PORT and instance.json
  t.eq(config.resolve(DIR, { PORT: '4567' }, { port: 9090 }).port, 9090, 'CLI --port overrides env PORT');
  t.eq(config.resolve(DIR, {}, { port: 'nope' }).port, config.resolve(DIR, {}).port, 'an invalid --port is ignored (same as no --port)');

  // lock lifecycle
  t.eq(config.readActiveLock(DIR), null, 'no active lock initially');
  config.writeLock(DIR, p1);
  // our own pid should not count as "another" instance
  t.eq(config.readActiveLock(DIR), null, 'own lock is not treated as a conflicting instance');
  // simulate a foreign, live lock (pid 1 is always alive)
  fs.writeFileSync(path.join(DIR, 'instance.lock'), JSON.stringify({ pid: 1, port: p1, startedAt: new Date().toISOString() }));
  const foreign = config.readActiveLock(DIR);
  t.ok(foreign && foreign.pid === 1, 'a live foreign lock is detected');
  // stale lock (impossible pid) is ignored
  fs.writeFileSync(path.join(DIR, 'instance.lock'), JSON.stringify({ pid: 2147480000, port: p1 }));
  t.eq(config.readActiveLock(DIR), null, 'a stale lock (dead pid) is ignored');
} catch (ex) {
  t.ok(false, 'unexpected exception: ' + ex.stack);
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
  t.done();
}
