'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Fresh temp dir per test; tests never touch real drives.
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskcorder-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function bigFile(file, mb = 16) {
  write(file, Buffer.alloc(mb * 1024 * 1024, 7));
}

// Paths of all leftover partial files under dir.
function partFiles(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...partFiles(p));
    else if (d.name.endsWith('.diskcorder-part')) out.push(p);
  }
  return out;
}

module.exports = { tmpDir, write, bigFile, partFiles };
