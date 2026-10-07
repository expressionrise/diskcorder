'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const thumbs = require('../src/thumbs');
const { tmpDir } = require('./helpers');

const FFMPEG = require('ffmpeg-static');

// Fixtures are generated once with ffmpeg's built-in test sources (no binary
// files in the repo). `black3` = 3 s of black followed by 9 s of a test pattern.
let fixtures = null;
function ff(args) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffmpeg failed: ${r.stderr}`);
}
function makeFixtures(dir) {
  const plain = path.join(dir, 'plain.mp4');
  const black3 = path.join(dir, 'black3.mp4');
  const image = path.join(dir, 'pic.png');
  ff(['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=25:d=6', '-c:v', 'mpeg4', plain]);
  ff(['-f', 'lavfi', '-i', 'color=black:s=320x240:r=25:d=3',
      '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=25:d=9',
      '-filter_complex', 'concat=n=2:v=1:a=0', '-c:v', 'mpeg4', black3]);
  ff(['-f', 'lavfi', '-i', 'testsrc=s=64x48', '-frames:v', '1', image]);
  return { plain, black3, image };
}

test.before(() => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'diskcorder-fixtures-'));
  fixtures = makeFixtures(dir);
  fixtures.dir = dir;
});
test.after(() => fs.rmSync(fixtures.dir, { recursive: true, force: true }));

function leftovers(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...leftovers(p));
    else if (d.name.startsWith('part-')) out.push(p);
  }
  return out;
}

test('media type helpers are case-insensitive', () => {
  assert.ok(thumbs.isVideo('MP4') && thumbs.isVideo('mkv'));
  assert.ok(thumbs.isImage('JPG') && !thumbs.isImage('mp4'));
  assert.ok(thumbs.isMedia('png') && !thumbs.isMedia('txt') && !thumbs.isMedia(null));
});

test('scoreFrame prefers a detailed frame over black or white ones', () => {
  const n = 96 * 54;
  const black = Buffer.alloc(n, 2);
  const white = Buffer.alloc(n, 253);
  const detail = Buffer.alloc(n);
  for (let i = 0; i < n; i++) detail[i] = (i + Math.floor(i / 96)) % 2 ? 190 : 60; // checkerboard
  assert.ok(thumbs.scoreFrame(detail) > thumbs.scoreFrame(black) * 5);
  assert.ok(thumbs.scoreFrame(detail) > thumbs.scoreFrame(white) * 3);
});

test('probeInfo reads duration, size, fps and codec', async () => {
  const info = await thumbs.probeInfo(fixtures.plain);
  assert.equal(info.width, 320);
  assert.equal(info.height, 240);
  assert.equal(info.fps, 25);
  assert.equal(info.vcodec, 'mpeg4');
  assert.ok(Math.abs(info.duration - 6) < 0.2, `duration ${info.duration}`);
});

test('probeInfo returns null for a file ffmpeg cannot read', async (t) => {
  const bad = path.join(tmpDir(t), 'nope.mp4');
  fs.writeFileSync(bad, 'not a video');
  assert.equal(await thumbs.probeInfo(bad), null);
});

test('pickBestTimestamp skips a black intro', async () => {
  const ts = await thumbs.pickBestTimestamp(fixtures.black3);
  assert.ok(ts >= 3, `picked ${ts}s, inside the 3 s black intro`);
});

test('pickBestTimestamp returns 0 for very short clips', async (t) => {
  const short = path.join(tmpDir(t), 'short.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=25:d=2', '-c:v', 'mpeg4', short]);
  assert.equal(await thumbs.pickBestTimestamp(short), 0);
});

test('generateThumb writes a jpg and leaves no part files', async (t) => {
  const dir = tmpDir(t);
  thumbs.init(dir);
  const out = await thumbs.generateThumb(fixtures.black3, 1, 10, undefined, 'video');
  assert.ok(fs.statSync(out).size > 500);
  const img = await thumbs.generateThumb(fixtures.image, 1, 11, undefined, 'image');
  assert.ok(fs.statSync(img).size > 100);
  assert.ok(thumbs.hasThumb ? await thumbs.hasThumb(1, 10) : true);
  assert.deepEqual(leftovers(dir), []);
});

test('an aborted generateThumb rejects and leaves no part files', async (t) => {
  const dir = tmpDir(t);
  thumbs.init(dir);
  const ac = new AbortController();
  const p = thumbs.generateThumb(fixtures.black3, 2, 20, ac.signal, 'video');
  ac.abort();
  await assert.rejects(p);
  assert.deepEqual(leftovers(dir), []);
  assert.ok(!fs.existsSync(thumbs.thumbPath(2, 20)), 'no truncated thumbnail may remain');
});

test('checkMedia tells a good file from a corrupt one', async (t) => {
  const good = await thumbs.checkMedia(fixtures.plain);
  assert.equal(good.ok, true);
  const broken = path.join(tmpDir(t), 'broken.mp4');
  fs.writeFileSync(broken, Buffer.concat([fs.readFileSync(fixtures.plain).subarray(0, 4000), Buffer.alloc(2000, 1)]));
  const bad = await thumbs.checkMedia(broken);
  assert.equal(bad.ok, false);
});
