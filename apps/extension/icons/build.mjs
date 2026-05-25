// Generates 16/32/48/128 PNG icons for the browser extension from the master
// asterism geometry. Pure Node — no native deps. Run after editing geometry:
//   node apps/extension/icons/build.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const FG = [0xc4, 0xa4, 0x72];
const MASTER_DOTS = [
  { x: 32, y: 18, r: 6.5 },
  { x: 18, y: 44, r: 5.5 },
  { x: 46, y: 44, r: 5.5 },
];

function renderAsterism(size) {
  const k = size / 64;
  // Optical sizing: nudge dot radii up at small sizes so the mark stays legible
  // (anti-aliased sub-2px disks otherwise vanish into transparent background).
  const boost = size <= 16 ? 1.4 : size <= 24 ? 1.2 : size <= 32 ? 1.08 : 1.0;
  const dots = MASTER_DOTS.map((d) => ({ x: d.x * k, y: d.y * k, r: d.r * k * boost }));
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0;
      for (const d of dots) {
        const dx = x + 0.5 - d.x;
        const dy = y + 0.5 - d.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const c = Math.max(0, Math.min(1, d.r + 0.5 - dist));
        if (c > cov) cov = c;
      }
      const i = (y * size + x) * 4;
      rgba[i] = FG[0];
      rgba[i + 1] = FG[1];
      rgba[i + 2] = FG[2];
      rgba[i + 3] = Math.round(0xff * cov);
    }
  }
  return makePng(size, size, rgba);
}

for (const size of [16, 32, 48, 128]) {
  const buf = renderAsterism(size);
  writeFileSync(new URL(`./${size}.png`, import.meta.url), buf);
  console.log(`wrote ${size}.png (${buf.length} bytes)`);
}
