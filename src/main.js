'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const scanner = require('./scanner');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#15161c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'catalog.db');
  db.init(dbPath);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: volumes --------------------------------------------------------

ipcMain.handle('volumes:list', () => db.listVolumes());
ipcMain.handle('volumes:delete', (_e, id) => { db.deleteVolume(id); return true; });
ipcMain.handle('volumes:rename', (_e, id, name) => { db.renameVolume(id, name); return true; });

ipcMain.handle('drive:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a drive or folder to map',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const root = res.filePaths[0];
  return { root, suggestedName: path.basename(root) || root };
});

ipcMain.handle('drive:scan', async (_e, { root, name, existingVolumeId }) => {
  if (!fs.existsSync(root)) {
    return { ok: false, error: `That path isn't reachable right now: ${root}` };
  }
  const rows = await scanner.scan(root, (count, current) => {
    if (win && !win.isDestroyed()) win.webContents.send('scan:progress', { count, current });
  });
  const meta = {
    name,
    root_path: root,
    scanned_at: new Date().toISOString(),
    file_count: 0,
    total_bytes: 0
  };
  const volumeId = db.replaceVolume(existingVolumeId || null, meta, rows);
  return { ok: true, volumeId };
});

// ---- IPC: browsing -------------------------------------------------------

ipcMain.handle('entries:children', (_e, volumeId, parentId) => db.getChildren(volumeId, parentId));
ipcMain.handle('entries:get', (_e, id) => db.getEntry(id));
ipcMain.handle('entries:setNote', (_e, id, note) => { db.setNote(id, note); return true; });
ipcMain.handle('entries:setAlias', (_e, id, alias) => { db.setAlias(id, alias); return true; });
ipcMain.handle('entries:search', (_e, term, volumeId) => db.search(term, volumeId));

// ---- IPC: real on-disk rename (drive must be connected) ------------------

ipcMain.handle('entries:realRename', (_e, id, newName) => {
  const entry = db.getEntry(id);
  if (!entry) return { ok: false, error: 'Entry not found.' };

  const vol = db.listVolumes().find(v => v.id === entry.volume_id);
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

  const parentRel = path.posix.dirname(entry.rel_path.replace(/\\/g, '/'));
  const newRel = parentRel === '.' ? newName : `${parentRel}/${newName}`;
  db.applyRealRename(id, newName, newRel);
  // Note: for folders, descendant rel_paths are not rewritten in this v1.
  // A re-scan of the drive will fully reconcile them.
  return { ok: true };
});
