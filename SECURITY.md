# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately via
GitHub: **Security → Report a vulnerability**, or
<https://github.com/expressionrise/diskcorder/security/advisories/new>.

Include what you found, how to reproduce it and the version of Diskcorder. You can expect
an acknowledgement within a few days.

## Scope

Diskcorder is a local-first desktop app: it has no server, account system or telemetry,
and its catalog (a SQLite file) never leaves your computer. Areas we care most about:

- file operations that could touch paths outside a mapped drive (rename, delete, copy,
  move, backup, import of a catalog file),
- the Electron renderer/preload boundary (`contextIsolation`, `sandbox`, the `window.api`
  surface, the `thumbcache://` protocol),
- handling of untrusted catalog files (`.json` imports) and of media files passed to the
  bundled ffmpeg.

Supported version: the latest release.
