import type { PdfPageViewLike } from "@/components/pdfReaderRuntime";
import { buildCanonicalCursor } from "@/lib/highlights/canonicalCursor";
import { canonicalCpToRawCp } from "@/lib/highlights/canonicalText";
import { codepointToUtf16 } from "@/lib/highlights/codepoints";
import {
  isValidPdfRect,
  projectPdfQuadToViewportRect,
} from "@/lib/highlights/coordinateTransforms";
import { deriveViewportTransformFromPageView } from "@/lib/highlights/pdfPageViewport";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";

export interface ExactTextHighlight {
  canonicalText: string;
  startOffset: number;
  endOffset: number;
  expectedText: string;
}

export function installExactPublicTextHighlight(
  root: HTMLElement,
  target: ExactTextHighlight,
): HTMLElement | null {
  clearExactPublicTextHighlight(root);
  const canonicalCodepoints = Array.from(target.canonicalText);
  if (
    target.startOffset < 0 ||
    target.endOffset <= target.startOffset ||
    target.endOffset > canonicalCodepoints.length
  ) {
    return null;
  }
  const selectedText = canonicalCodepoints
    .slice(target.startOffset, target.endOffset)
    .join("");
  if (!selectedText || selectedText !== target.expectedText) {
    return null;
  }

  const cursor = buildCanonicalCursor(root);
  if (cursor.emitted !== target.canonicalText) {
    return null;
  }

  const overlaps = cursor.nodes
    .flatMap((mapping) => {
      const start = Math.max(target.startOffset, mapping.start);
      const end = Math.min(target.endOffset, mapping.end);
      return start < end ? [{ mapping, start, end }] : [];
    })
    .sort((left, right) => right.start - left.start);
  if (overlaps.length === 0) {
    return null;
  }

  const marks: HTMLElement[] = [];
  try {
    for (const { mapping, start, end } of overlaps) {
      const rawText = mapping.node.data;
      const rawStart = canonicalCpToRawCp(
        rawText,
        start - mapping.start,
        mapping.trimLeadCp,
      );
      const rawEnd = canonicalCpToRawCp(
        rawText,
        end - mapping.start,
        mapping.trimLeadCp,
      );
      if (rawStart >= rawEnd) continue;

      const range = document.createRange();
      range.setStart(mapping.node, codepointToUtf16(rawText, rawStart));
      range.setEnd(mapping.node, codepointToUtf16(rawText, rawEnd));
      const mark = document.createElement("mark");
      mark.dataset.nexusPublicHighlightSegment = "true";
      range.surroundContents(mark);
      marks.push(mark);
    }
  } catch {
    clearExactPublicTextHighlight(root);
    return null;
  }
  if (marks.length === 0) {
    return null;
  }

  root.dataset.nexusPublicHighlightContainer = "true";
  root.dataset.publicHighlightTarget = "true";
  root.tabIndex = -1;
  return root;
}

export function focusPublicHighlightTarget(target: HTMLElement): void {
  const scrollTarget =
    target.dataset.nexusPublicHighlightContainer === "true"
      ? target.querySelector<HTMLElement>(
          'mark[data-nexus-public-highlight-segment="true"]',
        )
      : target;
  scrollTarget?.scrollIntoView({ behavior: "smooth", block: "center" });
  target.focus({ preventScroll: true });
}

export function clearExactPublicTextHighlight(root: HTMLElement): void {
  for (const mark of root.querySelectorAll<HTMLElement>(
    'mark[data-nexus-public-highlight-segment="true"]',
  )) {
    mark.replaceWith(...Array.from(mark.childNodes));
  }
  root.normalize();
  delete root.dataset.nexusPublicHighlightContainer;
  delete root.dataset.publicHighlightTarget;
  root.removeAttribute("tabindex");
}

export interface PublicPdfOverlayClasses {
  layer: string;
  rect: string;
}

const PUBLIC_HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "rgba(250, 204, 21, 0.34)",
  green: "rgba(74, 222, 128, 0.30)",
  blue: "rgba(96, 165, 250, 0.30)",
  pink: "rgba(244, 114, 182, 0.30)",
  purple: "rgba(192, 132, 252, 0.30)",
};

export function installPublicPdfHighlightOverlay({
  pageElement,
  pageView,
  quads,
  color,
  classes,
}: {
  pageElement: HTMLElement;
  pageView: PdfPageViewLike | undefined;
  quads: PdfHighlightQuad[];
  color: string;
  classes: PublicPdfOverlayClasses;
}): HTMLElement | null {
  const fallbackScale =
    typeof pageView?.viewport?.scale === "number" &&
    pageView.viewport.scale > 0
      ? pageView.viewport.scale
      : 1;
  const transform = deriveViewportTransformFromPageView(
    pageView,
    fallbackScale,
  );
  if (!transform || quads.length < 1 || quads.length > 512) {
    return null;
  }
  const viewportWidth = pageView?.viewport?.width ?? 0;
  const viewportHeight = pageView?.viewport?.height ?? 0;
  const rects = quads.map((quad) =>
    projectPdfQuadToViewportRect(quad, transform),
  );
  if (
    rects.some(
      (rect) =>
        !isValidPdfRect(rect) ||
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.top) ||
        rect.left < 0 ||
        rect.top < 0 ||
        rect.left + rect.width > viewportWidth + 0.01 ||
        rect.top + rect.height > viewportHeight + 0.01,
    )
  ) {
    return null;
  }

  pageElement
    .querySelector<HTMLElement>('[data-nexus-public-pdf-overlay="true"]')
    ?.remove();
  const layer = document.createElement("div");
  layer.className = classes.layer;
  layer.dataset.nexusPublicPdfOverlay = "true";
  let first: HTMLElement | null = null;
  rects.forEach((rect, index) => {
    const element = document.createElement("div");
    element.className = classes.rect;
    element.dataset.highlightColor = color.toLowerCase();
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    element.style.backgroundColor =
      PUBLIC_HIGHLIGHT_COLORS[color.toLowerCase()] ??
      PUBLIC_HIGHLIGHT_COLORS.yellow;
    if (index === 0) {
      element.dataset.publicHighlightTarget = "true";
      element.tabIndex = -1;
      first = element;
    }
    layer.append(element);
  });
  pageElement.append(layer);
  return first;
}
