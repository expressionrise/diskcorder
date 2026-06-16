# Diskcorder

**Map your external drives once, then browse, annotate, and rename them offline.**
A local-first Electron + SQLite disk cataloguer for creators with footage spread
across many USB HDDs.

> **Free and open source** (MIT). Local-first by design — your catalog lives in a
> single SQLite file on your machine and nothing is ever uploaded. Contributions
> welcome; see [Contributing](#contributing).

Plug in a drive, map it, and Diskcorder records every file and folder into a local
catalog. After that you can browse the whole tree, search across *all* your drives,
add notes, and give files friendly labels — **even when the drive is unplugged.**
When you do have the drive connected, you can also rename files for real, on disk.

---

## Why

If your raw footage lives on a shelf of USB hard drives, "which drive has the Devon
trip B-roll?" usually means plugging in disks one by one. Diskcorder answers that
question offline: it keeps a searchable map of what's on every drive, plus your own
notes and aliases, in a single local database. Nothing leaves your machine.

## Features

- **Offline catalog** — full file/folder tree per drive, browsable while the drive
  is disconnected.
- **Cross-drive search** — search names, notes, and aliases across every mapped
  drive at once; results show which drive and where.
- **Notes** — jot down what's in a folder, what you used it for, what to keep.
- **Virtual rename (alias)** — give a file a friendly label without touching the
  disk. Safe offline; the real filename is preserved.
- **Real rename** — when the drive is connected, rename the actual file/folder on
  disk from inside the app.
- **Re-scan that remembers** — re-mapping a drive preserves your notes and aliases
  by matching paths.

## Install

Diskcorder uses [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), a
native module that must be compiled against Electron's Node version.

```bash
npm install   # runs electron-rebuild for better-sqlite3 automatically (postinstall)
npm start
```

If `better-sqlite3` complains on first run (a native-module mismatch), rebuild it
once — this is the only real gotcha with the stack:

```bash
npm run rebuild
```

> Building native modules needs a C/C++ toolchain (on Windows, the
> "Desktop development with C++" workload or `windows-build-tools`).

## How it works

```
┌─────────────┐   IPC (window.api)   ┌──────────────┐
│  renderer   │ ───────────────────▶ │  main         │
│  (UI only)  │ ◀─── scan:progress ──│  process      │
└─────────────┘                      └──────┬────────┘
   plain HTML/CSS/JS                         │
   no Node access                            ▼
                                   ┌──────────────────┐
                                   │ scanner.js (fs)  │
                                   │ db.js (SQLite)   │
                                   └──────────────────┘
```

- **`src/main.js`** — creates the window and owns all privileged work: the folder
  picker, the filesystem scan, on-disk renames, and every database call. The
  catalog lives at `catalog.db` under Electron's `userData` directory.
- **`src/scanner.js`** — an async, depth-first walk of the chosen folder. Parents
  are emitted before children so the database can map temporary ids to real row ids
  in one pass. Symlinks are skipped; unreadable files/dirs are recorded rather than
  aborting the scan.
- **`src/db.js`** — the SQLite schema (`volumes`, `entries`) and all queries.
  `replaceVolume` re-scans a drive atomically and re-attaches existing notes and
  aliases by relative path.
- **`src/preload.js`** — the only bridge between renderer and main. It exposes a
  small, explicit `window.api`. The renderer runs with `contextIsolation: true` and
  `nodeIntegration: false`, so it can never touch Node directly.
- **`src/renderer/`** — a dependency-free three-pane UI (drives rail · file
  browser · detail pane). No framework, no build step. Theming is entirely CSS
  variables in `styles.css`.

### Using it

1. **Map a drive** — pick a drive or folder, give it a name, and let it scan.
2. **Browse** — click a drive in the left rail; double-click folders to open them,
   use the breadcrumb to go back.
3. **Annotate** — click any file or folder to add notes and an alias (both save
   automatically). Rows show an alias tag and a dot when notes exist.
4. **Search** — the top box searches every drive at once.
5. **Rename on disk** — in the detail pane, with the drive connected.

## Roadmap

- **ffprobe/ffmpeg** — pull duration/resolution/codec for video files and cache a
  thumbnail per clip.
- **FTS5 search** — swap `LIKE` for SQLite full-text search for big catalogs.
- **Volume fingerprint** — detect a re-inserted drive by its volume serial instead
  of the saved root path.
- **Folder rename reconciliation** — rewrite descendant relative paths when a
  folder is renamed on disk (today a re-scan reconciles them).
- **Export/import** — dump/restore the catalog as JSON, plus a "missing files since
  last scan" view.

## Contributing

Diskcorder is open source and contributions are welcome — issues, feature ideas,
and pull requests all help.

- **Architecture first.** Keep the security model intact: the renderer never
  imports Node modules, and all privileged work goes through `window.api` in
  `src/preload.js`. No front-end framework, no build step.
- **Match the style.** Plain HTML/CSS/JS in `src/renderer/`; theming stays in CSS
  variables in `styles.css`. Keep changes small and reviewable.
- **Run it locally** with `npm install && npm start` (see [Install](#install)).
- Good first contributions live in the [Roadmap](#roadmap) above.

By contributing you agree your work is licensed under the project's MIT license.

## License

[MIT](LICENSE) © Dawid Polakowski
