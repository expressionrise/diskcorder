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
