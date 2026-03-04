import type { PdfHighlightQuad } from "./pdfTypes";
import {
  projectPdfQuadToViewportRect,
  viewerScrollYFromClientY,
  normalizeQuarterTurnRotation,
  type PdfPageViewportTransform,
} from "./coordinateTransforms";

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export type HtmlAnchorDescriptor = {
  kind: "html";
  id: string;
};

export type PdfAnchorDescriptor = {
  kind: "pdf";
  id: string;
  pageNumber: number;
  quads: PdfHighlightQuad[];
};

export type AnchorDescriptor = HtmlAnchorDescriptor | PdfAnchorDescriptor;

export interface AnchorProviderContext {
  contentRoot: Element;
  viewerScrollContainer: HTMLElement;
}

export interface AnchorProvider {
  measureViewerAnchorPositions(
    descriptors: AnchorDescriptor[],
    context: AnchorProviderContext
  ): Map<string, number>;
}

function readPdfPageViewportTransform(pageElement: HTMLElement): PdfPageViewportTransform | null {
  const scaleRaw = pageElement.getAttribute("data-nexus-page-scale");
  const rotationRaw = pageElement.getAttribute("data-nexus-page-rotation");
  const widthRaw = pageElement.getAttribute("data-nexus-page-viewport-width");
  const heightRaw = pageElement.getAttribute("data-nexus-page-viewport-height");
  const dpiRaw = pageElement.getAttribute("data-nexus-page-dpi-scale");

  const scale = Number.parseFloat(scaleRaw ?? "");
  const rotationParsed = Number.parseInt(rotationRaw ?? "0", 10);
  const viewportWidth = Number.parseFloat(widthRaw ?? "");
  const viewportHeight = Number.parseFloat(heightRaw ?? "");
  const dpiScale = Number.parseFloat(dpiRaw ?? "1");

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

  const rotation = normalizeQuarterTurnRotation(rotationParsed);
  const pageWidthPoints =
    rotation === 90 || rotation === 270 ? viewportHeight / scale : viewportWidth / scale;
  const pageHeightPoints =
    rotation === 90 || rotation === 270 ? viewportWidth / scale : viewportHeight / scale;

  return {
    scale,
    rotation,
    pageWidthPoints,
    pageHeightPoints,
    dpiScale,
  };
}

export class HtmlAnchorProvider implements AnchorProvider {
  measureViewerAnchorPositions(
    descriptors: AnchorDescriptor[],
    context: AnchorProviderContext
  ): Map<string, number> {
    const positions = new Map<string, number>();
    const viewerRect = context.viewerScrollContainer.getBoundingClientRect();
    const viewerScrollTop = context.viewerScrollContainer.scrollTop;

    for (const descriptor of descriptors) {
      if (descriptor.kind !== "html") {
        continue;
      }
      const escapedId = escapeAttrValue(descriptor.id);
      const anchor =
        context.contentRoot.querySelector<HTMLElement>(`[data-highlight-anchor="${escapedId}"]`) ??
        context.contentRoot.querySelector<HTMLElement>(`[data-active-highlight-ids~="${escapedId}"]`);
      if (!anchor) {
        continue;
      }
      const anchorRect = anchor.getBoundingClientRect();
      const viewerY = viewerScrollYFromClientY(anchorRect.top, viewerRect.top, viewerScrollTop);
      positions.set(descriptor.id, viewerY as number);
    }
    return positions;
  }
}

export class PdfAnchorProvider implements AnchorProvider {
  measureViewerAnchorPositions(
    descriptors: AnchorDescriptor[],
    context: AnchorProviderContext
  ): Map<string, number> {
    const positions = new Map<string, number>();
    const viewerRect = context.viewerScrollContainer.getBoundingClientRect();
    const viewerScrollTop = context.viewerScrollContainer.scrollTop;
    const pageElementCache = new Map<number, HTMLElement | null>();

    const getPageElement = (pageNumber: number): HTMLElement | null => {
      if (pageElementCache.has(pageNumber)) {
        return pageElementCache.get(pageNumber) ?? null;
      }
      const pageElement =
        context.contentRoot.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`) ??
        context.contentRoot.querySelectorAll<HTMLElement>(".page")[pageNumber - 1] ??
        null;
      pageElementCache.set(pageNumber, pageElement);
      return pageElement;
    };

    for (const descriptor of descriptors) {
      if (descriptor.kind !== "pdf" || descriptor.quads.length === 0) {
        continue;
      }
      const pageElement = getPageElement(descriptor.pageNumber);
      if (!pageElement) {
        continue;
      }

      const viewportTransform = readPdfPageViewportTransform(pageElement);
      if (!viewportTransform) {
        continue;
      }

      const rect = projectPdfQuadToViewportRect(descriptor.quads[0], viewportTransform);
      const pageRect = pageElement.getBoundingClientRect();
      const pageTopInViewer = viewerScrollYFromClientY(pageRect.top, viewerRect.top, viewerScrollTop);
      positions.set(descriptor.id, (pageTopInViewer as number) + rect.top);
    }

    return positions;
  }
}

export const DEFAULT_HTML_ANCHOR_PROVIDER: AnchorProvider = new HtmlAnchorProvider();
export const DEFAULT_PDF_ANCHOR_PROVIDER: AnchorProvider = new PdfAnchorProvider();

