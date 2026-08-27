'use strict';
// Self-update. Two install shapes are supported:
//
//   • git checkout  — check GitHub for newer commits and FAST-FORWARD the local
//     checkout. Pure git via execFile (no shell). Deliberately conservative: it
//     only ever fast-forwards, and refuses when the working tree is dirty or has
//     diverged, so local edits are never clobbered.
//
//   • zip / tarball install (code downloaded from GitHub, no .git) — compare the
//     installed package.json version against the version on the default branch
//     and, when newer, download that branch's source tarball and copy it over
//     the app in place. Data lives outside the app tree (or in a gitignored
//     `data/` the archive doesn't contain), so notes are never touched.
//
// Applying server-side changes needs a restart either way; that's surfaced to
// the caller, not forced here.
const { execFile, spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SLUG = 'netwarper/cove';
const DEFAULT_REF = 'main';

// ---------------------------------------------------------------- git helpers
function git(args, cwd, timeout) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeout || 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        timedOut: !!(err && err.killed),
        noGit: !!(err && err.code === 'ENOENT'),
      });
    });
  });
}

async function isGitRepo(dir) {
  const r = await git(['rev-parse', '--is-inside-work-tree'], dir, 5000);
  return r.ok && r.stdout === 'true';
}

// Report a git checkout's update state. When `doFetch`, contacts origin first so
// `behind` reflects GitHub; otherwise it's a cheap local read.
async function gitStatus(dir, doFetch) {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).stdout || null;
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir);
  const upstream = up.ok ? up.stdout : null;
  const current = (await git(['rev-parse', '--short', 'HEAD'], dir)).stdout || null;
  const dirty = (await git(['status', '--porcelain'], dir)).stdout.length > 0;
  let fetched = false, fetchError = null, behind = 0, ahead = 0;
  if (!upstream) {
    return { isGit: true, mode: 'git', branch, upstream: null, current, dirty, ahead: 0, behind: 0, fetched: false,
      fetchError: 'this branch has no GitHub upstream to pull from', updatable: false };
  }
  if (doFetch) {
    const f = await git(['fetch', '--quiet', 'origin'], dir, 40000);
    fetched = f.ok;
    if (!f.ok) fetchError = f.timedOut ? 'fetch timed out — is GitHub reachable?' : (f.noGit ? 'git is not installed' : (f.stderr || 'fetch failed'));
  }
  const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], dir);
  if (counts.ok) { const p = counts.stdout.split(/\s+/); ahead = parseInt(p[0], 10) || 0; behind = parseInt(p[1], 10) || 0; }
  return { isGit: true, mode: 'git', branch, upstream, current, dirty, ahead, behind, fetched, fetchError,
    updatable: behind > 0 && ahead === 0 && !dirty && !fetchError };
}

// Fast-forward a git checkout to its upstream. Never merges/rebases; refuses on a
// dirty tree or a diverged history so local work is safe.
async function gitApply(dir) {
  const st = await gitStatus(dir, true);
  if (st.fetchError) return { ok: false, error: 'Could not reach GitHub: ' + st.fetchError };
  if (st.dirty) return { ok: false, error: 'The app folder has local changes — commit or discard them first, then update.' };
  if (st.ahead > 0) return { ok: false, error: 'Your checkout has commits that GitHub doesn’t, so it can’t fast-forward. Reconcile it with git first.' };
  if (st.behind === 0) return { ok: true, updated: false, from: st.current, to: st.current, message: 'Already up to date.' };
  const before = st.current;
  const pull = await git(['merge', '--ff-only', '@{u}'], dir, 40000);
  if (!pull.ok) return { ok: false, error: 'git could not fast-forward: ' + (pull.stderr || pull.stdout || 'unknown error') };
  const to = (await git(['rev-parse', '--short', 'HEAD'], dir)).stdout || null;
  const filesOut = (await git(['diff', '--name-only', before + '..HEAD'], dir)).stdout;
  const files = filesOut ? filesOut.split('\n').filter(Boolean) : [];
  const serverChanged = files.some((f) => /^(server\.js|lib\/|scripts\/|package\.json)$|^lib\/|^scripts\//.test(f));
  return { ok: true, updated: true, from: before, to, files, filesChanged: files.length, serverChanged };
}

// ------------------------------------------------------ zip / tarball helpers
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; } }
function localVersion(dir) { const p = readJson(path.join(dir, 'package.json')); return (p && p.version) || null; }

// Where to update from: the package.json `repository` URL (owner/repo), falling
// back to the project default. Overridable via env for testing.
function repoSlug(dir) {
  const p = readJson(path.join(dir, 'package.json'));
  const url = (p && p.repository && (typeof p.repository === 'string' ? p.repository : p.repository.url)) || '';
  const m = String(url).match(/github\.com[/:]([^/]+\/[^/.]+)/i);
  return (m && m[1]) || DEFAULT_SLUG;
}
function updateRef() { return process.env.COVE_UPDATE_REF || DEFAULT_REF; }
function endpoints(dir) {
  const slug = repoSlug(dir), ref = updateRef();
  return {
    slug, ref,
    raw: process.env.COVE_UPDATE_RAW_URL || ('https://raw.githubusercontent.com/' + slug + '/' + ref + '/package.json'),
    tarball: process.env.COVE_UPDATE_TARBALL_URL || ('https://codeload.github.com/' + slug + '/tar.gz/refs/heads/' + ref),
  };
}

// Compare dotted numeric versions. >0 when a is newer than b.
function cmpVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Minimal GET with redirect-following, for both http (tests) and https (GitHub).
function request(url, opts, onResponse, onError) {
  let u; try { u = new URL(url); } catch (e) { return onError(e); }
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.get(u, Object.assign({ headers: { 'User-Agent': 'Cove-Updater', 'Accept': '*/*' } }, opts || {}), (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (opts._redirects || 0) < 5) {
      res.resume();
      const next = new URL(res.headers.location, u).toString();
      return request(next, Object.assign({}, opts, { _redirects: (opts._redirects || 0) + 1 }), onResponse, onError);
    }
    onResponse(res);
  });
  req.on('error', onError);
  if (opts && opts.timeout) req.setTimeout(opts.timeout, () => req.destroy(new Error('request timed out')));
  return req;
}

function fetchText(url, timeout) {
  return new Promise((resolve, reject) => {
    request(url, { timeout: timeout || 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    }, reject);
  });
}

function download(url, dest, timeout) {
  return new Promise((resolve, reject) => {
    request(url, { timeout: timeout || 90000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error('GitHub returned HTTP ' + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    }, reject);
  });
}

// Unpack a .tar.gz using the system tar (present on macOS, Linux and Windows 10+).
function untar(file, dest) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', file, '-C', dest], { timeout: 60000, windowsHide: true }, (err) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? 'the `tar` tool isn’t available to unpack the update' : (err.stderr || err.message || 'tar failed')));
      else resolve();
    });
  });
}

// Copy a source tree over the install, overwriting files and adding new ones.
// Never deletes, and skips VCS/dependency dirs. Returns the number of files written.
const COPY_SKIP = new Set(['.git', 'node_modules']);
function copyTree(src, dst) {
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (COPY_SKIP.has(name)) continue;
    const s = path.join(src, name), d = path.join(dst, name);
    const stat = fs.lstatSync(s);
    if (stat.isDirectory()) n += copyTree(s, d);
    else { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); n++; }
  }
  return n;
}

async function zipStatus(dir, doFetch) {
  const current = localVersion(dir);
  const ep = endpoints(dir);
  const base = { isGit: false, mode: 'zip', current, branch: ep.ref, slug: ep.slug };
  if (!current) return Object.assign(base, { fetched: false, updatable: false, error: 'Can’t read the installed version (package.json is missing) — reinstall from the latest download.' });
  if (!doFetch) return Object.assign(base, { fetched: false, updatable: false });
  let r;
  try { r = await fetchText(ep.raw, 20000); }
  catch (e) { return Object.assign(base, { fetched: false, updatable: false, fetchError: 'could not reach GitHub (' + (e && e.message || e) + ')' }); }
  if (!r.ok) return Object.assign(base, { fetched: false, updatable: false, fetchError: 'GitHub returned HTTP ' + r.status });
  let latest = null;
  try { latest = JSON.parse(r.body).version; } catch (_e) { /* not JSON */ }
  if (!latest) return Object.assign(base, { fetched: true, updatable: false, fetchError: 'could not read the latest version from GitHub' });
  return Object.assign(base, { fetched: true, latest, updatable: cmpVersions(latest, current) > 0 });
}

async function zipApply(dir) {
  const st = await zipStatus(dir, true);
  if (st.error) return { ok: false, error: st.error };
  if (st.fetchError) return { ok: false, error: 'Could not reach GitHub: ' + st.fetchError };
  if (!st.updatable) return { ok: true, updated: false, from: st.current, to: st.current, message: 'Already up to date.' };
  const ep = endpoints(dir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-upd-'));
  try {
    const tgz = path.join(tmp, 'src.tar.gz');
    await download(ep.tarball, tgz, 120000);
    const outDir = path.join(tmp, 'x'); fs.mkdirSync(outDir);
    await untar(tgz, outDir);
    // A GitHub source tarball unpacks to a single top-level "<repo>-<ref>" dir.
    const dirs = fs.readdirSync(outDir).filter((n) => { try { return fs.statSync(path.join(outDir, n)).isDirectory(); } catch (_e) { return false; } });
    if (dirs.length !== 1) return { ok: false, error: 'the downloaded archive had an unexpected layout — aborting to be safe.' };
    const root = path.join(outDir, dirs[0]);
    // Sanity-check the archive really is Cove before writing over the install.
    if (!fs.existsSync(path.join(root, 'server.js')) || !fs.existsSync(path.join(root, 'package.json'))) {
      return { ok: false, error: 'the downloaded archive doesn’t look like Cove — aborting to be safe.' };
    }
    const filesChanged = copyTree(root, dir);
    const to = localVersion(dir) || st.latest;
    return { ok: true, updated: true, from: st.current, to, filesChanged, serverChanged: true };
  } catch (e) {
    return { ok: false, error: 'update failed: ' + (e && e.message || e) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
}

// ------------------------------------------------------------ public surface
// Report the install's update state, auto-detecting a git checkout vs a
// downloaded (zip/tarball) install.
async function status(dir, doFetch) {
  if (await isGitRepo(dir)) return gitStatus(dir, doFetch);
  return zipStatus(dir, doFetch);
}

// Apply the newest code — fast-forward for a git checkout, download-and-overwrite
// for a zip install.
async function apply(dir) {
  if (await isGitRepo(dir)) return gitApply(dir);
  return zipApply(dir);
}

// Best-effort restart via the cross-platform launcher (scripts/cove.js restart):
// it stops the running instance (found through its lock) and starts a fresh one
// with the new code, inheriting `env` so the data dir/port resolve unchanged.
// Detached + unref'd so it outlives the process it's about to replace.
function restartViaLauncher(appDir, env) {
  const child = spawn(process.execPath, [path.join(appDir, 'scripts', 'cove.js'), 'restart'],
    { cwd: appDir, env: env || process.env, detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true };
}

module.exports = { isGitRepo, status, apply, restartViaLauncher, cmpVersions };
