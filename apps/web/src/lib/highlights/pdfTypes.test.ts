import { describe, expect, it } from "vitest";
import { parseRawPdfQuads } from "./pdfTypes";

describe("parseRawPdfQuads", () => {
  it("returns parsed quads when all coordinates are numeric", () => {
    expect(
      parseRawPdfQuads([
        { x1: 1, y1: 2, x2: 3, y2: 4, x3: 5, y3: 6, x4: 7, y4: 8 },
      ]),
    ).toEqual([{ x1: 1, y1: 2, x2: 3, y2: 4, x3: 5, y3: 6, x4: 7, y4: 8 }]);
  });

  it("returns an empty array when the input is not an array", () => {
    expect(parseRawPdfQuads(undefined)).toEqual([]);
    expect(parseRawPdfQuads(null)).toEqual([]);
    expect(parseRawPdfQuads({ x1: 1 })).toEqual([]);
  });

  it("drops entries that miss any of the eight coordinates", () => {
    expect(
      parseRawPdfQuads([
        { x1: 1, y1: 2, x2: 3, y2: 4, x3: 5, y3: 6, x4: 7 },
        { x1: 1, y1: 2, x2: 3, y2: 4, x3: 5, y3: 6, x4: 7, y4: 8 },
        null,
        "not-a-quad",
      ]),
    ).toEqual([{ x1: 1, y1: 2, x2: 3, y2: 4, x3: 5, y3: 6, x4: 7, y4: 8 }]);
  });
});
