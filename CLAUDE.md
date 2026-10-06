# Diskcorder — working notes for Claude Code

Electron + SQLite desktop app (Windows) that catalogs external drives. Plain HTML/CSS/JS in
`src/renderer/`, no framework, no build step. See `README.md` for architecture.

## Start every session with refinement

Before writing code:
1. Read `ROADMAP.md`, `docs/PROJECT_LOG.md` and the open GitHub issues
   (`gh issue list -R expressionrise/diskcorder`).
2. Summarize where we are and propose the next items (a recommendation, not a survey).
3. Clarify acceptance criteria with the user and agree on scope for the session.
4. Only then start working.

At the end of the session: update `ROADMAP.md`, `docs/PROJECT_LOG.md` and the issues.

## Conventions

- Branches: work on `develop`, merge to `main` through a PR; `main` triggers the website deploy,
  tags `vX.Y.Z` (matching `package.json`) trigger the release build.
- Commits end with the Co-Authored-By line given by the harness. Don't push or change remotes
  without the user's go-ahead; the user pushes (`! git push origin develop`).
- Security model: renderer never touches Node; all privileged work via `window.api`
  (`src/preload.js`) and handlers in `src/main.js`; validate ids/paths (`safeJoin`, `assertInt`).
- Disk operations must be cancelable and never destroy the previous version early.
- `renderer.js` is one IIFE; test the UI via DOM + `window.api` (see PROJECT_LOG gotchas).
- Test destructive things only on throw-away drives/folders, never on real user data.
- Replies to the user are in Polish.

## Accounts

GitHub owner `expressionrise` (SSH alias `github.com-expressionrise`). The `gh` CLI is usually
logged in as `hexforest` (read-only on this repo); managing issues/labels/milestones needs
`gh auth login` as `expressionrise`.
