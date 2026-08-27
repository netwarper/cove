'use strict';
/* Self-update (lib/update) tests — exercised against a real local git remote. */
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const update = require('../lib/update');
const { harness } = require('./helpers');

const t = harness('update');

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
  catch (e) { throw new Error('git ' + args.join(' ') + ' failed: ' + (e.stderr ? e.stderr.toString() : e.message)); }
}
function commit(dir, file, body) {
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'change ' + file]);
}

(async () => {
  let gitAvailable = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch (_e) { gitAvailable = false; }
  if (!gitAvailable) { console.log('  (git not available — skipping)'); return t.done(); }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-upd-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');

  // bare remote (default branch 'main') + a working clone that tracks it
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '--quiet', remote, work]);
  git(work, ['config', 'user.email', 't@t']); git(work, ['config', 'user.name', 'T']);
  commit(work, 'a.txt', 'one');
  git(work, ['branch', '-M', 'main']);
  git(work, ['push', '-q', '-u', 'origin', 'main']);

  // non-git directory
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-plain-'));
  t.eq((await update.status(plain, false)).isGit, false, 'a non-git dir reports isGit:false');
  t.eq((await update.apply(plain)).ok, false, 'apply refuses on a non-git dir');

  // up to date
  let st = await update.status(work, true);
  t.eq(st.isGit, true, 'clone is a git repo');
  t.eq(st.branch, 'main', 'reports the current branch');
  t.eq([st.ahead, st.behind], [0, 0], 'fresh clone is level with origin');
  t.eq(st.updatable, false, 'nothing to update when level');
  t.eq((await update.apply(work)).updated, false, 'apply is a no-op when up to date');

  // remote advances (via a second clone) -> the first clone is behind
  execFileSync('git', ['clone', '--quiet', remote, other]);
  git(other, ['config', 'user.email', 't@t']); git(other, ['config', 'user.name', 'T']);
  commit(other, 'b.txt', 'two');
  commit(other, 'server.js', 'server change');
  git(other, ['push', '-q', 'origin', 'main']);

  st = await update.status(work, true);
  t.eq(st.behind, 2, 'after a fetch, the clone is 2 behind');
  t.eq(st.updatable, true, 'a clean, behind checkout is updatable');

  const res = await update.apply(work);
  t.eq(res.ok && res.updated, true, 'apply fast-forwards the checkout');
  t.eq(res.filesChanged, 2, 'reports the number of changed files');
  t.eq(res.serverChanged, true, 'flags that server-side files changed (needs restart)');
  t.ok(res.from !== res.to, 'HEAD moved forward (' + res.from + ' -> ' + res.to + ')');
  t.eq(fs.existsSync(path.join(work, 'b.txt')), true, 'the pulled file is now on disk');
  t.eq((await update.status(work, true)).behind, 0, 'nothing left to pull after updating');

  // dirty tree is refused (local edits are protected)
  fs.writeFileSync(path.join(work, 'a.txt'), 'locally edited');
  commit(other, 'c.txt', 'three'); git(other, ['push', '-q', 'origin', 'main']);
  const dirtyRes = await update.apply(work);
  t.eq(dirtyRes.ok, false, 'apply refuses when the working tree is dirty');
  t.ok(/local changes/i.test(dirtyRes.error || ''), 'explains the dirty-tree refusal');

  // ---- version compare ----
  t.ok(update.cmpVersions('1.2.0', '1.1.9') > 0, 'cmpVersions: newer minor is greater');
  t.ok(update.cmpVersions('1.10.0', '1.9.0') > 0, 'cmpVersions: numeric (not lexical) compare');
  t.eq(update.cmpVersions('2.0.0', '2.0.0'), 0, 'cmpVersions: equal versions compare 0');

  // ---- non-git (downloaded zip/tarball) install ----
  // Stand up a tiny local origin that mimics GitHub: raw package.json + a source
  // tarball whose single top-level dir holds the "new" release (version 9.9.9).
  const rel = path.join(root, 'release', 'cove-abc123');
  fs.mkdirSync(path.join(rel, 'public'), { recursive: true });
  fs.writeFileSync(path.join(rel, 'package.json'), JSON.stringify({ name: 'cove', version: '9.9.9' }));
  fs.writeFileSync(path.join(rel, 'server.js'), '// new server\n');
  fs.writeFileSync(path.join(rel, 'public', 'new.txt'), 'hello');
  const tgz = path.join(root, 'release.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', path.join(root, 'release'), 'cove-abc123']);

  const pkgBody = fs.readFileSync(path.join(rel, 'package.json'));
  const tgzBody = fs.readFileSync(tgz);
  const srv = http.createServer((req, res) => {
    if (req.url === '/package.json') { res.writeHead(200); res.end(pkgBody); }
    else if (req.url === '/tarball') { res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(tgzBody); }
    else { res.writeHead(404); res.end('nope'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  process.env.COVE_UPDATE_RAW_URL = base + '/package.json';
  process.env.COVE_UPDATE_TARBALL_URL = base + '/tarball';

  // a fresh, older, non-git install
  const zip = path.join(root, 'zipinstall');
  fs.mkdirSync(zip, { recursive: true });
  fs.writeFileSync(path.join(zip, 'package.json'), JSON.stringify({ name: 'cove', version: '1.0.0' }));
  fs.writeFileSync(path.join(zip, 'server.js'), '// old server\n');

  let zst = await update.status(zip, true);
  t.eq(zst.isGit, false, 'a downloaded install is not a git repo');
  t.eq(zst.mode, 'zip', 'reports zip update mode');
  t.eq(zst.current, '1.0.0', 'reads the installed version');
  t.eq(zst.latest, '9.9.9', 'reads the latest version from the origin');
  t.eq(zst.updatable, true, 'a newer published version is updatable');

  const zres = await update.apply(zip);
  t.eq(zres.ok && zres.updated, true, 'zip apply downloads and installs the update');
  t.eq(zres.to, '9.9.9', 'the install is now at the latest version');
  t.eq(zres.serverChanged, true, 'a zip update always asks for a restart');
  t.ok(fs.readFileSync(path.join(zip, 'package.json'), 'utf8').indexOf('9.9.9') >= 0, 'package.json was overwritten in place');
  t.eq(fs.existsSync(path.join(zip, 'public', 'new.txt')), true, 'new files from the archive were added');

  t.eq((await update.status(zip, true)).updatable, false, 'nothing to update once current');
  t.eq((await update.apply(zip)).updated, false, 'apply is a no-op when already at the latest version');

  srv.close();
  delete process.env.COVE_UPDATE_RAW_URL;
  delete process.env.COVE_UPDATE_TARBALL_URL;

  return t.done();
})();
