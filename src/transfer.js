'use strict';

/* Copy / move files and folders between drives.
   Uses stream.pipeline (not fs.copyFile / fs.rename) so we get byte-level
   progress, clean teardown on error/cancel, and cross-volume moves that
   fs.rename can't do (EXDEV). Everything is abortable via AbortSignal. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');

const HIGH_WATER = 1 << 18; // 256 KB — good throughput on USB 3.x

// Count total bytes to move so the UI can show overall progress.
async function measure(srcPath) {
  const st = await fsp.stat(srcPath);
  if (st.isFile()) return st.size;
  let total = 0;
  const dirents = await fsp.readdir(srcPath, { withFileTypes: true });
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue;
    total += await measure(path.join(srcPath, d.name)).catch(() => 0);
  }
  return total;
}

// Pick a non-colliding destination path: "name (2).ext", "name (3).ext"…
async function resolveConflict(dstPath, mode) {
  let exists = await fsp.access(dstPath).then(() => true).catch(() => false);
  if (!exists) return { dstPath, skip: false };
  if (mode === 'replace') return { dstPath, skip: false };
  if (mode === 'skip') return { dstPath, skip: true };

  // keep-both (default)
  const dir = path.dirname(dstPath);
  const ext = path.extname(dstPath);
  const base = path.basename(dstPath, ext);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!(await fsp.access(candidate).then(() => true).catch(() => false))) {
      return { dstPath: candidate, skip: false };
    }
  }
  throw new Error('Could not find a free name at the destination.');
}

function copyFileStream(srcPath, dstPath, signal, onBytes) {
  const rs = fs.createReadStream(srcPath, { highWaterMark: HIGH_WATER, signal });
  rs.on('data', chunk => onBytes(chunk.length));
  const ws = fs.createWriteStream(dstPath);
  return pipeline(rs, ws, { signal });
}

/**
 * Recursively copy src -> dst. Calls onBytes(n) as data flows.
 * On abort, partially written files are removed.
 */
async function copyRecursive(srcPath, dstPath, signal, onBytes) {
  const st = await fsp.stat(srcPath);
  if (st.isDirectory()) {
    await fsp.mkdir(dstPath, { recursive: true });
    const dirents = await fsp.readdir(srcPath, { withFileTypes: true });
    for (const d of dirents) {
      if (signal.aborted) throw new Error('aborted');
      if (d.isSymbolicLink()) continue;
      await copyRecursive(path.join(srcPath, d.name), path.join(dstPath, d.name), signal, onBytes);
    }
  } else {
    try {
      await copyFileStream(srcPath, dstPath, signal, onBytes);
    } catch (err) {
      await fsp.rm(dstPath, { force: true }).catch(() => {}); // drop partial file
      throw err;
    }
  }
}

/**
 * High-level transfer of one entry to a destination directory.
 * @param {object} opts
 *   srcPath, destDir, move, conflict ('keepboth'|'replace'|'skip'),
 *   signal, onProgress({copied,total}).
 * @returns {Promise<{status:'done'|'skipped', dstPath:string}>}
 */
async function transfer({ srcPath, destDir, move, conflict, signal, onProgress }) {
  if (!fs.existsSync(srcPath)) throw new Error('Source is no longer reachable. Connect the drive and try again.');
  if (!fs.existsSync(destDir)) throw new Error('Destination drive is not reachable.');

  const name = path.basename(srcPath);
  const wanted = path.join(destDir, name);
  const { dstPath, skip } = await resolveConflict(wanted, conflict || 'keepboth');
  if (skip) return { status: 'skipped', dstPath: wanted };

  const total = await measure(srcPath);
  let copied = 0;
  let lastTick = 0;
  const onBytes = (n) => {
    copied += n;
    const now = Date.now();
    if (onProgress && (now - lastTick > 80 || copied === total)) {
      lastTick = now;
      onProgress({ copied, total });
    }
  };

  if (conflict === 'replace') await fsp.rm(dstPath, { recursive: true, force: true }).catch(() => {});
  await copyRecursive(srcPath, dstPath, signal, onBytes);
  if (onProgress) onProgress({ copied: total, total });

  if (move) {
    // Only delete the source once the copy fully succeeded.
    await fsp.rm(srcPath, { recursive: true, force: true });
  }
  return { status: 'done', dstPath };
}

module.exports = { transfer, measure };
