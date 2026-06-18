'use strict';

/* Additive backup between drives: copy new and changed files from the selected
   source folders into the destination, skip files that are already there and
   unchanged, and never delete anything at the destination. Streamed (byte
   progress), abortable, and resilient — an unreadable file is counted as an
   error and skipped rather than aborting the whole run. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');

const HIGH_WATER = 1 << 18; // 256 KB

const MAX_LOGGED_FILES = 20000;   // cap the per-run file list so logs stay sane

function newStats() {
  return { copied: 0, skipped: 0, errors: 0, copiedBytes: 0, skippedBytes: 0, current: '', files: [] };
}

// Copy one file if it's new or changed; otherwise skip. "Changed" = different
// size, or the source is newer than the destination copy.
async function backupFile(src, dst, ctx) {
  const { signal, onProgress, stats } = ctx;
  let sst;
  try { sst = await fsp.stat(src); } catch { stats.errors++; return; }

  let needsCopy = true;
  try {
    const dst_st = await fsp.stat(dst);
    if (dst_st.size === sst.size && dst_st.mtimeMs >= sst.mtimeMs - 2000) needsCopy = false;
  } catch { needsCopy = true; }

  if (!needsCopy) {
    stats.skipped++;
    stats.skippedBytes += sst.size;
    onProgress(stats);
    return;
  }

  stats.current = path.basename(src);
  try {
    await fsp.mkdir(path.dirname(dst), { recursive: true }).catch(() => {});
    const rs = fs.createReadStream(src, { highWaterMark: HIGH_WATER, signal });
    rs.on('data', (c) => { stats.copiedBytes += c.length; onProgress(stats); });
    const ws = fs.createWriteStream(dst);
    await pipeline(rs, ws, { signal });
    await fsp.utimes(dst, sst.atime, sst.mtime).catch(() => {}); // keep mtime so next run skips it
    stats.copied++;
    if (stats.files.length < MAX_LOGGED_FILES) stats.files.push(path.relative(ctx.srcBase, src));
    onProgress(stats);
  } catch (err) {
    await fsp.rm(dst, { force: true }).catch(() => {}); // drop partial file
    if (signal.aborted || err.name === 'AbortError' || err.message === 'aborted') throw err;
    stats.errors++;
  }
}

async function backupTree(srcDir, dstDir, ctx) {
  const { signal } = ctx;
  let dirents;
  try { dirents = await fsp.readdir(srcDir, { withFileTypes: true }); }
  catch { ctx.stats.errors++; return; }
  await fsp.mkdir(dstDir, { recursive: true }).catch(() => {});
  for (const d of dirents) {
    if (signal.aborted) throw new Error('aborted');
    if (d.isSymbolicLink()) continue;
    const s = path.join(srcDir, d.name), t = path.join(dstDir, d.name);
    if (d.isDirectory()) await backupTree(s, t, ctx);
    else if (d.isFile()) await backupFile(s, t, ctx);
  }
}

/**
 * Back up selected items (relative paths) from srcBase into destBase.
 * @param {object} o  srcBase, destBase, items (string[] of rel paths; '' = whole drive),
 *                    signal, onProgress(stats)
 * @returns {Promise<stats>}
 */
async function runBackup({ srcBase, destBase, items, signal, onProgress }) {
  const stats = newStats();
  const ctx = { signal, onProgress, stats, srcBase };
  await fsp.mkdir(destBase, { recursive: true }).catch(() => {});
  const rels = (items && items.length) ? items : [''];
  for (const rel of rels) {
    if (signal.aborted) break;
    const s = rel ? path.join(srcBase, rel) : srcBase;
    const t = rel ? path.join(destBase, rel) : destBase;
    let st;
    try { st = await fsp.stat(s); } catch { stats.errors++; continue; }
    if (st.isDirectory()) await backupTree(s, t, ctx);
    else if (st.isFile()) await backupFile(s, t, ctx);
  }
  return stats;
}

module.exports = { runBackup };
