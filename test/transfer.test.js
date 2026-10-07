'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { transfer, measure } = require('../src/transfer');
const { tmpDir, write, bigFile, partFiles } = require('./helpers');

const run = (o) => transfer({ signal: new AbortController().signal, ...o });

test('copy keeps the source and reports the destination', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'a/file.txt'), 'hello');
  fs.mkdirSync(path.join(d, 'b'));
  const r = await run({ srcPath: path.join(d, 'a/file.txt'), destDir: path.join(d, 'b') });
  assert.equal(r.status, 'done');
  assert.equal(fs.readFileSync(path.join(d, 'b/file.txt'), 'utf8'), 'hello');
  assert.ok(fs.existsSync(path.join(d, 'a/file.txt')));
});

test('copy of a folder is recursive and measure() counts bytes', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'src/x/1.txt'), '12345');
  write(path.join(d, 'src/2.txt'), '123');
  fs.mkdirSync(path.join(d, 'dst'));
  assert.equal(await measure(path.join(d, 'src')), 8);
  await run({ srcPath: path.join(d, 'src'), destDir: path.join(d, 'dst') });
  assert.equal(fs.readFileSync(path.join(d, 'dst/src/x/1.txt'), 'utf8'), '12345');
  assert.equal(await measure(path.join(d, 'dst/src')), 8);
});

test('move removes the source after a verified copy', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'src/f.txt'), 'data');
  fs.mkdirSync(path.join(d, 'dst'));
  await run({ srcPath: path.join(d, 'src'), destDir: path.join(d, 'dst'), move: true });
  assert.ok(!fs.existsSync(path.join(d, 'src')));
  assert.equal(fs.readFileSync(path.join(d, 'dst/src/f.txt'), 'utf8'), 'data');
});

test('conflict: keepboth picks a free name', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'a/f.txt'), 'new');
  write(path.join(d, 'b/f.txt'), 'old');
  write(path.join(d, 'b/f (2).txt'), 'old2');
  const r = await run({ srcPath: path.join(d, 'a/f.txt'), destDir: path.join(d, 'b'), conflict: 'keepboth' });
  assert.equal(path.basename(r.dstPath), 'f (3).txt');
  assert.equal(fs.readFileSync(path.join(d, 'b/f.txt'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(r.dstPath, 'utf8'), 'new');
});

test('conflict: skip leaves everything as it was', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'a/f.txt'), 'new');
  write(path.join(d, 'b/f.txt'), 'old');
  const r = await run({ srcPath: path.join(d, 'a/f.txt'), destDir: path.join(d, 'b'), conflict: 'skip', move: true });
  assert.equal(r.status, 'skipped');
  assert.equal(fs.readFileSync(path.join(d, 'b/f.txt'), 'utf8'), 'old');
  assert.ok(fs.existsSync(path.join(d, 'a/f.txt')), 'a skipped move must not delete the source');
});

test('conflict: replace swaps in the new version without leftovers', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'a/f.txt'), 'new');
  write(path.join(d, 'b/f.txt'), 'old');
  const r = await run({ srcPath: path.join(d, 'a/f.txt'), destDir: path.join(d, 'b'), conflict: 'replace' });
  assert.equal(r.status, 'done');
  assert.equal(fs.readFileSync(path.join(d, 'b/f.txt'), 'utf8'), 'new');
  assert.deepEqual(partFiles(d), []);
});

test('cancel mid-copy removes the partial file and keeps the source', async (t) => {
  const d = tmpDir(t);
  bigFile(path.join(d, 'a/big.bin'));
  fs.mkdirSync(path.join(d, 'b'));
  const ac = new AbortController();
  await assert.rejects(transfer({
    srcPath: path.join(d, 'a/big.bin'), destDir: path.join(d, 'b'), move: true,
    signal: ac.signal, onProgress: () => ac.abort(),
  }));
  assert.ok(!fs.existsSync(path.join(d, 'b/big.bin')));
  assert.ok(fs.existsSync(path.join(d, 'a/big.bin')));
  assert.deepEqual(partFiles(d), []);
});

test('replace + cancel keeps the previous version', async (t) => {
  const d = tmpDir(t);
  bigFile(path.join(d, 'a/big.bin'));
  write(path.join(d, 'b/big.bin'), 'previous version');
  const ac = new AbortController();
  await assert.rejects(transfer({
    srcPath: path.join(d, 'a/big.bin'), destDir: path.join(d, 'b'), conflict: 'replace',
    signal: ac.signal, onProgress: () => ac.abort(),
  }));
  assert.equal(fs.readFileSync(path.join(d, 'b/big.bin'), 'utf8'), 'previous version');
  assert.deepEqual(partFiles(d), []);
});

test('missing source or destination gives a clear error', async (t) => {
  const d = tmpDir(t);
  fs.mkdirSync(path.join(d, 'b'));
  await assert.rejects(run({ srcPath: path.join(d, 'nope'), destDir: path.join(d, 'b') }), /Source/);
  write(path.join(d, 'f.txt'), 'x');
  await assert.rejects(run({ srcPath: path.join(d, 'f.txt'), destDir: path.join(d, 'nope') }), /Destination/);
});

test('moving a folder with a symlink keeps the original', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'src/real.txt'), 'x');
  try { fs.symlinkSync(path.join(d, 'src/real.txt'), path.join(d, 'src/link.txt')); }
  catch { return t.skip('cannot create symlinks on this machine'); }
  fs.mkdirSync(path.join(d, 'dst'));
  await assert.rejects(run({ srcPath: path.join(d, 'src'), destDir: path.join(d, 'dst'), move: true }), /symbolic links/);
  assert.ok(fs.existsSync(path.join(d, 'src/real.txt')));
  assert.ok(fs.existsSync(path.join(d, 'dst/src/real.txt')));
});
