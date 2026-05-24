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
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const quad = entry as Record<string, unknown>;
    const { x1, y1, x2, y2, x3, y3, x4, y4 } = quad;
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
