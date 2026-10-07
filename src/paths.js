'use strict';

// Path guards shared by the main process. Kept free of Electron imports so they
// can be unit-tested.

const path = require('path');

// True only if `child` is strictly inside `parent` (the parent itself is not).
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// Join a catalog-relative path onto a drive root, refusing anything that would
// land outside the root (catalog imports are untrusted: "..", absolute paths).
function safeJoin(root, rel) {
  if (!root || typeof rel !== 'string' || !rel) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  return isInside(base, full) ? full : null;
}

module.exports = { isInside, safeJoin };
