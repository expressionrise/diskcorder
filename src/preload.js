'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Helper: subscribe to a push channel, return an unsubscribe fn.
function on(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  // volumes
  listVolumes: () => ipcRenderer.invoke('volumes:list'),
  deleteVolume: (id) => ipcRenderer.invoke('volumes:delete', id),
  renameVolume: (id, name) => ipcRenderer.invoke('volumes:rename', id, name),
  isReachable: (id) => ipcRenderer.invoke('volumes:reachable', id),
  pickDrive: () => ipcRenderer.invoke('drive:pick'),
  scanDrive: (payload) => ipcRenderer.invoke('drive:scan', payload),

  // browsing
  getChildren: (volumeId, parentId) => ipcRenderer.invoke('entries:children', volumeId, parentId),
  getEntry: (id) => ipcRenderer.invoke('entries:get', id),
  setNote: (id, note) => ipcRenderer.invoke('entries:setNote', id, note),
  setAlias: (id, alias) => ipcRenderer.invoke('entries:setAlias', id, alias),
  search: (term, volumeId) => ipcRenderer.invoke('entries:search', term, volumeId),
  realRename: (id, newName) => ipcRenderer.invoke('entries:realRename', id, newName),

  // video thumbnails / previews
  ensureThumb: (id) => ipcRenderer.invoke('thumbs:ensure', id),
  generateThumbs: (volumeId) => ipcRenderer.invoke('thumbs:generate', volumeId),
  cancelThumbs: () => ipcRenderer.invoke('thumbs:cancel'),
  ffmpegReady: () => ipcRenderer.invoke('thumbs:ready'),

  // transfer (copy / move between drives)
  transferTargets: (entryId) => ipcRenderer.invoke('transfer:targets', entryId),
  startTransfer: (payload) => ipcRenderer.invoke('transfer:start', payload),
  cancelTransfer: (opId) => ipcRenderer.invoke('transfer:cancel', opId),

  // events
  onScanProgress: (cb) => on('scan:progress', cb),
  onThumbProgress: (cb) => on('thumbs:progress', cb),
  onTransferProgress: (cb) => on('transfer:progress', cb)
});
