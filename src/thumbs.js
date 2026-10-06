'use strict';

/* Video thumbnail + hover-preview generation, built on a bundled ffmpeg.
   - A still JPEG is sampled ~10% into the file (skips black intros).
   - A ~10s MP4 "preview" is assembled from 10 frames spread across the whole
     file, so hovering shows what's actually in the video end to end.
   Outputs are cached on disk keyed by volumeId/entryId — never in the DB. */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const VIDEO_EXTS = [
  'mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv',
  'mpg', 'mpeg', 'm2ts', 'ts', '3gp', 'ogv'
];
const IMAGE_EXTS = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'avif'
];
const MEDIA_EXTS = VIDEO_EXTS.concat(IMAGE_EXTS);

let cacheDir = null;     // set by init()
let ffmpegPath = null;   // resolved lazily

function resolveFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  // 1) ffmpeg-static (development / unpacked)
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return (ffmpegPath = p);
  } catch { /* not installed */ }
  // 2) packaged into resources (electron-builder extraResources)
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'ffmpeg.exe');
    if (fs.existsSync(p)) return (ffmpegPath = p);
  }
  // 3) fall back to a system ffmpeg on PATH
  return (ffmpegPath = 'ffmpeg');
}

function init(userDataPath) {
  cacheDir = path.join(userDataPath, 'thumbcache');
  fs.mkdirSync(cacheDir, { recursive: true });
  resolveFfmpeg();
}

function isVideo(ext) {
  return !!ext && VIDEO_EXTS.includes(ext.toLowerCase());
}
function isImage(ext) {
  return !!ext && IMAGE_EXTS.includes(ext.toLowerCase());
}
function isMedia(ext) {
  return !!ext && MEDIA_EXTS.includes(ext.toLowerCase());
}

function dirFor(volumeId) {
  return path.join(cacheDir, String(volumeId));
}
function thumbPath(volumeId, entryId) {
  return path.join(dirFor(volumeId), `${entryId}.jpg`);
}
function previewPath(volumeId, entryId) {
  return path.join(dirFor(volumeId), `${entryId}.mp4`);
}

async function ffmpegAvailable() {
  try {
    await run(['-version'], null, 8000);
    return true;
  } catch {
    return false;
  }
}

// Global cap on simultaneous ffmpeg processes. On-demand requests (hovering a
// list, the detail pane) and the batch generator all go through this, so a fast
// mouse sweep can no longer fork dozens of ffmpegs and exhaust RAM/handles.
const MAX_FFMPEG = 3;
let activeFfmpeg = 0;
const ffmpegWaiters = [];
function acquireSlot(signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    const grant = () => { activeFfmpeg++; resolve(); };
    if (activeFfmpeg < MAX_FFMPEG) return grant();
    const w = { grant };
    ffmpegWaiters.push(w);
    if (signal) signal.addEventListener('abort', () => {
      const i = ffmpegWaiters.indexOf(w);
      if (i >= 0) { ffmpegWaiters.splice(i, 1); reject(new Error('aborted')); }
    }, { once: true });
  });
}
function releaseSlot() {
  activeFfmpeg--;
  const next = ffmpegWaiters.shift();
  if (next) next.grant();
}

// Spawn ffmpeg with args; resolve on exit 0, reject otherwise. Abortable.
async function run(args, signal, timeoutMs) {
  await acquireSlot(signal);
  try { await runNow(args, signal, timeoutMs); }
  finally { releaseSlot(); }
}

function runNow(args, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpeg(), ['-nostdin', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let timer = null;
    proc.stderr.on('data', d => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs) timer = setTimeout(onAbort, timeoutMs);
    proc.on('error', e => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(e);
    });
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(new Error('aborted'));
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`));
    });
  });
}

// Parse "Duration: HH:MM:SS.xx" from ffmpeg's stderr (no ffprobe needed).
function probeDuration(src, signal) {
  return new Promise(resolve => {
    const proc = spawn(resolveFfmpeg(), ['-nostdin', '-i', src], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); if (err.length > 16000) err = err.slice(0, 8000) + err.slice(-4000); });
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const guard = setTimeout(onAbort, 30000);   // a hung drive must not hold the process forever
    proc.on('error', () => { clearTimeout(guard); if (signal) signal.removeEventListener('abort', onAbort); resolve(null); });
    proc.on('close', () => {
      clearTimeout(guard);
      if (signal) signal.removeEventListener('abort', onAbort);
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(null);
      resolve((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]));
    });
  });
}

// ---- smart still selection ------------------------------------------------
// The first frame of a video is often black, a logo, or a fade. Instead, probe a
// handful of positions with tiny grayscale frames and score each one (sharp,
// contrasty, neither black nor blown out), then render the winner full size.

const PROBE_W = 96, PROBE_H = 54;
const PROBE_POINTS = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85];

// Grab one tiny gray frame at `ts` as raw bytes (null if it can't be decoded).
function grabGray(src, ts, signal) {
  return new Promise(resolve => {
    const proc = spawn(resolveFfmpeg(), [
      '-nostdin', '-v', 'error', '-ss', String(ts), '-i', src, '-frames:v', '1',
      '-vf', `scale=${PROBE_W}:${PROBE_H},format=gray`, '-f', 'rawvideo', 'pipe:1'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const guard = setTimeout(onAbort, 20000);
    proc.stdout.on('data', d => chunks.push(d));
    const done = (v) => { clearTimeout(guard); if (signal) signal.removeEventListener('abort', onAbort); resolve(v); };
    proc.on('error', () => done(null));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      done(buf.length === PROBE_W * PROBE_H ? buf : null);
    });
  });
}

// Higher = a better thumbnail. Detail (edge energy) + contrast, heavily
// discounted for near-black or near-white frames.
function scoreFrame(px) {
  const n = px.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += px[i];
  const mean = sum / n;
  let varSum = 0, edge = 0;
  for (let y = 0; y < PROBE_H; y++) {
    for (let x = 0; x < PROBE_W; x++) {
      const v = px[y * PROBE_W + x];
      varSum += (v - mean) * (v - mean);
      if (x > 0) edge += Math.abs(v - px[y * PROBE_W + x - 1]);
      if (y > 0) edge += Math.abs(v - px[(y - 1) * PROBE_W + x]);
    }
  }
  const contrast = Math.sqrt(varSum / n);
  const exposure = Math.max(0.05, Math.min(1, mean / 50, (255 - mean) / 40));
  return (edge / n + contrast * 0.5) * exposure;
}

// Best timestamp (seconds) for a still, or 0 if it can't be decided.
async function pickBestTimestamp(src, signal) {
  const dur = (await probeDuration(src, signal)) || 0;
  if (dur < 4) return 0;                        // too short to be worth probing
  let best = 0, bestScore = -1;
  for (const f of PROBE_POINTS) {
    if (signal && signal.aborted) throw new Error('aborted');
    const ts = dur * f;
    const px = await grabGray(src, ts.toFixed(2), signal);
    if (!px) continue;
    const sc = scoreFrame(px);
    if (sc > bestScore) { bestScore = sc; best = ts; }
  }
  return best;
}

async function generateThumb(srcPath, volumeId, entryId, signal, kind) {
  const out = thumbPath(volumeId, entryId);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  // Images: decode directly. Videos: render the best-scoring frame (see above).
  // Render to a temp name and rename on success, so a killed/timed-out ffmpeg
  // never leaves a truncated .jpg that hasThumb() would treat as valid.
  const tmpOut = path.join(path.dirname(out), `part-${entryId}-${process.pid}.jpg`);
  try {
    let ts = 0;
    if (kind !== 'image') {
      await acquireSlot(signal);
      try { ts = await pickBestTimestamp(srcPath, signal); } catch (e) { if (e.message === 'aborted') throw e; ts = 0; }
      finally { releaseSlot(); }
    }
    const seek = ts > 0 ? ['-ss', ts.toFixed(2)] : [];
    await run([...seek, '-y', '-i', srcPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', tmpOut], signal, 60000);
    await fsp.rename(tmpOut, out);
  } catch (e) {
    await fsp.rm(tmpOut, { force: true }).catch(() => {});
    throw e;
  }
  return out;
}

// 10 frames spread across the video, assembled into a short looping MP4.
async function generatePreview(srcPath, volumeId, entryId, signal) {
  const out = previewPath(volumeId, entryId);
  await fsp.mkdir(path.dirname(out), { recursive: true });

  const dur = (await probeDuration(srcPath, signal)) || 0;
  const N = 10;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-prev-'));
  const SCALE = 'scale=320:180:force_original_aspect_ratio=decrease,' +
                'pad=320:180:(ow-iw)/2:(oh-ih)/2';
  try {
    let made = 0;
    for (let i = 0; i < N; i++) {
      if (signal && signal.aborted) throw new Error('aborted');
      const ts = dur > 0 ? (dur * (i + 0.5) / N).toFixed(2) : String(i);
      const frame = path.join(tmp, `f${made}.jpg`);
      try {
        await run([
          '-y', '-ss', ts, '-i', srcPath, '-frames:v', '1',
          '-vf', SCALE, '-q:v', '5', frame
        ], signal, 30000);
        made += 1;
      } catch (e) {
        if (e.message === 'aborted') throw e;
        // timestamp past end / unreadable frame — skip it
      }
    }
    if (made === 0) throw new Error('no frames extracted');

    const tmpOut = path.join(path.dirname(out), `part-${entryId}-${process.pid}.mp4`);
    try {
      await run([
        '-y', '-framerate', '1', '-start_number', '0',
        '-i', path.join(tmp, 'f%d.jpg'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '10',
        '-movflags', '+faststart', '-an', tmpOut
      ], signal, 90000);
      await fsp.rename(tmpOut, out);
    } catch (e) {
      await fsp.rm(tmpOut, { force: true }).catch(() => {});
      throw e;
    }
    return out;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Decode the whole file with ffmpeg, reporting any decode errors — a reliable
// way to tell whether a video/image is corrupt or just won't open. Abortable
// (large files can take a while). Resolves { ok, code, errors } or { aborted }.
function checkMedia(srcPath, signal) {
  return new Promise((resolve) => {
    const proc = spawn(resolveFfmpeg(), ['-nostdin', '-v', 'error', '-i', srcPath, '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    proc.stderr.on('data', d => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    proc.on('error', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ok: false, code: -1, errors: 'ffmpeg failed to start' });
    });
    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return resolve({ aborted: true });
      const errors = err.trim();
      resolve({ ok: code === 0 && !errors, code, errors });
    });
  });
}

// How many still thumbnails (.jpg) are already cached for a volume — used for
// the rail's "how many already created" coverage bar.
function countThumbs(volumeId) {
  try {
    return fs.readdirSync(dirFor(volumeId)).reduce((n, f) => n + (/^\d+\.jpg$/.test(f) ? 1 : 0), 0);
  } catch { return 0; }
}

// Total bytes of a volume's local cache (thumbnails + preview clips) — i.e. how
// much disk space this drive's catalog costs on the user's machine.
async function cacheSize(volumeId) {
  const dir = dirFor(volumeId);
  let files;
  try { files = await fsp.readdir(dir); } catch { return 0; }
  let total = 0;
  for (const f of files) {
    try { total += (await fsp.stat(path.join(dir, f))).size; } catch { /* skip */ }
  }
  return total;
}

async function hasThumb(volumeId, entryId) {
  try { await fsp.access(thumbPath(volumeId, entryId)); return true; } catch { return false; }
}
async function hasPreview(volumeId, entryId) {
  try { await fsp.access(previewPath(volumeId, entryId)); return true; } catch { return false; }
}

// Read every cached still for a volume as base64, keyed by entry id, so the
// thumbnails can travel inside a catalog export. Hover-preview .mp4 clips are
// intentionally left out — they're large and regenerate on demand.
async function exportThumbs(volumeId) {
  const dir = dirFor(volumeId);
  const out = {};
  let files;
  try { files = await fsp.readdir(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.jpg')) continue;
    const id = parseInt(f, 10);
    if (!Number.isInteger(id)) continue;
    try { out[id] = (await fsp.readFile(path.join(dir, f))).toString('base64'); } catch { /* skip */ }
  }
  return out;
}

// Write thumbnails carried in an export back into a (freshly imported) volume's
// cache, mapping each original entry id to its new id. Returns how many landed.
async function importThumbs(volumeId, thumbMap, idMap) {
  if (!thumbMap || typeof thumbMap !== 'object') return 0;
  const dir = dirFor(volumeId);
  await fsp.mkdir(dir, { recursive: true });
  let n = 0;
  for (const [oldId, b64] of Object.entries(thumbMap)) {
    const newId = idMap[oldId];
    if (newId == null || !b64) continue;
    try { await fsp.writeFile(path.join(dir, `${newId}.jpg`), Buffer.from(b64, 'base64')); n += 1; }
    catch { /* skip */ }
  }
  return n;
}

// After a re-scan/sync the entry ids change, so rename each cached file from
// its old id to the new id (matched by path via idRemap). Cached files whose
// entry is gone (deleted on disk) are dropped. New ids are always greater than
// old ones (AUTOINCREMENT), so a single pass can't clobber a not-yet-seen file.
async function remapCache(volumeId, idRemap) {
  const dir = dirFor(volumeId);
  let files;
  try { files = await fsp.readdir(dir); } catch { return; }
  const map = new Map(Object.entries(idRemap || {}).map(([o, n]) => [Number(o), n]));
  for (const f of files) {
    const m = /^(\d+)\.(jpg|mp4)$/.exec(f);
    if (!m) continue;
    const oldId = Number(m[1]), ext = m[2];
    const src = path.join(dir, f);
    const newId = map.get(oldId);
    if (newId == null) { await fsp.rm(src, { force: true }).catch(() => {}); continue; }
    const dst = path.join(dir, `${newId}.${ext}`);
    if (dst === src) continue;
    try { await fsp.rm(dst, { force: true }); await fsp.rename(src, dst); } catch { /* skip */ }
  }
}

// Delete the whole cache subtree for a volume (used on re-scan / removal).
async function clearVolume(volumeId) {
  await fsp.rm(dirFor(volumeId), { recursive: true, force: true }).catch(() => {});
}

// Drop the cached thumb + preview for a single entry (used when a file is deleted).
async function removeEntry(volumeId, entryId) {
  await fsp.rm(thumbPath(volumeId, entryId), { force: true }).catch(() => {});
  await fsp.rm(previewPath(volumeId, entryId), { force: true }).catch(() => {});
}

module.exports = {
  init, isVideo, isImage, isMedia, ffmpegAvailable,
  generateThumb, generatePreview, pickBestTimestamp, scoreFrame,
  hasThumb, hasPreview, countThumbs, cacheSize, checkMedia, exportThumbs, importThumbs, remapCache, clearVolume, removeEntry,
  thumbPath, previewPath, dirFor,
  VIDEO_EXTS, IMAGE_EXTS, MEDIA_EXTS,
  get cacheDir() { return cacheDir; }
};
