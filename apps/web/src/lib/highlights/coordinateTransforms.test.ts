import { describe, expect, it } from "vitest";
import {
  isValidPdfRect,
  normalizeQuarterTurnRotation,
  pagePointToViewportPoint,
  projectPdfQuadToViewportRect,
  type PdfPageViewportTransform,
} from "./coordinateTransforms";

const EPSILON = 0.001;

function expectClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(EPSILON);
}

describe("coordinateTransforms", () => {
  it("normalizes arbitrary rotation to quarter turns", () => {
    expect(normalizeQuarterTurnRotation(0)).toBe(0);
    expect(normalizeQuarterTurnRotation(90)).toBe(90);
    expect(normalizeQuarterTurnRotation(180)).toBe(180);
    expect(normalizeQuarterTurnRotation(270)).toBe(270);
    expect(normalizeQuarterTurnRotation(360)).toBe(0);
    expect(normalizeQuarterTurnRotation(-90)).toBe(270);
    expect(normalizeQuarterTurnRotation(91)).toBe(90);
  });

  it("keeps projection invariant across equivalent zoom*dpi products", () => {
    const quad = {
      x1: 72,
      y1: 120,
      x2: 144,
      y2: 120,
      x3: 144,
      y3: 132,
      x4: 72,
      y4: 132,
    };
    const cssScaled: PdfPageViewportTransform = {
      scale: 2,
      dpiScale: 1,
      rotation: 0,
      pageWidthPoints: 612,
      pageHeightPoints: 792,
    };
    const dpiScaled: PdfPageViewportTransform = {
      scale: 1,
      dpiScale: 2,
      rotation: 0,
      pageWidthPoints: 612,
      pageHeightPoints: 792,
    };
    const rectA = projectPdfQuadToViewportRect(quad, cssScaled);
    const rectB = projectPdfQuadToViewportRect(quad, dpiScaled);
    expectClose(rectA.left, rectB.left);
    expectClose(rectA.top, rectB.top);
    expectClose(rectA.width, rectB.width);
    expectClose(rectA.height, rectB.height);
  });

  it("treats sub-epsilon rects as invalid", () => {
    expect(isValidPdfRect({ width: 1, height: 1 })).toBe(true);
    expect(isValidPdfRect({ width: 0, height: 1 })).toBe(false);
    expect(isValidPdfRect({ width: 1, height: 0 })).toBe(false);
    expect(isValidPdfRect({ width: 0.001, height: 0.001 })).toBe(false);
    expect(isValidPdfRect({ width: 0.002, height: 0.002 })).toBe(true);
  });

  it("projects page points for all rotations", () => {
    const cases: Array<[0 | 90 | 180 | 270, number, number]> = [
      [0, 225, 487.5],
      [90, 997.5, 225],
      [180, 922.5, 997.5],
      [270, 487.5, 922.5],
    ];
    const transformBase = {
      scale: 1.5,
      dpiScale: 1.25,
      pageWidthPoints: 612,
      pageHeightPoints: 792,
    };
    for (const [rotation, expectedX, expectedY] of cases) {
      const transform: PdfPageViewportTransform = { ...transformBase, rotation };
      const point = pagePointToViewportPoint(120 as never, 260 as never, transform);
      expectClose(point.x, expectedX);
      expectClose(point.y, expectedY);
    }
  });
});
