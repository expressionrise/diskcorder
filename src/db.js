'use strict';

const Database = require('better-sqlite3');

let db = null;

// Bump this whenever the schema changes and add a matching migration step.
const SCHEMA_VERSION = 3;

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

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
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
    SELECT id, name, root_path, scanned_at, file_count, total_bytes
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
      // Preserve existing notes/aliases/tags keyed by rel_path if re-scanning.
      let preserved = new Map();
      if (existingVolumeId) {
        const old = db.prepare(
          `SELECT rel_path, note, alias, tags FROM entries WHERE volume_id = ? AND (note IS NOT NULL OR alias IS NOT NULL OR tags IS NOT NULL)`
        ).all(existingVolumeId);
        for (const r of old) preserved.set(r.rel_path, r);
        db.prepare(`DELETE FROM volumes WHERE id = ?`).run(existingVolumeId);
      }

      const vInfo = insertVolume().run(meta);
      const volumeId = vInfo.lastInsertRowid;

      const stmt = insertEntry();
      const updateAnnotations = db.prepare(`UPDATE entries SET note = ?, alias = ?, tags = ? WHERE id = ?`);
      const tempToReal = new Map();
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
        tempToReal.set(r.tempId, info.lastInsertRowid);
        if (!r.isDir) { totalBytes += r.size; fileCount += 1; }

        const keep = preserved.get(r.relPath);
        if (keep) updateAnnotations.run(keep.note, keep.alias, keep.tags, info.lastInsertRowid);
      }

      db.prepare(`UPDATE volumes SET file_count = ?, total_bytes = ? WHERE id = ?`)
        .run(fileCount, totalBytes, volumeId);

      return volumeId;
    });
    return tx();
  };
})();

// ---- Entries -------------------------------------------------------------

function getChildren(volumeId, parentId) {
  return db.prepare(`
    SELECT id, name, rel_path, is_dir, size, mtime, ext, note, alias
    FROM entries
    WHERE volume_id = ? AND parent_id IS ?
    ORDER BY is_dir DESC, name COLLATE NOCASE
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
    SELECT e.id, e.name, e.rel_path, e.is_dir, e.size, e.ext, e.note, e.alias, e.tags,
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
  listVolumes, getVolume, deleteVolume, renameVolume, replaceVolume,
  getChildren, getEntry, getMediaEntries,
  setNote, setAlias, setTags, listTags,
  applyRealRename, applyFolderRename, deleteEntrySubtree, search
};
