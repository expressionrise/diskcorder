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

// Spawn ffmpeg with args; resolve on exit 0, reject otherwise. Abortable.
function run(args, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpeg(), args, { windowsHide: true });
    let err = '';
    let timer = null;
    proc.stderr.on('data', d => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs) timer = setTimeout(onAbort, timeoutMs);
    proc.on('error', e => { if (timer) clearTimeout(timer); reject(e); });
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
    const proc = spawn(resolveFfmpeg(), ['-i', src], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(null);
      resolve((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]));
    });
  });
}

async function generateThumb(srcPath, volumeId, entryId, signal, kind) {
  const out = thumbPath(volumeId, entryId);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  // Images: decode a single frame directly. Videos: seek ~10% in first.
  let args;
  if (kind === 'image') {
    args = ['-y', '-i', srcPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out];
  } else {
    const dur = await probeDuration(srcPath, signal);
    const ss = dur && dur > 1 ? (dur * 0.1).toFixed(2) : '0';
    args = ['-y', '-ss', ss, '-i', srcPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out];
  }
  await run(args, signal, 60000);
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

    await run([
      '-y', '-framerate', '1', '-start_number', '0',
      '-i', path.join(tmp, 'f%d.jpg'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '10',
      '-movflags', '+faststart', '-an', out
    ], signal, 90000);
    return out;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function hasThumb(volumeId, entryId) {
  try { await fsp.access(thumbPath(volumeId, entryId)); return true; } catch { return false; }
}
async function hasPreview(volumeId, entryId) {
  try { await fsp.access(previewPath(volumeId, entryId)); return true; } catch { return false; }
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
  generateThumb, generatePreview,
  hasThumb, hasPreview, clearVolume, removeEntry,
  thumbPath, previewPath, dirFor,
  VIDEO_EXTS, IMAGE_EXTS, MEDIA_EXTS,
  get cacheDir() { return cacheDir; }
};
