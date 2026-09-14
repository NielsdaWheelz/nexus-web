// The worker's pinned Node/ICU owns the same dictionary-aware operation as Pane Find.
// Input is one original canonical fragment, never an independently split unit.
import { readFileSync, writeSync } from "node:fs";

const text = readFileSync(0, "utf8");
const segmenter = new Intl.Segmenter("und", { granularity: "word" });
const buffer = Buffer.allocUnsafe(16 * 1024);
let used = 0;
let position = 0;

function flush() {
  let written = 0;
  while (written < used) written += writeSync(1, buffer, written, used - written);
  used = 0;
}

function boundary(value) {
  buffer.writeUInt32LE(value, used);
  used += 4;
  if (used === buffer.length) {
    flush();
  }
}

boundary(0);
for (const { segment } of segmenter.segment(text)) {
  for (const _point of segment) position += 1;
  boundary(position);
}
if (used > 0) flush();
