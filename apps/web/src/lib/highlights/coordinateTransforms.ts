import type { PdfHighlightQuad } from "./pdfTypes";

type BrandedNumber<Tag extends string> = number & { readonly __brand: Tag };

export type PageSpaceX = BrandedNumber<"page-space-x">;
export type PageSpaceY = BrandedNumber<"page-space-y">;

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

function toPageSpaceX(value: number): PageSpaceX {
  return value as PageSpaceX;
}

function toPageSpaceY(value: number): PageSpaceY {
  return value as PageSpaceY;
}

export function normalizeQuarterTurnRotation(rotation: number): 0 | 90 | 180 | 270 {
  const normalized = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized;
  }
  return 0;
}

export function pagePointToViewportPoint(
  x: PageSpaceX,
  y: PageSpaceY,
  transform: PdfPageViewportTransform
): PdfViewportPoint {
  const effectiveScale = transform.scale * transform.dpiScale;
  const px = x as number;
  const py = y as number;

  switch (transform.rotation) {
    case 90:
      return {
        x: (transform.pageHeightPoints - py) * effectiveScale,
        y: px * effectiveScale,
      };
    case 180:
      return {
        x: (transform.pageWidthPoints - px) * effectiveScale,
        y: (transform.pageHeightPoints - py) * effectiveScale,
      };
    case 270:
      return {
        x: py * effectiveScale,
        y: (transform.pageWidthPoints - px) * effectiveScale,
      };
    case 0:
    default:
      return {
        x: px * effectiveScale,
        y: py * effectiveScale,
      };
  }
}

export function viewportPointToPagePoint(
  point: PdfViewportPoint,
  transform: PdfPageViewportTransform
): { x: PageSpaceX; y: PageSpaceY } {
  const effectiveScale = transform.scale * transform.dpiScale;
  if (effectiveScale <= 0) {
    return { x: toPageSpaceX(0), y: toPageSpaceY(0) };
  }
  const vx = point.x / effectiveScale;
  const vy = point.y / effectiveScale;

  switch (transform.rotation) {
    case 90:
      return {
        x: toPageSpaceX(vy),
        y: toPageSpaceY(transform.pageHeightPoints - vx),
      };
    case 180:
      return {
        x: toPageSpaceX(transform.pageWidthPoints - vx),
        y: toPageSpaceY(transform.pageHeightPoints - vy),
      };
    case 270:
      return {
        x: toPageSpaceX(transform.pageWidthPoints - vy),
        y: toPageSpaceY(vx),
      };
    case 0:
    default:
      return {
        x: toPageSpaceX(vx),
        y: toPageSpaceY(vy),
      };
  }
}

export function projectPdfQuadToViewportRect(
  quad: PdfHighlightQuad,
  transform: PdfPageViewportTransform
): PdfViewportRect {
  const points = [
    pagePointToViewportPoint(toPageSpaceX(quad.x1), toPageSpaceY(quad.y1), transform),
    pagePointToViewportPoint(toPageSpaceX(quad.x2), toPageSpaceY(quad.y2), transform),
    pagePointToViewportPoint(toPageSpaceX(quad.x3), toPageSpaceY(quad.y3), transform),
    pagePointToViewportPoint(toPageSpaceX(quad.x4), toPageSpaceY(quad.y4), transform),
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
