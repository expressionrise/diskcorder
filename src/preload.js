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
  setVolumeIcon: (id, icon) => ipcRenderer.invoke('volumes:setIcon', id, icon),
  isReachable: (id) => ipcRenderer.invoke('volumes:reachable', id),
  driveCapacity: (id) => ipcRenderer.invoke('volumes:capacity', id),
  exportVolume: (id) => ipcRenderer.invoke('volumes:export', id),
  importVolume: () => ipcRenderer.invoke('volumes:import'),
  pickDrive: () => ipcRenderer.invoke('drive:pick'),
  scanDrive: (payload) => ipcRenderer.invoke('drive:scan', payload),
  pauseScan: () => ipcRenderer.invoke('drive:scanPause'),
  resumeScan: () => ipcRenderer.invoke('drive:scanResume'),
  cancelScan: () => ipcRenderer.invoke('drive:scanCancel'),

  // browsing
  getChildren: (volumeId, parentId) => ipcRenderer.invoke('entries:children', volumeId, parentId),
  getEntry: (id) => ipcRenderer.invoke('entries:get', id),
  setNote: (id, note) => ipcRenderer.invoke('entries:setNote', id, note),
  setAlias: (id, alias) => ipcRenderer.invoke('entries:setAlias', id, alias),
  setFlag: (id, flag) => ipcRenderer.invoke('entries:setFlag', id, flag),
  setTags: (id, tags) => ipcRenderer.invoke('entries:setTags', id, tags),
  listTags: () => ipcRenderer.invoke('tags:list'),
  search: (term, volumeId) => ipcRenderer.invoke('entries:search', term, volumeId),
  largeFiles: (volumeId, opts) => ipcRenderer.invoke('entries:large', volumeId, opts),
  listFiles: (volumeId) => ipcRenderer.invoke('entries:list', volumeId),
  listFilesUnder: (volumeId, parentId) => ipcRenderer.invoke('entries:listUnder', volumeId, parentId),
  ancestry: (id) => ipcRenderer.invoke('entries:ancestry', id),
  realRename: (id, newName) => ipcRenderer.invoke('entries:realRename', id, newName),
  realDelete: (id) => ipcRenderer.invoke('entries:realDelete', id),
  testFile: (id) => ipcRenderer.invoke('file:test', id),
  cancelFileTest: () => ipcRenderer.invoke('file:test:cancel'),
  findDuplicates: (volumeId) => ipcRenderer.invoke('entries:duplicates', volumeId),
  revealInExplorer: (id) => ipcRenderer.invoke('entries:reveal', id),

  // space map (treemap)
  getTreemap: (volumeId, parentId) => ipcRenderer.invoke('entries:treemap', volumeId, parentId),

  // thumbnails / previews
  ensureThumb: (id) => ipcRenderer.invoke('thumbs:ensure', id),
  generateThumbs: (volumeId, opts) => ipcRenderer.invoke('thumbs:generate', volumeId, opts),
  cancelThumbs: () => ipcRenderer.invoke('thumbs:cancel'),
  pauseThumbs: () => ipcRenderer.invoke('thumbs:pause'),
  resumeThumbs: () => ipcRenderer.invoke('thumbs:resume'),
  ffmpegReady: () => ipcRenderer.invoke('thumbs:ready'),
  thumbCoverage: (volumeId) => ipcRenderer.invoke('thumbs:coverage', volumeId),
  cacheSize: (volumeId) => ipcRenderer.invoke('thumbs:cachesize', volumeId),

  // transfer (copy / move between drives)
  transferTargets: (entryId) => ipcRenderer.invoke('transfer:targets', entryId),
  startTransfer: (payload) => ipcRenderer.invoke('transfer:start', payload),
  cancelTransfer: (opId) => ipcRenderer.invoke('transfer:cancel', opId),

  // events
  onScanProgress: (cb) => on('scan:progress', cb),
  onThumbProgress: (cb) => on('thumbs:progress', cb),
  onTransferProgress: (cb) => on('transfer:progress', cb),

  // backup
  startBackup: (payload) => ipcRenderer.invoke('backup:start', payload),
  cancelBackup: () => ipcRenderer.invoke('backup:cancel'),
  onBackupProgress: (cb) => on('backup:progress', cb),
  // backup tab: jobs, folder picking, path runs, logs
  pickBackupFolder: (title) => ipcRenderer.invoke('backup:pickFolder', title),
  listBackupJobs: () => ipcRenderer.invoke('backup:listJobs'),
  saveBackupJob: (job) => ipcRenderer.invoke('backup:saveJob', job),
  deleteBackupJob: (id) => ipcRenderer.invoke('backup:deleteJob', id),
  runBackupPath: (payload) => ipcRenderer.invoke('backup:runPath', payload),
  backupLogIndex: () => ipcRenderer.invoke('backup:logIndex'),
  backupLogDetail: (runId) => ipcRenderer.invoke('backup:logDetail', runId)
});
