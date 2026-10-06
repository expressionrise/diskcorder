# Contributing to Diskcorder

Thanks for helping! Issues, ideas and pull requests are all welcome.

## Getting started

```bash
git clone https://github.com/expressionrise/diskcorder.git
cd diskcorder
npm install   # rebuilds better-sqlite3 for Electron (see the README for Node/proxy notes)
npm start
```

There is no build step: edit files under `src/` and restart `npm start`.

## Ground rules

- **Keep the security model.** The renderer never imports Node modules; privileged
  work goes through `window.api` in `src/preload.js` and the handlers in `src/main.js`.
  Validate every id/path coming from the renderer (see `safeJoin` / `assertInt`).
- **No framework, no bundler.** Plain HTML/CSS/JS in `src/renderer/`; theming stays in
  CSS variables in `styles.css`.
- **Be careful with the user's files.** Anything that writes, moves or deletes on a drive
  must be cancelable, must never destroy the previous version before the new one is
  complete, and must not touch paths outside the drive root.
- **Match the style** of the surrounding code and keep changes small and reviewable.

## Before opening a pull request

1. Branch from `develop` and open the PR against `develop`.
2. Run `node --check` on the files you changed (CI does this too).
3. Try the change in the real app, ideally with a throwaway USB drive for anything that
   touches the disk (copy, move, backup, rename, delete).
4. Describe what changed and how you tested it.

By contributing you agree your work is licensed under the project's MIT license.
Good first contributions are listed in the README's Roadmap.
