# Diskcorder roadmap

_Last refined: 2026-10-07 · current release: **v0.3.0** (v0.3.1 ready) · tracker: [GitHub issues](https://github.com/expressionrise/diskcorder/issues) and [milestones](https://github.com/expressionrise/diskcorder/milestones)._

The detailed tickets live in [`docs/roadmap/issues.json`](docs/roadmap/issues.json) and are
created on GitHub with `node scripts/create-issues.js` (re-runnable, skips existing titles).
Titles below match the issue titles.

## Now: v0.3.1 (post-release polish)

- [x] Stop shipping ffmpeg twice (-83 MB)
- [x] Portable build: keep data next to the exe
- [x] Automated test suite (transfer, backup, thumbnails, db) running in CI (ffmpeg concurrency cap not covered)
- [x] Smoke-test the packaged app in CI (`electron-builder --dir`)
- [x] Check the orange warning frames/banners (delete, move, replace) in all three themes (a one-time first-run notice is still undecided)
- [x] Test symbolic-link behavior (runs in CI where symlinks can be created) and the Gallery multi-select layout (checked)

## Next: v0.4.0

- [ ] Website: realistic screenshots and the expressionrise.com project card (+ repo topics)
- [ ] Publish to the Microsoft Store as MSIX (Microsoft signs it; needs Partner Center account, name reservation, privacy policy, store listing; after the test suite)
- [ ] Save the catalog onto the drive (opt-in sidecar file; always ask, ask on exit if unsaved)
- [ ] Opt-in auto-generation of thumbnails when a drive connects
- [ ] Choose a destination subfolder for copy / move
- [ ] Update the catalog live after copy / move
- [ ] Content-hash duplicate detection
- [ ] "Missing files since last scan" (diff on re-scan)
- [ ] File lists silently stop at 20,000 entries
- [ ] Accessibility & readability pass 2: font sizes and remaining hard-coded colors

## Backlog

- [ ] **Sign Windows releases** — SignPath Foundation declined 2026-10-07 (visibility); re-apply later or use a paid plan _(parked)_
- [ ] Faster search for very large catalogs (FTS5 / trigram)
- [ ] Recognize drives by volume serial number
- [ ] Replace blocking `fs.existsSync` calls in IPC handlers
- [ ] Thumbnail progress bar can update a transfer row
- [ ] Export of thumbnails loads everything into memory
- [ ] Don't lower `user_version` when opening a newer database
- [ ] Research: macOS and Linux support
- [ ] Localization (Polish UI)

## Done

See [docs/PROJECT_LOG.md](docs/PROJECT_LOG.md) for what shipped and when.

## Session ritual

Every working session starts with a short **refinement**: review this roadmap and the open
issues, pick/adjust the next items, clarify acceptance criteria, then work. At the end,
update this file, `docs/PROJECT_LOG.md` and the GitHub issues. See [CLAUDE.md](CLAUDE.md).
