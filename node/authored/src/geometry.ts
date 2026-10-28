/** Existing PDF page-space convention: bounding rectangles, decimal 0.001pt
 * round-half-away-from-zero, ordered top/left/bottom/right. Literal quote is kept. */
import type { Quad, SelectionCapture } from "./types.ts";
function quantize(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError("PDF coordinate must be finite");
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(Math.abs(value).toString());
  if (!match) throw new TypeError("Invalid PDF coordinate");
  const fraction = match[2] ?? "";
  const shift = Number(match[3] ?? 0) - fraction.length + 3;
  let units = BigInt(match[1]! + fraction);
  if (shift >= 0) units *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    units = units / divisor + (units % divisor * 2n >= divisor ? 1n : 0n);
  }
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("PDF coordinate exceeds exact millipoint capacity");
  return (value < 0 ? -Number(units) : Number(units)) / 1000;
}
export function canonicalQuads(quads: readonly Quad[]): Quad[] {
  if (quads.length < 1 || quads.length > 512) throw new TypeError("PDF selection requires 1–512 quads");
  return quads.map(quad => {
    const left = quantize(Math.min(quad.x1, quad.x2, quad.x3, quad.x4));
    const right = quantize(Math.max(quad.x1, quad.x2, quad.x3, quad.x4));
    const top = quantize(Math.min(quad.y1, quad.y2, quad.y3, quad.y4));
    const bottom = quantize(Math.max(quad.y1, quad.y2, quad.y3, quad.y4));
    if (right <= left || bottom <= top) throw new TypeError("PDF selection has zero area after normalization");
    return { x1: left, y1: top, x2: right, y2: top, x3: right, y3: bottom, x4: left, y4: bottom };
  }).sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1 || a.y3 - b.y3 || a.x3 - b.x3);
}
export function canonicalSelection(selection: SelectionCapture): SelectionCapture {
  if (selection.locator.type !== "pdf_page_geometry") return selection;
  if ([...selection.quote_exact].length > 2000) throw new TypeError("PDF quote exceeds 2000 codepoints");
  return { ...selection, locator: { ...selection.locator, quads: canonicalQuads(selection.locator.quads) } };
}
