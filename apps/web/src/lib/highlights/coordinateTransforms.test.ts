import { describe, expect, it } from "vitest";
import {
  normalizeQuarterTurnRotation,
  pagePointToViewportPoint,
  paneYFromViewerViewportY,
  projectPdfQuadToViewportRect,
  toViewerViewportY,
  viewerScrollYFromClientY,
  viewportPointToPagePoint,
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

  it("converts client Y to viewer-scroll Y deterministically", () => {
    const viewerY = viewerScrollYFromClientY(420, 200, 1000);
    expect(viewerY as number).toBe(1220);
  });

  it("converts viewer-viewport Y into pane space using explicit baseline", () => {
    const paneY = paneYFromViewerViewportY(toViewerViewportY(160), 52);
    expect(paneY as number).toBe(212);
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

  it("round-trips page points through viewport transforms for all rotations", () => {
    const rotations: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];
    const transformBase = {
      scale: 1.5,
      dpiScale: 1.25,
      pageWidthPoints: 612,
      pageHeightPoints: 792,
    };
    for (const rotation of rotations) {
      const transform: PdfPageViewportTransform = { ...transformBase, rotation };
      const point = pagePointToViewportPoint(120 as never, 260 as never, transform);
      const recovered = viewportPointToPagePoint(point, transform);
      expectClose(recovered.x as number, 120);
      expectClose(recovered.y as number, 260);
    }
  });
});

