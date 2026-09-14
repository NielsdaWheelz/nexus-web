import { expectExactRecord, expectFiniteNumber } from "@/lib/validation";

export interface PdfHighlightQuad {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
}

/** Strict wire boundary; unlike raw legacy overlays, no quad can be discarded. */
export function decodePdfHighlightQuad(raw: unknown, name: string): PdfHighlightQuad {
  const row = expectExactRecord(raw, ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"], name);
  return {
    x1: expectFiniteNumber(row.x1, `${name}.x1`), y1: expectFiniteNumber(row.y1, `${name}.y1`),
    x2: expectFiniteNumber(row.x2, `${name}.x2`), y2: expectFiniteNumber(row.y2, `${name}.y2`),
    x3: expectFiniteNumber(row.x3, `${name}.x3`), y3: expectFiniteNumber(row.y3, `${name}.y3`),
    x4: expectFiniteNumber(row.x4, `${name}.x4`), y4: expectFiniteNumber(row.y4, `${name}.y4`),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function canonicalPoint(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Project a viewport-space rect into a PDF-space `PdfHighlightQuad` by
 * subtracting the reference layer/page origin and dividing by the page scale.
 * Coordinates are rounded to 3 decimal places so equal selections produce
 * identical quads across renders.
 */
export function rectToCanonicalQuad(
  rect: RectLike,
  reference: RectLike,
  pageScale: number,
): PdfHighlightQuad {
  const left = canonicalPoint((rect.left - reference.left) / pageScale);
  const right = canonicalPoint((rect.right - reference.left) / pageScale);
  const top = canonicalPoint((rect.top - reference.top) / pageScale);
  const bottom = canonicalPoint((rect.bottom - reference.top) / pageScale);
  return {
    x1: left,
    y1: top,
    x2: right,
    y2: top,
    x3: right,
    y3: bottom,
    x4: left,
    y4: bottom,
  };
}

/**
 * Narrow an unknown value into `PdfHighlightQuad[]`. Returns `[]` if the input
 * is not an array, individual entries are dropped if any of the eight numeric
 * coordinates is missing or non-numeric.
 */
export function parseRawPdfQuads(value: unknown): PdfHighlightQuad[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const { x1, y1, x2, y2, x3, y3, x4, y4 } = entry;
    if (
      typeof x1 !== "number" ||
      typeof y1 !== "number" ||
      typeof x2 !== "number" ||
      typeof y2 !== "number" ||
      typeof x3 !== "number" ||
      typeof y3 !== "number" ||
      typeof x4 !== "number" ||
      typeof y4 !== "number"
    ) {
      return [];
    }
    return [{ x1, y1, x2, y2, x3, y3, x4, y4 }];
  });
}
