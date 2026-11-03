// The margin's stack (contract M): ring rows at rigid spacing, and a base only the text moves.
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
 * Rows in passage order. Each keeps its passage's spacing, or its own height and the gap when that is larger,
 * so rows never move against each other. The key, the row whose passage is nearest the reading line (screen
 * coordinates, as `y`), keeps its previous top, and walks toward its passage only in the frame the text moves,
 * in the text's direction, at most SLEW times as far. The text's motion is measured at the reading line too. With no
 * row in common with `previous`, the stack snaps.
 */
export function stackMargin(rows: readonly MarginRow[], previous: MarginFrame | null, line: number): {
  offsets: ReadonlyMap<string, number>;   // rigid, first row 0, integers
  base: number;                           // first row's top, rounded once
  frame: MarginFrame;
  moved: boolean;                         // Δ !== 0, or a snap from an earlier frame
} {
  const rigid = rows.map(() => 0);
  for (let i = 1; i < rows.length; i++)
    rigid[i] = rigid[i - 1] + Math.max(Math.round(rows[i].desired - rows[i - 1].desired), Math.ceil(rows[i - 1].height) + MARGIN_GAP);
  const offsets = new Map(rows.map((row, i) => [row.key, rigid[i]]));
  if (rows.length === 0) return {offsets, base: 0, frame: {y: new Map(), tops: new Map()}, moved: false};
  let key = 0;
  for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i].y - line) < Math.abs(rows[key].y - line)) key = i;
  // Δ comes from passages, never `desired`: a new row's baseline measures 0 first. It is read at the common row nearest
  // the line, not the first: a held row's passage far off screen moves when layout between it and the screen changes.
  let common = -1;
  if (previous !== null) for (let i = 0; i < rows.length; i++)
    if (previous.y.has(rows[i].key) && (common < 0 || Math.abs(rows[i].y - line) < Math.abs(rows[common].y - line))) common = i;
  let top: number, moved: boolean;
  if (previous === null || common < 0) {
    top = rows[key].desired;
    moved = previous !== null;
  } else {
    const delta = rows[common].y - previous.y.get(rows[common].key)!;
    // a key new to the ring takes its top from the rigid stack.
    top = previous.tops.get(rows[key].key) ?? previous.tops.get(rows[common].key)! + rigid[key] - rigid[common];
    top += Math.min(Math.max(rows[key].desired - top, Math.min(0, SLEW * delta)), Math.max(0, SLEW * delta));
    moved = delta !== 0;
  }
  const first = top - rigid[key];
  return {
    offsets,
    base: Math.round(first),
    frame: {y: new Map(rows.map(row => [row.key, row.y])), tops: new Map(rows.map((row, i) => [row.key, first + rigid[i]]))},
    moved,
  };
}
