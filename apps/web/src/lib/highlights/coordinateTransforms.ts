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

export function readPdfPageViewportTransform(
  pageElement: HTMLElement,
): PdfPageViewportTransform | null {
  const scale = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-scale") ?? "",
  );
  const viewportWidth = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-viewport-width") ?? "",
  );
  const viewportHeight = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-viewport-height") ?? "",
  );
  const dpiScale = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-dpi-scale") ?? "1",
  );

  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0 ||
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= 0 ||
    !Number.isFinite(dpiScale) ||
    dpiScale <= 0
  ) {
    return null;
  }

  const rotation = normalizeQuarterTurnRotation(
    Number.parseInt(
      pageElement.getAttribute("data-nexus-page-rotation") ?? "0",
      10,
    ),
  );

  return {
    scale,
    rotation,
    dpiScale,
    pageWidthPoints:
      rotation === 90 || rotation === 270
        ? viewportHeight / scale
        : viewportWidth / scale,
    pageHeightPoints:
      rotation === 90 || rotation === 270
        ? viewportWidth / scale
        : viewportHeight / scale,
  };
}


/** Inverse of the page transform used by selection and visible-source queries. */
export function viewportPointToPagePoint(x: number, y: number, transform: PdfPageViewportTransform): PdfViewportPoint {
  const scale = transform.scale * transform.dpiScale;
  const left = x / scale;
  const top = y / scale;
  switch (transform.rotation) {
    case 0: return { x: left, y: top };
    case 90: return { x: top, y: transform.pageHeightPoints - left };
    case 180: return { x: transform.pageWidthPoints - left, y: transform.pageHeightPoints - top };
    case 270: return { x: transform.pageWidthPoints - top, y: left };
  }
}
