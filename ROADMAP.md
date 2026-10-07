# Diskcorder roadmap

_Last refined: 2026-10-06 · current release: **v0.3.0** · tracker: [GitHub issues](https://github.com/expressionrise/diskcorder/issues) and [milestones](https://github.com/expressionrise/diskcorder/milestones)._

The detailed tickets live in [`docs/roadmap/issues.json`](docs/roadmap/issues.json) and are
created on GitHub with `node scripts/create-issues.js` (re-runnable, skips existing titles).
Titles below match the issue titles.

## Now: v0.3.1 (post-release polish)

- [ ] **Sign Windows releases with SignPath Foundation** — rejected 2026-10-07 (not enough public visibility: stars, forks, external mentions); on hold, reapply once the project has gained traction _(parked)_
- [ ] Stop shipping ffmpeg twice (shrink the installer, currently ~142 MB)
- [ ] Portable build: keep data next to the exe
- [ ] Automated test suite (transfer, backup, thumbnails, db) running in CI
- [ ] Smoke-test the packaged app in CI (`electron-builder --dir`)
- [ ] Check the orange warning frames/banners (delete, move, replace) in all three themes; decide on a one-time first-run "can delete files" notice
- [ ] Test symbolic-link behavior and the Gallery multi-select layout
- [ ] Website: realistic screenshots and the expressionrise.com project card (+ repo topics)

## Next: v0.4.0

- [ ] Publish to the Microsoft Store as MSIX (Microsoft signs it; needs Partner Center account, name reservation, privacy policy, store listing; after the test suite)
- [ ] Opt-in auto-generation of thumbnails when a drive connects
- [ ] Choose a destination subfolder for copy / move
- [ ] Update the catalog live after copy / move
- [ ] Content-hash duplicate detection
- [ ] "Missing files since last scan" (diff on re-scan)
- [ ] File lists silently stop at 20,000 entries
- [ ] Accessibility & readability pass 2: font sizes and remaining hard-coded colors

## Backlog

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
