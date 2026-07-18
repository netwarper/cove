'use strict';

/*
 * Scheduled encrypted backups.
 *
 * A backup is the same portable bundle as the manual export: vault.json plus
 * every encrypted file, base64-wrapped in one JSON document. Because the files
 * are already encrypted, producing a backup needs no key — so this can run on a
 * timer without an unlocked session. Point AUTO_BACKUP_DIR at a location OTHER
 * than the data directory (ideally a different disk / sync folder).
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');

const PREFIX = 'meeting-notes-backup-';

function stamp(d) {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Write one backup bundle atomically. Returns the file path. */
function writeBackup(dataDir, backupDir, now) {
  fs.mkdirSync(backupDir, { recursive: true });
  const bundle = store.exportBundle(dataDir);
  const file = path.join(backupDir, PREFIX + stamp(now || new Date()) + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bundle));
  fs.renameSync(tmp, file);
  return file;
}

/** Keep only the newest `keep` backups; remove the rest. Returns removed paths. */
function pruneBackups(backupDir, keep) {
  if (!fs.existsSync(backupDir)) return [];
  const files = fs.readdirSync(backupDir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.json'))
    .sort(); // timestamped names sort chronologically
  const removed = [];
  while (files.length > keep) {
    const f = files.shift();
    fs.rmSync(path.join(backupDir, f), { force: true });
    removed.push(f);
  }
  return removed;
}

function runAutoBackup(dataDir, backupDir, keep, now) {
  const file = writeBackup(dataDir, backupDir, now);
  const removed = pruneBackups(backupDir, keep);
  return { file, removed };
}

module.exports = { writeBackup, pruneBackups, runAutoBackup, PREFIX };
