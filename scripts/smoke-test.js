'use strict';

/* Smoke test for the unpacked Windows build (`npx electron-builder --win --dir`):
   checks that the resources the app needs are present, that ffmpeg ships exactly
   once, and that the exe starts and stays alive for a few seconds.
   Usage: node scripts/smoke-test.js [dist\win-unpacked] */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked'));
const res = path.join(dir, 'resources');
const problems = [];
const must = (cond, msg) => { if (!cond) problems.push(msg); };

must(fs.existsSync(path.join(dir, 'Diskcorder.exe')), 'Diskcorder.exe is missing');
for (const f of ['ffmpeg.exe', 'ffmpeg-LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) {
  must(fs.existsSync(path.join(res, f)), `resources/${f} is missing`);
}
must(fs.existsSync(path.join(res, 'app.asar')) || fs.existsSync(path.join(res, 'app')), 'app.asar is missing');

// ffmpeg must ship once (the extraResources copy), not also inside the app.
const found = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.toLowerCase() === 'ffmpeg.exe') found.push(path.relative(dir, p));
  }
})(dir);
must(found.length === 1, `expected one ffmpeg.exe, found ${found.length}: ${found.join(', ')}`);

// The bundled ffmpeg has to run.
if (fs.existsSync(path.join(res, 'ffmpeg.exe'))) {
  const r = spawnSync(path.join(res, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8' });
  must(r.status === 0 && /ffmpeg version/.test(r.stdout || ''), 'bundled ffmpeg.exe does not run');
}

function finish() {
  if (problems.length) {
    console.error('Smoke test FAILED:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  console.log('Smoke test passed.');
}

if (problems.length) finish();

// Start the app with a throw-away profile and make sure it does not crash.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'diskcorder-smoke-'));
const child = spawn(path.join(dir, 'Diskcorder.exe'), [`--user-data-dir=${userData}`], { stdio: 'ignore' });
let exited = null;
child.on('exit', (code) => { exited = code; });
setTimeout(() => {
  must(exited === null, `the app exited early (code ${exited})`);
  must(fs.existsSync(path.join(userData, 'catalog.db')), 'the app did not create its catalog.db');
  spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  setTimeout(() => {
    fs.rmSync(userData, { recursive: true, force: true });
    finish();
  }, 1500);
}, 10000);
