/*
 * End-to-end browser smoke test (opt-in).
 *
 * Unlike the rest of the suite, this drives a real headless Chromium against a
 * live server. It is intentionally NOT part of `npm test` and adds no runtime or
 * dev dependency to the project: it SELF-SKIPS (exit 0) unless BOTH
 *   - `playwright-core` can be imported (npm i -D playwright-core), and
 *   - a Chromium executable can be found.
 * so a plain checkout still passes `npm run test:e2e` as a no-op.
 *
 * Find a browser via (first that exists):
 *   COVE_CHROMIUM / PLAYWRIGHT_CHROMIUM / CHROME_PATH env var,
 *   playwright-core's own resolved chromium, or
 *   a chrome under $PLAYWRIGHT_BROWSERS_PATH (default /opt/pw-browsers).
 *
 * Covers: mobile drawer, desktop layout, offline-save queue, modal a11y,
 * AI summary + action-item→task, and the offline read cache.
 */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PASS = 'e2e-smoke-pass-123';

function skip(msg) { console.log('e2e: SKIP — ' + msg + ' (run `npm i -D playwright-core` and provide a Chromium to enable)'); process.exit(0); }

// ---- resolve playwright-core (optional) ----
let pw;
try { pw = await import('playwright-core'); } catch (_e) { skip('playwright-core not installed'); }

// ---- resolve a chromium executable ----
function firstExisting(paths) { for (const p of paths) { try { if (p && fs.existsSync(p)) return p; } catch (_e) { /* ignore */ } } return null; }
function globChromium(base) {
  try {
    if (!fs.existsSync(base)) return null;
    for (const d of fs.readdirSync(base)) {
      if (!/^chromium(-|_)/.test(d)) continue;
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
      const shell = path.join(base, d, 'chrome-linux', 'headless_shell');
      if (fs.existsSync(shell)) return shell;
    }
  } catch (_e) { /* ignore */ }
  return null;
}
let exe = firstExisting([process.env.COVE_CHROMIUM, process.env.PLAYWRIGHT_CHROMIUM, process.env.CHROME_PATH]);
if (!exe) { try { const p = pw.chromium.executablePath(); if (p && fs.existsSync(p)) exe = p; } catch (_e) { /* not installed via playwright */ } }
if (!exe) exe = globChromium(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
if (!exe) skip('no Chromium executable found');

// ---- test harness ----
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } }
// First-run setup shows the recovery-key modal, then the onboarding tour — clear
// any modal backdrop so it doesn't intercept later clicks.
async function dismissFirstRunModals(page) {
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(400);
    if (await page.locator('#modalBackdrop:not(.hidden)').isVisible().catch(() => false)) await page.keyboard.press('Escape').catch(() => {});
    else break;
  }
}

// ---- a fake OpenAI-compatible chat endpoint for the summary test ----
let chatHits = 0;
const chat = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    chatHits++;
    const content = JSON.stringify({ summary: 'E2E summary line.', actionItems: [{ text: 'ship the e2e task', due: '' }] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

function waitForServer(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const r = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
      r.on('error', () => { if (--tries <= 0) reject(new Error('server did not start')); else setTimeout(tick, 200); });
    };
    tick();
  });
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-e2e-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
let server, browser;
try {
  await new Promise((r) => chat.listen(0, '127.0.0.1', r));
  const chatUrl = 'http://127.0.0.1:' + chat.address().port + '/v1/chat/completions';

  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { DATA_DIR, PORT: String(PORT), HOST: '127.0.0.1' }),
    stdio: 'ignore',
  });
  await waitForServer(PORT);
  const BASE = 'http://127.0.0.1:' + PORT;

  browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

  // --- setup + unlock (desktop) ---
  const setupCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const sp = await setupCtx.newPage();
  await sp.goto(BASE, { waitUntil: 'networkidle' });
  if (await sp.locator('#passphrase2').isVisible().catch(() => false)) await sp.fill('#passphrase2', PASS);
  await sp.fill('#passphrase', PASS);
  await sp.click('#authSubmit');
  await sp.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  ok(true, 'setup + unlock reaches the app');
  await dismissFirstRunModals(sp);
  // enable offline cache + configure summary endpoint for later checks
  await sp.click('#moreBtn'); await sp.click('[data-more="account"]');
  await sp.waitForSelector('#offlineCache', { state: 'visible', timeout: 5000 });
  if (!(await sp.locator('#offlineCache').isChecked())) await sp.check('#offlineCache');
  await sp.fill('#sumEndpoint', chatUrl); await sp.fill('#sumModel', 'gpt-4o-mini');
  await sp.click('#saveSumBtn'); await sp.waitForTimeout(150);
  await sp.click('#accountModal .modal-close');
  // create a note with content
  if (!(await sp.locator('#noteCustomTitle').isVisible().catch(() => false))) await sp.click('#newNoteBtn');
  await sp.waitForSelector('#noteCustomTitle', { state: 'visible', timeout: 5000 });
  await sp.fill('#noteCustomTitle', 'E2E note');
  await sp.evaluate(() => { const e = document.getElementById('meetingEditor'); e.innerHTML = '<p>E2EBODY beta on friday</p>'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await sp.waitForTimeout(900);

  // --- modal a11y ---
  await sp.click('#moreBtn'); await sp.click('[data-more="account"]');
  await sp.waitForSelector('#accountModal:not(.hidden)', { timeout: 5000 });
  ok(await sp.getAttribute('#accountModal', 'role') === 'dialog', 'modal role="dialog"');
  ok(await sp.getAttribute('#accountModal', 'aria-modal') === 'true', 'modal aria-modal');
  ok(await sp.evaluate(() => document.getElementById('accountModal').contains(document.activeElement)), 'focus moved into modal');
  await sp.keyboard.press('Escape');
  ok(await sp.locator('#accountModal').isVisible() === false, 'Escape closes modal');

  // --- new-task feedback (toast + scroll-into-view) ---
  await sp.fill('#taskInput', 'harness upcoming task next friday');
  await sp.press('#taskInput', 'Enter');
  await sp.waitForSelector('#miniToast.show', { timeout: 4000 });
  ok(/Task added/.test(await sp.textContent('#miniToast') || ''), 'new-task toast shown');

  // --- AI summary + action item -> task ---
  const tasksBefore = await sp.evaluate(async () => (await window.API.globalTasks()).length);
  await sp.click('#summarizeBtn');
  await sp.waitForFunction(() => /E2E summary/.test(document.getElementById('summaryBody').textContent || ''), { timeout: 8000 });
  ok(chatHits >= 1, 'server proxied to the chat endpoint');
  await sp.locator('#summaryActions .summary-action button').first().click();
  await sp.waitForTimeout(500);
  const tasksAfter = await sp.evaluate(async () => (await window.API.globalTasks()).length);
  ok(tasksAfter === tasksBefore + 1, 'action item created a task');
  await sp.click('#summaryModal .modal-close').catch(() => {});

  // --- offline save queue ---
  await sp.route('**/api/notes/**', (route) => route.request().method() === 'PUT' ? route.abort('failed') : route.continue());
  await sp.fill('#noteCustomTitle', 'Edited offline ' + Date.now());
  await sp.waitForFunction(() => !!localStorage.getItem('cove.pendingSaves'), { timeout: 6000 }).catch(() => {});
  ok(await sp.evaluate(() => !!localStorage.getItem('cove.pendingSaves')), 'failed save parks payload in localStorage');
  await sp.unroute('**/api/notes/**');
  await sp.evaluate(() => window.dispatchEvent(new Event('online')));
  await sp.waitForFunction(() => !localStorage.getItem('cove.pendingSaves'), { timeout: 8000 }).catch(() => {});
  ok(!(await sp.evaluate(() => localStorage.getItem('cove.pendingSaves'))), 'queue flushes on reconnect');

  // --- offline read cache (reader from the server-down screen) ---
  ok(await sp.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('cove.noteCache') || '{}')).length >= 1), 'note cached for offline reading');
  await sp.route('**/api/**', (route) => route.abort('failed'));
  await sp.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sp.waitForSelector('#serverDown:not(.hidden)', { timeout: 8000 });
  await sp.waitForSelector('#serverDownCached:not(.hidden)', { timeout: 4000 });
  await sp.click('#serverDownCached');
  await sp.waitForSelector('#offlineReader:not(.hidden)', { timeout: 4000 });
  ok(await sp.locator('#orList .or-item').count() >= 1, 'offline reader lists cached notes');
  await sp.unroute('**/api/**');
  await setupCtx.close();

  // --- mobile drawer (fresh phone-sized context) ---
  const mctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const mp = await mctx.newPage();
  await mp.goto(BASE, { waitUntil: 'networkidle' });
  await mp.fill('#passphrase', PASS); await mp.click('#authSubmit');
  await mp.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  ok(await mp.locator('#menuBtn').isVisible(), 'mobile: hamburger visible');
  let sb = await mp.locator('.sidebar').boundingBox();
  ok(sb && sb.x < 0, 'mobile: sidebar off-canvas initially');
  await mp.click('#menuBtn'); await mp.waitForTimeout(350);
  sb = await mp.locator('.sidebar').boundingBox();
  ok(sb && sb.x >= 0, 'mobile: drawer opens on tap');
  await mctx.close();

  // --- desktop layout (hamburger hidden) ---
  const dctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const dp = await dctx.newPage();
  await dp.goto(BASE, { waitUntil: 'networkidle' });
  await dp.fill('#passphrase', PASS); await dp.click('#authSubmit');
  await dp.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  ok(!(await dp.locator('#menuBtn').isVisible()), 'desktop: hamburger hidden');
  await dctx.close();
} catch (ex) {
  fail++; console.log('  ✗ exception: ' + (ex && ex.stack || ex));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
  chat.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

console.log('\ne2e: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
