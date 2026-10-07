'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runBackup } = require('../src/backup');
const { tmpDir, write, bigFile, partFiles } = require('./helpers');

const backup = (o) => runBackup({ signal: new AbortController().signal, onProgress: () => {}, ...o });

test('first run copies everything, second run skips unchanged files', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'src/a.txt'), 'aaa');
  write(path.join(d, 'src/sub/b.txt'), 'bbbb');
  const o = { srcBase: path.join(d, 'src'), destBase: path.join(d, 'dst') };
  const first = await backup(o);
  assert.equal(first.copied, 2);
  assert.equal(fs.readFileSync(path.join(d, 'dst/sub/b.txt'), 'utf8'), 'bbbb');
  const second = await backup(o);
  assert.equal(second.copied, 0);
  assert.equal(second.skipped, 2);
});

test('changed files are updated, nothing is ever deleted at the destination', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'src/a.txt'), 'v1');
  const o = { srcBase: path.join(d, 'src'), destBase: path.join(d, 'dst') };
  await backup(o);
  write(path.join(d, 'dst/extra.txt'), 'only at destination');
  write(path.join(d, 'src/a.txt'), 'version two');
  const r = await backup(o);
  assert.equal(r.copied, 1);
  assert.equal(fs.readFileSync(path.join(d, 'dst/a.txt'), 'utf8'), 'version two');
  assert.ok(fs.existsSync(path.join(d, 'dst/extra.txt')));
});

test('items limits the backup to the selected paths', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'src/keep/a.txt'), 'a');
  write(path.join(d, 'src/skip/b.txt'), 'b');
  const r = await backup({ srcBase: path.join(d, 'src'), destBase: path.join(d, 'dst'), items: ['keep'] });
  assert.equal(r.copied, 1);
  assert.ok(!fs.existsSync(path.join(d, 'dst/skip')));
});

test('missing item counts as an error and the run continues', async (t) => {
  const d = tmpDir(t);
  write(path.join(d, 'src/a.txt'), 'a');
  const r = await backup({ srcBase: path.join(d, 'src'), destBase: path.join(d, 'dst'), items: ['gone', 'a.txt'] });
  assert.equal(r.errors, 1);
  assert.equal(r.copied, 1);
});

test('cancel keeps the previous good copy and leaves no part files', async (t) => {
  const d = tmpDir(t);
  bigFile(path.join(d, 'src/big.bin'));
  write(path.join(d, 'dst/big.bin'), 'old good copy');
  fs.utimesSync(path.join(d, 'dst/big.bin'), new Date(2000, 0, 1), new Date(2000, 0, 1));
  const ac = new AbortController();
  await assert.rejects(runBackup({
    srcBase: path.join(d, 'src'), destBase: path.join(d, 'dst'),
    signal: ac.signal, onProgress: () => ac.abort(),
  }));
  assert.equal(fs.readFileSync(path.join(d, 'dst/big.bin'), 'utf8'), 'old good copy');
  assert.deepEqual(partFiles(d), []);
});
