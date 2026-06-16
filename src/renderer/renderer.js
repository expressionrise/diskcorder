'use strict';

/* Diskcorder renderer — wires the UI shell to the main process through the
   preload `window.api` bridge. No Node access here, no framework, no build. */

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

const ICON = {
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`
};
const iconSvg = (isDir) => isDir ? ICON.folder : ICON.file;

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
  activeVolumeId: null,
  trail: [],              // [{ id: null|entryId, name }] — id null == volume root
  selectedEntry: null,    // full row from getEntry, for the detail pane
  searching: false
};

// ---- drives rail ---------------------------------------------------------

async function loadRail() {
  state.volumes = await api.listVolumes();
  state.maxBytes = Math.max(1, ...state.volumes.map(v => v.total_bytes || 0));
  renderRail();
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
    const pct = Math.max(3, Math.round(((v.total_bytes || 0) / state.maxBytes) * 100));

    card.innerHTML = `
      <div class="vname">
        <span class="vname-text"></span>
        <span class="badge-offline">offline</span>
      </div>
      <div class="vmeta">
        <span>${(v.file_count || 0).toLocaleString()} files</span>
        <span>${humanFileSize(v.total_bytes)}</span>
      </div>
      <div class="cap-bar"><div class="cap-fill" style="width:${pct}%"></div></div>
      <div class="vol-actions">
        <button class="mini" data-act="rescan">Re-scan</button>
        <button class="mini" data-act="rename">Rename</button>
        <button class="mini mini-danger" data-act="remove">Remove</button>
      </div>`;
    card.querySelector('.vname-text').textContent = v.name;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.vol-actions')) return;
      openVolume(v);
    });
    card.querySelector('[data-act="rescan"]').addEventListener('click', () => mapDrive(v));
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
    sub: 'This forgets the catalog, notes, and aliases for this drive. The drive itself is untouched.',
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
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = r.id;
    if (state.selectedEntry && state.selectedEntry.id === r.id) row.classList.add('selected');

    const icon = document.createElement('span');
    icon.className = 'ic';
    icon.innerHTML = iconSvg(r.is_dir);

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

  $('detail-icon').innerHTML = iconSvg(entry.is_dir);
  $('detail-name').textContent = entry.alias || entry.name;
  $('detail-path').textContent = entry.rel_path;

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

  const alias = $('alias-input');
  const note = $('note-input');
  alias.value = entry.alias || '';
  note.value = entry.note || '';
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
  if (row.classList.contains('selected') || true) markSelectedRow(id);
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
  toast('Renamed on disk.');
  await loadRail();
  if (!state.searching) await loadListing();
  await selectEntry(e.id);
});

// ---- search --------------------------------------------------------------

const runSearch = debounce(async (term) => {
  if (!term) {
    state.searching = false;
    if (state.activeVolumeId != null) await loadListing();
    else clearBrowser();
    return;
  }
  state.searching = true;
  const results = await api.search(term);
  $('listing-empty').classList.add('hidden');
  $('breadcrumb').innerHTML =
    `<span class="crumb current">Search · ${results.length} result${results.length === 1 ? '' : 's'}</span>`;
  renderRows(results, true);
}, 220);

$('search-input').addEventListener('input', (e) => runSearch(e.target.value.trim()));

// ---- map / re-scan a drive ----------------------------------------------

$('map-drive').addEventListener('click', () => mapDrive(null));

async function mapDrive(existingVol) {
  const picked = await api.pickDrive();
  if (!picked) return;

  const name = await promptModal({
    title: existingVol ? 'Re-scan drive' : 'Name this drive',
    sub: picked.root,
    value: existingVol ? existingVol.name : (picked.suggestedName || ''),
    confirmText: existingVol ? 'Re-scan' : 'Map it'
  });
  if (name == null || !name.trim()) return;

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
    toast(existingVol ? 'Drive re-scanned.' : 'Drive mapped.');
  } catch (err) {
    toast(err.message || 'Scan failed.', true);
  } finally {
    unsub();
    showScan(false);
  }
}

function showScan(on) {
  if (on) {
    $('scan-count').textContent = '0 items';
    $('scan-current').textContent = '';
  }
  $('scan-overlay').classList.toggle('hidden', !on);
}

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

// ---- boot ----------------------------------------------------------------

loadRail().catch(err => toast(err.message || 'Failed to load drives.', true));
