'use strict';

const Database = require('better-sqlite3');

let db = null;

// Bump this whenever the schema changes and add a matching migration step.
const SCHEMA_VERSION = 6;

function init(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS volumes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      root_path   TEXT,
      scanned_at  TEXT,
      file_count  INTEGER DEFAULT 0,
      total_bytes INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS entries (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      volume_id INTEGER NOT NULL,
      parent_id INTEGER,
      name      TEXT NOT NULL,
      rel_path  TEXT NOT NULL,
      is_dir    INTEGER NOT NULL,
      size      INTEGER DEFAULT 0,
      mtime     TEXT,
      ext       TEXT,
      note      TEXT,
      alias     TEXT,
      FOREIGN KEY (volume_id) REFERENCES volumes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entries_volume ON entries(volume_id);
    CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_id);
    CREATE INDEX IF NOT EXISTS idx_entries_name   ON entries(name);
  `);

  runMigrations();
  return db;
}

// Lightweight, forward-only migration runner keyed on SQLite's user_version.
function runMigrations() {
  let v = db.pragma('user_version', { simple: true });

  if (v < 1) {
    // v1: index on ext for fast "all videos in this volume" style queries.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_ext ON entries(ext);`);
    v = 1;
  }
  if (v < 2) {
    // v2: composite index for the children listing (the hot browse query).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_vol_parent ON entries(volume_id, parent_id);`);
    v = 2;
  }
  if (v < 3) {
    // v3: per-entry tags (JSON array) + a vocabulary of every tag ever used.
    const cols = db.prepare(`PRAGMA table_info(entries)`).all();
    if (!cols.some(c => c.name === 'tags')) db.exec(`ALTER TABLE entries ADD COLUMN tags TEXT`);
    db.exec(`CREATE TABLE IF NOT EXISTS tag_vocab (
      name      TEXT PRIMARY KEY COLLATE NOCASE,
      last_used TEXT
    )`);
    v = 3;
  }
  if (v < 4) {
    // v4: recursive subtree size per entry (folders show how much they hold).
    const cols = db.prepare(`PRAGMA table_info(entries)`).all();
    if (!cols.some(c => c.name === 'tree_size')) db.exec(`ALTER TABLE entries ADD COLUMN tree_size INTEGER`);
    backfillTreeSizes();
    v = 4;
  }
  if (v < 5) {
    // v5: optional per-drive avatar (an emoji), shown on the rail card.
    const cols = db.prepare(`PRAGMA table_info(volumes)`).all();
    if (!cols.some(c => c.name === 'icon')) db.exec(`ALTER TABLE volumes ADD COLUMN icon TEXT`);
    v = 5;
  }
  if (v < 6) {
    // v6: optional per-file flag (a star/heart/… emoji) shown beside the row.
    const cols = db.prepare(`PRAGMA table_info(entries)`).all();
    if (!cols.some(c => c.name === 'flag')) db.exec(`ALTER TABLE entries ADD COLUMN flag TEXT`);
    v = 6;
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

// Compute subtree sizes for existing catalogs (new scans compute them inline).
// Parents are inserted before children, so reverse-id order visits children
// first and rolls their totals up into parents in a single pass.
function backfillTreeSizes() {
  const rows = db.prepare(`SELECT id, parent_id, size, is_dir FROM entries ORDER BY id`).all();
  const acc = new Map();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const own = (acc.get(r.id) || 0) + (r.is_dir ? 0 : r.size);
    acc.set(r.id, own);
    if (r.parent_id != null) acc.set(r.parent_id, (acc.get(r.parent_id) || 0) + own);
  }
  const upd = db.prepare(`UPDATE entries SET tree_size = ? WHERE id = ?`);
  db.transaction(() => { for (const r of rows) upd.run(acc.get(r.id) || 0, r.id); })();
}

function close() {
  if (db) {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    db.close();
    db = null;
  }
}

// ---- Volumes -------------------------------------------------------------

function listVolumes() {
  return db.prepare(`
    SELECT id, name, root_path, scanned_at, file_count, total_bytes, icon
    FROM volumes
    ORDER BY name COLLATE NOCASE
  `).all();
}

function getVolume(volumeId) {
  return db.prepare(`SELECT * FROM volumes WHERE id = ?`).get(volumeId);
}

function deleteVolume(volumeId) {
  db.prepare(`DELETE FROM volumes WHERE id = ?`).run(volumeId);
}

function renameVolume(volumeId, name) {
  db.prepare(`UPDATE volumes SET name = ? WHERE id = ?`).run(name, volumeId);
}

function setVolumeIcon(volumeId, icon) {
  db.prepare(`UPDATE volumes SET icon = ? WHERE id = ?`).run(icon || null, volumeId);
}

// Replace a volume's catalog in one atomic transaction.
const replaceVolume = (() => {
  const insertVolume = () => db.prepare(`
    INSERT INTO volumes (name, root_path, scanned_at, file_count, total_bytes)
    VALUES (@name, @root_path, @scanned_at, @file_count, @total_bytes)
  `);
  const insertEntry = () => db.prepare(`
    INSERT INTO entries (volume_id, parent_id, name, rel_path, is_dir, size, mtime, ext)
    VALUES (@volume_id, @parent_id, @name, @rel_path, @is_dir, @size, @mtime, @ext)
  `);

  return function (existingVolumeId, meta, rows) {
    const tx = db.transaction(() => {
      let volumeId = existingVolumeId;
      // Previous scan keyed by rel_path: keeps notes/aliases/tags AND lets the
      // caller remap the (entry-id-keyed) thumbnail cache to the new ids.
      const oldByPath = new Map();
      if (existingVolumeId) {
        const old = db.prepare(`SELECT id, rel_path, note, alias, tags, flag, size, mtime FROM entries WHERE volume_id = ?`)
          .all(existingVolumeId);
        for (const r of old) oldByPath.set(r.rel_path, r);
        db.prepare(`DELETE FROM entries WHERE volume_id = ?`).run(existingVolumeId);
        // Keep the SAME volume row — a stable id preserves the thumbnail cache
        // dir, the drive icon, and any per-drive settings keyed by id.
        db.prepare(`UPDATE volumes SET name = @name, root_path = @root_path, scanned_at = @scanned_at WHERE id = @id`)
          .run({ name: meta.name, root_path: meta.root_path, scanned_at: meta.scanned_at, id: existingVolumeId });
      } else {
        volumeId = insertVolume().run(meta).lastInsertRowid;
      }

      const stmt = insertEntry();
      const updateAnnotations = db.prepare(`UPDATE entries SET note = ?, alias = ?, tags = ?, flag = ? WHERE id = ?`);
      const tempToReal = new Map();
      const idRemap = {};                 // old entry id -> new entry id (same rel_path)
      let totalBytes = 0;
      let fileCount = 0;

      for (const r of rows) {
        const parentId = r.parentTempId == null ? null : tempToReal.get(r.parentTempId);
        const info = stmt.run({
          volume_id: volumeId,
          parent_id: parentId,
          name: r.name,
          rel_path: r.relPath,
          is_dir: r.isDir,
          size: r.size,
          mtime: r.mtime,
          ext: r.ext
        });
        const newId = info.lastInsertRowid;
        tempToReal.set(r.tempId, newId);
        if (!r.isDir) { totalBytes += r.size; fileCount += 1; }

        const keep = oldByPath.get(r.relPath);
        if (keep) {
          if (keep.note != null || keep.alias != null || keep.tags != null || keep.flag != null) {
            updateAnnotations.run(keep.note, keep.alias, keep.tags, keep.flag, newId);
          }
          // Carry the cached thumbnail over only when the file is unchanged.
          // If it changed (same path, different size/mtime) leave it out, so the
          // stale thumb is dropped and a fresh one is generated. Most files are
          // unchanged between scans, so this keeps nearly all thumbnails.
          if (keep.size === r.size && keep.mtime === r.mtime) idRemap[keep.id] = newId;
        }
      }

      db.prepare(`UPDATE volumes SET file_count = ?, total_bytes = ? WHERE id = ?`)
        .run(fileCount, totalBytes, volumeId);

      // Roll file sizes up into folder subtree totals (children precede parents
      // when iterating in reverse, since parents are emitted first).
      const subtree = new Map();
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        const own = (subtree.get(r.tempId) || 0) + (r.isDir ? 0 : r.size);
        subtree.set(r.tempId, own);
        if (r.parentTempId != null) subtree.set(r.parentTempId, (subtree.get(r.parentTempId) || 0) + own);
      }
      const updTree = db.prepare(`UPDATE entries SET tree_size = ? WHERE id = ?`);
      for (const r of rows) updTree.run(subtree.get(r.tempId) || 0, tempToReal.get(r.tempId));

      return { volumeId, idRemap };
    });
    return tx();
  };
})();

// ---- Entries -------------------------------------------------------------

function getChildren(volumeId, parentId) {
  return db.prepare(`
    SELECT id, name, rel_path, is_dir, size, tree_size, mtime, ext, note, alias, tags, flag
    FROM entries
    WHERE volume_id = ? AND parent_id IS ?
    ORDER BY is_dir DESC, name COLLATE NOCASE
  `).all(volumeId, parentId ?? null);
}

// Flat tree for the space-map view: everything under a parent (or the whole
// volume when parentId is null), with subtree sizes for the treemap.
function getTreemap(volumeId, parentId) {
  return db.prepare(`
    SELECT id, parent_id, name, is_dir, ext, size, tree_size
    FROM entries
    WHERE volume_id = ? AND parent_id IS ?
    ORDER BY tree_size DESC
  `).all(volumeId, parentId ?? null);
}

function getEntry(id) {
  return db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
}

// All media entries (videos + images) for a volume, used to queue thumbnails.
function getMediaEntries(volumeId, exts) {
  const placeholders = exts.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, rel_path, ext, size FROM entries
    WHERE volume_id = ? AND is_dir = 0 AND ext IN (${placeholders})
    ORDER BY size DESC
  `).all(volumeId, ...exts);
}

// Every file (no folders) on a volume — for the flat "List" view. Sorting is
// done client-side; capped so a huge catalog can't overwhelm the renderer.
function listFiles(volumeId) {
  return db.prepare(`
    SELECT id, parent_id, name, rel_path, is_dir, size, mtime, ext, note, alias, tags, flag
    FROM entries WHERE volume_id = ? AND is_dir = 0
    LIMIT 20000
  `).all(volumeId);
}

// Every file (recursively) under a folder — for List/Gallery views that keep
// the same folder context when you switch views. parentId null = whole drive.
function listFilesUnder(volumeId, parentId) {
  return db.prepare(`
    WITH RECURSIVE descend(id) AS (
      SELECT id FROM entries WHERE volume_id = @v AND parent_id IS @p
      UNION ALL
      SELECT e.id FROM entries e JOIN descend d ON e.parent_id = d.id
    )
    SELECT e.id, e.parent_id, e.name, e.rel_path, e.is_dir, e.size, e.mtime, e.ext, e.note, e.alias, e.tags, e.flag
    FROM entries e JOIN descend ON e.id = descend.id
    WHERE e.is_dir = 0
    LIMIT 20000
  `).all({ v: volumeId, p: parentId ?? null });
}

// Every flagged (starred/hearted/…) entry on a volume, for the Starred tab.
function listFlagged(volumeId) {
  return db.prepare(`
    SELECT id, parent_id, name, rel_path, is_dir, size, tree_size, mtime, ext, note, alias, tags, flag
    FROM entries
    WHERE volume_id = ? AND flag IS NOT NULL
    ORDER BY flag, is_dir DESC, name COLLATE NOCASE
    LIMIT 20000
  `).all(volumeId);
}

// The folder chain from the volume root down to (and including) this entry,
// so the UI can rebuild a breadcrumb / navigate to any folder by id.
function getAncestry(id) {
  return db.prepare(`
    WITH RECURSIVE up(id, parent_id, name, is_dir, rel_path, lvl) AS (
      SELECT id, parent_id, name, is_dir, rel_path, 0 FROM entries WHERE id = ?
      UNION ALL
      SELECT e.id, e.parent_id, e.name, e.is_dir, e.rel_path, up.lvl + 1
      FROM entries e JOIN up ON e.id = up.parent_id
    )
    SELECT id, name, is_dir, rel_path FROM up ORDER BY lvl DESC
  `).all(id);
}

// Resolve a folder by its relative path to its current entry id (used to
// restore the last-open folder, even after a re-scan changed the ids).
function resolveFolderPath(volumeId, relPath) {
  const row = db.prepare(`SELECT id FROM entries WHERE volume_id = ? AND rel_path = ? AND is_dir = 1`)
    .get(volumeId, relPath);
  return row ? row.id : null;
}

// Largest files on a volume, with optional size/date filters. mtime is stored
// as an ISO string, so lexicographic >=/<= bounds work as date filters.
function getLargeFiles(volumeId, opts = {}) {
  const limit = Math.min(2000, Math.max(1, opts.limit || 100));
  const where = ['volume_id = ?', 'is_dir = 0'];
  const params = [volumeId];
  if (opts.minSize) { where.push('size >= ?'); params.push(opts.minSize); }
  if (opts.maxSize) { where.push('size <= ?'); params.push(opts.maxSize); }
  if (opts.after)   { where.push('mtime >= ?'); params.push(opts.after); }
  if (opts.before)  { where.push('mtime <= ?'); params.push(opts.before); }
  return db.prepare(`
    SELECT id, name, rel_path, size, mtime, ext, note, alias, tags, flag
    FROM entries
    WHERE ${where.join(' AND ')}
    ORDER BY size DESC
    LIMIT ?
  `).all(...params, limit);
}

// Count of media entries for a volume, for thumbnail-coverage reporting.
function countMediaEntries(volumeId, exts) {
  const placeholders = exts.map(() => '?').join(',');
  return db.prepare(`
    SELECT COUNT(*) AS n FROM entries
    WHERE volume_id = ? AND is_dir = 0 AND ext IN (${placeholders})
  `).get(volumeId, ...exts).n;
}

// ---- Export / import a volume catalog (JSON) -----------------------------

function exportVolume(volumeId) {
  const volume = db.prepare(
    `SELECT name, root_path, scanned_at, file_count, total_bytes, icon FROM volumes WHERE id = ?`
  ).get(volumeId);
  if (!volume) return null;
  const entries = db.prepare(
    `SELECT id, parent_id, name, rel_path, is_dir, size, mtime, ext, note, alias, tags, tree_size, flag
     FROM entries WHERE volume_id = ? ORDER BY id`
  ).all(volumeId);
  return { format: 'diskcorder-volume', version: 1, exported_at: new Date().toISOString(), volume, entries };
}

function importVolume(data) {
  if (!data || data.format !== 'diskcorder-volume' || !Array.isArray(data.entries)) {
    throw new Error('That file is not a Diskcorder catalog export.');
  }
  const v = data.volume || {};
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO volumes (name, root_path, scanned_at, file_count, total_bytes, icon)
      VALUES (@name, @root_path, @scanned_at, @file_count, @total_bytes, @icon)
    `).run({
      name: String(v.name || 'Imported drive'),
      root_path: v.root_path || null,
      scanned_at: v.scanned_at || new Date().toISOString(),
      file_count: v.file_count || 0,
      total_bytes: v.total_bytes || 0,
      icon: v.icon || null
    });
    const volumeId = info.lastInsertRowid;
    const ins = db.prepare(`
      INSERT INTO entries (volume_id, parent_id, name, rel_path, is_dir, size, mtime, ext, note, alias, tags, tree_size, flag)
      VALUES (@volume_id, @parent_id, @name, @rel_path, @is_dir, @size, @mtime, @ext, @note, @alias, @tags, @tree_size, @flag)
    `);
    const vocab = db.prepare(`INSERT INTO tag_vocab (name, last_used) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_used = excluded.last_used`);
    const now = new Date().toISOString();
    const idMap = new Map();
    // Parents are exported before children (ordered by id); ensure that here.
    const rows = data.entries.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
    for (const e of rows) {
      const parent = e.parent_id == null ? null : (idMap.get(e.parent_id) ?? null);
      const r = ins.run({
        volume_id: volumeId, parent_id: parent,
        name: String(e.name || ''), rel_path: String(e.rel_path || ''),
        is_dir: e.is_dir ? 1 : 0, size: e.size || 0, mtime: e.mtime || null,
        ext: e.ext || null, note: e.note || null, alias: e.alias || null,
        tags: e.tags || null, tree_size: e.tree_size || 0, flag: e.flag || null
      });
      idMap.set(e.id, r.lastInsertRowid);
      if (e.tags) { try { for (const t of JSON.parse(e.tags)) vocab.run(t, now); } catch { /* ignore bad tags */ } }
    }
    // Return the id remap too, so cached thumbnails carried in the export can
    // be rewritten to the new entry ids by the caller.
    return { volumeId, idMap: Object.fromEntries(idMap) };
  });
  return tx();
}

// ---- Tags ----------------------------------------------------------------

function setTags(id, tags) {
  const json = tags && tags.length ? JSON.stringify(tags) : null;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).run(json, id);
    if (tags && tags.length) {
      const now = new Date().toISOString();
      const up = db.prepare(`
        INSERT INTO tag_vocab (name, last_used) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET last_used = excluded.last_used
      `);
      for (const t of tags) up.run(t, now);
    }
  });
  tx();
}

// Every tag ever used, most-recently-used first (for autocomplete/recall).
function listTags() {
  return db.prepare(`SELECT name FROM tag_vocab ORDER BY last_used DESC, name COLLATE NOCASE`)
    .all().map(r => r.name);
}

function setNote(id, note) {
  db.prepare(`UPDATE entries SET note = ? WHERE id = ?`).run(note || null, id);
}

function setAlias(id, alias) {
  db.prepare(`UPDATE entries SET alias = ? WHERE id = ?`).run(alias || null, id);
}

function setFlag(id, flag) {
  db.prepare(`UPDATE entries SET flag = ? WHERE id = ?`).run(flag || null, id);
}

// Bulk-add one tag to many entries, merging with each entry's existing tags
// (no duplicates), and record it in the vocabulary. Returns how many changed.
function addTagToEntries(ids, tag) {
  tag = String(tag || '').trim();
  if (!tag || !Array.isArray(ids) || !ids.length) return 0;
  let changed = 0;
  const tx = db.transaction(() => {
    const get = db.prepare(`SELECT tags FROM entries WHERE id = ?`);
    const upd = db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`);
    for (const id of ids) {
      const row = get.get(id);
      if (!row) continue;
      let arr = [];
      try { const a = JSON.parse(row.tags || '[]'); if (Array.isArray(a)) arr = a; } catch { /* ignore bad tags */ }
      if (arr.some(t => String(t).toLowerCase() === tag.toLowerCase())) continue;
      arr.push(tag);
      upd.run(JSON.stringify(arr), id);
      changed++;
    }
    db.prepare(`
      INSERT INTO tag_vocab (name, last_used) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET last_used = excluded.last_used
    `).run(tag, new Date().toISOString());
  });
  tx();
  return changed;
}

// Bulk-set (flag truthy) or clear (flag null) the flag on many entries.
function setFlagForEntries(ids, flag) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  let n = 0;
  const tx = db.transaction(() => {
    const upd = db.prepare(`UPDATE entries SET flag = ? WHERE id = ?`);
    for (const id of ids) n += upd.run(flag || null, id).changes;
  });
  tx();
  return n;
}

function applyRealRename(id, newName, newRelPath) {
  db.prepare(`UPDATE entries SET name = ?, rel_path = ? WHERE id = ?`)
    .run(newName, newRelPath, id);
}

// Rewrite a folder's own row plus every descendant's rel_path after an
// on-disk rename, so the catalog stays accurate without a full re-scan.
function applyFolderRename(id, newName, oldRel, newRel) {
  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT volume_id FROM entries WHERE id = ?`).get(id);
    db.prepare(`UPDATE entries SET name = ?, rel_path = ? WHERE id = ?`).run(newName, newRel, id);
    // Descendants are stored as `${oldRel}/...` — re-prefix them.
    db.prepare(`
      UPDATE entries
      SET rel_path = ? || substr(rel_path, ?)
      WHERE volume_id = ? AND rel_path LIKE ? ESCAPE '\\'
    `).run(newRel, oldRel.length + 1, row.volume_id, escapeLike(oldRel) + '/%');
  });
  tx();
}

// Escape LIKE wildcards so user input / paths are matched literally.
function escapeLike(s) {
  return s.replace(/[\\%_]/g, c => '\\' + c);
}

// Files that share an identical name + size with at least one other file
// (a strong offline duplicate signal — content isn't hashed). Scans every
// mapped drive by default, or a single volume when volumeId is given.
// Find duplicate files (matched by name + size) across a chosen set of drives.
//   volumeIds : drive ids to include; empty/omitted = every mapped drive.
//   crossOnly : when true, only return sets whose copies span 2+ DIFFERENT
//               drives (the "same file in several places" case), hiding
//               duplicates that sit entirely within one drive.
function findDuplicates(opts = {}) {
  const ids = Array.isArray(opts.volumeIds)
    ? opts.volumeIds.filter(Number.isInteger)
    : (Number.isInteger(opts) ? [opts] : []);   // tolerate a bare id for callers
  const crossOnly = !!opts.crossOnly;
  const inList = ids.length ? `(${ids.map(() => '?').join(',')})` : ``;
  const innerScope = ids.length ? `AND volume_id IN ${inList}` : ``;
  const outerScope = ids.length ? `WHERE e.volume_id IN ${inList}` : ``;
  const having = crossOnly
    ? `HAVING COUNT(*) > 1 AND COUNT(DISTINCT volume_id) > 1`
    : `HAVING COUNT(*) > 1`;
  const params = ids.length ? [...ids, ...ids] : [];
  return db.prepare(`
    WITH dups AS (
      SELECT name, size FROM entries
      WHERE is_dir = 0 AND size > 0 ${innerScope}
      GROUP BY name, size ${having}
    )
    SELECT e.id, e.name, e.size, e.ext, e.mtime, e.volume_id, e.rel_path, v.name AS volume_name
    FROM entries e
    JOIN dups d ON d.name = e.name AND d.size = e.size
    JOIN volumes v ON v.id = e.volume_id
    ${outerScope}
    ORDER BY e.size DESC, e.name COLLATE NOCASE, v.name COLLATE NOCASE
    LIMIT 5000
  `).all(...params);
}

// Remove an entry and all of its descendants (used after a successful move).
function deleteEntrySubtree(id) {
  const tx = db.transaction(() => {
    const e = db.prepare(`SELECT volume_id, rel_path, is_dir FROM entries WHERE id = ?`).get(id);
    if (!e) return;
    db.prepare(`DELETE FROM entries WHERE id = ?`).run(id);
    if (e.is_dir) {
      const rel = e.rel_path.replace(/\\/g, '/');
      db.prepare(`DELETE FROM entries WHERE volume_id = ? AND rel_path LIKE ? ESCAPE '\\'`)
        .run(e.volume_id, escapeLike(rel) + '/%');
    }
  });
  tx();
}

function search(term, volumeId) {
  const like = `%${escapeLike(term)}%`;
  const volClause = volumeId ? `AND e.volume_id = ?` : ``;
  const params = volumeId ? [like, like, like, like, volumeId] : [like, like, like, like];
  return db.prepare(`
    SELECT e.id, e.name, e.rel_path, e.is_dir, e.size, e.ext, e.note, e.alias, e.tags, e.flag,
           e.volume_id, e.parent_id, v.name AS volume_name
    FROM entries e
    JOIN volumes v ON v.id = e.volume_id
    WHERE (e.name LIKE ? ESCAPE '\\' OR e.note LIKE ? ESCAPE '\\'
           OR e.alias LIKE ? ESCAPE '\\' OR e.tags LIKE ? ESCAPE '\\') ${volClause}
    ORDER BY e.is_dir DESC, e.name COLLATE NOCASE
    LIMIT 500
  `).all(...params);
}

module.exports = {
  init, close,
  listVolumes, getVolume, deleteVolume, renameVolume, setVolumeIcon, replaceVolume,
  getChildren, getTreemap, getEntry, getMediaEntries, countMediaEntries, getLargeFiles, listFiles, listFilesUnder, listFlagged, getAncestry, resolveFolderPath, findDuplicates,
  exportVolume, importVolume,
  setNote, setAlias, setFlag, setTags, listTags, addTagToEntries, setFlagForEntries,
  applyRealRename, applyFolderRename, deleteEntrySubtree, search
};
