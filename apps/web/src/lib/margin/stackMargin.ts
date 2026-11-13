// The margin's stack (contract M): rigid targets, reached only as the text moves.
// Pure. The pane measures the ring, and writes what this returns.

/** A ring row with a measured passage: `desired` is its aligned top in the list's coordinates, `y` its
 * passage's top on screen, whose change between frames is the text's motion. */
export interface MarginRow {key: string; desired: number; height: number; y: number}
/** What the next frame continues from. Tops stay fractional, so the slew never accumulates rounding. */
export interface MarginFrame {y: ReadonlyMap<string, number>; tops: ReadonlyMap<string, number>}

/** Air between two stacked rows. */
export const MARGIN_GAP = 4;
/** The stack follows the text at most this many times as far as the text moved. */
const SLEW = 3;

/**
 * Rows in passage order. Passage spacing or height plus the gap defines the rigid target. A hold can deform
 * that spacing: continuing rows start at their finalized tops and move toward the target only with the text,
 * in its direction, at most SLEW times as far. Growth repairs physical collisions around the reading-line key.
 * With no row in common with `previous`, the stack snaps.
 */
export function stackMargin(rows: readonly MarginRow[], previous: MarginFrame | null, line: number): {
  offsets: ReadonlyMap<string, number>;   // published, first row 0, integers
  base: number;                           // first row's top, rounded once
  frame: MarginFrame;
  moved: boolean;                         // Δ !== 0, or a snap from an earlier frame
} {
  const rigid = rows.map(() => 0);
  for (let i = 1; i < rows.length; i++)
    rigid[i] = rigid[i - 1] + Math.max(Math.round(rows[i].desired - rows[i - 1].desired), Math.ceil(rows[i - 1].height) + MARGIN_GAP);
  const offsets = new Map<string, number>();
  if (rows.length === 0) return {offsets, base: 0, frame: {y: new Map(), tops: new Map()}, moved: false};
  let key = 0;
  for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i].y - line) < Math.abs(rows[key].y - line)) key = i;
  // Δ comes from passages, never `desired`: a new row's baseline measures 0 first. It is read at the common row nearest
  // the line, not the first: a held row's passage far off screen moves when layout between it and the screen changes.
  let common = -1;
  if (previous !== null) for (let i = 0; i < rows.length; i++)
    if (previous.y.has(rows[i].key) && (common < 0 || Math.abs(rows[i].y - line) < Math.abs(rows[common].y - line))) common = i;
  let top: number, moved: boolean, delta = 0;
  if (previous === null || common < 0) {
    top = rows[key].desired;
    moved = previous !== null;
  } else {
    delta = rows[common].y - previous.y.get(rows[common].key)!;
    // a key new to the ring takes its top from the rigid stack.
    top = previous.tops.get(rows[key].key) ?? previous.tops.get(rows[common].key)! + rigid[key] - rigid[common];
    top += Math.min(Math.max(rows[key].desired - top, Math.min(0, SLEW * delta)), Math.max(0, SLEW * delta));
    moved = delta !== 0;
  }
  const first = top - rigid[key];
  const target = rigid.map(offset => first + offset);
  const tops = rows.map((row, i) => previous?.tops.get(row.key) ?? target[i]);
  if (previous !== null && common >= 0) {
    // Growth or admission can make the previous layout overlap. Repair that before clamping:
    // a common directional clamp between two feasible layouts preserves nonoverlap.
    for (let i = key + 1; i < rows.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + Math.ceil(rows[i - 1].height) + MARGIN_GAP);
    for (let i = key - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - Math.ceil(rows[i].height) - MARGIN_GAP);
    for (let i = 0; i < rows.length; i++)
      tops[i] += Math.min(Math.max(target[i] - tops[i], Math.min(0, SLEW * delta)), Math.max(0, SLEW * delta));
  }
  const base = Math.round(tops[0]);
  for (let i = 0; i < rows.length; i++) offsets.set(rows[i].key, Math.round(tops[i]) - base);
  return {
    offsets,
    base,
    frame: {y: new Map(rows.map(row => [row.key, row.y])), tops: new Map(rows.map((row, i) => [row.key, tops[i]]))},
    moved,
  };
}
