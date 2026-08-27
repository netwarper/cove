'use strict';
// Self-update: check GitHub for newer commits and fast-forward the local
// checkout. Pure git via execFile (no shell — nothing user-supplied reaches a
// command line). Deliberately conservative: it only ever FAST-FORWARDS, and
// refuses when the working tree is dirty or has diverged, so a user's local
// edits are never clobbered. Applying server-side changes still needs a
// restart; that's surfaced to the caller, not forced here.
const { execFile, spawn } = require('child_process');
const path = require('path');

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

// Report the checkout's update state. When `doFetch`, contacts origin first so
// `behind` reflects GitHub; otherwise it's a cheap local read.
async function status(dir, doFetch) {
  if (!(await isGitRepo(dir))) {
    const probe = await git(['--version'], dir, 5000);
    return { isGit: false, error: probe.noGit ? 'git is not installed' : 'this install is not a git checkout' };
  }
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).stdout || null;
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir);
  const upstream = up.ok ? up.stdout : null;
  const current = (await git(['rev-parse', '--short', 'HEAD'], dir)).stdout || null;
  const dirty = (await git(['status', '--porcelain'], dir)).stdout.length > 0;
  let fetched = false, fetchError = null, behind = 0, ahead = 0;
  if (!upstream) {
    return { isGit: true, branch, upstream: null, current, dirty, ahead: 0, behind: 0, fetched: false,
      fetchError: 'this branch has no GitHub upstream to pull from', updatable: false };
  }
  if (doFetch) {
    const f = await git(['fetch', '--quiet', 'origin'], dir, 40000);
    fetched = f.ok;
    if (!f.ok) fetchError = f.timedOut ? 'fetch timed out — is GitHub reachable?' : (f.noGit ? 'git is not installed' : (f.stderr || 'fetch failed'));
  }
  const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], dir);
  if (counts.ok) { const p = counts.stdout.split(/\s+/); ahead = parseInt(p[0], 10) || 0; behind = parseInt(p[1], 10) || 0; }
  return { isGit: true, branch, upstream, current, dirty, ahead, behind, fetched, fetchError,
    updatable: behind > 0 && ahead === 0 && !dirty && !fetchError };
}

// Fast-forward the checkout to its upstream. Never merges/rebases; refuses on a
// dirty tree or a diverged history so local work is safe.
async function apply(dir) {
  const st = await status(dir, true);
  if (!st.isGit) return { ok: false, error: (st.error || 'not a git checkout') + ' — download the latest release manually.' };
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
  // Client-only files apply on reload; anything server-side needs a restart.
  const serverChanged = files.some((f) => /^(server\.js|lib\/|scripts\/|package\.json)$|^lib\/|^scripts\//.test(f));
  return { ok: true, updated: true, from: before, to, files, filesChanged: files.length, serverChanged };
}

// Best-effort restart via the cross-platform launcher (scripts/cove.js restart):
// it stops the running instance (found through its lock) and starts a fresh one
// with the pulled code, inheriting `env` so the data dir/port resolve unchanged.
// Detached + unref'd so it outlives the process it's about to replace.
function restartViaLauncher(appDir, env) {
  const child = spawn(process.execPath, [path.join(appDir, 'scripts', 'cove.js'), 'restart'],
    { cwd: appDir, env: env || process.env, detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true };
}

module.exports = { isGitRepo, status, apply, restartViaLauncher };
