import type { PdfHighlightQuad } from "./pdfTypes";

export interface PdfPageViewportTransform {
  scale: number;
  rotation: 0 | 90 | 180 | 270;
  pageWidthPoints: number;
  pageHeightPoints: number;
  dpiScale: number;
}

export interface PdfViewportPoint {
  x: number;
  y: number;
}

export interface PdfViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MIN_RECT_SIZE = 1;

/** Sub-point threshold below which PDF geometry dimensions are treated as zero. */
export const PDF_QUAD_EPSILON = 0.001;

/** True when both dimensions are above the sub-point treat-as-zero threshold. */
export function isValidPdfRect(rect: {
  width: number;
  height: number;
}): boolean {
  return rect.width > PDF_QUAD_EPSILON && rect.height > PDF_QUAD_EPSILON;
}

export function normalizeQuarterTurnRotation(rotation: number): 0 | 90 | 180 | 270 {
  const normalized = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized;
  }
  return 0;
}

export function pagePointToViewportPoint(
  x: number,
  y: number,
  transform: PdfPageViewportTransform
): PdfViewportPoint {
  const effectiveScale = transform.scale * transform.dpiScale;

  switch (transform.rotation) {
    case 90:
      return {
        x: (transform.pageHeightPoints - y) * effectiveScale,
        y: x * effectiveScale,
      };
    case 180:
      return {
        x: (transform.pageWidthPoints - x) * effectiveScale,
        y: (transform.pageHeightPoints - y) * effectiveScale,
      };
    case 270:
      return {
        x: y * effectiveScale,
        y: (transform.pageWidthPoints - x) * effectiveScale,
      };
    case 0:
    default:
      return {
        x: x * effectiveScale,
        y: y * effectiveScale,
      };
  }
}

export function projectPdfQuadToViewportRect(
  quad: PdfHighlightQuad,
  transform: PdfPageViewportTransform
): PdfViewportRect {
  const points = [
    pagePointToViewportPoint(quad.x1, quad.y1, transform),
    pagePointToViewportPoint(quad.x2, quad.y2, transform),
    pagePointToViewportPoint(quad.x3, quad.y3, transform),
    pagePointToViewportPoint(quad.x4, quad.y4, transform),
  ];

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  return {
    left,
    top,
    width: Math.max(right - left, MIN_RECT_SIZE),
    height: Math.max(bottom - top, MIN_RECT_SIZE),
  };
}
