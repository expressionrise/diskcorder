'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { isInside, safeJoin } = require('../src/paths');

const win = process.platform === 'win32';
const ROOT = win ? 'D:\\Drive' : '/mnt/drive';

test('safeJoin joins normal relative paths under the root', () => {
  assert.equal(safeJoin(ROOT, 'a.txt'), path.join(ROOT, 'a.txt'));
  assert.equal(safeJoin(ROOT, 'sub/dir/a.txt'), path.join(ROOT, 'sub', 'dir', 'a.txt'));
  assert.equal(safeJoin(ROOT, 'sub/../a.txt'), path.join(ROOT, 'a.txt'));
});

test('safeJoin refuses ".." escapes', () => {
  assert.equal(safeJoin(ROOT, '..'), null);
  assert.equal(safeJoin(ROOT, '../x'), null);
  assert.equal(safeJoin(ROOT, 'sub/../../x'), null);
  assert.equal(safeJoin(ROOT, '..\\x'), win ? null : path.join(ROOT, '..\\x'));
});

test('safeJoin refuses the root itself and empty input', () => {
  assert.equal(safeJoin(ROOT, ''), null);
  assert.equal(safeJoin(ROOT, '.'), null);
  assert.equal(safeJoin(ROOT, 'sub/..'), null);
  assert.equal(safeJoin('', 'a.txt'), null);
  assert.equal(safeJoin(null, 'a.txt'), null);
  assert.equal(safeJoin(ROOT, undefined), null);
  assert.equal(safeJoin(ROOT, 42), null);
});

test('safeJoin refuses absolute paths outside the root', () => {
  assert.equal(safeJoin(ROOT, win ? 'C:\\Windows\\system32' : '/etc/passwd'), null);
  assert.equal(safeJoin(ROOT, win ? '\\Windows' : '/etc'), null);
});

test('safeJoin refuses sibling directories that share the root as a prefix', () => {
  const sibling = win ? 'D:\\Drive2\\x' : '/mnt/drive2/x';
  assert.equal(safeJoin(ROOT, path.relative(ROOT, sibling)), null);
  assert.equal(safeJoin(ROOT, sibling), null);
});

test('safeJoin on a drive root (D:\\) still confines paths to it', { skip: !win }, () => {
  assert.equal(safeJoin('D:\\', 'a.txt'), 'D:\\a.txt');
  assert.equal(safeJoin('D:\\', '..\\x'), 'D:\\x', '".." cannot climb above a drive root, so it stays on the drive');
  assert.equal(safeJoin('D:\\', 'E:\\x'), null);
});

test('isInside is strict: not the parent itself, not a sibling', () => {
  assert.equal(isInside(ROOT, path.join(ROOT, 'a')), true);
  assert.equal(isInside(ROOT, ROOT), false);
  assert.equal(isInside(ROOT, path.dirname(ROOT)), false);
  assert.equal(isInside(ROOT, ROOT + '2'), false);
});

const fs = require('fs');
const os = require('os');
const { portableDataDir } = require('../src/paths');

test('portableDataDir is null unless running as the portable build', () => {
  assert.equal(portableDataDir({}), null);
});

test('portableDataDir creates DiskcorderData next to the exe', (t) => {
  const exeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskcorder-portable-'));
  t.after(() => fs.rmSync(exeDir, { recursive: true, force: true }));
  const dir = portableDataDir({ PORTABLE_EXECUTABLE_DIR: exeDir });
  assert.equal(dir, path.join(exeDir, 'DiskcorderData'));
  assert.ok(fs.statSync(dir).isDirectory());
});

test('portableDataDir falls back (null) when the folder is not writable', () => {
  const failing = {
    constants: fs.constants,
    mkdirSync() { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); },
    accessSync() {},
  };
  assert.equal(portableDataDir({ PORTABLE_EXECUTABLE_DIR: ROOT }, failing), null);
});
