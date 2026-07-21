'use strict';
/* Scheduled-backup unit tests (no timers). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../lib/crypto');
const { Store } = require('../lib/store');
const backup = require('../lib/backup');
const { harness } = require('./helpers');

const t = harness('backup');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-bkp-'));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-bkpout-'));

try {
  const { dek } = c.createVault('backup pass 123');
  fs.writeFileSync(path.join(DATA, 'vault.json'), JSON.stringify({ vault: { version: 2 } }));
  new Store(DATA, dek).ensureInitialized(); // makes index + a workspace (encrypted files)

  // write one backup
  const file = backup.writeBackup(DATA, OUT, new Date('2026-01-01T00:00:00Z'));
  t.ok(fs.existsSync(file), 'backup file is written');
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  t.eq(bundle.format, 'meeting-notes-backup', 'backup uses the portable bundle format');
  t.ok(bundle.files['vault.json'], 'backup includes the vault');
  t.ok(Object.keys(bundle.files).some((f) => f.endsWith('.enc')), 'backup includes encrypted data files');

  // several backups then prune to keep=2
  backup.writeBackup(DATA, OUT, new Date('2026-01-02T00:00:00Z'));
  backup.writeBackup(DATA, OUT, new Date('2026-01-03T00:00:00Z'));
  let files = fs.readdirSync(OUT).filter((f) => f.startsWith(backup.PREFIX));
  t.eq(files.length, 3, 'three backups on disk before pruning');
  const removed = backup.pruneBackups(OUT, 2);
  t.eq(removed.length, 1, 'pruning to keep=2 removes the oldest one');
  files = fs.readdirSync(OUT).filter((f) => f.startsWith(backup.PREFIX)).sort();
  t.eq(files.length, 2, 'two backups remain after pruning');
  t.ok(files[0].includes('2026-01-02') && files[1].includes('2026-01-03'), 'the newest two are kept');

  // runAutoBackup writes + prunes in one call
  const r = backup.runAutoBackup(DATA, OUT, 2, new Date('2026-01-04T00:00:00Z'));
  t.ok(fs.existsSync(r.file), 'runAutoBackup writes a new backup');
  t.eq(fs.readdirSync(OUT).filter((f) => f.startsWith(backup.PREFIX)).length, 2, 'runAutoBackup keeps the cap');
} catch (ex) {
  t.ok(false, 'unexpected exception: ' + ex.stack);
} finally {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  t.done();
}
