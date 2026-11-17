import type { Schema } from "@/lib/api/wire";
import { fnv1a, rng } from "./material";

type Unit = Schema<"UnitOut">;

export function stretch(units: readonly Unit[], position: number | null): readonly [number, number] {
  if (units.length <= 16) return [0, 1];
  const at = units.findLastIndex(unit => unit.start <= (position ?? 0));
  const current = units[Math.max(0, at)];
  if (current.part !== null) {
    const part = units.filter(unit => unit.part === current.part);
    if (part.length <= 16) return [part[0].start, part[part.length - 1].end];
  }
  const start = Math.min(Math.max(0, at - 4), units.length - 13);
  return [units[start].start, units[start + 12].end];
}

function bump(values: Float32Array, center: number, height: number, left: number, right: number, power: number) {
  const start = Math.max(0, Math.floor(center - left));
  const end = Math.min(values.length - 1, Math.ceil(center + right));
  for (let x = start; x <= end; x++) {
    const distance = x < center ? (center - x) / left : (x - center) / right;
    if (distance < 1) values[x] = Math.max(values[x], height * Math.pow(1 - distance, power));
  }
}

function smooth(values: Float32Array, radius: number) {
  const copy = Float32Array.from(values);
  for (let x = 0; x < values.length; x++) {
    let sum = 0, count = 0;
    for (let k = -radius; k <= radius; k++) {
      if (x + k >= 0 && x + k < values.length) { sum += copy[x + k]; count++; }
    }
    values[x] = sum / count;
  }
}

/** Three ranges from the same unit weights; the near range has one peak per unit. */
export function ridge({ mediaId, units, range: [a, b], width, height }: {
  mediaId: string;
  units: readonly Unit[];
  range: readonly [number, number];
  width: number;
  height: number;
}): { near: Float32Array; middle: Float32Array; far: Float32Array } {
  const shown = units.flatMap((unit, index) => unit.end > a && unit.start < b ? [{ ...unit, index }] : []);
  const roomy = shown.length <= 16;
  const longest = Math.max(...units.map(unit => unit.weight), Number.EPSILON);
  const near = new Float32Array(width + 1), middle = new Float32Array(width + 1), far = new Float32Array(width + 1);
  if (shown.length === 0) return { near, middle, far };
  for (const unit of shown) {
    const random = rng(fnv1a(`${mediaId}:${unit.index}`));
    const j1 = random(), j2 = random(), j3 = random(), j4 = random(), j5 = random();
    const span = Math.max(2, (unit.end - unit.start) / (b - a) * width);
    const center = ((unit.start + unit.end) / 2 - a) / (b - a) * width + (j1 - 0.5) * span * 0.25;
    const tall = Math.sqrt(unit.weight / longest);
    const peak = roomy ? height * 0.8 * (0.26 + 0.74 * tall) : height * 0.36 * (0.2 + 0.8 * tall);
    const left = Math.max(2.5, span * (roomy ? 0.85 + j2 * 0.3 : 0.7 + j2 * 0.5));
    const right = Math.max(2.5, span * (roomy ? 0.85 + j3 * 0.3 : 0.7 + j3 * 0.5));
    bump(near, center, peak, left, right, roomy ? 1.45 : 1.3);
    if (roomy) bump(far, center + (j5 - 0.5) * span * 1.6,
      Math.min(height * 0.98, peak * 0.8 + height * 0.32), left * 3 + 10, right * 3 + 10, 1.15);
    bump(middle, center + (j4 - 0.5) * span * 0.9,
      Math.min(height * 0.95, roomy ? peak * 1.1 + height * 0.1 : peak * 1.9 + height * 0.1),
      left * (roomy ? 1.7 : 2.6) + 8, right * (roomy ? 1.7 : 2.6) + 8, 1.1);
  }
  smooth(near, roomy ? 3 : width / shown.length < 6 ? 3 : width / shown.length < 10 ? 2 : 1);
  smooth(middle, 3);
  const parts = new Map<number | null, { start: number; end: number; weight: number }>();
  for (const unit of shown) {
    const part = parts.get(unit.part);
    if (part === undefined) parts.set(unit.part, { start: unit.start, end: unit.end, weight: unit.weight });
    else { part.end = unit.end; part.weight += unit.weight; }
  }
  if (roomy) smooth(far, 5);
  else if (parts.size > 1) {
    const biggest = Math.max(...[...parts.values()].map(part => part.weight), Number.EPSILON);
    for (const [index, part] of parts) {
      const random = rng(fnv1a(`${mediaId}/${index}`));
      const half = (part.end - part.start) / (b - a) * width * 0.78;
      bump(far, ((part.start + part.end) / 2 - a) / (b - a) * width + (random() - 0.5) * half * 0.3,
        height * (0.74 + 0.24 * part.weight / biggest), half, half, 1.05);
    }
  } else {
    far.set(middle);
    smooth(far, Math.max(5, Math.round(width / 26)));
    const top = Math.max(...far, 1);
    for (let x = 0; x <= width; x++) far[x] = height * (0.3 + 0.68 * far[x] / top);
  }
  smooth(far, 4);
  for (let x = 0; x <= width; x++) {
    far[x] = Math.max(far[x], height * 0.26);
    near[x] = Math.max(near[x], roomy ? height * 0.07 : 2.5);
    middle[x] = Math.max(middle[x], near[x] * 0.6 + 4);
  }
  return { near, middle, far };
}
