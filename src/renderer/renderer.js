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
  cancel:  svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>')
};

const IMAGE_EXTS = ['jpg','jpeg','png','gif','webp','bmp','svg','heic','tif','tiff','avif'];
const AUDIO_EXTS = ['mp3','wav','flac','aac','ogg','m4a','wma','aiff','opus'];
const ARCHIVE_EXTS = ['zip','rar','7z','tar','gz','bz2','xz','iso'];
const DOC_EXTS = ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','rtf','odt','csv'];
const CODE_EXTS = ['js','mjs','ts','tsx','jsx','json','html','css','py','c','cpp','h','hpp','java','go','rs','sh','xml','yml','yaml','php','rb'];
const VIDEO_EXTS = ['mp4','mkv','mov','avi','webm','m4v','wmv','flv','mpg','mpeg','m2ts','ts','3gp','ogv'];

function isVideoExt(ext) { return !!ext && VIDEO_EXTS.includes(ext.toLowerCase()); }

function iconFor(isDir, ext) {
  if (isDir) return ICON.folder;
  const e = (ext || '').toLowerCase();
  if (VIDEO_EXTS.includes(e)) return ICON.video;
  if (IMAGE_EXTS.includes(e)) return ICON.image;
  if (AUDIO_EXTS.includes(e)) return ICON.audio;
  if (ARCHIVE_EXTS.includes(e)) return ICON.archive;
  if (DOC_EXTS.includes(e)) return ICON.doc;
  if (CODE_EXTS.includes(e)) return ICON.code;
  return ICON.file;
}

const thumbUrl = (volId, id) => `thumbcache://${volId}/${id}.jpg`;
const previewUrl = (volId, id) => `thumbcache://${volId}/${id}.mp4`;

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
  maxBytes: 1,            // largest catalog, for the relative capacity bar
  reachable: {},          // volumeId -> bool (drive currently connected?)
  activeVolumeId: null,
  trail: [],              // [{ id: null|entryId, name }] — id null == volume root
  selectedEntry: null,    // full row from getEntry, for the detail pane
  searching: false,
  ffmpegReady: false
};

// ---- drives rail ---------------------------------------------------------

async function loadRail() {
  state.volumes = await api.listVolumes();
  state.maxBytes = Math.max(1, ...state.volumes.map(v => v.total_bytes || 0));
  renderRail();
  refreshReachability();
}

async function refreshReachability() {
  await Promise.all(state.volumes.map(async v => {
    try { state.reachable[v.id] = await api.isReachable(v.id); } catch { state.reachable[v.id] = false; }
  }));
  // update badges in place
  document.querySelectorAll('.volume-card').forEach(card => {
    const id = Number(card.dataset.id);
    const badge = card.querySelector('.badge');
    if (!badge) return;
    const online = !!state.reachable[id];
    badge.textContent = online ? 'connected' : 'offline';
    badge.classList.toggle('online', online);
  });
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
    const pct = Math.max(3, Math.round(((v.total_bytes || 0) / state.maxBytes) * 100));
    const online = !!state.reachable[v.id];

    card.innerHTML = `
      <div class="vname">
        <span class="vname-text"></span>
        <span class="badge ${online ? 'online' : ''}">${online ? 'connected' : 'offline'}</span>
      </div>
      <div class="vmeta">
        <span>${(v.file_count || 0).toLocaleString()} files</span>
        <span>${humanFileSize(v.total_bytes)}</span>
      </div>
      <div class="cap-bar"><div class="cap-fill" style="width:${pct}%"></div></div>
      <div class="vol-actions">
        <button class="mini" data-act="rescan" title="Re-scan this drive">Re-scan</button>
        <button class="mini" data-act="previews" title="Generate video previews">Previews</button>
        <button class="mini" data-act="rename" title="Rename label">Rename</button>
        <button class="mini mini-danger" data-act="remove" title="Forget this drive">Remove</button>
      </div>`;
    card.querySelector('.vname-text').textContent = v.name;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.vol-actions')) return;
      openVolume(v);
    });
    card.querySelector('[data-act="rescan"]').addEventListener('click', () => mapDrive(v));
    card.querySelector('[data-act="previews"]').addEventListener('click', () => generatePreviews(v));
    card.querySelector('[data-act="rename"]').addEventListener('click', () => renameVolume(v));
    card.querySelector('[data-act="remove"]').addEventListener('click', () => removeVolume(v));

    list.appendChild(card);
  }
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
  $('listing').innerHTML = '';
  $('breadcrumb').innerHTML = '';
  $('listing-empty').classList.remove('hidden');
}

async function openVolume(v) {
  state.activeVolumeId = v.id;
  state.trail = [{ id: null, name: v.name }];
  state.searching = false;
  $('search-input').value = '';
  renderRail();
  await loadListing();
}

async function loadListing() {
  if (state.activeVolumeId == null) { clearBrowser(); return; }
  $('listing-empty').classList.add('hidden');
  const parent = state.trail[state.trail.length - 1];
  const rows = await api.getChildren(state.activeVolumeId, parent.id);
  renderBreadcrumb();
  renderRows(rows, false);
}

function renderBreadcrumb() {
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
}

function renderRows(rows, asSearch) {
  const listing = $('listing');
  listing.innerHTML = '';

  if (!rows.length) {
    const e = document.createElement('div');
    e.className = 'listing-empty';
    e.textContent = asSearch ? 'No matches.' : 'This folder is empty.';
    listing.appendChild(e);
    return;
  }

  for (const r of rows) {
    const volId = asSearch ? r.volume_id : state.activeVolumeId;
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = r.id;
    if (state.selectedEntry && state.selectedEntry.id === r.id) row.classList.add('selected');

    const icon = document.createElement('span');
    icon.className = 'ic';
    icon.innerHTML = iconFor(r.is_dir, r.ext);

    // Video rows get a lazy thumbnail + hover preview in the icon slot.
    if (!r.is_dir && isVideoExt(r.ext)) {
      icon.classList.add('thumb');
      wireThumb(icon, volId, r.id, r.ext);
    }

    const label = document.createElement('div');
    label.className = 'label';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = r.alias || r.name;
    if (r.alias) {
      const tag = document.createElement('span');
      tag.className = 'alias-tag';
      tag.textContent = r.name;
      nm.appendChild(tag);
    }
    if (r.note) {
      const dot = document.createElement('span');
      dot.className = 'note-dot';
      dot.title = 'Has notes';
      nm.appendChild(dot);
    }
    label.appendChild(nm);
    if (asSearch) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${r.volume_name} · ${r.rel_path}`;
      label.appendChild(sub);
    }

    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = r.is_dir ? '' : humanFileSize(r.size);

    row.append(icon, label, sz);

    row.addEventListener('click', () => selectEntry(r.id));
    if (r.is_dir && !asSearch) {
      row.addEventListener('dblclick', () => {
        state.trail.push({ id: r.id, name: r.alias || r.name });
        loadListing();
      });
    }
    listing.appendChild(row);
  }
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
    ['Modified', fmtDate(entry.mtime)],
    entry.alias && ['Real name', entry.name]
  ].filter(Boolean);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    meta.append(dt, dd);
  }

  $('alias-input').value = entry.alias || '';
  $('note-input').value = entry.note || '';
}

// Video media preview in the detail pane: big thumbnail, plays preview on hover.
function renderMedia(entry) {
  const box = $('detail-media');
  box.innerHTML = '';
  if (entry.is_dir || !isVideoExt(entry.ext)) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

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
  hint.innerHTML = ICON.play + '<span>Hover to preview</span>';
  frame.appendChild(hint);

  let vid = null;
  frame.addEventListener('mouseenter', async () => {
    if (!state.ffmpegReady) { hint.querySelector('span').textContent = 'ffmpeg unavailable'; return; }
    if (!hasThumb) {
      frame.classList.add('loading');
      const res = await api.ensureThumb(entry.id).catch(() => null);
      frame.classList.remove('loading');
      if (!res || !res.ok) { hint.querySelector('span').textContent = res && res.error === 'offline' ? 'Drive offline' : 'No preview'; return; }
      img.src = thumbUrl(entry.volume_id, entry.id) + '?t=' + Date.now();
      hasThumb = true; frame.classList.add('ready');
    }
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
  toast((move ? 'Moved' : 'Copied') + ' to destination. Re-scan that drive to catalog it.');
  if (move) { await loadRail(); if (!state.searching) await loadListing(); clearDetail(); }
}

// ---- video preview batch generation --------------------------------------

async function generatePreviews(v) {
  if (!state.reachable[v.id]) { toast('Connect “' + v.name + '” first.', true); return; }
  if (!state.ffmpegReady) { toast('ffmpeg is not available — previews disabled.', true); return; }
  const drawer = showOp('thumbs', `Previews · ${v.name}`);
  const res = await api.generateThumbs(v.id).catch(err => ({ ok: false, error: err.message }));
  hideOp(drawer);
  if (!res || !res.ok) { toast(res && res.error ? res.error : 'Preview generation failed.', true); return; }
  if (res.total === 0) { toast('No video files found on this drive.'); return; }
  toast(res.canceled ? 'Preview generation canceled.' : `Generated previews for ${res.done} videos.`);
  if (v.id === state.activeVolumeId && !state.searching) await loadListing();
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
let scanning = false;

async function mapDrive(existingVol) {
  if (scanning) return;
  const picked = await api.pickDrive();
  if (!picked) return;

  const name = await promptModal({
    title: existingVol ? 'Re-scan drive' : 'Name this drive',
    sub: picked.root,
    value: existingVol ? existingVol.name : (picked.suggestedName || ''),
    confirmText: existingVol ? 'Re-scan' : 'Map it'
  });
  if (name == null || !name.trim()) return;

  scanning = true;
  $('map-drive').disabled = true;
  showScan(true);
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
    if (!res || !res.ok) {
      toast(res && res.error ? res.error : 'Scan failed.', true);
      return;
    }
    await loadRail();
    const vol = state.volumes.find(v => v.id === res.volumeId);
    if (vol) await openVolume(vol);
    const skipNote = res.skipped ? ` (${res.skipped} unreadable item${res.skipped === 1 ? '' : 's'} skipped)` : '';
    toast((existingVol ? 'Drive re-scanned.' : 'Drive mapped.') + skipNote);
  } catch (err) {
    toast(err.message || 'Scan failed.', true);
  } finally {
    unsub();
    showScan(false);
    scanning = false;
    $('map-drive').disabled = false;
  }
}

function showScan(on) {
  if (on) {
    $('scan-count').textContent = '0 items';
    $('scan-current').textContent = '';
  }
  $('scan-overlay').classList.toggle('hidden', !on);
}

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
  drawer.appendChild(row);
  return row;
}
function hideOp(row) {
  if (row && row.parentNode) row.remove();
  const drawer = $('ops-drawer');
  if (!drawer.querySelector('.op-row')) drawer.classList.add('hidden');
}

api.onThumbProgress(({ done, total, current, finished }) => {
  const drawer = $('ops-drawer');
  const row = drawer.querySelector('.op-row');
  if (!row) return;
  const pct = total ? Math.round((done / total) * 100) : 0;
  row.querySelector('.op-fill').style.width = pct + '%';
  row.querySelector('.op-pct').textContent = `${done}/${total}`;
});

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

// ---- boot ----------------------------------------------------------------

(async () => {
  try { state.ffmpegReady = await api.ffmpegReady(); } catch { state.ffmpegReady = false; }
  await loadRail();
})().catch(err => toast(err.message || 'Failed to load drives.', true));

// Re-check which drives are plugged in when the window regains focus.
window.addEventListener('focus', () => { if (state.volumes.length) refreshReachability(); });

})();
