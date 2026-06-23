'use strict';

/* Diskcorder renderer — wires the UI shell to the main process through the
   preload `window.api` bridge. No Node access here, no framework, no build. */

// Everything runs inside an IIFE. `window.api` is exposed by preload via
// contextBridge as a *non-configurable global*, so a top-level `const api`
// would collide ("Identifier 'api' has already been declared") and abort the
// whole script. Scoping it to a function avoids the clash.
(() => {

const api = window.api;

// ---- DOM + small utilities ----------------------------------------------

const $ = (id) => document.getElementById(id);

function humanFileSize(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / Math.pow(1024, i);
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

// ---- icon set (one consistent stroke style across the whole app) --------

const S = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const svg = (body) => `<svg viewBox="0 0 24 24" ${S}>${body}</svg>`;
const ICON = {
  folder:  svg('<path d="M3 7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  file:    svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  video:   svg('<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M17 9l4-2v10l-4-2z"/>'),
  image:   svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="M21 16l-5-5L5 20"/>'),
  audio:   svg('<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  archive: svg('<path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M12 11v4M10.5 12.5h3"/>'),
  doc:     svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 16h6"/>'),
  code:    svg('<path d="M16 18l4-6-4-6M8 6l-4 6 4 6"/>'),
  copy:    svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
  move:    svg('<path d="M5 9l-3 3 3 3M2 12h10M14 5l3-3 3 3M17 2v20"/>'),
  rename:  svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  rescan:  svg('<path d="M21 12a9 9 0 1 1-3-6.7M21 3v5h-5"/>'),
  trash:   svg('<path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/>'),
  play:    svg('<path d="M7 5v14l11-7z"/>'),
  film:    svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
  search:  svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  cancel:  svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>')
};

const IMAGE_EXTS = ['jpg','jpeg','png','gif','webp','bmp','svg','heic','tif','tiff','avif'];
const AUDIO_EXTS = ['mp3','wav','flac','aac','ogg','m4a','wma','aiff','opus'];
const ARCHIVE_EXTS = ['zip','rar','7z','tar','gz','bz2','xz','iso'];
const DOC_EXTS = ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','rtf','odt','csv'];
const CODE_EXTS = ['js','mjs','ts','tsx','jsx','json','html','css','py','c','cpp','h','hpp','java','go','rs','sh','xml','yml','yaml','php','rb'];
const VIDEO_EXTS = ['mp4','mkv','mov','avi','webm','m4v','wmv','flv','mpg','mpeg','m2ts','ts','3gp','ogv'];

function isVideoExt(ext) { return !!ext && VIDEO_EXTS.includes(ext.toLowerCase()); }
function isImageExt(ext) { return !!ext && IMAGE_EXTS.includes(ext.toLowerCase()); }

function iconFor(isDir, ext) {
  if (isDir) return ICON.folder;
  const e = (ext || '').toLowerCase();
  if (VIDEO_EXTS.includes(e)) return ICON.film;
  if (IMAGE_EXTS.includes(e)) return ICON.image;
  if (AUDIO_EXTS.includes(e)) return ICON.audio;
  if (ARCHIVE_EXTS.includes(e)) return ICON.archive;
  if (DOC_EXTS.includes(e)) return ICON.doc;
  if (CODE_EXTS.includes(e)) return ICON.code;
  return ICON.file;
}

// Fixed host "media" — a numeric host (the volume id) gets normalised to an IP
// by the standard-scheme URL parser, so the ids live in the path instead.
const thumbUrl = (volId, id) => `thumbcache://media/${volId}/${id}.jpg`;
const previewUrl = (volId, id) => `thumbcache://media/${volId}/${id}.mp4`;

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 5200 : 2600);
}

// ---- application state ---------------------------------------------------

const state = {
  volumes: [],
  maxBytes: 1,            // largest catalog, for the offline fallback bar
  reachable: {},          // volumeId -> bool (drive currently connected?)
  capacity: {},           // volumeId -> { total, free, used } | null (when online)
  coverage: {},           // volumeId -> { made, total } thumbnails created so far
  cacheBytes: {},         // volumeId -> local cache size in bytes (catalog cost)
  activeVolumeId: null,
  trail: [],              // [{ id: null|entryId, name }] — id null == volume root
  selectedEntry: null,    // full row from getEntry, for the detail pane
  searching: false,
  fileView: 'folders',    // 'folders' (tree) | 'list' (flat filenames + locations)
  fileSort: 'name',       // 'name' | 'size' | 'date' | 'label' | 'tag'
  fileSortDir: 'asc',     // 'asc' | 'desc'
  ffmpegReady: false,
  tagVocab: [],           // every tag ever used, for autocomplete
  tab: 'files',           // 'files' | 'space'
  tmTrail: [],            // drill path within the space map
  tmItems: [],            // current level's rows
  tmTiles: []             // laid-out rectangles for hit-testing
};

// Multi-select for bulk tag/flag in the Files view.
let multiMode = false;          // when on, clicking files ticks them instead of opening them
const multiSel = new Set();     // entry ids currently ticked for bulk actions

// ---- drives rail ---------------------------------------------------------

async function loadRail() {
  state.volumes = await api.listVolumes();
  state.maxBytes = Math.max(1, ...state.volumes.map(v => v.total_bytes || 0));
  renderRail();
  refreshReachability();
}

// Thumbnail coverage (how many stills are already cached) for every drive.
// Independent of whether the drive is connected — it reads the local cache.
async function refreshCoverage(ids) {
  const vols = ids ? state.volumes.filter(v => ids.includes(v.id)) : state.volumes;
  await Promise.all(vols.map(async v => {
    try { state.coverage[v.id] = await api.thumbCoverage(v.id); }
    catch { state.coverage[v.id] = null; }
  }));
  document.querySelectorAll('.volume-card').forEach(card => renderCoverage(card, Number(card.dataset.id)));
  if (state.activeVolumeId != null) refreshCacheSize(state.activeVolumeId);
}

// The persistent "X / Y thumbnails created" bar under the storage bar.
function renderCoverage(card, id) {
  const wrap = card.querySelector('.thumb-cov');
  const fill = card.querySelector('.thumb-cov-fill');
  const text = card.querySelector('.thumb-cov-text');
  if (!wrap || !fill) return;
  const c = state.coverage[id];
  if (!c || !c.total) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const pct = Math.round((c.made / c.total) * 100);
  fill.style.width = pct + '%';
  wrap.classList.toggle('complete', c.made >= c.total);
  if (text) text.textContent = `${c.made.toLocaleString()} / ${c.total.toLocaleString()} thumbnails`;
  wrap.title = c.made >= c.total
    ? `All ${c.total.toLocaleString()} thumbnails created`
    : `${c.made.toLocaleString()} of ${c.total.toLocaleString()} thumbnails created — click “Thumbnails” to make the rest`;
}

async function refreshReachability() {
  const wasOnline = { ...state.reachable };
  await Promise.all(state.volumes.map(async v => {
    try { state.reachable[v.id] = await api.isReachable(v.id); } catch { state.reachable[v.id] = false; }
    try { state.capacity[v.id] = state.reachable[v.id] ? await api.driveCapacity(v.id) : null; }
    catch { state.capacity[v.id] = null; }
  }));
  // update badges + capacity bars in place
  document.querySelectorAll('.volume-card').forEach(card => {
    const id = Number(card.dataset.id);
    const badge = card.querySelector('.badge');
    if (badge) {
      const online = !!state.reachable[id];
      badge.textContent = online ? 'connected' : 'offline';
      badge.classList.toggle('online', online);
    }
    updateCapBar(card, id);
    renderVolDetail(card, id);
  });
  await refreshCoverage();
  // Drives that just became connected: auto-sync (if enabled) then auto-thumbnail.
  const justConnected = state.volumes.filter(v => state.reachable[v.id] && !wasOnline[v.id]).map(v => v.id);
  for (const id of justConnected) queueAutoThumbs(id);
  if (justConnected.length) autoSyncConnected(justConnected);
}

// Fill the rail's capacity bar from real disk usage when the drive is online,
// otherwise fall back to the drive's cataloged size relative to the biggest one.
function updateCapBar(card, id) {
  const fill = card.querySelector('.cap-fill');
  const cap = card.querySelector('.cap-bar');
  const usage = card.querySelector('.cap-usage');
  if (!fill || !cap) return;
  const c = state.capacity[id];
  if (c && c.total) {
    const pct = Math.min(100, Math.max(2, Math.round((c.used / c.total) * 100)));
    fill.style.width = pct + '%';
    cap.title = `${humanFileSize(c.used)} used of ${humanFileSize(c.total)} · ${humanFileSize(c.free)} free`;
    if (usage) usage.textContent = `${humanFileSize(c.used)} / ${humanFileSize(c.total)}`;
  } else {
    const v = state.volumes.find(x => x.id === id);
    const pct = Math.max(3, Math.round(((v && v.total_bytes || 0) / state.maxBytes) * 100));
    fill.style.width = pct + '%';
    cap.title = 'Drive offline — bar shows cataloged size relative to your largest drive';
    if (usage) usage.textContent = '';
  }
}

function renderRail() {
  const list = $('volumes');
  const empty = $('rail-empty');
  list.innerHTML = '';

  if (!state.volumes.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const v of state.volumes) {
    const card = document.createElement('li');
    card.className = 'volume-card' + (v.id === state.activeVolumeId ? ' active' : '');
    card.dataset.id = v.id;
    const online = !!state.reachable[v.id];

    card.innerHTML = `
      <div class="vname">
        <span class="vavatar" title="Click to change this drive's icon"></span>
        <span class="vname-text"></span>
        <span class="badge ${online ? 'online' : ''}">${online ? 'connected' : 'offline'}</span>
      </div>
      <div class="vmeta">
        <span>${(v.file_count || 0).toLocaleString()} files</span>
        <span>${humanFileSize(v.total_bytes)}</span>
      </div>
      <div class="cap-bar"><div class="cap-fill"></div></div>
      <div class="cap-usage"></div>
      <div class="thumb-cov">
        <div class="thumb-cov-bar"><div class="thumb-cov-fill"></div></div>
        <span class="thumb-cov-text"></span>
      </div>
      <div class="thumb-prog hidden">
        <div class="thumb-prog-bar"><div class="thumb-prog-fill"></div></div>
        <span class="thumb-prog-text"></span>
      </div>
      <div class="vol-detail${v.id === state.activeVolumeId ? '' : ' hidden'}"></div>
      <div class="vol-actions">
        <button class="mini" data-act="sync" title="Re-read this drive and update the catalog — new files appear, deleted ones are removed, notes and labels are kept.">Update</button>
        <button class="mini" data-act="backup" title="Copy this drive's files to another connected drive (additive — copies new &amp; changed files, never deletes)">Backup</button>
        <button class="mini" data-act="rescan" title="Point this drive to a new folder or drive letter and rebuild its catalog.">Relocate</button>
        <button class="mini" data-act="thumbs" title="Generate the still previews for every image and video on this drive. Resumes where it left off and skips ones already made.">Previews</button>
        <button class="mini" data-act="rename" title="Rename this drive's label in Diskcorder (the disk itself is untouched)">Rename</button>
        <button class="mini" data-act="export" title="Save this drive's catalog to a .json file you can import elsewhere">Export</button>
        <button class="mini mini-danger" data-act="remove" title="Remove this drive from Diskcorder (the disk and its files are untouched)">Remove</button>
      </div>
      <label class="vol-autosync" title="Automatically update this drive's catalog whenever it connects">
        <input type="checkbox" data-act="autosync" /> Auto-update on connect
      </label>`;
    card.querySelector('.vname-text').textContent = v.name;
    const avatar = card.querySelector('.vavatar');
    avatar.textContent = v.icon || '💾';
    avatar.addEventListener('click', (e) => { e.stopPropagation(); pickDriveIcon(v); });

    card.addEventListener('click', (e) => {
      if (e.target.closest('.vol-actions') || e.target.closest('.vavatar') || e.target.closest('.vol-autosync')) return;
      openVolume(v);
    });
    card.querySelector('[data-act="sync"]').addEventListener('click', () => syncDrive(v));
    card.querySelector('[data-act="backup"]').addEventListener('click', () => openBackup(v));
    card.querySelector('[data-act="rescan"]').addEventListener('click', () => mapDrive(v));
    card.querySelector('[data-act="thumbs"]').addEventListener('click', () => generateThumbnails(v));
    card.querySelector('[data-act="rename"]').addEventListener('click', () => renameVolume(v));
    card.querySelector('[data-act="export"]').addEventListener('click', () => exportVolume(v));
    card.querySelector('[data-act="remove"]').addEventListener('click', () => removeVolume(v));
    const autoCb = card.querySelector('[data-act="autosync"]');
    autoCb.checked = !!getAutoSync()[v.id];
    autoCb.addEventListener('click', (e) => e.stopPropagation());
    autoCb.addEventListener('change', () => setAutoSync(v.id, autoCb.checked));

    list.appendChild(card);
    updateCapBar(card, v.id);
    renderCoverage(card, v.id);
    renderVolDetail(card, v.id);
  }
}

// Drive details for the (expanded) active card: real disk figures from the
// system, alongside what Diskcorder has cataloged, so the two can be compared.
function renderVolDetail(card, id) {
  const box = card.querySelector('.vol-detail');
  if (!box) return;
  const v = state.volumes.find(x => x.id === id);
  if (!v) return;
  const c = state.capacity[id];
  const rows = [];
  if (c && c.total) {
    rows.push(['Drive total', humanFileSize(c.total)]);
    rows.push(['Used on disk', humanFileSize(c.used)]);
    rows.push(['Free', humanFileSize(c.free)]);
  }
  rows.push(['Cataloged', `${humanFileSize(v.total_bytes)} · ${(v.file_count || 0).toLocaleString()} files`]);
  const cache = state.cacheBytes[id];
  if (cache != null) rows.push(['Catalog cache', humanFileSize(cache)]);
  if (!c) rows.push(['Status', state.reachable[id] ? 'reading…' : 'offline']);
  if (v.root_path) rows.push(['Path', v.root_path]);

  box.innerHTML = '';
  for (const [k, val] of rows) {
    const kEl = document.createElement('span'); kEl.className = 'vd-k'; kEl.textContent = k;
    const vEl = document.createElement('span'); vEl.className = 'vd-v'; vEl.textContent = val;
    if (k === 'Path') vEl.title = val;
    if (k === 'Catalog cache') { kEl.title = vEl.title = 'Local disk this drive\'s thumbnails & previews use on this machine'; }
    box.append(kEl, vEl);
  }
}

// How much local disk a drive's cached thumbnails/previews use. Fetched for the
// active (expanded) card, since that's where the detail block is shown.
async function refreshCacheSize(id) {
  if (id == null) return;
  try { state.cacheBytes[id] = await api.cacheSize(id); } catch { return; }
  document.querySelectorAll(`.volume-card[data-id="${id}"]`).forEach(card => renderVolDetail(card, id));
}

const DRIVE_ICONS = ['💾','💿','📀','🗄️','📦','🎬','🎞️','🎥','📷','📸','🖼️','🎵','🎮','📁','🗂️','☁️','🔒','💼','🏠','⭐','🚀','🔴','🟢','🔵','🟡','🟣','🟠','🐧'];

// Lightweight emoji picker for a drive's avatar icon.
function pickDriveIcon(v) {
  const backdrop = $('icon-modal');
  const grid = $('icon-grid');
  const clearBtn = $('icon-clear');
  const cancelBtn = $('icon-cancel');

  grid.innerHTML = '';
  for (const emo of DRIVE_ICONS) {
    const b = document.createElement('button');
    b.className = 'icon-opt' + (v.icon === emo ? ' active' : '');
    b.textContent = emo;
    b.addEventListener('click', () => setIcon(emo));
    grid.appendChild(b);
  }
  $('icon-modal-title').textContent = `Icon for “${v.name}”`;
  backdrop.classList.remove('hidden');

  async function setIcon(icon) {
    cleanup();
    await api.setVolumeIcon(v.id, icon);
    await loadRail();
  }
  function cleanup() {
    backdrop.classList.add('hidden');
    clearBtn.removeEventListener('click', onClear);
    cancelBtn.removeEventListener('click', cleanup);
    backdrop.removeEventListener('mousedown', onBackdrop);
    document.removeEventListener('keydown', onEsc);
  }
  const onClear = () => setIcon(null);
  const onBackdrop = (e) => { if (e.target === backdrop) cleanup(); };
  const onEsc = (e) => { if (e.key === 'Escape') cleanup(); };
  clearBtn.addEventListener('click', onClear);
  cancelBtn.addEventListener('click', cleanup);
  backdrop.addEventListener('mousedown', onBackdrop);
  document.addEventListener('keydown', onEsc);
}

async function renameVolume(v) {
  const name = await promptModal({
    title: 'Rename drive', sub: v.root_path || '', value: v.name, confirmText: 'Save'
  });
  if (name == null || !name.trim() || name === v.name) return;
  await api.renameVolume(v.id, name.trim());
  await loadRail();
  if (v.id === state.activeVolumeId && state.trail[0]) {
    state.trail[0].name = name.trim();
    renderBreadcrumb();
  }
}

async function exportVolume(v) {
  const res = await api.exportVolume(v.id).catch(e => ({ ok: false, error: e.message }));
  if (!res || (!res.ok && !res.canceled)) { toast(res && res.error ? res.error : 'Export failed.', true); return; }
  if (res.ok) {
    const t = res.thumbs ? ` and ${res.thumbs.toLocaleString()} thumbnails` : '';
    toast(`Exported ${res.count.toLocaleString()} entries${t}.`);
  }
}

async function importVolume() {
  const res = await api.importVolume().catch(e => ({ ok: false, error: e.message }));
  if (!res || res.canceled) return;
  if (!res.ok) { toast(res.error || 'Import failed.', true); return; }
  await loadTagVocab();
  await loadRail();
  const vol = state.volumes.find(v => v.id === res.volumeId);
  if (vol) await openVolume(vol);
  toast(res.thumbs ? `Catalog imported with ${res.thumbs.toLocaleString()} thumbnails.` : 'Catalog imported.');
}

async function removeVolume(v) {
  const ok = await promptModal({
    title: `Remove “${v.name}”?`,
    sub: 'This forgets the catalog, notes, aliases, and cached previews for this drive. The drive itself is untouched.',
    confirmText: 'Remove', input: false, danger: true
  });
  if (!ok) return;
  await api.deleteVolume(v.id);
  if (v.id === state.activeVolumeId) {
    state.activeVolumeId = null;
    state.trail = [];
    clearBrowser();
    clearDetail();
  }
  await loadRail();
  toast('Drive removed from catalog.');
}

// ---- file browser --------------------------------------------------------

function clearBrowser() {
  const listing = $('listing');
  if (listing._lazyScroll) { listing.removeEventListener('scroll', listing._lazyScroll); listing._lazyScroll = null; }
  listing.classList.remove('gallery');
  listing.innerHTML = '';
  $('breadcrumb').innerHTML = '';
  $('listing-empty').classList.remove('hidden');
}

async function openVolume(v) {
  state.activeVolumeId = v.id;
  state.trail = [{ id: null, name: v.name, rel: '' }];
  state.tmTrail = [{ id: null, name: v.name }];
  state.searching = false;
  $('search-input').value = '';
  renderRail();
  loadFolderTree();
  refreshCacheSize(v.id);
  await loadListing();
  if (state.tab === 'space') await tmLoadLevel(null);
  else if (state.tab === 'large') await loadLargeFiles();
  else if (state.tab === 'starred') await loadStarred();
  saveSession();
}

// All flagged items on the active drive, for the Starred tab.
async function loadStarred() {
  const list = $('starred-list');
  const sum = $('starred-summary');
  if (list._lazyScroll) { list.removeEventListener('scroll', list._lazyScroll); list._lazyScroll = null; }
  if (state.activeVolumeId == null) {
    list.innerHTML = '';
    sum.textContent = 'Open a drive to see its starred items.';
    return;
  }
  const rows = await api.flaggedItems(state.activeVolumeId).catch(() => []);
  if (!rows.length) {
    list.innerHTML = '<div class="listing-empty">No starred items yet. Click the ☆ on a file or folder (or right-click → flag) to star it.</div>';
    sum.textContent = '0 starred';
    return;
  }
  sum.textContent = `${rows.length.toLocaleString()} starred item${rows.length === 1 ? '' : 's'}`;
  lazyRender(list, rows, (r) => makeFileRow(r, false, true));
}

// ---- session memory: last drive, folder, view, and tab -------------------

function saveSession() {
  try {
    const tail = state.trail[state.trail.length - 1] || {};
    localStorage.setItem('diskcorder-session', JSON.stringify({
      volumeId: state.activeVolumeId,
      folderPath: tail.rel || '',
      fileView: state.fileView,
      tab: state.tab
    }));
  } catch { /* ignore */ }
}

async function restoreSession() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem('diskcorder-session') || 'null'); } catch { s = null; }
  if (!s || s.volumeId == null) return;
  const vol = state.volumes.find(v => v.id === s.volumeId);
  if (!vol) return;

  state.activeVolumeId = vol.id;
  state.fileView = ['folders', 'list', 'gallery'].includes(s.fileView) ? s.fileView : 'folders';
  updateViewToggle();
  state.trail = [{ id: null, name: vol.name, rel: '' }];
  state.tmTrail = [{ id: null, name: vol.name }];
  renderRail();
  loadFolderTree();
  refreshCacheSize(vol.id);

  // Resolve the saved folder by PATH (robust across re-scans that change ids).
  if (s.folderPath) {
    const fid = await api.resolvePath(vol.id, s.folderPath).catch(() => null);
    if (fid) {
      const chain = await api.ancestry(fid).catch(() => []);
      for (const c of chain) if (c.is_dir) state.trail.push({ id: c.id, name: c.name, rel: c.rel_path });
    }
  }
  await loadListing();
  if (s.tab && s.tab !== 'files' && $('tab-' + s.tab)) switchTab(s.tab);
}

async function loadListing() {
  if (state.activeVolumeId == null) { clearBrowser(); return; }
  $('listing-empty').classList.add('hidden');
  saveSession();

  const parent = state.trail[state.trail.length - 1];

  // List + Gallery list every file under the CURRENT folder (recursively), so
  // switching views keeps you in the same place; Folders browses the tree.
  if (state.fileView === 'list' || state.fileView === 'gallery') {
    const rows = await api.listFilesUnder(state.activeVolumeId, parent.id);
    sortEntries(rows, false);
    renderBreadcrumb(rows.length);
    if (state.fileView === 'gallery') renderGallery(rows);
    else renderRows(rows, false, { showPath: true });
    return;
  }

  const rows = await api.getChildren(state.activeVolumeId, parent.id);
  sortEntries(rows, true);
  renderBreadcrumb();
  renderRows(rows, false);
}

// Sort a row set in place by the current Files-view sort key + direction.
// In folder view, folders are kept above files regardless of the key.
function sortEntries(rows, foldersFirst) {
  const dir = state.fileSortDir === 'desc' ? -1 : 1;
  const sizeOf = r => r.is_dir ? (r.tree_size || 0) : (r.size || 0);
  const nameOf = r => (r.alias || r.name || '').toLowerCase();
  const firstTag = r => { const t = parseTagList(r.tags); return t.length ? t[0].toLowerCase() : ''; };
  rows.sort((a, b) => {
    if (foldersFirst && !!a.is_dir !== !!b.is_dir) return a.is_dir ? -1 : 1;
    let r = 0;
    switch (state.fileSort) {
      case 'size': r = sizeOf(a) - sizeOf(b); break;
      case 'date': r = String(a.mtime || '').localeCompare(String(b.mtime || '')); break;
      case 'type': {
        const ca = tmCategory(a), cb = tmCategory(b);
        r = ca !== cb ? ca.localeCompare(cb) : (a.ext || '').localeCompare(b.ext || '');
        break;
      }
      case 'flag': {
        const fa = a.flag || '', fb = b.flag || '';
        if (!fa !== !fb) return (fa ? -1 : 1);   // flagged first, both directions
        r = fa.localeCompare(fb);
        break;
      }
      case 'label': {
        const la = a.alias || '', lb = b.alias || '';
        if (!la !== !lb) return (la ? -1 : 1);          // unlabeled last, both directions
        r = la.toLowerCase().localeCompare(lb.toLowerCase());
        break;
      }
      case 'tag': {
        const ta = firstTag(a), tb = firstTag(b);
        if (!ta !== !tb) return (ta ? -1 : 1);          // untagged last, both directions
        r = ta.localeCompare(tb);
        break;
      }
      case 'video': {
        const va = !a.is_dir && isVideoExt(a.ext), vb = !b.is_dir && isVideoExt(b.ext);
        if (va !== vb) return va ? -1 : 1;              // videos first, both directions
        r = nameOf(a).localeCompare(nameOf(b));
        break;
      }
      case 'image': {
        const ia = !a.is_dir && isImageExt(a.ext), ib = !b.is_dir && isImageExt(b.ext);
        if (ia !== ib) return ia ? -1 : 1;              // images first, both directions
        r = nameOf(a).localeCompare(nameOf(b));
        break;
      }
      default: r = nameOf(a).localeCompare(nameOf(b));
    }
    if (r === 0) r = nameOf(a).localeCompare(nameOf(b));
    return r * dir;
  });
}

function parseTagList(tagsJson) {
  if (!tagsJson) return [];
  try { const a = JSON.parse(tagsJson); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Append a row of tag chips to a list/gallery item's label, so tags are
// visible without opening the detail pane.
function appendTagChips(label, r) {
  const tags = parseTagList(r.tags);
  if (!tags.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'row-tags';
  for (const t of tags) {
    const chip = document.createElement('span');
    chip.className = 'row-tag';
    chip.textContent = t;
    wrap.appendChild(chip);
  }
  label.appendChild(wrap);
}

// Files-view controls: Folders / List / Gallery toggle + sort key + direction.
function updateViewToggle() {
  document.querySelectorAll('#file-view-toggle .seg-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.view === state.fileView));
}
document.querySelectorAll('#file-view-toggle .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (state.fileView === btn.dataset.view) return;
    state.fileView = btn.dataset.view;
    updateViewToggle();
    if (state.activeVolumeId != null && !state.searching) loadListing();
  });
});

// Jump the Folders view to a folder by id (from the rail tree or a List-row
// path). Rebuilds the breadcrumb trail from the folder's ancestry.
async function navigateToFolder(folderId) {
  if (state.activeVolumeId == null) return;
  const drive = state.volumes.find(v => v.id === state.activeVolumeId);
  const trail = [{ id: null, name: drive ? drive.name : 'Drive', rel: '' }];
  if (folderId != null) {
    const chain = await api.ancestry(folderId).catch(() => []);
    for (const c of chain) if (c.is_dir) trail.push({ id: c.id, name: c.name, rel: c.rel_path });
  }
  state.trail = trail;
  state.searching = false;
  $('search-input').value = '';
  if (state.fileView !== 'folders') { state.fileView = 'folders'; updateViewToggle(); }
  if (state.tab !== 'files') switchTab('files');
  await loadListing();
  highlightTreeNode(folderId);
}

// ---- rail folder tree ----------------------------------------------------

async function loadFolderTree() {
  const head = $('tree-head'), tree = $('folder-tree');
  if (state.activeVolumeId == null) {
    head.classList.add('hidden'); tree.classList.add('hidden'); tree.innerHTML = '';
    return;
  }
  head.classList.remove('hidden'); tree.classList.remove('hidden');
  tree.innerHTML = '';
  const folders = (await api.getChildren(state.activeVolumeId, null)).filter(k => k.is_dir);
  if (!folders.length) { tree.innerHTML = '<div class="tree-empty">No subfolders.</div>'; return; }
  for (const f of folders) tree.appendChild(buildTreeNode(f, 0));
}

function buildTreeNode(folder, depth) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.id = folder.id;

  const tog = document.createElement('span');
  tog.className = 'tree-toggle';
  tog.textContent = '▶';
  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = folder.alias || folder.name;
  row.append(tog, name);

  const kidsWrap = document.createElement('div');
  kidsWrap.className = 'tree-children hidden';
  kidsWrap.style.marginLeft = '10px';        // indent nested tiles as a group
  let loaded = false, open = false;
  // Open the node (loading children once); resolves when children are in the DOM.
  async function ensureOpen() {
    if (!open) { open = true; tog.textContent = '▼'; kidsWrap.classList.remove('hidden'); }
    if (!loaded) {
      loaded = true;
      const kids = (await api.getChildren(state.activeVolumeId, folder.id)).filter(k => k.is_dir);
      if (!kids.length) { tog.textContent = ''; tog.classList.add('leaf'); }
      for (const k of kids) kidsWrap.appendChild(buildTreeNode(k, depth + 1));
    }
  }
  row._ensureOpen = ensureOpen;     // used by revealTree to expand to a folder
  tog.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (open) { open = false; tog.textContent = '▶'; kidsWrap.classList.add('hidden'); }
    else await ensureOpen();
  });
  // The whole row navigates; the toggle (which stops propagation) only expands.
  row.addEventListener('click', () => navigateToFolder(folder.id));

  node.append(row, kidsWrap);
  return node;
}

// Expand the rail folder tree down to the folder containing an entry, and
// highlight it — so selecting a file in any view shows where it lives.
async function revealTree(entryId) {
  if (state.activeVolumeId == null) return;
  const chain = (await api.ancestry(entryId).catch(() => [])).filter(c => c.is_dir);
  if (!chain.length) { highlightTreeNode(null); return; }
  for (let i = 0; i < chain.length; i++) {
    const row = document.querySelector(`.folder-tree .tree-row[data-id="${chain[i].id}"]`);
    if (!row) return;                       // tree not loaded that far — give up quietly
    if (i < chain.length - 1 && row._ensureOpen) await row._ensureOpen();
  }
  const deepest = chain[chain.length - 1];
  highlightTreeNode(deepest.id);
  const r = document.querySelector(`.folder-tree .tree-row[data-id="${deepest.id}"]`);
  if (r) r.scrollIntoView({ block: 'nearest' });
}

function highlightTreeNode(folderId) {
  document.querySelectorAll('.folder-tree .tree-row.active').forEach(r => r.classList.remove('active'));
  if (folderId == null) return;
  const r = document.querySelector(`.folder-tree .tree-row[data-id="${folderId}"]`);
  if (r) r.classList.add('active');
}
$('file-sort').addEventListener('change', (e) => {
  state.fileSort = e.target.value;
  if (state.activeVolumeId != null && !state.searching) loadListing();
});
$('file-sort-dir').addEventListener('click', () => {
  state.fileSortDir = state.fileSortDir === 'asc' ? 'desc' : 'asc';
  $('file-sort-dir').textContent = state.fileSortDir === 'asc' ? '↑' : '↓';
  if (state.activeVolumeId != null && !state.searching) loadListing();
});

function renderBreadcrumb(count) {
  const bc = $('breadcrumb');
  bc.innerHTML = '';
  state.trail.forEach((crumb, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      bc.appendChild(sep);
    }
    const last = i === state.trail.length - 1;
    const c = document.createElement('span');
    c.className = 'crumb' + (last ? ' current' : '');
    c.textContent = crumb.name;
    if (!last) c.addEventListener('click', () => {
      state.trail = state.trail.slice(0, i + 1);
      loadListing();
    });
    bc.appendChild(c);
  });
  if (count != null) {
    const meta = document.createElement('span');
    meta.className = 'crumb-count';
    meta.textContent = `${count.toLocaleString()}${count >= 20000 ? '+' : ''} file${count === 1 ? '' : 's'}`;
    bc.appendChild(meta);
  }
}

// Render a large item set incrementally: paint ~2 screens up front, then append
// more as the user nears the bottom. Keeps huge lists from blocking the UI.
function lazyRender(container, items, makeEl) {
  container.innerHTML = '';
  if (container._lazyScroll) { container.removeEventListener('scroll', container._lazyScroll); container._lazyScroll = null; }
  if (!items.length) return;

  const rowH = 44;                                   // rough row height estimate
  const perScreen = Math.max(20, Math.ceil((container.clientHeight || 600) / rowH));
  const batch = perScreen * 2;                       // ~2 screens per chunk
  let i = 0;

  const paint = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(items.length, i + batch);
    for (; i < end; i++) {
      const el = makeEl(items[i], i);
      if (el) frag.appendChild(el);
    }
    container.appendChild(frag);
    if (i >= items.length && container._lazyScroll) {
      container.removeEventListener('scroll', container._lazyScroll);
      container._lazyScroll = null;
    }
  };
  paint();                                           // first ~2 screens

  if (i < items.length) {
    const onScroll = () => {
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - rowH * perScreen) paint();
    };
    container._lazyScroll = onScroll;
    container.addEventListener('scroll', onScroll);
  }
}

function renderRows(rows, asSearch, opts = {}) {
  const listing = $('listing');
  const showPath = !!opts.showPath;
  listing.classList.remove('gallery');

  if (!rows.length) {
    listing.innerHTML = '';
    if (listing._lazyScroll) { listing.removeEventListener('scroll', listing._lazyScroll); listing._lazyScroll = null; }
    const e = document.createElement('div');
    e.className = 'listing-empty';
    e.textContent = asSearch ? 'No matches.' : (showPath ? 'This drive has no files.' : 'This folder is empty.');
    listing.appendChild(e);
    return;
  }
  lazyRender(listing, rows, (r) => makeFileRow(r, asSearch, showPath));
}

function makeFileRow(r, asSearch, showPath) {
  const volId = asSearch ? r.volume_id : state.activeVolumeId;
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = r.id;
  if (state.selectedEntry && state.selectedEntry.id === r.id) row.classList.add('selected');

  const flag = makeFlagCell(r);

  const icon = document.createElement('span');
  icon.className = 'ic';
  icon.innerHTML = iconFor(r.is_dir, r.ext);
  if (!r.is_dir && isVideoExt(r.ext)) { icon.classList.add('thumb'); wireThumb(icon, volId, r.id); }
  else if (!r.is_dir && isImageExt(r.ext)) { icon.classList.add('thumb'); wireImageThumb(icon, volId, r.id); }

  const label = document.createElement('div');
  label.className = 'label';
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = r.alias || r.name;
  if (r.alias) { const tag = document.createElement('span'); tag.className = 'alias-tag'; tag.textContent = r.name; nm.appendChild(tag); }
  if (r.note) { const dot = document.createElement('span'); dot.className = 'note-dot'; dot.title = 'Has notes'; nm.appendChild(dot); }
  label.appendChild(nm);
  if (asSearch || showPath) {
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = asSearch ? `${r.volume_name} · ${r.rel_path}` : r.rel_path;
    // In the flat List view the path is clickable — jump to that folder.
    if (showPath && !asSearch) {
      sub.classList.add('sub-link');
      sub.title = 'Open this folder';
      sub.addEventListener('click', (e) => { e.stopPropagation(); navigateToFolder(r.parent_id ?? null); });
    }
    label.appendChild(sub);
  }
  appendTagChips(label, r);

  const sz = document.createElement('span');
  sz.className = 'sz';
  sz.textContent = r.is_dir ? humanFileSize(r.tree_size) : humanFileSize(r.size);
  if (r.is_dir) sz.classList.add('sz-dir');

  if (multiMode) {
    row.classList.toggle('multi-selected', multiSel.has(r.id));
    row.append(makeMultiCheck(r, row), flag, icon, label, sz);
  } else {
    row.append(flag, icon, label, sz);
  }
  row.addEventListener('click', () => {
    if (multiMode) setMultiSelected(r.id, !multiSel.has(r.id), row);
    else selectEntry(r.id);
  });
  row.addEventListener('contextmenu', (e) => openContextMenu(e, r, asSearch));
  if (r.is_dir && !asSearch && !showPath) {
    row.addEventListener('dblclick', () => {
      state.trail.push({ id: r.id, name: r.alias || r.name, rel: r.rel_path });
      loadListing();
    });
  }
  return row;
}

// ---- per-file flag (star / heart / …) -----------------------------------

const FLAG_EMOJIS = ['⭐', '❤️', '🔵', '🚩', '✅'];
let flagPop = null;

function makeFlagCell(r) {
  const cell = document.createElement('span');
  cell.className = 'flagcell' + (r.flag ? ' flagged' : '');
  cell.textContent = r.flag || '☆';
  cell.title = r.flag ? 'Change or clear flag' : 'Flag this file';
  cell.addEventListener('click', (e) => { e.stopPropagation(); openFlagPicker(cell, r); });
  return cell;
}

function openFlagPicker(anchor, r) {
  closeFlagPicker();
  const pop = document.createElement('div');
  pop.className = 'flag-pop';
  for (const emo of FLAG_EMOJIS) {
    const b = document.createElement('button');
    b.className = 'flag-opt' + (r.flag === emo ? ' active' : '');
    b.textContent = emo;
    b.addEventListener('click', (e) => { e.stopPropagation(); setRowFlag(r, emo === r.flag ? null : emo, anchor); closeFlagPicker(); });
    pop.appendChild(b);
  }
  const clr = document.createElement('button');
  clr.className = 'flag-opt flag-clear'; clr.textContent = '✕'; clr.title = 'Clear flag';
  clr.addEventListener('click', (e) => { e.stopPropagation(); setRowFlag(r, null, anchor); closeFlagPicker(); });
  pop.appendChild(clr);

  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8) + 'px';
  pop.style.top = (rect.bottom + 4) + 'px';
  flagPop = pop;
  setTimeout(() => document.addEventListener('mousedown', onFlagOutside), 0);
}
function onFlagOutside(e) { if (flagPop && !flagPop.contains(e.target)) closeFlagPicker(); }
function closeFlagPicker() {
  if (flagPop) { flagPop.remove(); flagPop = null; document.removeEventListener('mousedown', onFlagOutside); }
}
async function setRowFlag(r, flag, cell) {
  await api.setFlag(r.id, flag).catch(() => {});
  r.flag = flag || null;
  if (cell) { cell.textContent = flag || '☆'; cell.classList.toggle('flagged', !!flag); }
  document.querySelectorAll(`.row[data-id="${r.id}"] .flagcell, .grow[data-id="${r.id}"] .flagcell`).forEach(c => {
    c.textContent = flag || '☆'; c.classList.toggle('flagged', !!flag);
  });
  if (state.selectedEntry && state.selectedEntry.id === r.id) state.selectedEntry.flag = r.flag;
  if (state.tab === 'starred') loadStarred();   // keep the Starred tab in sync
}

// ---- right-click context menu (file rows in any view) --------------------

let ctxMenu = null;
function openContextMenu(e, r, asSearch) {
  e.preventDefault();
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';

  // quick flag row
  const flags = document.createElement('div');
  flags.className = 'ctx-flags';
  for (const emo of FLAG_EMOJIS) {
    const b = document.createElement('button');
    b.className = 'ctx-flag' + (r.flag === emo ? ' active' : '');
    b.textContent = emo;
    b.addEventListener('click', () => { setRowFlag(r, emo === r.flag ? null : emo); closeContextMenu(); });
    flags.appendChild(b);
  }
  const clr = document.createElement('button');
  clr.className = 'ctx-flag'; clr.textContent = '✕'; clr.title = 'Clear flag';
  clr.addEventListener('click', () => { setRowFlag(r, null); closeContextMenu(); });
  flags.appendChild(clr);
  menu.appendChild(flags);

  const item = (label, fn, danger) => {
    const it = document.createElement('button');
    it.className = 'ctx-item' + (danger ? ' danger' : '');
    it.textContent = label;
    it.addEventListener('click', async () => { closeContextMenu(); await fn(); });
    menu.appendChild(it);
  };
  const sep = () => { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); };

  item('Details', () => selectEntry(r.id));
  if (!r.is_dir) {
    item('Open', async () => {
      const res = await api.openFile(r.id);
      if (!res || !res.ok) toast(res && res.error ? res.error : 'Could not open the file.', true);
    });
    item('Open with…', async () => {
      const res = await api.openFileWith(r.id);
      if (!res || !res.ok) toast(res && res.error ? res.error : 'Could not open the file.', true);
    });
  }
  item('Locate on disk', async () => {
    const res = await api.revealInExplorer(r.id);
    if (!res || !res.ok) toast(res && res.error ? res.error : 'Could not open the location.', true);
  });
  sep();
  item('Copy to…', async () => { await selectEntry(r.id); startTransferFlow(false); });
  item('Move to…', async () => { await selectEntry(r.id); startTransferFlow(true); });
  item('Rename on disk…', async () => { await selectEntry(r.id); $('real-rename').click(); });
  sep();
  item('Delete…', async () => { await selectEntry(r.id); $('real-delete').click(); }, true);

  document.body.appendChild(menu);
  const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
  ctxMenu = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', onCtxOutside);
    document.addEventListener('keydown', onCtxEsc);
    window.addEventListener('blur', closeContextMenu, { once: true });
  }, 0);
}
function onCtxOutside(e) { if (ctxMenu && !ctxMenu.contains(e.target)) closeContextMenu(); }
function onCtxEsc(e) { if (e.key === 'Escape') closeContextMenu(); }
function closeContextMenu() {
  if (!ctxMenu) return;
  ctxMenu.remove(); ctxMenu = null;
  document.removeEventListener('mousedown', onCtxOutside);
  document.removeEventListener('keydown', onCtxEsc);
}

// Gallery view: a list like the others, but each row has a large thumbnail.
function renderGallery(rows) {
  const listing = $('listing');
  listing.classList.add('gallery');
  if (!rows.length) {
    listing.innerHTML = '';
    if (listing._lazyScroll) { listing.removeEventListener('scroll', listing._lazyScroll); listing._lazyScroll = null; }
    const e = document.createElement('div');
    e.className = 'listing-empty';
    e.textContent = 'This drive has no files.';
    listing.appendChild(e);
    return;
  }
  const volId = state.activeVolumeId;
  lazyRender(listing, rows, (r) => {
    const row = document.createElement('div');
    row.className = 'grow';
    row.dataset.id = r.id;
    if (state.selectedEntry && state.selectedEntry.id === r.id) row.classList.add('selected');

    const flag = makeFlagCell(r);

    const thumb = document.createElement('div');
    thumb.className = 'gthumb-lg ic';
    thumb.innerHTML = iconFor(r.is_dir, r.ext);
    if (isVideoExt(r.ext)) { thumb.classList.add('thumb'); wireThumb(thumb, volId, r.id); }
    else if (isImageExt(r.ext)) { thumb.classList.add('thumb'); wireImageThumb(thumb, volId, r.id); }

    const label = document.createElement('div');
    label.className = 'label';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = r.alias || r.name;
    if (r.note) { const dot = document.createElement('span'); dot.className = 'note-dot'; dot.title = 'Has notes'; nm.appendChild(dot); }
    const sub = document.createElement('div');
    sub.className = 'sub sub-link';
    sub.textContent = r.rel_path;
    sub.title = 'Open this folder';
    sub.addEventListener('click', (e) => { e.stopPropagation(); navigateToFolder(r.parent_id ?? null); });
    label.append(nm, sub);
    appendTagChips(label, r);

    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = humanFileSize(r.size);

    if (multiMode) {
      row.classList.toggle('multi-selected', multiSel.has(r.id));
      row.append(makeMultiCheck(r, row), flag, thumb, label, sz);
    } else {
      row.append(flag, thumb, label, sz);
    }
    row.addEventListener('click', () => {
      if (multiMode) setMultiSelected(r.id, !multiSel.has(r.id), row);
      else selectEntry(r.id);
    });
    row.addEventListener('contextmenu', (e) => openContextMenu(e, r, false));
    return row;
  });
}

// Lazily load a video thumbnail; on hover, generate-if-needed and play the
// ~10s preview clip in place. Falls back to the video icon if anything fails.
function wireThumb(slot, volId, id, ext) {
  const img = document.createElement('img');
  img.className = 'thumb-img';
  img.loading = 'lazy';
  img.src = thumbUrl(volId, id);
  img.onload = () => slot.classList.add('thumbed');
  img.onerror = () => { img.remove(); };
  slot.appendChild(img);

  let vid = null;
  let ensuring = false;

  slot.addEventListener('mouseenter', async () => {
    if (!state.ffmpegReady) return;
    if (!slot.classList.contains('thumbed') && !ensuring) {
      ensuring = true;
      slot.classList.add('thumb-loading');
      const res = await api.ensureThumb(id).catch(() => null);
      slot.classList.remove('thumb-loading');
      ensuring = false;
      if (res && res.ok) {
        if (!slot.querySelector('.thumb-img')) {
          const fresh = document.createElement('img');
          fresh.className = 'thumb-img';
          fresh.src = thumbUrl(volId, id) + '?t=' + Date.now();
          fresh.onload = () => slot.classList.add('thumbed');
          slot.insertBefore(fresh, slot.firstChild);
        }
      } else return;
    }
    if (!vid) {
      vid = document.createElement('video');
      vid.className = 'thumb-vid';
      vid.muted = true; vid.loop = true; vid.autoplay = true; vid.playsInline = true;
      vid.src = previewUrl(volId, id) + '?t=' + Date.now();
      slot.appendChild(vid);
      vid.play().catch(() => {});
    }
  });
  slot.addEventListener('mouseleave', () => {
    if (vid) { vid.pause(); vid.remove(); vid = null; }
  });
}

// Image rows: load the cached thumbnail; generate it on first hover if missing.
function wireImageThumb(slot, volId, id) {
  const img = document.createElement('img');
  img.className = 'thumb-img';
  img.loading = 'lazy';
  img.src = thumbUrl(volId, id);
  img.onload = () => slot.classList.add('thumbed');
  img.onerror = () => { img.remove(); };
  slot.appendChild(img);

  let ensuring = false;
  slot.addEventListener('mouseenter', async () => {
    if (slot.classList.contains('thumbed') || ensuring || !state.ffmpegReady) return;
    ensuring = true;
    slot.classList.add('thumb-loading');
    const res = await api.ensureThumb(id).catch(() => null);
    slot.classList.remove('thumb-loading');
    ensuring = false;
    if (res && res.ok) {
      const fresh = document.createElement('img');
      fresh.className = 'thumb-img';
      fresh.src = thumbUrl(volId, id) + '?t=' + Date.now();
      fresh.onload = () => slot.classList.add('thumbed');
      slot.insertBefore(fresh, slot.firstChild);
    }
  });
}

function markSelectedRow(id) {
  document.querySelectorAll('.row.selected').forEach(r => r.classList.remove('selected'));
  const row = document.querySelector(`.row[data-id="${id}"]`);
  if (row) row.classList.add('selected');
}

// ---- detail pane ---------------------------------------------------------

function clearDetail() {
  state.selectedEntry = null;
  $('detail-body').classList.add('hidden');
  $('detail-empty').classList.remove('hidden');
}

async function selectEntry(id) {
  const entry = await api.getEntry(id);
  if (!entry) { toast('That entry is no longer in the catalog.', true); return; }
  state.selectedEntry = entry;
  markSelectedRow(id);
  renderDetail(entry);
  if (entry.volume_id === state.activeVolumeId) revealTree(id);  // reveal in the rail tree
}

function renderDetail(entry) {
  $('detail-empty').classList.add('hidden');
  $('detail-body').classList.remove('hidden');

  $('detail-icon').innerHTML = iconFor(entry.is_dir, entry.ext);
  $('detail-name').textContent = entry.alias || entry.name;
  $('detail-path').textContent = entry.rel_path;

  renderMedia(entry);

  const meta = $('detail-meta');
  meta.innerHTML = '';
  const rows = [
    ['Type', entry.is_dir ? 'Folder' : (entry.ext ? `.${entry.ext} file` : 'File')],
    !entry.is_dir && ['Size', humanFileSize(entry.size)],
    entry.is_dir && ['Contains', humanFileSize(entry.tree_size)],
    ['Modified', fmtDate(entry.mtime)],
    entry.alias && ['Real name', entry.name]
  ].filter(Boolean);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    meta.append(dt, dd);
  }

  // Reset the integrity-test control for the newly shown entry.
  const testBtn = $('test-file');
  testBtn.classList.toggle('hidden', !!entry.is_dir);
  testBtn.textContent = 'Verify file…';
  const testRes = $('test-result');
  testRes.className = 'test-result hidden';
  testRes.textContent = '';

  $('alias-input').value = entry.alias || '';
  $('note-input').value = entry.note || '';
  renderTags(entry);
}

// ---- tags ----------------------------------------------------------------

function parseTags(entry) {
  if (!entry || !entry.tags) return [];
  try { const a = JSON.parse(entry.tags); return Array.isArray(a) ? a : []; } catch { return []; }
}

function renderTags(entry) {
  const box = $('tags-box');
  box.innerHTML = '';
  const tags = parseTags(entry);
  for (const t of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = t;
    const x = document.createElement('button');
    x.className = 'tag-x'; x.textContent = '×'; x.title = 'Remove tag';
    x.addEventListener('click', () => removeTag(t));
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

async function addTag(name) {
  const e = state.selectedEntry;
  if (!e) return;
  name = name.trim();
  if (!name) return;
  const tags = parseTags(e);
  if (tags.some(t => t.toLowerCase() === name.toLowerCase())) return;
  tags.push(name);
  await commitTags(e, tags);
}

async function removeTag(name) {
  const e = state.selectedEntry;
  if (!e) return;
  await commitTags(e, parseTags(e).filter(t => t !== name));
}

async function commitTags(entry, tags) {
  const res = await api.setTags(entry.id, tags);
  entry.tags = res && res.tags && res.tags.length ? JSON.stringify(res.tags) : null;
  renderTags(entry);
  await loadTagVocab();
}

async function loadTagVocab() {
  try { state.tagVocab = await api.listTags(); } catch { state.tagVocab = []; }
  const dl = $('tag-vocab');
  dl.innerHTML = '';
  for (const t of state.tagVocab) {
    const o = document.createElement('option');
    o.value = t;
    dl.appendChild(o);
  }
}

function commitTagInput() {
  const input = $('tag-input');
  const val = input.value;
  if (!val.trim()) return;
  addTag(val);
  input.value = '';
  input.focus();
}

$('tag-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitTagInput();
  }
});
$('tag-add').addEventListener('click', commitTagInput);

// ---- multi-select (bulk tag / flag) --------------------------------------

// A selection checkbox for a file row / gallery card while in Select mode.
function makeMultiCheck(r, rowEl) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'multi-check';
  cb.checked = multiSel.has(r.id);
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => setMultiSelected(r.id, cb.checked, rowEl));
  return cb;
}

function setMultiSelected(id, on, rowEl) {
  if (on) multiSel.add(id); else multiSel.delete(id);
  if (rowEl) {
    rowEl.classList.toggle('multi-selected', on);
    const cb = rowEl.querySelector('.multi-check');
    if (cb) cb.checked = on;
  }
  updateBulkBar();
}

function clearMultiSel() {
  multiSel.clear();
  document.querySelectorAll('.row.multi-selected, .grow.multi-selected')
    .forEach(el => el.classList.remove('multi-selected'));
  document.querySelectorAll('.multi-check').forEach(cb => { cb.checked = false; });
  updateBulkBar();
}

function updateBulkBar() {
  const n = multiSel.size;
  $('bulk-count').textContent = `${n} selected`;
  const off = n === 0;
  $('bulk-tag-add').disabled = off;
  $('bulk-clear').disabled = off;
  document.querySelectorAll('#bulk-flags .bulk-flag').forEach(b => { b.disabled = off; });
}

function toggleMultiMode() {
  multiMode = !multiMode;
  $('file-select-toggle').classList.toggle('active', multiMode);
  $('bulk-bar').classList.toggle('hidden', !multiMode);
  if (!multiMode) multiSel.clear();
  updateBulkBar();
  loadListing();   // re-render rows with / without checkboxes
}

// Build the flag buttons in the bulk bar (FLAG_EMOJIS is defined above).
function renderBulkFlags() {
  const box = $('bulk-flags');
  box.innerHTML = '';
  for (const emo of FLAG_EMOJIS) {
    const b = document.createElement('button');
    b.className = 'bulk-flag'; b.textContent = emo; b.disabled = true;
    b.title = `Flag selected with ${emo}`;
    b.addEventListener('click', () => bulkSetFlag(emo));
    box.appendChild(b);
  }
  const clr = document.createElement('button');
  clr.className = 'bulk-flag'; clr.textContent = '☆'; clr.disabled = true;
  clr.title = 'Clear flag on selected';
  clr.addEventListener('click', () => bulkSetFlag(null));
  box.appendChild(clr);
}

async function bulkAddTag() {
  const input = $('bulk-tag-input');
  const tag = input.value.trim();
  if (!tag || multiSel.size === 0) return;
  const ids = [...multiSel];
  let changed = 0;
  try { changed = await api.addTagBulk(ids, tag); }
  catch (e) { toast('Failed to add tag: ' + (e.message || e), true); return; }
  input.value = '';
  await loadTagVocab();
  toast(`Tagged ${changed} file${changed === 1 ? '' : 's'} “${tag}”.`);
  await refreshAfterBulk(ids);
}

async function bulkSetFlag(flag) {
  if (multiSel.size === 0) return;
  const ids = [...multiSel];
  try { await api.setFlagBulk(ids, flag); }
  catch (e) { toast('Failed to set flag: ' + (e.message || e), true); return; }
  const n = ids.length;
  toast(flag ? `Flagged ${n} file${n === 1 ? '' : 's'}.` : `Cleared flag on ${n} file${n === 1 ? '' : 's'}.`);
  await refreshAfterBulk(ids);
}

// Re-render the listing so new tags/flags show; keep the selection so the user
// can apply several tags/flags in a row.
async function refreshAfterBulk(ids) {
  await loadListing();
  if (state.selectedEntry && ids.includes(state.selectedEntry.id)) {
    await selectEntry(state.selectedEntry.id);
  }
}

$('file-select-toggle').addEventListener('click', toggleMultiMode);
$('bulk-clear').addEventListener('click', clearMultiSel);
$('bulk-tag-add').addEventListener('click', bulkAddTag);
$('bulk-tag-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); bulkAddTag(); }
});
renderBulkFlags();

// Media preview in the detail pane. Videos: big thumbnail that plays the ~10s
// clip on hover. Images: just the thumbnail.
let mediaZoom = (() => { try { return Math.min(3, Math.max(1, parseFloat(localStorage.getItem('diskcorder-mediazoom')) || 1)); } catch { return 1; } })();
function setMediaZoom(z) {
  mediaZoom = Math.max(1, Math.min(3, Math.round(z * 100) / 100));
  try { localStorage.setItem('diskcorder-mediazoom', String(mediaZoom)); } catch { /* ignore */ }
  $('detail-media').style.setProperty('--media-zoom', mediaZoom);
}

function renderMedia(entry) {
  const box = $('detail-media');
  box.innerHTML = '';
  const video = !entry.is_dir && isVideoExt(entry.ext);
  const image = !entry.is_dir && isImageExt(entry.ext);
  if (!video && !image) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  // Zoom control (DaVinci-style magnifier − / +) to enlarge the preview.
  const zoomBar = document.createElement('div');
  zoomBar.className = 'media-zoom';
  const mag = document.createElement('span'); mag.className = 'media-zoom-ic'; mag.innerHTML = ICON.search;
  const zOut = document.createElement('button'); zOut.className = 'media-zoom-btn'; zOut.textContent = '−'; zOut.title = 'Smaller preview';
  const zIn = document.createElement('button'); zIn.className = 'media-zoom-btn'; zIn.textContent = '+'; zIn.title = 'Larger preview';
  zoomBar.append(mag, zOut, zIn);
  const applyZoom = () => box.style.setProperty('--media-zoom', mediaZoom);
  zOut.addEventListener('click', () => { setMediaZoom(mediaZoom - 0.25); });
  zIn.addEventListener('click', () => { setMediaZoom(mediaZoom + 0.25); });
  box.appendChild(zoomBar);
  applyZoom();

  const frame = document.createElement('div');
  frame.className = 'media-frame';
  const img = document.createElement('img');
  img.className = 'media-img';
  img.src = thumbUrl(entry.volume_id, entry.id) + '?t=' + Date.now();
  let hasThumb = false;
  img.onload = () => { hasThumb = true; frame.classList.add('ready'); };
  img.onerror = () => { img.remove(); };
  frame.appendChild(img);

  const hint = document.createElement('div');
  hint.className = 'media-hint';
  hint.innerHTML = video ? ICON.play + '<span>Hover to preview</span>'
                         : ICON.image + '<span>Image</span>';
  frame.appendChild(hint);

  // Ensure a thumbnail exists (covers images, and videos not yet generated).
  const ensure = async (msgEl) => {
    if (hasThumb || !state.ffmpegReady) return hasThumb;
    frame.classList.add('loading');
    const res = await api.ensureThumb(entry.id).catch(() => null);
    frame.classList.remove('loading');
    if (!res || !res.ok) {
      if (msgEl) msgEl.textContent = res && res.error === 'offline' ? 'Drive offline' : 'No preview';
      return false;
    }
    img.src = thumbUrl(entry.volume_id, entry.id) + '?t=' + Date.now();
    hasThumb = true; frame.classList.add('ready');
    return true;
  };

  // Build the still thumb up front for the clicked file — images and videos
  // alike — so the pane isn't empty while the user decides whether to hover.
  if (!hasThumb) ensure(hint.querySelector('span'));
  if (image) { box.appendChild(frame); return; }

  let vid = null;
  frame.addEventListener('mouseenter', async () => {
    if (!state.ffmpegReady) { hint.querySelector('span').textContent = 'ffmpeg unavailable'; return; }
    if (!(await ensure(hint.querySelector('span')))) return;
    if (!vid) {
      vid = document.createElement('video');
      vid.className = 'media-vid';
      vid.muted = true; vid.loop = true; vid.autoplay = true; vid.playsInline = true; vid.controls = false;
      vid.src = previewUrl(entry.volume_id, entry.id) + '?t=' + Date.now();
      frame.appendChild(vid);
      vid.play().catch(() => {});
    }
  });
  frame.addEventListener('mouseleave', () => { if (vid) { vid.pause(); vid.remove(); vid = null; } });

  box.appendChild(frame);
}

const saveAlias = debounce(async (id, value) => {
  await api.setAlias(id, value);
  if (state.selectedEntry && state.selectedEntry.id === id) state.selectedEntry.alias = value || null;
  refreshRow(id);
}, 400);

const saveNote = debounce(async (id, value) => {
  await api.setNote(id, value);
  if (state.selectedEntry && state.selectedEntry.id === id) state.selectedEntry.note = value || null;
  refreshRow(id);
}, 500);

// Update a single visible row's name/alias-tag/note-dot in place after a save.
function refreshRow(id) {
  const e = state.selectedEntry;
  if (!e || e.id !== id) return;
  const row = document.querySelector(`.row[data-id="${id}"]`);
  if (!row) return;
  const nm = row.querySelector('.nm');
  nm.textContent = e.alias || e.name;
  if (e.alias) {
    const tag = document.createElement('span');
    tag.className = 'alias-tag';
    tag.textContent = e.name;
    nm.appendChild(tag);
  }
  if (e.note) {
    const dot = document.createElement('span');
    dot.className = 'note-dot';
    dot.title = 'Has notes';
    nm.appendChild(dot);
  }
  markSelectedRow(id);
}

$('alias-input').addEventListener('input', (e) => {
  if (state.selectedEntry) saveAlias(state.selectedEntry.id, e.target.value.trim());
});
$('note-input').addEventListener('input', (e) => {
  if (state.selectedEntry) saveNote(state.selectedEntry.id, e.target.value);
});

// ---- on-disk rename ------------------------------------------------------

$('real-rename').addEventListener('click', async () => {
  const e = state.selectedEntry;
  if (!e) return;
  const newName = await promptModal({
    title: 'Rename on disk',
    sub: `${e.rel_path}\nThe drive must be connected — this changes the real ${e.is_dir ? 'folder' : 'file'}.`,
    value: e.name, confirmText: 'Rename', danger: true
  });
  if (newName == null || !newName.trim() || newName === e.name) return;

  const res = await api.realRename(e.id, newName.trim());
  if (!res || !res.ok) {
    toast(res && res.error ? res.error : 'Rename failed.', true);
    return;
  }
  toast(res.isDir ? 'Folder renamed on disk — child paths updated.' : 'Renamed on disk.');
  await loadRail();
  if (!state.searching) await loadListing();
  await selectEntry(e.id);
});

$('reveal-loc').addEventListener('click', async () => {
  const e = state.selectedEntry;
  if (!e) return;
  const res = await api.revealInExplorer(e.id);
  if (!res || !res.ok) toast(res && res.error ? res.error : 'Could not open the location.', true);
});

// Test the selected file for damage: ffmpeg decode for media, full read otherwise.
let fileTesting = false;
$('test-file').addEventListener('click', async () => {
  const e = state.selectedEntry;
  if (!e || e.is_dir) return;
  const btn = $('test-file');
  const box = $('test-result');
  if (fileTesting) { api.cancelFileTest(); return; }   // second click cancels

  fileTesting = true;
  btn.textContent = 'Cancel test';
  box.className = 'test-result testing';
  box.textContent = 'Testing… reading the file from the drive. Large files can take a while.';

  const testedId = e.id;
  const res = await api.testFile(e.id).catch(err => ({ status: 'error', detail: err.message }));
  fileTesting = false;
  btn.textContent = 'Test file for damage…';
  // Ignore the result if the user moved on to a different file meanwhile.
  if (!state.selectedEntry || state.selectedEntry.id !== testedId) return;
  renderTestResult(box, res);
});

function renderTestResult(box, res) {
  if (!res || res.status === 'canceled') {
    box.className = 'test-result hidden';
    box.textContent = '';
    if (res && res.status === 'canceled') toast('File test canceled.');
    return;
  }
  let cls = 'bad';
  const lines = [];
  switch (res.status) {
    case 'ok':
      cls = 'ok';
      lines.push('✓ No problems detected.');
      lines.push(res.method === 'ffmpeg'
        ? 'Decoded fully with ffmpeg — the streams are intact.'
        : `Read all ${humanFileSize(res.bytesRead)} from the drive without a read error.`);
      break;
    case 'damaged':
      lines.push('✗ This media looks damaged — ffmpeg hit decode errors:');
      if (res.ffmpegErrors) lines.push(res.ffmpegErrors);
      break;
    case 'unreadable':
      lines.push('✗ The drive returned an error while reading this file.');
      if (res.readError) lines.push(res.readError);
      if (res.bytesRead != null) lines.push(`Failed after ${humanFileSize(res.bytesRead)} of ${humanFileSize(res.expectedSize)}.`);
      break;
    case 'size-mismatch':
      cls = 'warn';
      lines.push('⚠ Readable, but the size on disk doesn’t match the catalog — it may be truncated or changed.');
      break;
    case 'missing':
      lines.push('✗ File not found on the connected drive.');
      break;
    case 'offline':
      lines.push('✗ Drive is not connected — connect it and try again.');
      break;
    default:
      lines.push('✗ ' + (res.detail || 'Test failed.'));
  }
  if (res.sizeMismatch && res.status !== 'size-mismatch') {
    lines.push(`Size on disk ${humanFileSize(res.sizeOnDisk)} vs catalog ${humanFileSize(res.expectedSize)}.`);
  }
  box.className = 'test-result ' + cls;
  box.innerHTML = '';
  lines.forEach((l, i) => {
    const d = document.createElement('div');
    d.textContent = l;
    if (i > 0) d.className = 'tr-detail';
    box.appendChild(d);
  });
}

$('real-delete').addEventListener('click', async () => {
  const e = state.selectedEntry;
  if (!e) return;
  const ok = await promptModal({
    title: `Delete “${e.alias || e.name}”?`,
    sub: `${e.rel_path}\nThis permanently deletes the real ${e.is_dir ? 'folder and everything in it' : 'file'} from disk. The drive must be connected.`,
    confirmText: 'Delete', input: false, danger: true
  });
  if (!ok) return;
  const res = await api.realDelete(e.id);
  if (!res || !res.ok) { toast(res && res.error ? res.error : 'Delete failed.', true); return; }
  toast(res.isDir ? 'Folder deleted from disk.' : 'Deleted from disk.');
  clearDetail();
  await loadRail();
  if (state.searching) runSearch($('search-input').value.trim());
  else await loadListing();
});

// ---- copy / move between drives ------------------------------------------

$('copy-to').addEventListener('click', () => startTransferFlow(false));
$('move-to').addEventListener('click', () => startTransferFlow(true));

async function startTransferFlow(move) {
  const e = state.selectedEntry;
  if (!e) return;
  const targets = await api.transferTargets(e.id);
  if (!targets.length) {
    toast('No other connected drive to ' + (move ? 'move' : 'copy') + ' to. Connect a destination drive first.', true);
    return;
  }
  const choice = await transferModal({ entry: e, targets, move });
  if (!choice) return;

  toast((move ? 'Moving ' : 'Copying ') + '“' + e.name + '”…');
  const res = await api.startTransfer({
    entryId: e.id, destVolumeId: choice.destVolumeId, move, conflict: choice.conflict
  });
  if (!res || !res.ok) {
    if (!res || !res.canceled) toast(res && res.error ? res.error : 'Transfer failed.', true);
    return;
  }
  if (res.status === 'skipped') { toast('Skipped — already exists at destination.'); return; }
  const destVol = state.volumes.find(v => v.id === choice.destVolumeId);
  const destName = destVol ? destVol.name : 'destination';
  toast((move ? 'Moved' : 'Copied') + ' to "' + destName + '" — open that drive to see it in the catalog.');
  if (move) { await loadRail(); if (!state.searching) await loadListing(); clearDetail(); }
}

// ---- thumbnail batch generation ------------------------------------------

async function generateThumbnails(v) {
  if (!state.reachable[v.id]) { toast('Connect “' + v.name + '” first.', true); return; }
  if (!state.ffmpegReady) { toast('ffmpeg not found — previews disabled.', true); return; }
  if (thumbsBusy) { toast('Preview generation is already running — see the bar below.'); return; }
  thumbsBusy = true;
  const drawer = showOp('thumbs', `Previews · ${v.name}`);
  const res = await api.generateThumbs(v.id, { previews: false }).catch(err => ({ ok: false, error: err.message }));
  hideOp(drawer);
  thumbsBusy = false;
  await refreshCoverage([v.id]);
  if (!res || !res.ok) { toast(res && res.error ? res.error : 'Preview generation failed.', true); }
  else if (res.total === 0) { toast('All previews are already up to date.'); }
  else {
    toast(res.canceled ? 'Preview generation paused.' : `Generated ${res.done} previews.`);
    if (v.id === state.activeVolumeId && !state.searching) await loadListing();
  }
  drainAutoThumbs(); // resume any auto work that was waiting
}

// ---- search --------------------------------------------------------------

const runSearch = debounce(async (term) => {
  if (!term) {
    state.searching = false;
    if (state.activeVolumeId != null) await loadListing();
    else clearBrowser();
    return;
  }
  state.searching = true;
  const scoped = $('scope-toggle').checked && state.activeVolumeId != null ? state.activeVolumeId : null;
  const results = await api.search(term, scoped);
  $('listing-empty').classList.add('hidden');
  $('breadcrumb').innerHTML =
    `<span class="crumb current">Search · ${results.length} result${results.length === 1 ? '' : 's'}${scoped ? ' · this drive' : ''}</span>`;
  renderRows(results, true);
}, 220);

$('search-input').addEventListener('input', (e) => runSearch(e.target.value.trim()));
$('scope-toggle').addEventListener('change', () => runSearch($('search-input').value.trim()));

// ---- map / re-scan a drive ----------------------------------------------

$('map-drive').addEventListener('click', () => mapDrive(null));
$('import-drive').addEventListener('click', () => importVolume());

// Info / help modal
$('info-btn').addEventListener('click', () => $('info-modal').classList.remove('hidden'));
$('info-close').addEventListener('click', () => $('info-modal').classList.add('hidden'));
$('info-modal').addEventListener('click', (e) => { if (e.target.id === 'info-modal') $('info-modal').classList.add('hidden'); });

let scanning = false;

async function mapDrive(existingVol) {
  if (scanning) return;
  const picked = await api.pickDrive();
  if (!picked) return;

  const name = await promptModal({
    title: existingVol ? 'Relocate drive' : 'Name this drive',
    sub: picked.root,
    value: existingVol ? existingVol.name : (picked.suggestedName || ''),
    confirmText: existingVol ? 'Relocate' : 'Map it'
  });
  if (name == null || !name.trim()) return;

  scanning = true;
  $('map-drive').disabled = true;
  showScan(true);
  if (existingVol) $('scan-title').textContent = `Relocating ${existingVol.name}…`;
  const unsub = api.onScanProgress(({ count, current }) => {
    $('scan-count').textContent = `${count.toLocaleString()} items`;
    $('scan-current').textContent = current || '';
  });

  try {
    const res = await api.scanDrive({
      root: picked.root,
      name: name.trim(),
      existingVolumeId: existingVol ? existingVol.id : null
    });
    if (res && res.canceled) { toast('Mapping canceled.'); return; }
    if (!res || !res.ok) {
      toast(res && res.error ? res.error : 'Scan failed.', true);
      return;
    }
    await loadRail();
    const vol = state.volumes.find(v => v.id === res.volumeId);
    if (vol) await openVolume(vol);
    const skipNote = res.skipped ? ` (${res.skipped} unreadable item${res.skipped === 1 ? '' : 's'} skipped)` : '';
    toast((existingVol ? 'Drive relocated and updated.' : 'Drive mapped.') + skipNote);
    // Kick off thumbnail generation in the background (stills only — hover
    // preview clips are made on demand). Resumable and skips existing work.
    if (vol && state.ffmpegReady) queueAutoThumbs(vol.id);
  } catch (err) {
    toast(err.message || 'Scan failed.', true);
  } finally {
    unsub();
    showScan(false);
    scanning = false;
    $('map-drive').disabled = false;
  }
}

// Sync = re-scan in place from the drive's saved location (no folder picker),
// reconciling the catalog with what's actually on the disk now. Removed files
// drop out, new files appear; notes/labels/tags are preserved by path.
async function syncDrive(v, auto = false) {
  if (scanning) return;
  if (!state.reachable[v.id] || !v.root_path) {
    if (!auto) toast('Connect “' + v.name + '” to update its catalog.', true);
    return;
  }
  const before = v.file_count || 0;

  scanning = true;
  $('map-drive').disabled = true;
  showScan(true);
  $('scan-title').textContent = `Updating ${v.name}…`;
  const unsub = api.onScanProgress(({ count, current }) => {
    $('scan-count').textContent = `${count.toLocaleString()} items`;
    $('scan-current').textContent = current || '';
  });

  try {
    const res = await api.scanDrive({ root: v.root_path, name: v.name, existingVolumeId: v.id });
    if (res && res.canceled) { if (!auto) toast('Update canceled.'); return; }
    if (!res || !res.ok) { toast(res && res.error ? res.error : 'Update failed.', true); return; }
    await loadRail();
    const vol = state.volumes.find(x => x.id === res.volumeId) || v;
    const delta = (vol.file_count || 0) - before;
    const deltaStr = delta === 0 ? 'no changes' : `${delta > 0 ? '+' : ''}${delta.toLocaleString()} files`;
    toast(`Updated “${vol.name}” — ${(vol.file_count || 0).toLocaleString()} files (${deltaStr}).`);
    // Entry ids changed, so reopen at the root to avoid a stale breadcrumb trail.
    if (vol.id === state.activeVolumeId) await openVolume(vol);
    if (vol && state.ffmpegReady) queueAutoThumbs(vol.id);   // thumbnail any new media
  } catch (err) {
    toast(err.message || 'Update failed.', true);
  } finally {
    unsub();
    showScan(false);
    scanning = false;
    $('map-drive').disabled = false;
  }
}

// ---- backup to another drive ---------------------------------------------

const ROOT_FILES = ' root-files';   // sentinel for the "files in drive root" row

async function openBackup(v) {
  if (!state.reachable[v.id]) { toast('Connect “' + v.name + '” first.', true); return; }
  const dests = state.volumes.filter(x => x.id !== v.id && state.reachable[x.id]);
  if (!dests.length) { toast('Connect another drive to back up to.', true); return; }

  const backdrop = $('backup-modal');
  const destSel = $('backup-dest');
  const foldersBox = $('backup-folders');
  const progress = $('backup-progress');
  const startBtn = $('backup-start');
  const cancelBtn = $('backup-cancel');

  $('backup-title').textContent = `Back up “${v.name}”`;
  $('backup-sub').textContent = 'Copies new and changed files into a folder named after this drive. Nothing at the destination is deleted.';
  destSel.disabled = false;
  destSel.innerHTML = '';
  for (const d of dests) {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = (d.icon ? d.icon + ' ' : '') + d.name;
    destSel.appendChild(o);
  }

  foldersBox.innerHTML = '<div class="backup-loading">Loading folders…</div>';
  const kids = await api.getChildren(v.id, null).catch(() => []);
  const topFolders = kids.filter(k => k.is_dir);
  const rootFiles = kids.filter(k => !k.is_dir);
  foldersBox.innerHTML = '';
  const addRow = (label, value) => {
    const lab = document.createElement('label');
    lab.className = 'backup-folder';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = value; cb.checked = true;
    const span = document.createElement('span'); span.textContent = label;
    lab.append(cb, span); foldersBox.appendChild(lab);
  };
  if (!topFolders.length && !rootFiles.length) foldersBox.innerHTML = '<div class="backup-loading">This drive is empty.</div>';
  for (const f of topFolders) addRow('📁 ' + (f.alias || f.name), f.rel_path);
  if (rootFiles.length) addRow(`🗎 Files in the drive root (${rootFiles.length})`, ROOT_FILES);

  progress.classList.add('hidden');
  progress.classList.remove('active');
  startBtn.disabled = false; startBtn.textContent = 'Start backup';
  cancelBtn.textContent = 'Cancel';
  backdrop.classList.remove('hidden');

  let unsub = null, running = false;

  function collectItems() {
    const items = [];
    foldersBox.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
      if (cb.value === ROOT_FILES) for (const rf of rootFiles) items.push(rf.rel_path);
      else items.push(cb.value);
    });
    return items;
  }
  function showStats(p) {
    $('backup-stats').textContent =
      `${(p.copied || 0).toLocaleString()} copied · ${humanFileSize(p.copiedBytes || 0)} · ` +
      `${(p.skipped || 0).toLocaleString()} skipped` + (p.errors ? ` · ${p.errors} errors` : '');
  }

  async function start() {
    const items = collectItems();
    if (!items.length) { toast('Pick at least one folder to back up.', true); return; }
    running = true;
    startBtn.disabled = true; destSel.disabled = true;
    foldersBox.querySelectorAll('input').forEach(i => i.disabled = true);
    progress.classList.remove('hidden');
    progress.classList.add('active');
    showStats({});
    $('backup-current').textContent = 'Scanning…';
    cancelBtn.textContent = 'Cancel';

    unsub = api.onBackupProgress((p) => {
      showStats(p);
      $('backup-current').textContent = p.finished ? 'Finishing…' : (p.current ? 'Copying ' + p.current : 'Working…');
    });
    const destName = destSel.options[destSel.selectedIndex].textContent;
    const res = await api.startBackup({ srcVolumeId: v.id, destVolumeId: Number(destSel.value), items })
      .catch(e => ({ ok: false, error: e.message }));
    if (unsub) { unsub(); unsub = null; }
    running = false;
    progress.classList.remove('active');

    if (!res || (!res.ok && !res.canceled)) {
      $('backup-current').textContent = '';
      toast(res && res.error ? res.error : 'Backup failed.', true);
    } else if (res.canceled) {
      $('backup-current').textContent = 'Canceled.';
      toast('Backup canceled.');
    } else {
      showStats(res);
      $('backup-current').textContent =
        `Done — ${res.copied.toLocaleString()} copied, ${res.skipped.toLocaleString()} unchanged` +
        (res.errors ? `, ${res.errors} errors` : '') + '.';
      toast(`Backed up ${res.copied.toLocaleString()} file${res.copied === 1 ? '' : 's'} (${humanFileSize(res.copiedBytes)}) to “${destName}”.`, !!res.errors);
    }
    startBtn.disabled = false; startBtn.textContent = 'Back up again';
    destSel.disabled = false;
    foldersBox.querySelectorAll('input').forEach(i => i.disabled = false);
    cancelBtn.textContent = 'Close';
  }

  function onCancelOrClose() {
    if (running) { api.cancelBackup(); cancelBtn.textContent = 'Canceling…'; return; }
    cleanup();
  }
  function cleanup() {
    if (running) api.cancelBackup();
    if (unsub) { unsub(); unsub = null; }
    backdrop.classList.add('hidden');
    startBtn.removeEventListener('click', start);
    cancelBtn.removeEventListener('click', onCancelOrClose);
    backdrop.removeEventListener('mousedown', onBackdrop);
    document.removeEventListener('keydown', onEsc);
  }
  const onBackdrop = (e) => { if (e.target === backdrop && !running) cleanup(); };
  const onEsc = (e) => { if (e.key === 'Escape' && !running) cleanup(); };
  startBtn.addEventListener('click', start);
  cancelBtn.addEventListener('click', onCancelOrClose);
  backdrop.addEventListener('mousedown', onBackdrop);
  document.addEventListener('keydown', onEsc);
}

// ---- backup tab (saved actions + run logs) -------------------------------

$('backup-new').addEventListener('click', () => openJobForm(null));
$('logdetail-close').addEventListener('click', () => $('logdetail-modal').classList.add('hidden'));
$('logdetail-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'logdetail-modal') $('logdetail-modal').classList.add('hidden'); });

async function loadBackupTab() {
  await renderBackupJobs();
  await renderBackupLog();
}

async function renderBackupJobs() {
  const box = $('backup-jobs');
  const jobs = await api.listBackupJobs().catch(() => []);
  box.innerHTML = '';
  if (!jobs.length) {
    box.innerHTML = '<div class="backup-empty">No backup actions yet. Click “New backup” to create one — pick a source folder (a drive, a phone folder, anything) and where to copy it.</div>';
    return;
  }
  for (const job of jobs) box.appendChild(buildJobCard(job));
}

let backupRunning = false, runningJobId = null;

function buildJobCard(job) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.dataset.id = job.id;

  const top = document.createElement('div');
  top.className = 'job-top';
  const nm = document.createElement('div'); nm.className = 'job-name'; nm.textContent = job.name;
  const acts = document.createElement('div'); acts.className = 'job-acts';
  const runB = document.createElement('button'); runB.className = 'btn btn-primary mini-btn'; runB.textContent = 'Run';
  const editB = document.createElement('button'); editB.className = 'btn btn-ghost mini-btn'; editB.textContent = 'Edit';
  const delB = document.createElement('button'); delB.className = 'btn btn-ghost-danger mini-btn'; delB.textContent = 'Delete';
  acts.append(runB, editB, delB);
  top.append(nm, acts);

  const paths = document.createElement('div');
  paths.className = 'job-paths';
  const s = document.createElement('span'); s.className = 'job-src'; s.textContent = job.source; s.title = job.source;
  const a = document.createElement('span'); a.className = 'job-arrow'; a.textContent = '→';
  const d = document.createElement('span'); d.className = 'job-dst'; d.textContent = job.dest; d.title = job.dest;
  paths.append(s, a, d);

  const last = document.createElement('div');
  last.className = 'job-last';
  last.textContent = job.lastRun
    ? `Last run ${fmtDate(job.lastRun.when)} — ${job.lastRun.copied.toLocaleString()} copied, ${job.lastRun.skipped.toLocaleString()} unchanged` + (job.lastRun.errors ? `, ${job.lastRun.errors} errors` : '')
    : 'Never run';

  const prog = document.createElement('div');
  prog.className = 'job-prog hidden';
  prog.innerHTML = `<div class="backup-bar"><div class="backup-bar-fill"></div></div><div class="job-prog-text"></div>`;

  card.append(top, paths, last, prog);

  runB.addEventListener('click', () => {
    if (backupRunning) { if (runningJobId === job.id) api.cancelBackup(); else toast('A backup is already running.'); return; }
    runJob(job, card, runB);
  });
  editB.addEventListener('click', () => { if (!backupRunning) openJobForm(job); });
  delB.addEventListener('click', async () => {
    if (backupRunning) return;
    const ok = await promptModal({ title: `Delete “${job.name}”?`, sub: 'Removes this backup action. Files already backed up are left untouched.', confirmText: 'Delete', input: false, danger: true });
    if (!ok) return;
    await api.deleteBackupJob(job.id);
    renderBackupJobs();
  });
  return card;
}

async function runJob(job, card, runB) {
  backupRunning = true; runningJobId = job.id;
  const prog = card.querySelector('.job-prog');
  const ptext = card.querySelector('.job-prog-text');
  prog.classList.remove('hidden'); prog.classList.add('active');
  runB.textContent = 'Cancel'; runB.classList.remove('btn-primary'); runB.classList.add('btn-ghost-danger');
  ptext.textContent = 'Scanning…';

  const unsub = api.onBackupProgress((p) => {
    if (p.jobId && p.jobId !== job.id) return;
    ptext.textContent = (p.finished ? 'Finishing…' : (p.current ? 'Copying ' + p.current : 'Working…')) +
      ` · ${(p.copied || 0).toLocaleString()} copied · ${humanFileSize(p.copiedBytes || 0)} · ${(p.skipped || 0).toLocaleString()} skipped` +
      (p.errors ? ` · ${p.errors} err` : '');
  });
  const res = await api.runBackupPath({ source: job.source, dest: job.dest, name: job.name, jobId: job.id }).catch(e => ({ ok: false, error: e.message }));
  unsub();
  backupRunning = false; runningJobId = null;

  if (!res || (!res.ok && !res.canceled)) toast(res && res.error ? res.error : 'Backup failed.', true);
  else if (res.canceled) toast('Backup canceled.');
  else toast(`Backed up “${job.name}” — ${res.copied.toLocaleString()} copied, ${res.skipped.toLocaleString()} unchanged` + (res.errors ? `, ${res.errors} errors` : '') + '.', !!res.errors);

  await renderBackupJobs();
  await renderBackupLog();
}

function openJobForm(job) {
  const backdrop = $('jobform-modal');
  $('jobform-title').textContent = job ? 'Edit backup action' : 'New backup action';
  $('jobform-name').value = job ? job.name : '';
  $('jobform-source').value = job ? job.source : '';
  $('jobform-dest').value = job ? job.dest : '';
  backdrop.classList.remove('hidden');
  $('jobform-name').focus();

  const ps = $('jobform-pick-source'), pd = $('jobform-pick-dest'), saveB = $('jobform-save'), cancelB = $('jobform-cancel');
  const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
  const pickSrc = async () => {
    const p = await api.pickBackupFolder('Choose the folder to back up');
    if (p) { $('jobform-source').value = p; if (!$('jobform-name').value.trim()) $('jobform-name').value = baseName(p); }
  };
  const pickDst = async () => { const p = await api.pickBackupFolder('Choose where to back up to'); if (p) $('jobform-dest').value = p; };
  async function save() {
    const source = $('jobform-source').value.trim(), dest = $('jobform-dest').value.trim();
    const name = $('jobform-name').value.trim() || (source ? baseName(source) : 'Backup');
    if (!source || !dest) { toast('Pick a source and a destination folder.', true); return; }
    await api.saveBackupJob({ id: job ? job.id : null, name, source, dest, lastRun: job ? job.lastRun : null });
    cleanup();
    renderBackupJobs();
  }
  function cleanup() {
    backdrop.classList.add('hidden');
    ps.removeEventListener('click', pickSrc); pd.removeEventListener('click', pickDst);
    saveB.removeEventListener('click', save); cancelB.removeEventListener('click', cleanup);
    backdrop.removeEventListener('mousedown', onBd); document.removeEventListener('keydown', onEsc);
  }
  const onBd = (e) => { if (e.target === backdrop) cleanup(); };
  const onEsc = (e) => { if (e.key === 'Escape') cleanup(); };
  ps.addEventListener('click', pickSrc); pd.addEventListener('click', pickDst);
  saveB.addEventListener('click', save); cancelB.addEventListener('click', cleanup);
  backdrop.addEventListener('mousedown', onBd); document.addEventListener('keydown', onEsc);
}

async function renderBackupLog() {
  const box = $('backup-log');
  const idx = await api.backupLogIndex().catch(() => []);
  box.innerHTML = '';
  if (!idx.length) { box.innerHTML = '<div class="backup-empty">No backup runs yet.</div>'; return; }
  for (const r of idx.slice(0, 50)) {
    const row = document.createElement('div');
    row.className = 'log-row';
    const when = document.createElement('span'); when.className = 'log-when'; when.textContent = fmtDate(r.when);
    const name = document.createElement('span'); name.className = 'log-name'; name.textContent = r.name + (r.canceled ? ' (canceled)' : '');
    const st = document.createElement('span'); st.className = 'log-stats';
    st.textContent = `${r.copied.toLocaleString()} copied · ${r.skipped.toLocaleString()} unchanged` + (r.errors ? ` · ${r.errors} err` : '') + ` · ${humanFileSize(r.copiedBytes)}`;
    row.append(when, name, st);
    row.addEventListener('click', () => openLogDetail(r.runId));
    box.appendChild(row);
  }
}

async function openLogDetail(runId) {
  const d = await api.backupLogDetail(runId).catch(() => null);
  if (!d) { toast('That log is no longer available.', true); return; }
  $('logdetail-title').textContent = d.name + (d.canceled ? ' (canceled)' : '');
  $('logdetail-sub').textContent =
    `${fmtDate(d.when)} · ${d.source} → ${d.dest} · ${d.copied.toLocaleString()} copied, ${d.skipped.toLocaleString()} unchanged` + (d.errors ? `, ${d.errors} errors` : '');
  const box = $('logdetail-files');
  box.innerHTML = '';
  if (!d.files || !d.files.length) {
    box.innerHTML = '<div class="backup-empty">No files were copied in this run (everything was already up to date).</div>';
  } else {
    const frag = document.createDocumentFragment();
    for (const f of d.files) { const el = document.createElement('div'); el.className = 'logfile'; el.textContent = f; frag.appendChild(el); }
    box.appendChild(frag);
  }
  $('logdetail-modal').classList.remove('hidden');
}

// Per-drive "auto-sync on connect" preference, kept in localStorage.
function getAutoSync() {
  try { return JSON.parse(localStorage.getItem('diskcorder-autosync') || '{}'); } catch { return {}; }
}
function setAutoSync(id, on) {
  const m = getAutoSync();
  if (on) m[id] = true; else delete m[id];
  try { localStorage.setItem('diskcorder-autosync', JSON.stringify(m)); } catch { /* ignore */ }
}

// Sync (sequentially) any auto-sync drives that just became connected.
async function autoSyncConnected(ids) {
  const on = getAutoSync();
  for (const id of ids) {
    if (!on[id]) continue;
    const v = state.volumes.find(x => x.id === id);
    if (v && state.reachable[id]) await syncDrive(v, true);
  }
}

// Only one thumbnail pass runs at a time (the main process keeps a single set
// of pause/cancel controls), so auto and manual passes are serialized here.
let thumbsBusy = false;
const autoThumbQueue = [];

// Queue a drive for automatic thumbnail generation (on connect / after scan).
// Skips drives with no media or already-complete coverage so it stays cheap.
function queueAutoThumbs(volumeId) {
  if (!state.ffmpegReady || !state.reachable[volumeId]) return;
  const c = state.coverage[volumeId];
  if (c && c.total === 0) return;                 // nothing to thumbnail
  if (c && c.total && c.made >= c.total) return;  // already done
  if (!autoThumbQueue.includes(volumeId)) autoThumbQueue.push(volumeId);
  drainAutoThumbs();
}

async function drainAutoThumbs() {
  if (thumbsBusy) return;
  while (autoThumbQueue.length) {
    const id = autoThumbQueue.shift();
    const vol = state.volumes.find(v => v.id === id);
    if (!vol || !state.reachable[id]) continue;
    await autoThumbs(vol);
  }
}

// Background thumbnail pass (after a scan or on connect), surfaced in the ops drawer.
async function autoThumbs(vol) {
  if (thumbsBusy) return;
  thumbsBusy = true;
  const row = showOp('thumbs', `Thumbnails · ${vol.name}`);
  try {
    const res = await api.generateThumbs(vol.id, { previews: false });
    if (res && res.ok && res.total > 0 && vol.id === state.activeVolumeId && !state.searching) {
      await loadListing(); // reveal freshly-made thumbnails
    }
  } catch { /* non-fatal */ } finally {
    hideOp(row);
    thumbsBusy = false;
    await refreshCoverage([vol.id]);
  }
}

function showScan(on) {
  if (on) {
    $('scan-count').textContent = '0 items';
    $('scan-current').textContent = '';
    $('scan-title').textContent = 'Mapping drive…';
    $('scan-pause').textContent = 'Pause';
  }
  $('scan-overlay').classList.toggle('hidden', !on);
}

// Pause / resume / cancel the in-progress scan.
$('scan-pause').addEventListener('click', async () => {
  const btn = $('scan-pause');
  if (btn.textContent === 'Pause') {
    await api.pauseScan(); btn.textContent = 'Resume';
    $('scan-title').textContent = 'Paused';
  } else {
    await api.resumeScan(); btn.textContent = 'Pause';
    $('scan-title').textContent = 'Mapping drive…';
  }
});
$('scan-cancel').addEventListener('click', () => api.cancelScan());

// ---- bottom ops drawer (transfers + preview batches) ---------------------

function showOp(kind, label) {
  const drawer = $('ops-drawer');
  drawer.classList.remove('hidden');
  const row = document.createElement('div');
  row.className = 'op-row';
  row.innerHTML = `
    <span class="op-label"></span>
    <div class="op-bar"><div class="op-fill"></div></div>
    <span class="op-pct">…</span>`;
  row.querySelector('.op-label').textContent = label;
  // Thumbnail batches can be paused / resumed / canceled while they run.
  if (kind === 'thumbs') {
    const pause = document.createElement('button');
    pause.className = 'btn btn-ghost mini-btn op-ctl';
    pause.textContent = 'Pause';
    pause.addEventListener('click', async () => {
      if (pause.textContent === 'Pause') { await api.pauseThumbs(); pause.textContent = 'Resume'; }
      else { await api.resumeThumbs(); pause.textContent = 'Pause'; }
    });
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost-danger mini-btn op-ctl';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => api.cancelThumbs());
    row.append(pause, cancel);
  }
  drawer.appendChild(row);
  return row;
}
function hideOp(row) {
  if (row && row.parentNode) row.remove();
  const drawer = $('ops-drawer');
  if (!drawer.querySelector('.op-row')) drawer.classList.add('hidden');
}

api.onThumbProgress(({ done, total, current, finished, volumeId }) => {
  const drawer = $('ops-drawer');
  const row = drawer.querySelector('.op-row');
  if (row) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    row.querySelector('.op-fill').style.width = pct + '%';
    row.querySelector('.op-pct').textContent = `${done}/${total}`;
  }
  if (volumeId != null) updateThumbProg(volumeId, done, total, finished);
});

// Per-drive thumbnail-generation bar, shown in the rail card under the storage
// bar while a batch runs for that drive. Also drives the persistent coverage
// bar upward live (baseline made-count captured at batch start + done so far).
const thumbBase = {};
function updateThumbProg(volumeId, done, total, finished) {
  const card = document.querySelector(`.volume-card[data-id="${volumeId}"]`);
  if (!card) return;

  if (done === 0 && !finished) {
    thumbBase[volumeId] = (state.coverage[volumeId] && state.coverage[volumeId].made) || 0;
  }
  const cov = state.coverage[volumeId];
  if (cov && cov.total && !finished) {
    cov.made = Math.min(cov.total, (thumbBase[volumeId] || 0) + done);
    renderCoverage(card, volumeId);
  }

  const wrap = card.querySelector('.thumb-prog');
  const fill = card.querySelector('.thumb-prog-fill');
  const text = card.querySelector('.thumb-prog-text');
  if (!wrap || !fill) return;
  if (finished || !total) { wrap.classList.add('hidden'); fill.style.width = '0%'; return; }
  wrap.classList.remove('hidden');
  const pct = Math.round((done / total) * 100);
  fill.style.width = pct + '%';
  if (text) text.textContent = `generating ${done}/${total}`;
}

let activeTransferRow = null;
let activeOpId = null;
api.onTransferProgress(({ opId, name, copied, total, state: st, error }) => {
  if (st === 'start') {
    activeOpId = opId;
    activeTransferRow = showOp('transfer', 'Copying ' + name);
    const cancel = document.createElement('button');
    cancel.className = 'op-cancel';
    cancel.innerHTML = ICON.cancel;
    cancel.title = 'Cancel';
    cancel.addEventListener('click', () => api.cancelTransfer(opId));
    activeTransferRow.appendChild(cancel);
    return;
  }
  if (!activeTransferRow) return;
  if (st === 'progress') {
    const pct = total ? Math.round((copied / total) * 100) : 0;
    activeTransferRow.querySelector('.op-fill').style.width = pct + '%';
    activeTransferRow.querySelector('.op-pct').textContent = pct + '%';
  } else {
    // done / skipped / error
    hideOp(activeTransferRow);
    activeTransferRow = null; activeOpId = null;
  }
});

// ---- reusable prompt / confirm modal ------------------------------------
// Electron has no window.prompt; this drives the #name-modal markup for both
// text entry (input:true -> resolves string|null) and confirmation
// (input:false -> resolves boolean).

function promptModal({ title, sub = '', value = '', confirmText = 'OK', input = true, danger = false }) {
  return new Promise((resolve) => {
    const backdrop = $('name-modal');
    const inputEl = $('name-modal-input');
    const confirmBtn = $('name-modal-confirm');
    const cancelBtn = $('name-modal-cancel');

    $('name-modal-title').textContent = title;
    $('name-modal-sub').textContent = sub;
    $('name-modal-sub').classList.toggle('hidden', !sub);

    inputEl.classList.toggle('hidden', !input);
    if (input) inputEl.value = value;

    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle('btn-danger', !!danger);

    backdrop.classList.remove('hidden');
    if (input) { inputEl.focus(); inputEl.select(); }
    else confirmBtn.focus();

    function cleanup(result) {
      backdrop.classList.add('hidden');
      confirmBtn.classList.remove('btn-danger');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      inputEl.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onEsc);
      backdrop.removeEventListener('mousedown', onBackdrop);
      resolve(result);
    }
    const onConfirm = () => cleanup(input ? inputEl.value : true);
    const onCancel = () => cleanup(input ? null : false);
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); onConfirm(); } };
    const onEsc = (e) => { if (e.key === 'Escape') onCancel(); };
    const onBackdrop = (e) => { if (e.target === backdrop) onCancel(); };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    if (input) inputEl.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onEsc);
    backdrop.addEventListener('mousedown', onBackdrop);
  });
}

// Transfer destination chooser. Resolves { destVolumeId, conflict } or null.
function transferModal({ entry, targets, move }) {
  return new Promise((resolve) => {
    const backdrop = $('xfer-modal');
    const sel = $('xfer-dest');
    const confirmBtn = $('xfer-confirm');
    const cancelBtn = $('xfer-cancel');

    $('xfer-title').textContent = (move ? 'Move' : 'Copy') + ' to drive';
    $('xfer-sub').textContent = `${entry.name} · ${humanFileSize(entry.size)}`;
    confirmBtn.textContent = move ? 'Move' : 'Copy';
    confirmBtn.classList.toggle('btn-danger', !!move);

    sel.innerHTML = '';
    for (const t of targets) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = `${t.name}  (${t.root_path})`;
      sel.appendChild(o);
    }

    backdrop.classList.remove('hidden');
    confirmBtn.focus();

    function cleanup(result) {
      backdrop.classList.add('hidden');
      confirmBtn.classList.remove('btn-danger');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onEsc);
      backdrop.removeEventListener('mousedown', onBackdrop);
      resolve(result);
    }
    const onConfirm = () => cleanup({
      destVolumeId: Number(sel.value),
      conflict: backdrop.querySelector('input[name="xfer-conflict"]:checked').value
    });
    const onCancel = () => cleanup(null);
    const onEsc = (e) => { if (e.key === 'Escape') onCancel(); };
    const onBackdrop = (e) => { if (e.target === backdrop) onCancel(); };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onEsc);
    backdrop.addEventListener('mousedown', onBackdrop);
  });
}

// ---- tabs: Files | Space map ---------------------------------------------

$('tab-files').addEventListener('click', () => switchTab('files'));
$('tab-starred').addEventListener('click', () => switchTab('starred'));
$('tab-large').addEventListener('click', () => switchTab('large'));
$('tab-space').addEventListener('click', () => switchTab('space'));
$('tab-dupes').addEventListener('click', () => switchTab('dupes'));
$('tab-test').addEventListener('click', () => switchTab('test'));
$('tab-backup').addEventListener('click', () => switchTab('backup'));

function switchTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  for (const t of ['files', 'starred', 'large', 'space', 'dupes', 'test', 'backup']) {
    $('tab-' + t).classList.toggle('active', tab === t);
    $('view-' + t).classList.toggle('hidden', tab !== t);
  }
  saveSession();
  if (tab === 'starred') loadStarred();
  if (tab === 'test') initTestTab();
  if (tab === 'backup') loadBackupTab();
  if (tab === 'space') {
    if (!state.tmTrail.length && state.activeVolumeId != null) {
      const v = state.volumes.find(x => x.id === state.activeVolumeId);
      state.tmTrail = [{ id: null, name: v ? v.name : 'Drive' }];
    }
    tmLoadLevel(state.tmTrail.length ? state.tmTrail[state.tmTrail.length - 1].id : null);
  } else if (tab === 'dupes') {
    renderDupeDrivePicker();
    loadDuplicates();
  } else if (tab === 'large') {
    loadLargeFiles();
  }
}

// ---- large files ---------------------------------------------------------

['large-min', 'large-from', 'large-to', 'large-limit', 'large-sort', 'large-group-year'].forEach(id =>
  $(id).addEventListener('change', loadLargeFiles));
$('large-reset').addEventListener('click', () => {
  $('large-min').value = '0';
  $('large-from').value = '';
  $('large-to').value = '';
  $('large-limit').value = '100';
  $('large-sort').value = 'size';
  $('large-group-year').checked = false;
  loadLargeFiles();
});

function sortLarge(rows) {
  const key = $('large-sort').value;
  rows.sort((a, b) => {
    switch (key) {
      case 'date':     return String(b.mtime || '').localeCompare(String(a.mtime || ''));   // newest first
      case 'date-asc': return String(a.mtime || '').localeCompare(String(b.mtime || ''));   // oldest first
      case 'type': {
        const ca = tmCategory(a), cb = tmCategory(b);
        return ca !== cb ? ca.localeCompare(cb)
          : (a.ext || '').localeCompare(b.ext || '') || (b.size || 0) - (a.size || 0);
      }
      case 'name':     return (a.alias || a.name || '').toLowerCase().localeCompare((b.alias || b.name || '').toLowerCase());
      default:         return (b.size || 0) - (a.size || 0);                                 // largest first
    }
  });
}

const yearOf = (mtime) => { const d = mtime ? new Date(mtime) : null; return (d && !isNaN(d)) ? d.getFullYear() : null; };

async function loadLargeFiles() {
  const list = $('large-list');
  const summary = $('large-summary');
  if (state.activeVolumeId == null) {
    list.innerHTML = '';
    summary.textContent = 'Open a drive to see its largest files.';
    return;
  }
  const minSize = Number($('large-min').value) || 0;
  const limit = Number($('large-limit').value) || 100;
  const from = $('large-from').value;   // 'YYYY-MM-DD' or ''
  const to = $('large-to').value;
  const opts = { limit };
  if (minSize) opts.minSize = minSize;
  if (from) opts.after = from + 'T00:00:00.000Z';
  if (to) opts.before = to + 'T23:59:59.999Z';

  const rows = await api.largeFiles(state.activeVolumeId, opts).catch(() => []);
  sortLarge(rows);

  if (!rows.length) {
    list.innerHTML = '';
    if (list._lazyScroll) { list.removeEventListener('scroll', list._lazyScroll); list._lazyScroll = null; }
    summary.textContent = 'No files match these filters.';
    return;
  }

  // Build a flat render list (optionally with year-header items) and lazy-render.
  const items = $('large-group-year').checked
    ? groupLargeByYear(rows)
    : rows.map((r, i) => ({ row: r, rank: i + 1 }));
  lazyRender(list, items, (it) => it.head ? buildYearHead(it) : buildLargeRow(it.row, it.rank));

  const totalBytes = rows.reduce((n, r) => n + (r.size || 0), 0);
  summary.textContent = `${rows.length.toLocaleString()} file${rows.length === 1 ? '' : 's'} · ${humanFileSize(totalBytes)}`;
}

// Flatten rows into header + row items grouped by year (years newest-first).
function groupLargeByYear(rows) {
  const groups = new Map();
  for (const r of rows) {
    const y = yearOf(r.mtime);
    const key = y == null ? 'Unknown date' : y;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 'Unknown date') return 1;
    if (b === 'Unknown date') return -1;
    return b - a;
  });
  const items = [];
  for (const key of keys) {
    const arr = groups.get(key);
    items.push({ head: true, year: key, count: arr.length, bytes: arr.reduce((n, r) => n + (r.size || 0), 0) });
    arr.forEach((r, i) => items.push({ row: r, rank: i + 1 }));
  }
  return items;
}

function buildYearHead(it) {
  const head = document.createElement('div');
  head.className = 'lg-year-head';
  head.innerHTML = `<span></span><span class="lg-year-meta">${it.count} file${it.count === 1 ? '' : 's'} · ${humanFileSize(it.bytes)}</span>`;
  head.firstChild.textContent = it.year;
  return head;
}

function buildLargeRow(r, rank) {
  const volId = state.activeVolumeId;
  const row = document.createElement('div');
  row.className = 'row large-row';
  row.dataset.id = r.id;
  if (state.selectedEntry && state.selectedEntry.id === r.id) row.classList.add('selected');

  const flag = makeFlagCell(r);

  const rankEl = document.createElement('span');
  rankEl.className = 'lg-rank';
  rankEl.textContent = rank;

  const icon = document.createElement('span');
  icon.className = 'ic';
  icon.innerHTML = iconFor(0, r.ext);
  if (isVideoExt(r.ext)) { icon.classList.add('thumb'); wireThumb(icon, volId, r.id); }
  else if (isImageExt(r.ext)) { icon.classList.add('thumb'); wireImageThumb(icon, volId, r.id); }

  const label = document.createElement('div');
  label.className = 'label';
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = r.alias || r.name;
  if (r.note) { const dot = document.createElement('span'); dot.className = 'note-dot'; dot.title = 'Has notes'; nm.appendChild(dot); }
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = r.rel_path;
  label.append(nm, sub);

  const date = document.createElement('span');
  date.className = 'lg-date';
  date.textContent = fmtDate(r.mtime);

  const sz = document.createElement('span');
  sz.className = 'sz';
  sz.textContent = humanFileSize(r.size);

  row.append(flag, rankEl, icon, label, date, sz);
  row.addEventListener('click', () => selectEntry(r.id));
  row.addEventListener('contextmenu', (e) => openContextMenu(e, r, false));
  return row;
}

// ---- duplicates ----------------------------------------------------------

const dupeSel = new Set();      // ids of copies ticked for bulk deletion
const dupeById = new Map();     // id -> copy row (for size totals + deletion)
const dupeDrives = new Set();   // volume ids to compare; empty = none picked

$('dupes-refresh').addEventListener('click', loadDuplicates);
$('dupes-cross').addEventListener('change', loadDuplicates);

// Drive picker for the Duplicates tab: one toggle per mapped drive, so you can
// compare any 2+ drives. Defaults to all drives selected.
function renderDupeDrivePicker() {
  const box = $('dupes-drives');
  box.innerHTML = '';
  const vols = state.volumes;
  const known = new Set(vols.map(v => v.id));
  for (const id of [...dupeDrives]) if (!known.has(id)) dupeDrives.delete(id);
  if (dupeDrives.size === 0) for (const v of vols) dupeDrives.add(v.id);  // default: all

  box.classList.toggle('hidden', !vols.length);
  for (const v of vols) {
    const chip = document.createElement('label');
    chip.className = 'dupe-drive' + (dupeDrives.has(v.id) ? ' on' : '') + (state.reachable[v.id] ? '' : ' offline');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = dupeDrives.has(v.id);
    cb.addEventListener('change', () => {
      if (cb.checked) dupeDrives.add(v.id); else dupeDrives.delete(v.id);
      chip.classList.toggle('on', cb.checked);
      loadDuplicates();
    });
    const nm = document.createElement('span');
    nm.textContent = (v.icon ? v.icon + ' ' : '') + v.name;
    if (!state.reachable[v.id]) chip.title = 'Offline — copies here can be listed but not deleted';
    chip.append(cb, nm);
    box.appendChild(chip);
  }
}
$('dupes-clear').addEventListener('click', clearDupeSelection);
$('dupes-keep-newest').addEventListener('click', () => selectAllBut('newest'));
$('dupes-keep-oldest').addEventListener('click', () => selectAllBut('oldest'));
$('dupes-delete-sel').addEventListener('click', deleteSelectedDuplicates);

async function loadDuplicates() {
  const list = $('dupes-list');
  const crossOnly = $('dupes-cross').checked;
  const volumeIds = [...dupeDrives];
  dupeSel.clear();
  dupeById.clear();
  if (volumeIds.length === 0) {
    $('dupes-summary').textContent = 'Pick at least one drive to scan.';
    list.innerHTML = '';
    $('dupes-actions').classList.add('hidden');
    return;
  }
  if (crossOnly && volumeIds.length < 2) {
    $('dupes-summary').textContent = 'Pick 2 or more drives to compare across drives.';
    list.innerHTML = '';
    $('dupes-actions').classList.add('hidden');
    return;
  }
  $('dupes-summary').textContent = 'Scanning for duplicates…';
  list.innerHTML = '';
  let rows;
  try { rows = await api.findDuplicates({ volumeIds, crossOnly }); }
  catch (e) { $('dupes-summary').textContent = 'Failed: ' + (e.message || e); return; }

  // group by name + size
  const groups = new Map();
  for (const r of rows) {
    const key = r.size + '|' + r.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: r.name, size: r.size, items: [] });
    groups.get(key).items.push(r);
  }
  const list2 = [...groups.values()].filter(g => g.items.length > 1);
  // reclaimable = every copy beyond the first, summed
  const wasted = list2.reduce((s, g) => s + g.size * (g.items.length - 1), 0);
  const allVols = volumeIds.length === state.volumes.length;
  const where = crossOnly ? 'across drives'
    : (allVols ? 'across all drives' : `across ${volumeIds.length} drive${volumeIds.length === 1 ? '' : 's'}`);
  $('dupes-summary').textContent = list2.length
    ? `${list2.length} duplicate set${list2.length === 1 ? '' : 's'} ${where} · up to ${humanFileSize(wasted)} reclaimable`
    : `No duplicates found ${where} (matched by name + size).`;

  $('dupes-actions').classList.toggle('hidden', !list2.length);

  for (const g of list2) {
    // Mark the newest / oldest copy so "keep newest/oldest" can spare it.
    const withTime = g.items.filter(it => it.mtime);
    const newest = withTime.reduce((a, b) => (a && a.mtime >= b.mtime ? a : b), null);
    const oldest = withTime.reduce((a, b) => (a && a.mtime <= b.mtime ? a : b), null);

    const card = document.createElement('div');
    card.className = 'dup-group';
    const head = document.createElement('div');
    head.className = 'dup-head';
    head.innerHTML = `<span class="dup-name"></span><span class="dup-meta">${humanFileSize(g.size)} · ${g.items.length} copies</span>`;
    head.querySelector('.dup-name').textContent = g.name;
    card.appendChild(head);

    for (const it of g.items) {
      const reachable = !!state.reachable[it.volume_id];
      dupeById.set(it.id, it);

      const rowEl = document.createElement('div');
      rowEl.className = 'dup-item';
      rowEl.dataset.id = it.id;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'dup-check';
      check.disabled = !reachable;
      check.title = reachable ? 'Tick to delete this copy' : 'Drive offline — connect it to delete this copy';
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => toggleDupe(it.id, check.checked, rowEl));

      const loc = document.createElement('div');
      loc.className = 'dup-loc';
      loc.innerHTML = `<span class="dup-vol"></span><span class="dup-path"></span><span class="dup-when"></span>`;
      loc.querySelector('.dup-vol').textContent = it.volume_name;
      loc.querySelector('.dup-path').textContent = it.rel_path;
      const when = loc.querySelector('.dup-when');
      when.textContent = it.mtime ? fmtDate(it.mtime) : '';
      if (it === newest && g.items.length > 1) when.textContent += ' · newest';
      else if (it === oldest && g.items.length > 1) when.textContent += ' · oldest';

      const del = document.createElement('button');
      del.className = 'btn btn-ghost-danger mini-btn';
      del.textContent = 'Delete';
      del.disabled = !reachable;
      del.title = reachable ? 'Delete this copy from disk' : 'Drive offline';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteDuplicate(it, g.items.length); });

      rowEl.addEventListener('click', () => {
        document.querySelectorAll('.dup-item.previewing').forEach(el => el.classList.remove('previewing'));
        rowEl.classList.add('previewing');
        selectEntry(it.id);
      });
      rowEl.append(check, loc, del);
      card.appendChild(rowEl);
    }
    $('dupes-list').appendChild(card);
  }
  updateDupeActions();
}

// Tick/untick a copy for bulk deletion.
function toggleDupe(id, on, rowEl) {
  if (on) dupeSel.add(id); else dupeSel.delete(id);
  if (rowEl) rowEl.classList.toggle('selected', on);
  updateDupeActions();
}

// In every set, tick all copies except the one to keep (newest or oldest),
// so deleting the selection leaves exactly one copy of each file.
function selectAllBut(keep) {
  // group the on-screen copies back together by their card
  document.querySelectorAll('.dup-group').forEach(card => {
    const rows = [...card.querySelectorAll('.dup-item')];
    const items = rows.map(r => dupeById.get(Number(r.dataset.id))).filter(Boolean);
    const timed = items.filter(it => it.mtime);
    if (!timed.length) return;
    const survivor = keep === 'oldest'
      ? timed.reduce((a, b) => (a.mtime <= b.mtime ? a : b))
      : timed.reduce((a, b) => (a.mtime >= b.mtime ? a : b));
    for (const r of rows) {
      const it = dupeById.get(Number(r.dataset.id));
      const check = r.querySelector('.dup-check');
      if (!it || !check || check.disabled) continue;       // skip offline copies
      const on = it.id !== survivor.id;
      check.checked = on;
      toggleDupe(it.id, on, r);
    }
  });
}

function clearDupeSelection() {
  dupeSel.clear();
  document.querySelectorAll('.dup-item').forEach(r => {
    const c = r.querySelector('.dup-check');
    if (c) c.checked = false;
    r.classList.remove('selected');
  });
  updateDupeActions();
}

// Refresh the count + total size + button state in the bulk action bar.
function updateDupeActions() {
  const n = dupeSel.size;
  const bytes = [...dupeSel].reduce((s, id) => s + ((dupeById.get(id) || {}).size || 0), 0);
  $('dupes-selcount').textContent = n
    ? `${n} selected · ${humanFileSize(bytes)}`
    : '0 selected';
  $('dupes-delete-sel').disabled = n === 0;
  $('dupes-delete-sel').textContent = n ? `Delete selected (${n})` : 'Delete selected';
}

async function deleteSelectedDuplicates() {
  const ids = [...dupeSel];
  if (!ids.length) return;
  const bytes = ids.reduce((s, id) => s + ((dupeById.get(id) || {}).size || 0), 0);
  const ok = await promptModal({
    title: `Delete ${ids.length} selected cop${ids.length === 1 ? 'y' : 'ies'}?`,
    sub: `This permanently deletes ${ids.length} real file${ids.length === 1 ? '' : 's'} from disk (${humanFileSize(bytes)}). This cannot be undone.`,
    confirmText: `Delete ${ids.length}`, input: false, danger: true
  });
  if (!ok) return;

  let done = 0, failed = 0;
  for (const id of ids) {
    const res = await api.realDelete(id).catch(() => null);
    if (res && res.ok) done += 1; else failed += 1;
  }
  toast(failed ? `Deleted ${done}; ${failed} failed (drive offline?).` : `Deleted ${done} cop${done === 1 ? 'y' : 'ies'} from disk.`, !!failed);
  await loadRail();
  await loadDuplicates();
}

async function deleteDuplicate(it, copies) {
  const ok = await promptModal({
    title: 'Delete this copy?',
    sub: `${it.volume_name} · ${it.rel_path}\nThis permanently deletes the real file. ${copies - 1} copy(ies) will remain.`,
    confirmText: 'Delete', input: false, danger: true
  });
  if (!ok) return;
  const res = await api.realDelete(it.id);
  if (!res || !res.ok) { toast(res && res.error ? res.error : 'Delete failed.', true); return; }
  toast('Deleted from disk.');
  await loadRail();
  await loadDuplicates();
}

// ---- space map (treemap) -------------------------------------------------

const TM_COLORS = {
  folder: '#54aeff', video: '#d4af37', image: '#7ee787', audio: '#ff7b72',
  archive: '#d2a8ff', doc: '#79c0ff', code: '#f0883e', other: '#6e7681'
};
function tmCategory(item) {
  if (item.is_dir) return 'folder';
  const e = (item.ext || '').toLowerCase();
  if (VIDEO_EXTS.includes(e)) return 'video';
  if (IMAGE_EXTS.includes(e)) return 'image';
  if (AUDIO_EXTS.includes(e)) return 'audio';
  if (ARCHIVE_EXTS.includes(e)) return 'archive';
  if (DOC_EXTS.includes(e)) return 'doc';
  if (CODE_EXTS.includes(e)) return 'code';
  return 'other';
}
const tmValue = (it) => it.is_dir ? (it.tree_size || 0) : (it.size || 0);

let tmCanvas, tmCtx, tmHovered = null;
const tmVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
function tmInit() {
  tmCanvas = $('tm-canvas');
  tmCtx = tmCanvas.getContext('2d');
  tmRenderLegend();
  tmCanvas.addEventListener('mousemove', tmHover);
  tmCanvas.addEventListener('mouseleave', () => {
    $('tm-tip').classList.add('hidden');
    if (tmHovered) { tmHovered = null; tmDraw(); }
  });
  tmCanvas.addEventListener('click', tmClick);
  window.addEventListener('resize', () => { if (state.tab === 'space') tmResize(); });
}

async function tmLoadLevel(parentId) {
  if (state.activeVolumeId == null) { state.tmItems = []; tmResize(); tmRenderCrumbs(); return; }
  state.tmItems = await api.getTreemap(state.activeVolumeId, parentId);
  tmRenderCrumbs();
  tmResize();
}

function tmResize() {
  if (!tmCanvas) return;
  const stage = tmCanvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  tmCanvas.width = Math.max(1, Math.floor(stage.width * dpr));
  tmCanvas.height = Math.max(1, Math.floor(stage.height * dpr));
  tmCanvas.style.width = stage.width + 'px';
  tmCanvas.style.height = stage.height + 'px';
  tmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tmRelayout();
  tmDraw();
}

// Compute the tile rectangles for the current level (separate from drawing so
// hover highlights can repaint without re-running the squarify layout).
function tmRelayout() {
  tmHovered = null;
  const dpr = window.devicePixelRatio || 1;
  const W = tmCanvas.width / dpr, H = tmCanvas.height / dpr;
  state.tmTiles = tmLayout(state.tmItems, 2, 2, W - 4, H - 4);
}

function tmDraw() {
  const dpr = window.devicePixelRatio || 1;
  const W = tmCanvas.width / dpr, H = tmCanvas.height / dpr;
  tmCtx.clearRect(0, 0, W, H);
  $('tm-empty').classList.toggle('hidden', state.tmItems.length > 0 && state.activeVolumeId != null);
  if (state.activeVolumeId == null) { $('tm-empty').textContent = 'Open a drive to see its space map.'; return; }

  const gap = tmVar('--bg') || '#0d1117';
  const accent = tmVar('--accent') || '#d4af37';
  const total = state.tmItems.reduce((s, it) => s + Math.max(tmValue(it), 0), 0) || 1;

  for (const t of state.tmTiles) {
    const hovered = t === tmHovered;
    const radius = Math.min(4, t.w / 2, t.h / 2);

    // base colour + a soft top-light / bottom-shade gradient for depth
    tmRoundRect(t.x, t.y, t.w, t.h, radius);
    tmCtx.fillStyle = TM_COLORS[tmCategory(t.it)];
    tmCtx.fill();
    const g = tmCtx.createLinearGradient(0, t.y, 0, t.y + t.h);
    g.addColorStop(0, 'rgba(255,255,255,0.16)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.14)');
    tmRoundRect(t.x, t.y, t.w, t.h, radius);
    tmCtx.fillStyle = g;
    tmCtx.fill();
    if (hovered) {
      tmRoundRect(t.x, t.y, t.w, t.h, radius);
      tmCtx.fillStyle = 'rgba(255,255,255,0.16)';
      tmCtx.fill();
    }

    // separator that matches the panel background (gap look), accent on hover
    tmCtx.lineWidth = hovered ? 2 : 1.25;
    tmCtx.strokeStyle = hovered ? accent : gap;
    tmRoundRect(t.x + 0.7, t.y + 0.7, t.w - 1.4, t.h - 1.4, radius);
    tmCtx.stroke();

    // label: name, plus size + share of the level when there's room
    if (t.w > 56 && t.h > 22) {
      tmCtx.save();
      tmCtx.beginPath(); tmCtx.rect(t.x + 5, t.y + 4, t.w - 10, t.h - 8); tmCtx.clip();
      tmCtx.textBaseline = 'top';
      tmCtx.fillStyle = 'rgba(13,17,23,0.92)';
      tmCtx.font = '600 12px Inter, system-ui, sans-serif';
      tmCtx.fillText(t.it.name, t.x + 7, t.y + 5);
      if (t.h > 40) {
        const pct = Math.round(tmValue(t.it) / total * 100);
        tmCtx.fillStyle = 'rgba(13,17,23,0.65)';
        tmCtx.font = '11px Inter, system-ui, sans-serif';
        tmCtx.fillText(humanFileSize(tmValue(t.it)) + (pct >= 1 ? `  ·  ${pct}%` : ''), t.x + 7, t.y + 22);
      }
      tmCtx.restore();
    }
  }
}

function tmRoundRect(x, y, w, h, r) {
  // Tiles can be sub-pixel thin; a negative radius makes arcTo throw.
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  tmCtx.beginPath();
  if (w <= 0 || h <= 0) return;
  tmCtx.moveTo(x + r, y);
  tmCtx.arcTo(x + w, y, x + w, y + h, r);
  tmCtx.arcTo(x + w, y + h, x, y + h, r);
  tmCtx.arcTo(x, y + h, x, y, r);
  tmCtx.arcTo(x, y, x + w, y, r);
  tmCtx.closePath();
}

// squarified treemap
function tmLayout(items, x, y, w, h) {
  const total = items.reduce((s, it) => s + Math.max(tmValue(it), 0), 0);
  const out = [];
  if (total <= 0 || w <= 0 || h <= 0) return out;
  const scaled = items
    .map(it => ({ it, area: Math.max(tmValue(it), 0) / total * (w * h) }))
    .filter(s => s.area > 0);

  let rx = x, ry = y, rw = w, rh = h, row = [], i = 0;
  const worst = (row, len) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    const mx = Math.max(...row.map(r => r.area)), mn = Math.min(...row.map(r => r.area));
    const l2 = len * len, s2 = sum * sum;
    return Math.max((l2 * mx) / s2, s2 / (l2 * mn));
  };
  while (i < scaled.length) {
    const shortest = Math.min(rw, rh);
    const next = scaled[i];
    if (row.length === 0 || worst(row, shortest) >= worst(row.concat(next), shortest)) {
      row.push(next); i++;
    } else {
      tmPlaceRow(row, rx, ry, rw, rh, out);
      const used = row.reduce((s, r) => s + r.area, 0);
      if (rw >= rh) { const dw = used / rh; rx += dw; rw -= dw; }
      else { const dh = used / rw; ry += dh; rh -= dh; }
      row = [];
    }
  }
  if (row.length) tmPlaceRow(row, rx, ry, rw, rh, out);
  return out;
}
function tmPlaceRow(row, x, y, w, h, out) {
  const sum = row.reduce((s, r) => s + r.area, 0);
  if (sum <= 0) return;
  if (w >= h) {
    const cw = sum / h; let cy = y;
    for (const r of row) { const ch = r.area / cw; out.push({ it: r.it, x, y: cy, w: cw, h: ch }); cy += ch; }
  } else {
    const ch = sum / w; let cx = x;
    for (const r of row) { const cw = r.area / ch; out.push({ it: r.it, x: cx, y, w: cw, h: ch }); cx += cw; }
  }
}

function tmTileAt(px, py) {
  for (const t of state.tmTiles) if (px >= t.x && px <= t.x + t.w && py >= t.y && py <= t.y + t.h) return t;
  return null;
}
function tmHover(e) {
  const r = tmCanvas.getBoundingClientRect();
  const t = tmTileAt(e.clientX - r.left, e.clientY - r.top);
  if (t !== tmHovered) { tmHovered = t; tmDraw(); }    // repaint highlight
  tmCanvas.style.cursor = (t && t.it.is_dir) ? 'pointer' : 'default';

  const tip = $('tm-tip');
  if (!t) { tip.classList.add('hidden'); return; }
  const total = state.tmItems.reduce((s, it) => s + Math.max(tmValue(it), 0), 0) || 1;
  const pct = Math.round(tmValue(t.it) / total * 100);
  const kind = t.it.is_dir ? 'folder' : (t.it.ext ? `.${t.it.ext}` : 'file');
  tip.innerHTML = '';
  const strong = document.createElement('strong'); strong.textContent = t.it.name;
  tip.append(
    strong,
    document.createElement('br'),
    document.createTextNode(`${humanFileSize(tmValue(t.it))} · ${pct}% of this level · ${kind}` +
      (t.it.is_dir ? ' · click to open' : ''))
  );
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
  tip.classList.remove('hidden');
}
function tmClick(e) {
  const r = tmCanvas.getBoundingClientRect();
  const t = tmTileAt(e.clientX - r.left, e.clientY - r.top);
  if (!t) return;
  if (t.it.is_dir) {
    state.tmTrail.push({ id: t.it.id, name: t.it.name });
    tmLoadLevel(t.it.id);
  } else {
    selectEntry(t.it.id); // show the file in the detail pane
  }
}
function tmRenderCrumbs() {
  const bc = $('tm-crumbs');
  bc.innerHTML = '';
  state.tmTrail.forEach((c, i) => {
    if (i > 0) { const s = document.createElement('span'); s.className = 'crumb-sep'; s.textContent = '›'; bc.appendChild(s); }
    const last = i === state.tmTrail.length - 1;
    const el = document.createElement('span');
    el.className = 'crumb' + (last ? ' current' : '');
    el.textContent = c.name;
    if (!last) el.addEventListener('click', () => { state.tmTrail = state.tmTrail.slice(0, i + 1); tmLoadLevel(c.id); });
    bc.appendChild(el);
  });
}
function tmRenderLegend() {
  const box = $('tm-legend');
  box.innerHTML = '';
  for (const [name, color] of Object.entries(TM_COLORS)) {
    const item = document.createElement('span');
    item.className = 'lg';
    const sw = document.createElement('i'); sw.style.background = color;
    item.append(sw, document.createTextNode(name));
    box.appendChild(item);
  }
}

// ---- test drive ----------------------------------------------------------

let testRunning = false;
let testResults = [];

function initTestTab() {
  const empty = $('test-empty');
  const controls = $('test-start').parentElement;
  if (!state.activeVolumeId) {
    empty.classList.remove('hidden');
    controls.classList.add('hidden');
    $('test-status').classList.add('hidden');
    $('test-results').classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  controls.classList.remove('hidden');
}

async function startDriveTest() {
  if (testRunning || !state.activeVolumeId) return;
  const sampleStr = $('test-sample').value;
  const sampleSize = sampleStr === 'all' ? 0 : parseInt(sampleStr, 10);

  testRunning = true;
  testResults = [];
  $('test-start').disabled = true;
  $('test-sample').disabled = true;
  $('test-status').classList.remove('hidden');
  $('test-results').classList.add('hidden');
  $('test-progress-text').textContent = 'Gathering files…';

  try {
    const allFiles = await api.listFiles(state.activeVolumeId);
    let testFiles = allFiles;
    if (sampleSize > 0 && testFiles.length > sampleSize) {
      testFiles = [];
      const step = Math.floor(allFiles.length / sampleSize);
      for (let i = 0; i < allFiles.length && testFiles.length < sampleSize; i += step) {
        testFiles.push(allFiles[i]);
      }
    }

    $('test-progress-text').textContent = `Testing 0 / ${testFiles.length} files…`;
    let passed = 0, failed = 0;

    for (let i = 0; i < testFiles.length; i++) {
      if (!testRunning) break;
      const file = testFiles[i];
      if (file.is_dir) continue;

      const res = await api.testFile(file.id).catch(() => ({ ok: false, status: 'error' }));
      const success = res && res.ok;
      if (success) passed++; else failed++;
      testResults.push({ file, result: res, success });

      const pct = Math.floor(((i + 1) / testFiles.length) * 100);
      $('test-progress-bar').style.width = pct + '%';
      $('test-progress-text').textContent = `Testing ${i + 1} / ${testFiles.length} files… (${passed} passed, ${failed} failed)`;
    }

    showTestResults(testFiles.length - (testFiles.filter(f => f.is_dir).length), passed, failed);
  } catch (err) {
    toast('Test failed: ' + err.message, true);
  } finally {
    testRunning = false;
    $('test-start').disabled = false;
    $('test-sample').disabled = false;
    $('test-status').classList.add('hidden');
  }
}

function showTestResults(tested, passed, failed) {
  $('test-results').classList.remove('hidden');
  $('test-tested').textContent = `Tested: ${tested}`;
  $('test-passed').textContent = `Passed: ${passed}`;
  $('test-failed').textContent = `Failed: ${failed}`;

  const list = $('test-list');
  list.innerHTML = '';
  for (const r of testResults.filter(r => !r.success)) {
    const item = document.createElement('div');
    item.className = 'test-item error';
    const nameEl = document.createElement('div');
    nameEl.className = 'test-name';
    nameEl.textContent = r.file.name;
    const statusEl = document.createElement('div');
    statusEl.className = 'test-status-detail';
    const status = r.result ? r.result.status : 'error';
    const statusText = {
      'damaged': 'File damaged or corrupt',
      'unreadable': 'File unreadable',
      'size-mismatch': 'File size mismatch',
      'missing': 'File not found',
      'error': 'Test error'
    }[status] || status;
    statusEl.textContent = statusText;
    item.append(nameEl, statusEl);
    list.appendChild(item);
  }
  if (!testResults.some(r => !r.success)) {
    const msg = document.createElement('div');
    msg.className = 'test-success';
    msg.textContent = 'All files passed! Drive is healthy.';
    list.appendChild(msg);
  }
}

$('test-start').addEventListener('click', startDriveTest);
$('test-cancel').addEventListener('click', () => { testRunning = false; });
$('test-clear').addEventListener('click', () => {
  testResults = [];
  $('test-results').classList.add('hidden');
  $('test-list').innerHTML = '';
});

// ---- color theme ---------------------------------------------------------

const THEMES = [
  { key: 'dark',  cls: '',            name: 'Dark' },
  { key: 'blue',  cls: 'theme-blue',  name: 'GitHub Dark' },
  { key: 'light', cls: 'theme-light', name: 'GitHub Light' }
];
function applyTheme(key) {
  const t = THEMES.find(x => x.key === key) || THEMES[0];
  document.body.classList.remove('theme-blue', 'theme-light');
  if (t.cls) document.body.classList.add(t.cls);
  try { localStorage.setItem('diskcorder-theme', t.key); } catch { /* ignore */ }
  const btn = $('theme-btn');
  if (btn) { btn.textContent = t.name; btn.dataset.key = t.key; }
}
$('theme-btn').addEventListener('click', () => {
  const cur = $('theme-btn').dataset.key || 'dark';
  const i = THEMES.findIndex(x => x.key === cur);
  applyTheme(THEMES[(i + 1) % THEMES.length].key);
});
applyTheme((() => { try { return localStorage.getItem('diskcorder-theme') || 'dark'; } catch { return 'dark'; } })());

// ---- boot ----------------------------------------------------------------

(async () => {
  tmInit();
  try { state.ffmpegReady = await api.ffmpegReady(); } catch { state.ffmpegReady = false; }
  await loadTagVocab();
  await loadRail();
  await restoreSession();   // reopen the last drive + folder + tab + view
})().catch(err => toast(err.message || 'Failed to load drives.', true));

// Re-check which drives are plugged in when the window regains focus.
window.addEventListener('focus', () => { if (state.volumes.length) refreshReachability(); });

})();
