import type { PdfPageViewLike } from "@/components/pdfReaderRuntime";
import { isPositiveFinite } from "@/lib/validation";
import {
  PDF_QUAD_EPSILON,
  normalizeQuarterTurnRotation,
  type PdfPageViewportTransform,
} from "./coordinateTransforms";

export function deriveScaleFromPageView(
  pageView: PdfPageViewLike | undefined,
): number | null {
  if (!pageView?.viewport) {
    return null;
  }
  const viewport = pageView.viewport;
  if (typeof viewport.scale === "number" && viewport.scale > 0) {
    return viewport.scale;
  }
  if (pageView.pdfPage?.getViewport) {
    const baseViewport = pageView.pdfPage.getViewport({
      scale: 1,
      rotation: viewport.rotation,
    });
    if (baseViewport.width > 0) {
      const scale = viewport.width / baseViewport.width;
      if (isPositiveFinite(scale)) {
        return scale;
      }
    }
  }
  return null;
}

export function deriveViewportTransformFromPageView(
  pageView: PdfPageViewLike | undefined,
  fallbackScale: number,
): PdfPageViewportTransform | null {
  const viewport = pageView?.viewport;
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }
  const scale = deriveScaleFromPageView(pageView) ?? fallbackScale;
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  const rotation = normalizeQuarterTurnRotation(viewport.rotation ?? 0);
  const pageWidthPoints =
    rotation === 90 || rotation === 270
      ? viewport.height / scale
      : viewport.width / scale;
  const pageHeightPoints =
    rotation === 90 || rotation === 270
      ? viewport.width / scale
      : viewport.height / scale;

  return {
    scale,
    rotation,
    pageWidthPoints,
    pageHeightPoints,
    dpiScale: 1,
  };
}

/**
 * Maximum relative drift between the text layer and canvas surface of a PDF
 * page element. Used to detect cases where pdf.js has rendered the two layers
 * at mismatched scales or positions, which would make highlight projection
 * unsafe.
 */
export function computePageLayerAlignmentDelta(
  pageElement: HTMLElement,
): number | null {
  const textLayer = pageElement.querySelector<HTMLElement>(".textLayer");
  const canvasSurface =
    pageElement.querySelector<HTMLElement>(".canvasWrapper") ??
    pageElement.querySelector<HTMLElement>("canvas");
  if (!textLayer || !canvasSurface) {
    return null;
  }
  const textRect = textLayer.getBoundingClientRect();
  const canvasRect = canvasSurface.getBoundingClientRect();
  if (
    textRect.width <= PDF_QUAD_EPSILON ||
    textRect.height <= PDF_QUAD_EPSILON ||
    canvasRect.width <= PDF_QUAD_EPSILON ||
    canvasRect.height <= PDF_QUAD_EPSILON
  ) {
    return null;
  }

  const widthScaleDrift = Math.abs(textRect.width / canvasRect.width - 1);
  const heightScaleDrift = Math.abs(textRect.height / canvasRect.height - 1);
  const leftOffsetDrift =
    Math.abs(textRect.left - canvasRect.left) / canvasRect.width;
  const topOffsetDrift =
    Math.abs(textRect.top - canvasRect.top) / canvasRect.height;
  const rightOffsetDrift =
    Math.abs(textRect.right - canvasRect.right) / canvasRect.width;
  const bottomOffsetDrift =
    Math.abs(textRect.bottom - canvasRect.bottom) / canvasRect.height;
  return Math.max(
    widthScaleDrift,
    heightScaleDrift,
    leftOffsetDrift,
    topOffsetDrift,
    rightOffsetDrift,
    bottomOffsetDrift,
  );
}
