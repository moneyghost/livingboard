// Renders the app icon (orange rounded square + white ✳) to PNG without dependencies.
// Run: node scripts/make-icons.mjs  → public/icon-192.png, icon-512.png, apple-touch-icon.png
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0xd9, 0x77, 0x57];
const FG = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function icon(size, { rounded }) {
  const r = size * 0.22;
  const half = size / 2;
  const arm = size * 0.27;
  const stroke = size * 0.045;
  const spokes = [0, 45, 90, 135].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return [half - Math.cos(a) * arm, half - Math.sin(a) * arm, half + Math.cos(a) * arm, half + Math.sin(a) * arm];
  });
  const inBg = (x, y) => {
    if (!rounded) return true;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return Math.hypot(x - cx, y - cy) <= r;
  };
  const inFg = (x, y) => spokes.some(([ax, ay, bx, by]) => segDist(x, y, ax, ay, bx, by) <= stroke);
  const S = 4;
  return png(size, (x, y) => {
    let bg = 0;
    let fg = 0;
    for (let i = 0; i < S; i++)
      for (let j = 0; j < S; j++) {
        const sx = x + (i + 0.5) / S;
        const sy = y + (j + 0.5) / S;
        if (inBg(sx, sy)) {
          bg++;
          if (inFg(sx, sy)) fg++;
        }
      }
    const a = bg / (S * S);
    const f = bg ? fg / bg : 0;
    const c = BG.map((v, k) => Math.round(v * (1 - f) + FG[k] * f));
    return [...c, Math.round(a * 255)];
  });
}

const out = new URL("../public/", import.meta.url);
writeFileSync(new URL("icon-192.png", out), icon(192, { rounded: true }));
writeFileSync(new URL("icon-512.png", out), icon(512, { rounded: true }));
// iOS rounds the corners itself and wants an opaque square.
writeFileSync(new URL("apple-touch-icon.png", out), icon(180, { rounded: false }));
console.log("icons written");
