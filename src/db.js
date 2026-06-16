'use strict';

const Database = require('better-sqlite3');

let db = null;

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
  return db;
}

// ---- Volumes -------------------------------------------------------------

function listVolumes() {
  return db.prepare(`
    SELECT id, name, root_path, scanned_at, file_count, total_bytes
    FROM volumes
    ORDER BY name COLLATE NOCASE
  `).all();
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
      // Preserve existing notes/aliases keyed by rel_path if re-scanning.
      let preserved = new Map();
      if (existingVolumeId) {
        const old = db.prepare(
          `SELECT rel_path, note, alias FROM entries WHERE volume_id = ? AND (note IS NOT NULL OR alias IS NOT NULL)`
        ).all(existingVolumeId);
        for (const r of old) preserved.set(r.rel_path, r);
        db.prepare(`DELETE FROM volumes WHERE id = ?`).run(existingVolumeId);
      }

      const vInfo = insertVolume().run(meta);
      const volumeId = vInfo.lastInsertRowid;

      const stmt = insertEntry();
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
        if (keep) {
          db.prepare(`UPDATE entries SET note = ?, alias = ? WHERE id = ?`)
            .run(keep.note, keep.alias, info.lastInsertRowid);
        }
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

function search(term, volumeId) {
  const like = `%${term}%`;
  const params = volumeId ? [like, like, like, volumeId] : [like, like, like];
  const volClause = volumeId ? `AND e.volume_id = ?` : ``;
  return db.prepare(`
    SELECT e.id, e.name, e.rel_path, e.is_dir, e.size, e.note, e.alias,
           e.volume_id, e.parent_id, v.name AS volume_name
    FROM entries e
    JOIN volumes v ON v.id = e.volume_id
    WHERE (e.name LIKE ? OR e.note LIKE ? OR e.alias LIKE ?) ${volClause}
    ORDER BY e.is_dir DESC, e.name COLLATE NOCASE
    LIMIT 500
  `).all(...params);
}

module.exports = {
  init,
  listVolumes, deleteVolume, renameVolume, replaceVolume,
  getChildren, getEntry, setNote, setAlias, applyRealRename, search
};
