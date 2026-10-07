'use strict';

// Runs the node:test suite under Electron's Node (ELECTRON_RUN_AS_NODE), because
// better-sqlite3 is compiled for Electron's ABI and will not load in plain Node.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'test'))
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join('test', f));

const res = spawnSync(require('electron'), ['--test', ...tests], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
});
process.exit(res.status ?? 1);
