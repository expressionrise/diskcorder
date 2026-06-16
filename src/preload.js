'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // volumes
  listVolumes: () => ipcRenderer.invoke('volumes:list'),
  deleteVolume: (id) => ipcRenderer.invoke('volumes:delete', id),
  renameVolume: (id, name) => ipcRenderer.invoke('volumes:rename', id, name),
  pickDrive: () => ipcRenderer.invoke('drive:pick'),
  scanDrive: (payload) => ipcRenderer.invoke('drive:scan', payload),

  // browsing
  getChildren: (volumeId, parentId) => ipcRenderer.invoke('entries:children', volumeId, parentId),
  getEntry: (id) => ipcRenderer.invoke('entries:get', id),
  setNote: (id, note) => ipcRenderer.invoke('entries:setNote', id, note),
  setAlias: (id, alias) => ipcRenderer.invoke('entries:setAlias', id, alias),
  search: (term, volumeId) => ipcRenderer.invoke('entries:search', term, volumeId),
  realRename: (id, newName) => ipcRenderer.invoke('entries:realRename', id, newName),

  // events
  onScanProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  }
});
