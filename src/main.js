'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const db = require('./db');
const scanner = require('./scanner');
const thumbs = require('./thumbs');
const transfer = require('./transfer');

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
function registerThumbProtocol() {
  const root = path.normalize(thumbs.cacheDir);
  protocol.handle('thumbcache', (request) => {
    try {
      const u = new URL(request.url); // thumbcache://<volumeId>/<entryId>.<ext>
      const rel = path.normalize(decodeURIComponent(u.hostname + u.pathname));
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
      if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
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
ipcMain.handle('volumes:reachable', (_e, id) => {
  const vol = db.getVolume(assertInt(id));
  return !!(vol && vol.root_path && fs.existsSync(vol.root_path));
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

ipcMain.handle('drive:scan', async (_e, { root, name, existingVolumeId }) => {
  assertStr(root, 'root');
  assertStr(name, 'name', 200);
  if (existingVolumeId != null) assertInt(existingVolumeId, 'existingVolumeId');
  if (!fs.existsSync(root)) {
    return { ok: false, error: `That path isn't reachable right now: ${root}` };
  }
  const { entries, skipped } = await scanner.scan(root, (count, current) => {
    send('scan:progress', { count, current });
  });
  const meta = {
    name, root_path: root,
    scanned_at: new Date().toISOString(),
    file_count: 0, total_bytes: 0
  };
  // A re-scan invalidates the old volume id's thumb cache.
  if (existingVolumeId) await thumbs.clearVolume(existingVolumeId);
  const volumeId = db.replaceVolume(existingVolumeId || null, meta, entries);
  return { ok: true, volumeId, skipped };
});

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
ipcMain.handle('entries:search', (_e, term, volumeId) =>
  db.search(assertStr(term, 'term', 200), volumeId == null ? null : assertInt(volumeId, 'volumeId')));

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

// ---- IPC: video thumbnails ----------------------------------------------

let thumbAbort = null;

ipcMain.handle('thumbs:ready', () => thumbs.ffmpegAvailable());

// Generate (if missing) the thumb + preview for a single entry, on demand.
ipcMain.handle('thumbs:ensure', async (_e, id) => {
  assertInt(id);
  const entry = db.getEntry(id);
  if (!entry || entry.is_dir || !thumbs.isVideo(entry.ext)) return { ok: false };
  const vol = db.getVolume(entry.volume_id);
  if (!vol || !vol.root_path) return { ok: false, error: 'offline' };
  const src = path.join(vol.root_path, entry.rel_path);
  if (!fs.existsSync(src)) return { ok: false, error: 'offline' };

  const ac = new AbortController();
  try {
    if (!(await thumbs.hasThumb(entry.volume_id, id))) {
      await thumbs.generateThumb(src, entry.volume_id, id, ac.signal);
    }
    if (!(await thumbs.hasPreview(entry.volume_id, id))) {
      await thumbs.generatePreview(src, entry.volume_id, id, ac.signal);
    }
    return { ok: true, volumeId: entry.volume_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Batch-generate for every reachable video in a volume (concurrency-limited).
ipcMain.handle('thumbs:generate', async (_e, volumeId) => {
  assertInt(volumeId);
  const vol = db.getVolume(volumeId);
  if (!vol || !vol.root_path || !fs.existsSync(vol.root_path)) {
    return { ok: false, error: 'Drive is not connected.' };
  }
  const vids = db.getVideoEntries(volumeId, thumbs.VIDEO_EXTS);
  if (!vids.length) return { ok: true, total: 0 };

  thumbAbort = new AbortController();
  const signal = thumbAbort.signal;
  const total = vids.length;
  let done = 0;

  const worker = async (queue) => {
    while (queue.length && !signal.aborted) {
      const v = queue.shift();
      const src = path.join(vol.root_path, v.rel_path);
      try {
        if (fs.existsSync(src)) {
          if (!(await thumbs.hasThumb(volumeId, v.id))) await thumbs.generateThumb(src, volumeId, v.id, signal);
          if (!(await thumbs.hasPreview(volumeId, v.id))) await thumbs.generatePreview(src, volumeId, v.id, signal);
        }
      } catch { /* skip this one */ }
      done += 1;
      send('thumbs:progress', { done, total, current: v.rel_path, volumeId });
    }
  };

  const queue = vids.slice();
  await Promise.all([worker(queue), worker(queue)]); // 2 concurrent ffmpeg
  send('thumbs:progress', { done, total, current: '', volumeId, finished: true });
  thumbAbort = null;
  return { ok: true, total, done, canceled: signal.aborted };
});

ipcMain.handle('thumbs:cancel', () => { if (thumbAbort) thumbAbort.abort(); return true; });

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
