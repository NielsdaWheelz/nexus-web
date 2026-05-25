// Single-source-of-truth icon pipeline. Reads the master asterism SVG and
// regenerates every derived icon: Android adaptive launcher foreground +
// monochrome (vector XML, 108dp), Android notification icon (vector XML,
// 24dp), Android launcher colors, the Google Play Console 512x512 PNG, and
// the browser extension PNGs at 16/32/48/128 px. Pure Node, no native deps.
//
//   node scripts/build-icons.mjs
//   make build-icons

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER_SVG = "apps/web/public/brand/asterism.svg";

const FG_GOLD = "#c4a472";
const BG_DARK = "#15140f";

function readMasterDots() {
  const svg = readFileSync(resolve(REPO_ROOT, MASTER_SVG), "utf8");
  const dots = [];
  const re = /<circle\b[^>]*\bcx="([\d.]+)"[^>]*\bcy="([\d.]+)"[^>]*\br="([\d.]+)"/g;
  let m;
  while ((m = re.exec(svg))) {
    dots.push({ x: Number(m[1]), y: Number(m[2]), r: Number(m[3]) });
  }
  if (dots.length !== 3) {
    throw new Error(`expected 3 <circle> elements in ${MASTER_SVG}, got ${dots.length}`);
  }
  return dots;
}

// Optical sizing: at small rendered sizes, anti-aliased sub-2px disks vanish
// into the background. Nudge radii up to keep the mark legible. Vector outputs
// also rasterize at fixed visible sizes (notification icon ~24px, launcher
// 108dp at any density) so the same table applies.
function opticalBoost(size) {
  if (size <= 16) return 1.4;
  if (size <= 24) return 1.2;
  if (size <= 32) return 1.08;
  return 1.0;
}

function scaleDotsForVector(masterDots, viewport) {
  const k = viewport / 64;
  const boost = opticalBoost(viewport);
  const snapCenter = (v) => Math.round(v);
  const snapRadius = (v) => Math.round(v * 2) / 2;
  return masterDots.map((d) => ({
    x: snapCenter(d.x * k),
    y: snapCenter(d.y * k),
    r: snapRadius(d.r * k * boost),
  }));
}

function circleToVectorPath(d) {
  const left = d.x - d.r;
  const span = d.r * 2;
  return `M${left},${d.y} a${d.r},${d.r} 0 1,0 ${span},0 a${d.r},${d.r} 0 1,0 -${span},0 Z`;
}

function makeLauncherVector(viewport, dots, fillRef) {
  const paths = dots
    .map(
      (d) =>
        `    <path\n        android:fillColor="${fillRef}"\n        android:pathData="${circleToVectorPath(d)}" />`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${viewport}dp"
    android:height="${viewport}dp"
    android:viewportWidth="${viewport}"
    android:viewportHeight="${viewport}">
${paths}
</vector>
`;
}

function makeNotificationVector(dots) {
  const paths = dots
    .map(
      (d) =>
        `    <path\n        android:fillColor="#FFFFFFFF"\n        android:pathData="${circleToVectorPath(d)}" />`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24"
    android:tint="?attr/colorControlNormal">
${paths}
</vector>
`;
}

function makeColorsXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BG_DARK}</color>
    <color name="ic_launcher_foreground">${FG_GOLD}</color>
</resources>
`;
}

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
function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(width, height, rgba) {
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
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function hexRgb(hex) {
  const h = hex.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function renderAsterismPng({ size, masterDots, fg, bg }) {
  const k = size / 64;
  const boost = opticalBoost(size);
  const dots = masterDots.map((d) => ({ x: d.x * k, y: d.y * k, r: d.r * k * boost }));
  const [fr, fgChan, fb] = hexRgb(fg);
  const [br, bgChan, bb] = bg ? hexRgb(bg) : [0, 0, 0];
  const opaque = Boolean(bg);
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
      if (opaque) {
        rgba[i] = Math.round(fr * cov + br * (1 - cov));
        rgba[i + 1] = Math.round(fgChan * cov + bgChan * (1 - cov));
        rgba[i + 2] = Math.round(fb * cov + bb * (1 - cov));
        rgba[i + 3] = 0xff;
      } else {
        rgba[i] = fr;
        rgba[i + 1] = fgChan;
        rgba[i + 2] = fb;
        rgba[i + 3] = Math.round(0xff * cov);
      }
    }
  }
  return encodePng(size, size, rgba);
}

function writeText(rel, text) {
  const path = resolve(REPO_ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`wrote ${rel} (${text.length} chars)`);
}
function writeBin(rel, buf) {
  const path = resolve(REPO_ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log(`wrote ${rel} (${buf.length} bytes)`);
}

const masterDots = readMasterDots();
console.log(`source: ${MASTER_SVG}`);
console.log(`dots: ${masterDots.map((d) => `(${d.x}, ${d.y}, r=${d.r})`).join("  ")}`);

const launcherDots = scaleDotsForVector(masterDots, 108);
writeText(
  "apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml",
  makeLauncherVector(108, launcherDots, "@color/ic_launcher_foreground"),
);
writeText(
  "apps/android/app/src/main/res/drawable/ic_launcher_monochrome.xml",
  makeLauncherVector(108, launcherDots, "#FFFFFFFF"),
);

const notificationDots = scaleDotsForVector(masterDots, 24);
writeText(
  "apps/android/app/src/main/res/drawable/ic_stat_nexus.xml",
  makeNotificationVector(notificationDots),
);

writeText(
  "apps/android/app/src/main/res/values/ic_launcher_colors.xml",
  makeColorsXml(),
);

// Google Play Console requires an opaque 512x512 launcher icon uploaded
// separately from the APK. Match the launcher composition: dark background
// with the gold mark filling the canvas at the same proportions as
// ic_launcher_foreground.xml on the 108dp adaptive canvas.
writeBin(
  "apps/android/ic_launcher-playstore.png",
  renderAsterismPng({ size: 512, masterDots, fg: FG_GOLD, bg: BG_DARK }),
);

for (const size of [16, 32, 48, 128]) {
  writeBin(
    `apps/extension/icons/${size}.png`,
    renderAsterismPng({ size, masterDots, fg: FG_GOLD, bg: null }),
  );
}
