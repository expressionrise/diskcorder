'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Walk a directory tree and return a flat, DFS-ordered list of entries.
 * Parents always appear before their children, so the caller can map
 * temp ids -> real DB row ids in a single pass.
 *
 * @param {string} rootPath
 * @param {(count:number, current:string)=>void} onProgress
 */
async function scan(rootPath, onProgress) {
  const entries = [];
  let nextId = 1;
  let count = 0;

  async function walk(dirPath, relPath, parentTempId) {
    let dirents;
    try {
      dirents = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip rather than abort the whole scan
    }

    dirents.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

    for (const d of dirents) {
      // Never follow symlinks — avoids infinite loops on circular links.
      if (d.isSymbolicLink()) continue;

      const full = path.join(dirPath, d.name);
      const childRel = relPath ? `${relPath}/${d.name}` : d.name;
      const isDir = d.isDirectory();

      let size = 0;
      let mtime = null;
      try {
        const st = await fsp.stat(full);
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch {
        // permission denied / vanished file — record it with zeros
      }

      const tempId = nextId++;
      entries.push({
        tempId,
        parentTempId,
        name: d.name,
        relPath: childRel,
        isDir: isDir ? 1 : 0,
        size: isDir ? 0 : size,
        mtime,
        ext: isDir ? null : path.extname(d.name).slice(1).toLowerCase() || null
      });

      count += 1;
      if (onProgress && count % 250 === 0) onProgress(count, childRel);

      if (isDir) await walk(full, childRel, tempId);
    }
  }

  await walk(rootPath, '', null);
  if (onProgress) onProgress(count, '');
  return entries;
}

module.exports = { scan };
