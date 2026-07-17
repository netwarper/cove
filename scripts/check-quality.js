'use strict';
/* Quality gate: syntax-check every JS file and run a few lightweight static
 * checks. Zero dependencies — uses `node --check` under the hood. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', 'data', '.git']);
let errors = 0;
let checked = 0;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT, []);

// 1. Syntax check
for (const f of files) {
  checked++;
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (ex) {
    errors++;
    console.log('✗ syntax error in ' + path.relative(ROOT, f));
    console.log('  ' + String(ex.stderr || ex.message).split('\n').slice(0, 3).join('\n  '));
  }
}

// 2. Lightweight static checks. Regexes are built dynamically so this file's
//    own source does not trip the patterns it scans for. The checker excludes
//    itself from the scan as well.
const SELF = path.relative(ROOT, __filename);
const DISALLOWED = [
  { re: new RegExp('\\b' + 'eval' + '\\s*\\('), msg: 'dynamic code evaluation' },
  { re: new RegExp('child' + '_process'), msg: 'child_process import in server', only: ['server.js'] },
];
for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (rel === SELF) continue;
  const src = fs.readFileSync(f, 'utf8');
  for (const rule of DISALLOWED) {
    if (rule.only && !rule.only.includes(rel)) continue;
    if (rule.re.test(src)) {
      errors++;
      console.log('✗ ' + rel + ': ' + rule.msg);
    }
  }
}

// 3. Ensure server binds to localhost by default (no accidental 0.0.0.0 default)
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
if (!/HOST\s*=\s*process\.env\.HOST\s*\|\|\s*'127\.0\.0\.1'/.test(server)) {
  errors++;
  console.log("✗ server.js: default HOST should be 127.0.0.1 (local-only by default)");
}

console.log('\nquality: checked ' + checked + ' files, ' + errors + ' issue(s)');
if (errors) process.exitCode = 1;
