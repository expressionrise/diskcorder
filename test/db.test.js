'use strict';

// better-sqlite3 is built for Electron's ABI, so this file must run under
// Electron's Node (see the "test" script in package.json).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../src/db');
const { tmpDir } = require('./helpers');

function open(t) {
  t.after(() => db.close()); // registered first: hooks run in order, and the db file must be closed before the dir is removed
  const file = path.join(tmpDir(t), 'catalog.db');
  db.init(file);
  return file;
}

// Flat DFS rows in the shape scanner.scan() produces.
function rows(spec) {
  const out = [];
  let id = 1;
  const walk = (items, parentTempId, prefix) => {
    for (const it of items) {
      const tempId = id++;
      const relPath = prefix + it.name;
      out.push({
        tempId, parentTempId, name: it.name, relPath, isDir: it.children ? 1 : 0,
        size: it.size || 0, mtime: it.mtime || '2024-01-01T00:00:00.000Z',
        ext: it.children ? null : path.extname(it.name).slice(1).toLowerCase() || null
      });
      if (it.children) walk(it.children, tempId, relPath + '/');
    }
  };
  walk(spec, null, '');
  return out;
}

const META = { name: 'Test', root_path: 'X:\\', scanned_at: '2024-01-01T00:00:00.000Z', file_count: 0, total_bytes: 0 };
const byPath = (volumeId, rel) => db.listFiles(volumeId).find(e => e.rel_path === rel);

const TREE = [
  { name: 'docs', children: [{ name: 'a.txt', size: 10 }, { name: 'b.mp4', size: 100 }] },
  { name: 'docs2', children: [{ name: 'c.txt', size: 5 }] },
];

test('replaceVolume stores the tree with rolled-up folder sizes', (t) => {
  open(t);
  const { volumeId } = db.replaceVolume(null, META, rows(TREE));
  const vol = db.getVolume(volumeId);
  assert.equal(vol.file_count, 3);
  assert.equal(vol.total_bytes, 115);
  const top = db.getChildren(volumeId, null);
  assert.deepEqual(top.map(e => e.name).sort(), ['docs', 'docs2']);
  assert.equal(top.find(e => e.name === 'docs').tree_size, 110);
});

test('re-scan keeps the volume id, notes, aliases, tags and flags', (t) => {
  open(t);
  const first = db.replaceVolume(null, META, rows(TREE));
  const a = byPath(first.volumeId, 'docs/a.txt');
  db.setNote(a.id, 'my note');
  db.setAlias(a.id, 'nice name');
  db.setTags(a.id, ['holiday', 'raw']);
  db.setFlag(a.id, 'star');

  const second = db.replaceVolume(first.volumeId, META, rows(TREE));
  assert.equal(second.volumeId, first.volumeId);
  const a2 = db.getEntry(byPath(second.volumeId, 'docs/a.txt').id);
  assert.equal(a2.note, 'my note');
  assert.equal(a2.alias, 'nice name');
  assert.deepEqual(JSON.parse(a2.tags), ['holiday', 'raw']);
  assert.equal(a2.flag, 'star');
});

test('re-scan remaps cached thumbnails only for unchanged files', (t) => {
  open(t);
  const first = db.replaceVolume(null, META, rows(TREE));
  const a = byPath(first.volumeId, 'docs/a.txt');
  const b = byPath(first.volumeId, 'docs/b.mp4');

  const changed = rows(TREE);
  changed.find(r => r.relPath === 'docs/b.mp4').size = 999; // b.mp4 was modified
  const second = db.replaceVolume(first.volumeId, META, changed);
  const newA = byPath(second.volumeId, 'docs/a.txt');
  assert.equal(second.idRemap[a.id], newA.id);
  assert.ok(!(b.id in second.idRemap), 'a changed file must lose its stale thumbnail');
});

test('search treats % and _ literally', (t) => {
  open(t);
  const { volumeId } = db.replaceVolume(null, META, rows([
    { name: '100%.txt', size: 1 }, { name: '1000.txt', size: 1 },
    { name: 'a_b.txt', size: 1 }, { name: 'axb.txt', size: 1 },
  ]));
  assert.deepEqual(db.search('100%', volumeId).map(e => e.name), ['100%.txt']);
  assert.deepEqual(db.search('a_b', volumeId).map(e => e.name), ['a_b.txt']);
});

test('deleteEntrySubtree removes a folder and its children only', (t) => {
  open(t);
  const { volumeId } = db.replaceVolume(null, META, rows(TREE));
  const docs = db.getChildren(volumeId, null).find(e => e.name === 'docs');
  db.deleteEntrySubtree(docs.id);
  const left = db.listFiles(volumeId).map(e => e.rel_path);
  assert.deepEqual(left, ['docs2/c.txt'], 'docs2 shares the "docs" prefix and must survive');
});

test('tags are remembered for autocomplete', (t) => {
  open(t);
  const { volumeId } = db.replaceVolume(null, META, rows(TREE));
  db.setTags(byPath(volumeId, 'docs/a.txt').id, ['one']);
  db.setTags(byPath(volumeId, 'docs/b.mp4').id, ['two']);
  const names = db.listTags().map(x => (typeof x === 'string' ? x : x.name)).sort();
  assert.deepEqual(names, ['one', 'two']);
});

test('migrations upgrade an old database and are idempotent', (t) => {
  const file = path.join(tmpDir(t), 'old.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE volumes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, root_path TEXT,
      scanned_at TEXT, file_count INTEGER DEFAULT 0, total_bytes INTEGER DEFAULT 0);
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, volume_id INTEGER NOT NULL, parent_id INTEGER,
      name TEXT NOT NULL, rel_path TEXT NOT NULL, is_dir INTEGER NOT NULL, size INTEGER DEFAULT 0,
      mtime TEXT, ext TEXT, note TEXT, alias TEXT);
    INSERT INTO volumes (name, root_path) VALUES ('Legacy', 'Y:\\');
    INSERT INTO entries (volume_id, name, rel_path, is_dir, size) VALUES (1, 'x.txt', 'x.txt', 0, 7);
  `);
  old.close();

  db.init(file);
  const peek = (fn) => { const h = new Database(file, { readonly: true }); try { return fn(h); } finally { h.close(); } };
  const cols = peek(h => h.pragma('table_info(entries)').map(c => c.name));
  assert.ok(cols.includes('tags') && cols.includes('flag') && cols.includes('tree_size'));
  assert.equal(db.getVolume(1).name, 'Legacy');
  db.close();

  db.init(file); // second open must not fail or lose data
  assert.equal(db.listFiles(1).length, 1);
  db.close();
  assert.ok(peek(h => h.pragma('user_version', { simple: true })) >= 6);
});
