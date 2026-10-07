# Project log

Chronological record of what was built and decided. Newest first. Update at the end of
every session.

## 2026-10-06 — v0.3.0: review, hardening, polish, release, website, signing prep

**Review and fixes (full read of `src/`)**
- Path validation (`safeJoin` / `isInside`) for Delete, Rename, test file, transfer, thumbnails;
  Delete verifies type/size against the catalog; rename rejects `.`/`..`/empty/trailing dot.
- Transfer: no replace-onto-self, no copy-into-self; *replace* writes to `.diskcorder-part`
  and swaps on success; cancelled folder copies cleaned up; move keeps the source on size
  mismatch or when symlinks are present.
- Backup: temp file + rename (a cancel can't destroy the previous good copy), fixed endless
  recursion `D:\` -> `D:\x`, blocked concurrent backups.
- Re-scan of an unreadable drive no longer wipes its catalog.
- Thumbnails: ffmpeg concurrency capped at 3, jobs de-duplicated, atomic outputs, timeouts
  (likely cause of the earlier crashes; auto-generation on connect is still disabled).
- XSS-ish: drive name in capacity results via `textContent`; `thumbcache://` prefix check.
- Duplicates: refuse to delete every copy of a file.

**Features**
- Smart video stills (probe 6 positions, score sharpness/contrast/exposure, render the best);
  Previews on an up-to-date drive offers to re-create video stills.
- Media info in the detail pane (duration, resolution, fps, codecs, bitrate) via ffmpeg banner.
- Folder visit marks (dots / emoji / off, 30-day decay) in localStorage + "Frequent" list in the rail.
- Clickable tags (search by tag).
- Gallery is a responsive grid of cards.
- Readability: raised text/border contrast in all three themes (faint text was ~2.3:1).

**Release and repo**
- Version 0.3.0; package.json metadata; dynamic README badges; NSIS installer + portable exe.
- GitHub Actions: `ci.yml` (syntax check), `release.yml` (tag `v*` builds and publishes
  Setup + Portable to Releases), `pages.yml` (deploys `site/`).
- Website in `site/` -> https://expressionrise.github.io/diskcorder/
- THIRD_PARTY_NOTICES.md (bundled FFmpeg is GPLv3, separate process), CODE_SIGNING.md,
  SECURITY.md, CONTRIBUTING.md, issue/PR templates; ffmpeg license shipped in `resources/`.
- PRs merged `develop` -> `main` (#4, #5); release `v0.3.0` published with both exes.
- Applied to SignPath Foundation (free OSS code signing). 2026-10-07: application declined for
  lack of public visibility (stars/forks/contributors, external mentions). They invited a reapply
  later or a paid subscription. Decision: park signing for now; releases stay unsigned.

**How it was tested** (throw-away scripts, not in the repo yet — see the test-suite ticket)
- Electron driven through the real UI/IPC against a 2 GB USB pendrive: map drive, navigate,
  visit marks, thumbnails (generate + refresh), tags, media info, real rename/delete, all tabs.
- transfer/backup/thumbs unit-style scripts on the USB drive and local disk.
- Packaged build: `electron-builder --dir` + launch smoke test.

**Gotchas learned**
- `src/renderer/renderer.js` is wrapped in an IIFE: its functions are NOT reachable from
  `executeJavaScript`; drive the UI through the DOM (clicks) and `window.api`.
- `window.api` is exposed by preload; `api.scanDrive({ root, name })` maps a drive without a dialog.
- Test harness: a wrapper Electron script requires `src/main.js`, sets a throw-away
  `userData`, then uses `webContents.executeJavaScript` / `capturePage`.
- Install on this machine needs a CA bundle and a Node flag (see memory `install-environment`).
- Bash heredocs with backticks/`$` can break; write files with the editor tool instead.
- `gh` is logged in as `hexforest`, which has **no write access** to `expressionrise/diskcorder`;
  pushes use the SSH alias `github.com-expressionrise` (key = expressionrise). Creating
  labels/milestones needs `gh auth login` as `expressionrise`.
- Remote-changing actions (set-url, push) may be blocked by the permission classifier; the
  user pushes with `! git push ...`.

## 2026-06-23 — v0.2.0 feature burst
Test Drive tab (health scan + capacity verification), Backup tab, Starred tab, multi-select,
file flags, context menu, session memory, drive identification (`.diskcorder-id`), export to
computer or the drive, first-launch tutorial, themes, UX label cleanup; thumbnails switched
to manual after crashes.

## 2026-06-16 … 06-18 — v0.1 / v0.2 foundations
Scaffold (main/preload/db/scanner/UI), scan controls, tags, duplicates, treemap, thumbnails
with pause/resume, view modes (folders/list/gallery), folder tree, themes, lazy lists, README.
