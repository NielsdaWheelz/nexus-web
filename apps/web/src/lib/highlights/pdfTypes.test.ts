import { describe, expect, it } from "vitest";
import { parseRawPdfQuads, rectToCanonicalQuad } from "./pdfTypes";

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

describe("rectToCanonicalQuad", () => {
  it("subtracts reference origin, divides by pageScale, and rounds to 3dp", () => {
    expect(
      rectToCanonicalQuad(
        { left: 110, right: 230, top: 60, bottom: 100 },
        { left: 10, right: 1010, top: 10, bottom: 1010 },
        2,
      ),
    ).toEqual({
      x1: 50,
      y1: 25,
      x2: 110,
      y2: 25,
      x3: 110,
      y3: 45,
      x4: 50,
      y4: 45,
    });
  });

  it("collapses sub-millisignificant decimals via 3dp rounding", () => {
    const quad = rectToCanonicalQuad(
      { left: 12.34567, right: 25.65432, top: 0, bottom: 1 },
      { left: 0, right: 100, top: 0, bottom: 100 },
      1,
    );
    expect(quad.x1).toBe(12.346);
    expect(quad.x2).toBe(25.654);
  });
});
