'use strict';

/* Generates src/renderer/assets/icon.png and icon.ico — a gradient rounded
   square with a "disk + record" mark, matching the in-app brand SVG.
   Pure Node (zlib only); run with `node scripts/make-icon.js`. */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const assetsDir = path.join(__dirname, '..', 'src', 'renderer', 'assets');

// palette (matches styles.css theme)
const GOLD = [0xd4, 0xaf, 0x37];
const BLUE = [0x54, 0xae, 0xff];
const INK  = [0x0d, 0x11, 0x17];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

// signed distance to a rounded rectangle, for crisp anti-aliased edges
function roundRectAlpha(x, y, w, h, r) {
  const cx = Math.abs(x - w / 2) - (w / 2 - r);
  const cy = Math.abs(y - h / 2) - (h / 2 - r);
  const dx = Math.max(cx, 0), dy = Math.max(cy, 0);
  const dist = Math.sqrt(dx * dx + dy * dy) + Math.min(Math.max(cx, cy), 0) - r;
  return clamp01(0.5 - dist); // ~1px feather
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function buildPixels() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const c = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const outA = roundRectAlpha(x, y, SIZE, SIZE, 56);
      if (outA <= 0) { buf[i + 3] = 0; continue; }

      // diagonal gold -> blue gradient
      let col = mix(GOLD, BLUE, clamp01((x + y) / (2 * SIZE)));

      const r = Math.hypot(x - c, y - c);
      // faint outer ring
      if (Math.abs(r - 104) < 1.4) col = mix(col, [255, 255, 255], 0.30);
      // disk groove ring
      if (r < 92 && r > 78) col = mix(col, INK, 0.55 * clamp01(1 - Math.abs(r - 85) / 7));
      // central hub
      if (r < 40) col = mix(col, INK, clamp01((40 - r) / 6));
      // record dot
      if (r < 16) col = INK.slice();

      buf[i]     = Math.round(col[0]);
      buf[i + 1] = Math.round(col[1]);
      buf[i + 2] = Math.round(col[2]);
      buf[i + 3] = Math.round(outA * 255);
    }
  }
  return buf;
}

// ---- minimal PNG encoder -------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  // filter byte 0 per scanline
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- ICO container wrapping a single PNG image ---------------------------
function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0; // 256 -> stored as 0
  entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([header, entry, png]);
}

fs.mkdirSync(assetsDir, { recursive: true });
const pixels = buildPixels();
const png = encodePng(pixels);
fs.writeFileSync(path.join(assetsDir, 'icon.png'), png);
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), encodeIco(png));
console.log('Wrote icon.png (%d bytes) and icon.ico to %s', png.length, assetsDir);
