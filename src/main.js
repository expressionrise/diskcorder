'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const db = require('./db');
const scanner = require('./scanner');
const thumbs = require('./thumbs');
const transfer = require('./transfer');
const backup = require('./backup');
const { spawn } = require('child_process');

let win = null;

// ---- tiny argument guards (renderer is trusted, but fail loud on bugs) ----
function assertInt(v, label = 'id') {
  if (!Number.isInteger(v)) throw new Error(`Invalid ${label}.`);
  return v;
}
function assertStr(v, label = 'value', max = 1000) {
  if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${label}.`);
  return v;
}

// ---- single instance ------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  bootstrap();
}

// thumbcache:// must be registered before app is ready.
protocol.registerSchemesAsPrivileged([{
  scheme: 'thumbcache',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#15161c',
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function bootstrap() {
  app.whenReady().then(() => {
    const dbPath = path.join(app.getPath('userData'), 'catalog.db');
    db.init(dbPath);
    thumbs.init(app.getPath('userData'));
    registerThumbProtocol();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { db.close(); });

// Serve cached thumbs/previews without exposing the userData path directly.
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };
function registerThumbProtocol() {
  const root = path.normalize(thumbs.cacheDir);
  protocol.handle('thumbcache', async (request) => {
    try {
      const u = new URL(request.url); // thumbcache://media/<volumeId>/<entryId>.<ext>
      const rel = decodeURIComponent(u.pathname).replace(/^[\\/]+/, '');
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
      const data = await fsp.readFile(file).catch(() => null);
      if (!data) return new Response('not found', { status: 404 });
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } });
    } catch {
      return new Response('bad request', { status: 400 });
    }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- IPC: volumes --------------------------------------------------------

ipcMain.handle('volumes:list', () => db.listVolumes());
ipcMain.handle('volumes:delete', async (_e, id) => {
  assertInt(id);
  db.deleteVolume(id);
  await thumbs.clearVolume(id);
  return true;
});
ipcMain.handle('volumes:rename', (_e, id, name) => {
  db.renameVolume(assertInt(id), assertStr(name, 'name', 200));
  return true;
});
ipcMain.handle('volumes:setIcon', (_e, id, icon) => {
  db.setVolumeIcon(assertInt(id), icon == null ? null : assertStr(icon, 'icon', 16));
  return true;
});
ipcMain.handle('volumes:reachable', (_e, id) => {
  const vol = db.getVolume(assertInt(id));
  return !!(vol && vol.root_path && fs.existsSync(vol.root_path));
});

// Real filesystem capacity for the drive holding this volume's root, so the
// rail can show used / total disk space (not just the cataloged bytes).
// Returns null when the drive is offline or statfs is unsupported.
ipcMain.handle('volumes:capacity', async (_e, id) => {
  const vol = db.getVolume(assertInt(id));
  if (!vol || !vol.root_path || !fs.existsSync(vol.root_path)) return null;
  try {
    const s = await fsp.statfs(vol.root_path);
    const total = s.blocks * s.bsize;
    const free  = s.bavail * s.bsize;
    if (!total) return null;
    return { total, free, used: Math.max(0, total - free) };
  } catch {
    return null;
  }
});

ipcMain.handle('volumes:export', async (_e, id) => {
  assertInt(id);
  const data = db.exportVolume(id);
  if (!data) return { ok: false, error: 'Drive not found.' };
  // Bundle the cached stills so the catalog stays useful on another machine.
  data.thumbs = await thumbs.exportThumbs(id);
  const safe = (data.volume.name || 'drive').replace(/[\\/:*?"<>|]/g, '_');
  const res = await dialog.showSaveDialog(win, {
    title: 'Export drive catalog',
    defaultPath: `${safe}.diskcorder.json`,
    filters: [{ name: 'Diskcorder catalog', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  await fsp.writeFile(res.filePath, JSON.stringify(data), 'utf8');
  return { ok: true, path: res.filePath, count: data.entries.length, thumbs: Object.keys(data.thumbs).length };
});

ipcMain.handle('volumes:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import drive catalog',
    properties: ['openFile'],
    filters: [{ name: 'Diskcorder catalog', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  let data;
  try { data = JSON.parse(await fsp.readFile(res.filePaths[0], 'utf8')); }
  catch (e) { return { ok: false, error: 'Could not read that file: ' + e.message }; }
  try {
    const { volumeId, idMap } = db.importVolume(data);
    const thumbsRestored = await thumbs.importThumbs(volumeId, data.thumbs, idMap);
    return { ok: true, volumeId, thumbs: thumbsRestored };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('drive:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a drive or folder to map',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const root = res.filePaths[0];
  return { root, suggestedName: suggestName(root) };
});

// Drive roots ("D:\") give an empty/ugly basename — make a friendly default.
function suggestName(root) {
  const driveRoot = /^([A-Za-z]):[\\/]?$/.exec(root);
  if (driveRoot) return `${driveRoot[1].toUpperCase()} drive`;
  return path.basename(root) || root;
}

// Pause/cancel control for the in-flight scan.
let scanControl = null;
function makeScanControl() {
  let paused = false, aborted = false, waiters = [];
  const release = () => { waiters.forEach(r => r()); waiters = []; };
  return {
    pause()  { paused = true; },
    resume() { paused = false; release(); },
    cancel() { aborted = true; paused = false; release(); },
    isAborted: () => aborted,
    waitWhilePaused: () => paused ? new Promise(r => waiters.push(r)) : Promise.resolve()
  };
}

ipcMain.handle('drive:scan', async (_e, { root, name, existingVolumeId }) => {
  assertStr(root, 'root');
  assertStr(name, 'name', 200);
  if (existingVolumeId != null) assertInt(existingVolumeId, 'existingVolumeId');
  if (!fs.existsSync(root)) {
    return { ok: false, error: `That path isn't reachable right now: ${root}` };
  }
  scanControl = makeScanControl();
  try {
    const { entries, skipped } = await scanner.scan(root, (count, current) => {
      send('scan:progress', { count, current });
    }, scanControl);
    const meta = {
      name, root_path: root,
      scanned_at: new Date().toISOString(),
      file_count: 0, total_bytes: 0
    };
    const { volumeId, idRemap } = db.replaceVolume(existingVolumeId || null, meta, entries);
    // Keep cached thumbnails across a re-scan/sync: remap them from the old
    // entry ids to the new ones (matched by path) instead of discarding them.
    if (existingVolumeId) await thumbs.remapCache(volumeId, idRemap);
    return { ok: true, volumeId, skipped };
  } catch (err) {
    if (err && err.code === 'SCAN_ABORTED') return { ok: false, canceled: true };
    throw err;
  } finally {
    scanControl = null;
  }
});

ipcMain.handle('drive:scanPause',  () => { if (scanControl) scanControl.pause();  return true; });
ipcMain.handle('drive:scanResume', () => { if (scanControl) scanControl.resume(); return true; });
ipcMain.handle('drive:scanCancel', () => { if (scanControl) scanControl.cancel(); return true; });

// ---- IPC: browsing -------------------------------------------------------

ipcMain.handle('entries:children', (_e, volumeId, parentId) =>
  db.getChildren(assertInt(volumeId), parentId == null ? null : assertInt(parentId, 'parentId')));
ipcMain.handle('entries:get', (_e, id) => db.getEntry(assertInt(id)));
ipcMain.handle('entries:setNote', (_e, id, note) => {
  db.setNote(assertInt(id), note == null ? null : assertStr(note, 'note', 20000));
  return true;
});
ipcMain.handle('entries:setAlias', (_e, id, alias) => {
  db.setAlias(assertInt(id), alias == null ? null : assertStr(alias, 'alias', 500));
  return true;
});
ipcMain.handle('entries:setFlag', (_e, id, flag) => {
  db.setFlag(assertInt(id), flag == null ? null : assertStr(flag, 'flag', 16));
  return true;
});
ipcMain.handle('entries:search', (_e, term, volumeId) =>
  db.search(assertStr(term, 'term', 200), volumeId == null ? null : assertInt(volumeId, 'volumeId')));
ipcMain.handle('entries:list', (_e, volumeId) => db.listFiles(assertInt(volumeId)));
ipcMain.handle('entries:listUnder', (_e, volumeId, parentId) =>
  db.listFilesUnder(assertInt(volumeId), parentId == null ? null : assertInt(parentId, 'parentId')));
ipcMain.handle('entries:flagged', (_e, volumeId) => db.listFlagged(assertInt(volumeId)));
ipcMain.handle('entries:resolvePath', (_e, volumeId, relPath) =>
  db.resolveFolderPath(assertInt(volumeId), assertStr(relPath, 'relPath', 4096)));
ipcMain.handle('entries:ancestry', (_e, id) => db.getAncestry(assertInt(id)));
ipcMain.handle('entries:large', (_e, volumeId, opts) => {
  assertInt(volumeId);
  const o = opts || {};
  return db.getLargeFiles(volumeId, {
    limit: o.limit ? assertInt(o.limit, 'limit') : 100,
    minSize: o.minSize ? assertInt(o.minSize, 'minSize') : 0,
    maxSize: o.maxSize ? assertInt(o.maxSize, 'maxSize') : 0,
    after: o.after ? assertStr(o.after, 'after', 40) : null,
    before: o.before ? assertStr(o.before, 'before', 40) : null
  });
});

// ---- IPC: integrity test (is the real file readable / not corrupt?) ------

// Stream the whole file to catch read errors / bad sectors. Abortable.
function readTest(srcPath, signal) {
  return new Promise((resolve) => {
    const rs = fs.createReadStream(srcPath);
    let bytes = 0;
    const onAbort = () => rs.destroy(new Error('aborted'));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    rs.on('data', c => { bytes += c.length; });
    rs.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ok: false, bytes, error: e.message, aborted: !!(signal && signal.aborted) });
    });
    rs.on('end', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ok: true, bytes });
    });
  });
}

let fileTestAbort = null;
ipcMain.handle('file:test:cancel', () => { if (fileTestAbort) fileTestAbort.abort(); return true; });

ipcMain.handle('file:test', async (_e, id) => {
  assertInt(id);
  const entry = db.getEntry(id);
  if (!entry || entry.is_dir) return { ok: false, status: 'error', detail: 'Not a file.' };
  const vol = db.getVolume(entry.volume_id);
  if (!vol || !vol.root_path) return { ok: false, status: 'offline' };
  const src = path.join(vol.root_path, entry.rel_path);

  let st;
  try { st = await fsp.stat(src); }
  catch { return { ok: false, status: 'missing' }; }

  const sizeOnDisk = st.size;
  const expectedSize = entry.size || 0;
  const sizeMismatch = !!expectedSize && sizeOnDisk !== expectedSize;

  fileTestAbort = new AbortController();
  const signal = fileTestAbort.signal;
  const kind = kindOf(entry.ext);
  let result;
  try {
    if ((kind === 'video' || kind === 'image') && await thumbs.ffmpegAvailable()) {
      const r = await thumbs.checkMedia(src, signal);
      if (r.aborted) return { status: 'canceled' };
      result = {
        ok: r.ok, method: 'ffmpeg', status: r.ok ? 'ok' : 'damaged',
        ffmpegErrors: (r.errors || '').split('\n').slice(0, 12).join('\n')
      };
    } else {
      const r = await readTest(src, signal);
      if (r.aborted) return { status: 'canceled' };
      result = {
        ok: r.ok, method: 'read', status: r.ok ? 'ok' : 'unreadable',
        bytesRead: r.bytes, readError: r.error || null
      };
    }
  } finally {
    fileTestAbort = null;
  }

  result.sizeOnDisk = sizeOnDisk;
  result.expectedSize = expectedSize;
  if (sizeMismatch) {
    result.ok = false;
    result.sizeMismatch = true;
    if (result.status === 'ok') result.status = 'size-mismatch';
  }
  return result;
});

// ---- IPC: real on-disk rename (drive must be connected) ------------------

ipcMain.handle('entries:realRename', (_e, id, newName) => {
  assertInt(id);
  assertStr(newName, 'newName', 255);
  const entry = db.getEntry(id);
  if (!entry) return { ok: false, error: 'Entry not found.' };

  const vol = db.getVolume(entry.volume_id);
  if (!vol || !vol.root_path) return { ok: false, error: 'No root path for this drive.' };

  const oldFull = path.join(vol.root_path, entry.rel_path);
  if (!fs.existsSync(oldFull)) {
    return { ok: false, error: 'Drive not connected, or the file has moved. Connect the drive and try again.' };
  }
  if (/[\\/:*?"<>|]/.test(newName)) {
    return { ok: false, error: 'That name contains characters the filesystem won\'t allow.' };
  }

  const newFull = path.join(path.dirname(oldFull), newName);
  if (fs.existsSync(newFull)) {
    return { ok: false, error: 'Something with that name already exists here.' };
  }

  try {
    fs.renameSync(oldFull, newFull);
  } catch (err) {
    return { ok: false, error: `Rename failed: ${err.message}` };
  }

  const oldRel = entry.rel_path.replace(/\\/g, '/');
  const parentRel = path.posix.dirname(oldRel);
  const newRel = parentRel === '.' ? newName : `${parentRel}/${newName}`;
  if (entry.is_dir) {
    db.applyFolderRename(id, newName, oldRel, newRel); // rewrites descendants too
  } else {
    db.applyRealRename(id, newName, newRel);
  }
  return { ok: true, isDir: !!entry.is_dir };
});

// ---- IPC: delete on disk (drive must be connected) -----------------------

ipcMain.handle('entries:realDelete', async (_e, id) => {
  assertInt(id);
  const entry = db.getEntry(id);
  if (!entry) return { ok: false, error: 'Entry not found.' };
  const vol = db.getVolume(entry.volume_id);
  if (!vol || !vol.root_path) return { ok: false, error: 'No root path for this drive.' };

  const full = path.join(vol.root_path, entry.rel_path);
  if (!fs.existsSync(full)) {
    return { ok: false, error: 'Drive not connected, or the file has moved. Connect the drive and try again.' };
  }
  try {
    await fsp.rm(full, { recursive: !!entry.is_dir, force: true });
  } catch (err) {
    return { ok: false, error: `Delete failed: ${err.message}` };
  }
  await thumbs.removeEntry(entry.volume_id, id).catch(() => {});
  db.deleteEntrySubtree(id); // drops the row (and descendants for folders)
  return { ok: true, isDir: !!entry.is_dir };
});

// ---- IPC: reveal in Explorer ---------------------------------------------

// Resolve an entry's real on-disk path, or null if the drive/file isn't there.
function realPathFor(id) {
  const entry = db.getEntry(id);
  if (!entry) return null;
  const vol = db.getVolume(entry.volume_id);
  if (!vol || !vol.root_path) return null;
  const full = path.join(vol.root_path, entry.rel_path);
  return fs.existsSync(full) ? full : null;
}

ipcMain.handle('entries:reveal', (_e, id) => {
  assertInt(id);
  const full = realPathFor(id);
  if (!full) return { ok: false, error: 'Drive not connected, or the file has moved. Connect the drive and try again.' };
  shell.showItemInFolder(full); // opens Explorer with the item selected
  return { ok: true };
});

// Open the file in its default application.
ipcMain.handle('entries:open', async (_e, id) => {
  assertInt(id);
  const full = realPathFor(id);
  if (!full) return { ok: false, error: 'Drive not connected, or the file has moved.' };
  const err = await shell.openPath(full); // '' on success
  return err ? { ok: false, error: err } : { ok: true };
});

// Show the OS "Open with…" chooser (Windows); fall back to default open elsewhere.
ipcMain.handle('entries:openWith', (_e, id) => {
  assertInt(id);
  const full = realPathFor(id);
  if (!full) return { ok: false, error: 'Drive not connected, or the file has moved.' };
  if (process.platform === 'win32') {
    spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', full], { windowsHide: false, detached: true }).unref();
    return { ok: true };
  }
  shell.openPath(full);
  return { ok: true };
});

// ---- IPC: duplicates -----------------------------------------------------

ipcMain.handle('entries:duplicates', (_e, opts) => {
  opts = opts || {};
  const volumeIds = Array.isArray(opts.volumeIds)
    ? opts.volumeIds.map(v => assertInt(v, 'volumeId'))
    : [];
  return db.findDuplicates({ volumeIds, crossOnly: !!opts.crossOnly });
});

// ---- IPC: thumbnails (video + image) ------------------------------------

let thumbAbort = null;
let thumbGate = null;   // pause/resume gate for the batch generator
function makePauseGate() {
  let paused = false, waiters = [];
  return {
    get paused() { return paused; },
    pause()  { paused = true; },
    resume() { paused = false; waiters.forEach(r => r()); waiters = []; },
    wait()   { return paused ? new Promise(r => waiters.push(r)) : Promise.resolve(); }
  };
}
const kindOf = (ext) => thumbs.isVideo(ext) ? 'video' : (thumbs.isImage(ext) ? 'image' : null);

// Generate (if missing) the thumb — plus a hover preview for videos — for one
// entry, on demand (used on hover / selection).
ipcMain.handle('thumbs:ensure', async (_e, id) => {
  assertInt(id);
  const entry = db.getEntry(id);
  if (!entry || entry.is_dir) return { ok: false };
  const kind = kindOf(entry.ext);
  if (!kind) return { ok: false };
  const vol = db.getVolume(entry.volume_id);
  if (!vol || !vol.root_path) return { ok: false, error: 'offline' };
  const src = path.join(vol.root_path, entry.rel_path);
  if (!fs.existsSync(src)) return { ok: false, error: 'offline' };

  const ac = new AbortController();
  try {
    if (!(await thumbs.hasThumb(entry.volume_id, id))) {
      await thumbs.generateThumb(src, entry.volume_id, id, ac.signal, kind);
    }
    if (kind === 'video' && !(await thumbs.hasPreview(entry.volume_id, id))) {
      await thumbs.generatePreview(src, entry.volume_id, id, ac.signal);
    }
    return { ok: true, volumeId: entry.volume_id, kind };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('thumbs:ready', () => thumbs.ffmpegAvailable());

// Thumbnail coverage for a volume: how many of its media files already have a
// cached still, out of the total. Works offline (reads the cache, not the drive).
ipcMain.handle('thumbs:coverage', (_e, volumeId) => {
  assertInt(volumeId);
  const total = db.countMediaEntries(volumeId, thumbs.MEDIA_EXTS);
  const made = Math.min(thumbs.countThumbs(volumeId), total);
  return { made, total };
});

// Local disk used by a drive's cached thumbnails + previews (its catalog cost).
ipcMain.handle('thumbs:cachesize', (_e, volumeId) => thumbs.cacheSize(assertInt(volumeId)));

// Batch-generate for every reachable media file in a volume (concurrency
// limited). `previews` also builds the 10s hover clips for videos (slower).
ipcMain.handle('thumbs:generate', async (_e, volumeId, opts) => {
  assertInt(volumeId);
  const previews = !!(opts && opts.previews);
  const vol = db.getVolume(volumeId);
  if (!vol || !vol.root_path || !fs.existsSync(vol.root_path)) {
    return { ok: false, error: 'Drive is not connected.' };
  }
  const media = db.getMediaEntries(volumeId, thumbs.MEDIA_EXTS);
  if (!media.length) return { ok: true, total: 0 };

  // Only queue files that still need work, so a re-run resumes where it left
  // off instead of re-walking the whole catalog and "starting over". Anything
  // already cached is skipped here and never counted toward the total.
  const pending = [];
  for (const m of media) {
    const kind = kindOf(m.ext);
    if (!kind) continue;
    const needThumb = !(await thumbs.hasThumb(volumeId, m.id));
    const needPrev  = previews && kind === 'video' && !(await thumbs.hasPreview(volumeId, m.id));
    if (needThumb || needPrev) pending.push(m);
  }
  if (!pending.length) {
    send('thumbs:progress', { done: 0, total: 0, current: '', volumeId, finished: true });
    return { ok: true, total: 0, done: 0 };
  }

  thumbAbort = new AbortController();
  thumbGate = makePauseGate();
  const signal = thumbAbort.signal;
  const total = pending.length;
  let done = 0;
  send('thumbs:progress', { done, total, current: '', volumeId });

  const worker = async (queue) => {
    while (queue.length && !signal.aborted) {
      await thumbGate.wait();          // block here while paused
      if (signal.aborted) break;
      const m = queue.shift();
      if (!m) break;
      const kind = kindOf(m.ext);
      const src = path.join(vol.root_path, m.rel_path);
      try {
        if (kind && fs.existsSync(src)) {
          if (!(await thumbs.hasThumb(volumeId, m.id))) await thumbs.generateThumb(src, volumeId, m.id, signal, kind);
          if (previews && kind === 'video' && !(await thumbs.hasPreview(volumeId, m.id))) {
            await thumbs.generatePreview(src, volumeId, m.id, signal);
          }
        }
      } catch { /* skip this one */ }
      done += 1;
      send('thumbs:progress', { done, total, current: m.rel_path, volumeId });
    }
  };

  const queue = pending.slice();
  await Promise.all([worker(queue), worker(queue)]); // 2 concurrent ffmpeg
  send('thumbs:progress', { done, total, current: '', volumeId, finished: true });
  thumbAbort = null;
  thumbGate = null;
  return { ok: true, total, done, canceled: signal.aborted };
});

ipcMain.handle('thumbs:cancel', () => { if (thumbAbort) thumbAbort.abort(); if (thumbGate) thumbGate.resume(); return true; });
ipcMain.handle('thumbs:pause',  () => { if (thumbGate) thumbGate.pause();  return true; });
ipcMain.handle('thumbs:resume', () => { if (thumbGate) thumbGate.resume(); return true; });

// ---- IPC: tags -----------------------------------------------------------

ipcMain.handle('tags:list', () => db.listTags());
ipcMain.handle('entries:setTags', (_e, id, tags) => {
  assertInt(id);
  if (!Array.isArray(tags)) throw new Error('Invalid tags.');
  const clean = [...new Set(tags
    .map(t => String(t).trim())
    .filter(t => t && t.length <= 60))].slice(0, 40);
  db.setTags(id, clean);
  return { ok: true, tags: clean };
});

ipcMain.handle('entries:addTagBulk', (_e, ids, tag) => {
  if (!Array.isArray(ids)) throw new Error('Invalid selection.');
  const cleanIds = ids.map(i => assertInt(i, 'id'));
  const t = assertStr(tag, 'tag', 60).trim();
  if (!t) throw new Error('Empty tag.');
  return db.addTagToEntries(cleanIds, t);
});

ipcMain.handle('entries:setFlagBulk', (_e, ids, flag) => {
  if (!Array.isArray(ids)) throw new Error('Invalid selection.');
  const cleanIds = ids.map(i => assertInt(i, 'id'));
  return db.setFlagForEntries(cleanIds, flag == null ? null : assertStr(flag, 'flag', 16));
});

// ---- IPC: space map (treemap) -------------------------------------------

ipcMain.handle('entries:treemap', (_e, volumeId, parentId) =>
  db.getTreemap(assertInt(volumeId), parentId == null ? null : assertInt(parentId, 'parentId')));

// ---- IPC: transfer (copy / move between drives) --------------------------

const transferOps = new Map(); // opId -> AbortController
let nextOpId = 1;

// Reachable destination drives (everything except the source's own volume).
ipcMain.handle('transfer:targets', (_e, entryId) => {
  assertInt(entryId);
  const entry = db.getEntry(entryId);
  return db.listVolumes()
    .filter(v => v.root_path && fs.existsSync(v.root_path) && (!entry || v.id !== entry.volume_id))
    .map(v => ({ id: v.id, name: v.name, root_path: v.root_path }));
});

ipcMain.handle('transfer:start', async (_e, { entryId, destVolumeId, move, conflict }) => {
  assertInt(entryId);
  assertInt(destVolumeId, 'destVolumeId');
  const entry = db.getEntry(entryId);
  if (!entry) return { ok: false, error: 'Entry not found.' };
  const srcVol = db.getVolume(entry.volume_id);
  const destVol = db.getVolume(destVolumeId);
  if (!srcVol || !destVol) return { ok: false, error: 'Drive not found.' };

  const srcPath = path.join(srcVol.root_path, entry.rel_path);
  const destDir = destVol.root_path;

  const opId = nextOpId++;
  const ac = new AbortController();
  transferOps.set(opId, ac);
  send('transfer:progress', { opId, name: entry.name, copied: 0, total: entry.size || 0, state: 'start' });

  try {
    const res = await transfer.transfer({
      srcPath, destDir, move: !!move, conflict: conflict || 'keepboth', signal: ac.signal,
      onProgress: ({ copied, total }) => send('transfer:progress', { opId, name: entry.name, copied, total, state: 'progress' })
    });
    if (move && res.status === 'done') {
      // Source is gone now; drop its rows so the catalog stays honest.
      db.deleteEntrySubtree(entryId);
    }
    send('transfer:progress', { opId, name: entry.name, state: res.status, dstPath: res.dstPath });
    return { ok: true, status: res.status, dstPath: res.dstPath, moved: !!move };
  } catch (err) {
    const msg = ac.signal.aborted ? 'Canceled.' : err.message;
    send('transfer:progress', { opId, name: entry.name, state: 'error', error: msg });
    return { ok: false, error: msg, canceled: ac.signal.aborted };
  } finally {
    transferOps.delete(opId);
  }
});

ipcMain.handle('transfer:cancel', (_e, opId) => {
  const ac = transferOps.get(opId);
  if (ac) ac.abort();
  return true;
});

// ---- IPC: additive backup between two connected drives -------------------

let backupAbort = null;

ipcMain.handle('backup:cancel', () => { if (backupAbort) backupAbort.abort(); return true; });

ipcMain.handle('backup:start', async (_e, { srcVolumeId, destVolumeId, items }) => {
  assertInt(srcVolumeId);
  assertInt(destVolumeId);
  if (srcVolumeId === destVolumeId) return { ok: false, error: 'Pick a different drive to back up to.' };
  const src = db.getVolume(srcVolumeId);
  const dest = db.getVolume(destVolumeId);
  if (!src || !src.root_path || !fs.existsSync(src.root_path)) return { ok: false, error: 'Source drive is not connected.' };
  if (!dest || !dest.root_path || !fs.existsSync(dest.root_path)) return { ok: false, error: 'Destination drive is not connected.' };

  const rels = (Array.isArray(items) ? items : [])
    .map(s => assertStr(s, 'item', 4096))
    .filter(s => !path.isAbsolute(s) && !s.split(/[\\/]/).includes('..'));   // stay inside the drive

  // Back up into a folder named after the source drive, so multiple drives
  // can share one destination without colliding.
  const safeName = (src.name || 'Backup').replace(/[\\/:*?"<>|]/g, '_');
  const destBase = path.join(dest.root_path, safeName);

  backupAbort = new AbortController();
  let last = 0;
  const emit = (s, finished = false) => send('backup:progress', {
    copied: s.copied, skipped: s.skipped, errors: s.errors,
    copiedBytes: s.copiedBytes, skippedBytes: s.skippedBytes,
    current: s.current, finished
  });
  try {
    const stats = await backup.runBackup({
      srcBase: src.root_path, destBase, items: rels,
      signal: backupAbort.signal,
      onProgress: (s) => { const now = Date.now(); if (now - last > 120) { last = now; emit(s); } }
    });
    emit(stats, true);
    return { ok: true, ...stats, canceled: backupAbort.signal.aborted, destBase };
  } catch (err) {
    if (backupAbort && backupAbort.signal.aborted) return { ok: true, canceled: true };
    return { ok: false, error: err.message };
  } finally {
    backupAbort = null;
  }
});

// ---- IPC: backup tab — saved actions, any-folder runs, and run logs -------

const jobsFile = () => path.join(app.getPath('userData'), 'backup-jobs.json');
const logsDir  = () => path.join(app.getPath('userData'), 'backup-logs');
const logIndexFile = () => path.join(logsDir(), 'index.json');

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

ipcMain.handle('backup:pickFolder', async (_e, title) => {
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Choose a folder',
    properties: ['openDirectory', 'createDirectory']
  });
  return (res.canceled || !res.filePaths.length) ? null : res.filePaths[0];
});

ipcMain.handle('backup:listJobs', () => readJson(jobsFile(), []));

ipcMain.handle('backup:saveJob', async (_e, job) => {
  const jobs = await readJson(jobsFile(), []);
  const j = {
    id: job.id || `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: assertStr(job.name || 'Backup', 'name', 200),
    source: assertStr(job.source, 'source', 4096),
    dest: assertStr(job.dest, 'dest', 4096),
    lastRun: job.lastRun || null
  };
  const i = jobs.findIndex(x => x.id === j.id);
  if (i >= 0) jobs[i] = { ...jobs[i], ...j }; else jobs.push(j);
  await fsp.writeFile(jobsFile(), JSON.stringify(jobs, null, 2), 'utf8');
  return j;
});

ipcMain.handle('backup:deleteJob', async (_e, id) => {
  const jobs = (await readJson(jobsFile(), [])).filter(x => x.id !== id);
  await fsp.writeFile(jobsFile(), JSON.stringify(jobs, null, 2), 'utf8');
  return true;
});

ipcMain.handle('backup:logIndex', () => readJson(logIndexFile(), []));
ipcMain.handle('backup:logDetail', (_e, runId) => {
  assertStr(runId, 'runId', 80);
  if (!/^[\w-]+$/.test(runId)) return null;          // guard against path tricks
  return readJson(path.join(logsDir(), `${runId}.json`), null);
});

// Run a backup of an arbitrary source folder into an arbitrary destination
// folder (created under a subfolder named after the source). Writes a log.
ipcMain.handle('backup:runPath', async (_e, { source, dest, name, jobId }) => {
  assertStr(source, 'source', 4096);
  assertStr(dest, 'dest', 4096);
  if (!fs.existsSync(source)) return { ok: false, error: 'Source folder is not reachable.' };
  if (!fs.existsSync(dest)) return { ok: false, error: 'Destination folder is not reachable.' };
  const srcBase = path.resolve(source);
  const destBase = path.join(path.resolve(dest), path.basename(srcBase) || 'Backup');
  if (path.resolve(destBase).startsWith(srcBase + path.sep)) {
    return { ok: false, error: 'Destination is inside the source folder.' };
  }

  backupAbort = new AbortController();
  let last = 0;
  const emit = (s, finished = false) => send('backup:progress', {
    copied: s.copied, skipped: s.skipped, errors: s.errors,
    copiedBytes: s.copiedBytes, current: s.current, finished, jobId
  });
  const when = new Date().toISOString();
  try {
    const stats = await backup.runBackup({
      srcBase, destBase, items: [''], signal: backupAbort.signal,
      onProgress: (s) => { const now = Date.now(); if (now - last > 120) { last = now; emit(s); } }
    });
    emit(stats, true);
    const canceled = backupAbort.signal.aborted;

    // write the run log
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await fsp.mkdir(logsDir(), { recursive: true }).catch(() => {});
    const summary = {
      runId, name: name || path.basename(srcBase), jobId: jobId || null,
      source: srcBase, dest: destBase, when, canceled,
      copied: stats.copied, skipped: stats.skipped, errors: stats.errors, copiedBytes: stats.copiedBytes
    };
    await fsp.writeFile(path.join(logsDir(), `${runId}.json`), JSON.stringify({ ...summary, files: stats.files }, null, 2), 'utf8');
    const index = await readJson(logIndexFile(), []);
    index.unshift(summary);
    await fsp.writeFile(logIndexFile(), JSON.stringify(index.slice(0, 200), null, 2), 'utf8');

    if (jobId) {
      const jobs = await readJson(jobsFile(), []);
      const j = jobs.find(x => x.id === jobId);
      if (j) { j.lastRun = summary; await fsp.writeFile(jobsFile(), JSON.stringify(jobs, null, 2), 'utf8'); }
    }
    return { ok: true, ...summary };
  } catch (err) {
    if (backupAbort && backupAbort.signal.aborted) return { ok: true, canceled: true };
    return { ok: false, error: err.message };
  } finally {
    backupAbort = null;
  }
});
