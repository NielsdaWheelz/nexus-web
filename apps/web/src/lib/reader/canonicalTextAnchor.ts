/**
 * Reader pane text-anchor scroll helpers.
 *
 * Operate on the workspace pane scroll container (`[data-pane-content]`) plus
 * a CanonicalCursorResult to find, scroll to, and check visibility of
 * canonical text offsets in the reader.
 */

import {
  type CanonicalCursorResult,
} from "@/lib/highlights/canonicalCursor";
import type { DomTextSpan } from "@/lib/highlights/domTextCursor";
import {
  getPaneScrollTopPaddingPx,
  type ReaderScrollCommands,
} from "@/lib/reader/paneScroll";
import type { Presence } from "@/lib/api/presence";
import { findSourceAnchor } from "@/lib/reader/epubInternalLinks";

export const READER_END_TOLERANCE_PX = 2;


export interface VisibleCanonicalTextRange {
  startOffset: number;
  endOffset: number;
  primaryOffset: number | null;
}

export function isTextViewportAtEnd(
  viewport: HTMLElement,
  endMarker: HTMLElement,
): boolean {
  if (
    !viewport.isConnected ||
    !endMarker.isConnected ||
    viewport.scrollHeight <= 0 ||
    viewport.clientHeight <= 0
  ) {
    return false;
  }

  const bottomDistance =
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  if (Math.abs(bottomDistance) > READER_END_TOLERANCE_PX) {
    return false;
  }

  const viewportRect = viewport.getBoundingClientRect();
  const endMarkerRect = endMarker.getBoundingClientRect();
  if (
    viewportRect.width <= 0 ||
    viewportRect.height <= 0 ||
    endMarkerRect.width <= 0 ||
    endMarkerRect.height <= 0
  ) {
    return false;
  }
  return (
    endMarkerRect.right > viewportRect.left &&
    endMarkerRect.left < viewportRect.right &&
    endMarkerRect.bottom > viewportRect.top &&
    endMarkerRect.top < viewportRect.bottom
  );
}

export function findFirstVisibleCanonicalOffset(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
): number | null {
  return (
    captureVisibleCanonicalTextRange(container, cursor)?.primaryOffset ?? null
  );
}

/** The semantic anchor and its exact placement inside the current scrollport. */
interface TextReaderViewportPlacement {
  readonly viewportTopDeltaPx: number;
  readonly scrollLeft: number;
}

export type TextReaderPlacement = CanonicalTextReaderPlacement | SourceAnchorReaderPlacement;

export interface CanonicalTextReaderPlacement extends TextReaderViewportPlacement {
  readonly kind: "CanonicalText";
  readonly anchorCp: number;
}

export interface SourceAnchorReaderPlacement extends TextReaderViewportPlacement {
  readonly kind: "SourceAnchor";
  /** Absent identifies the authored content root, including image-only sections. */
  readonly anchorId: Presence<string>;
}

export type TextReaderNavigationTarget =
  | { kind: "Text"; fragmentId: string; startOffset: number; endOffset: number }
  | { kind: "SourceAnchor"; fragmentId: string; anchorId: string }
  | { kind: "Boundary"; edge: "Start" | "End" };

export function measureCanonicalViewportOrigin(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
): CanonicalTextReaderPlacement | null {
  const anchorCp = findFirstVisibleCanonicalOffset(container, cursor);
  if (anchorCp === null) return null;
  const viewportTopDeltaPx = measureCanonicalTextAnchorViewportDelta(
    container,
    cursor,
    anchorCp,
  );
  if (viewportTopDeltaPx === null) return null;
  return { kind: "CanonicalText", anchorCp, viewportTopDeltaPx, scrollLeft: container.scrollLeft };
}

export function measureSourceAnchorViewportOrigin(
  container: HTMLElement,
  contentRoot: HTMLElement,
  anchorId: Presence<string>,
): SourceAnchorReaderPlacement | null {
  const element = anchorId.kind === "Present" ? findSourceAnchor(contentRoot, anchorId.value) : contentRoot;
  if (!container.isConnected || !element?.isConnected || !container.contains(element)) return null;
  const viewport = container.getBoundingClientRect();
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const delta = element.getBoundingClientRect().top - viewport.top;
  return Number.isFinite(delta)
    ? { kind: "SourceAnchor", anchorId, viewportTopDeltaPx: delta, scrollLeft: container.scrollLeft }
    : null;
}

export function restoreTextReaderPlacement(
  commands: ReaderScrollCommands,
  container: HTMLElement,
  cursor: CanonicalCursorResult | null,
  contentRoot: HTMLElement,
  placement: TextReaderPlacement,
): boolean {
  if (placement.kind === "CanonicalText") {
    return cursor !== null && restoreCanonicalTextAnchorViewportPosition(
      commands, container, cursor, placement.anchorCp,
      placement.viewportTopDeltaPx, placement.scrollLeft,
    );
  }
  if (!Number.isFinite(placement.viewportTopDeltaPx) || !Number.isFinite(placement.scrollLeft)) return false;
  const current = measureSourceAnchorViewportOrigin(container, contentRoot, placement.anchorId);
  if (!current) return false;
  commands.adjustTop(container, current.viewportTopDeltaPx - placement.viewportTopDeltaPx);
  container.scrollLeft = placement.scrollLeft;
  const restored = measureSourceAnchorViewportOrigin(container, contentRoot, placement.anchorId);
  return restored !== null &&
    Math.abs(restored.viewportTopDeltaPx - placement.viewportTopDeltaPx) <= 1 &&
    Math.abs(restored.scrollLeft - placement.scrollLeft) <= 1;
}

function canonicalOffsetRects(
  cursor: CanonicalCursorResult,
  offset: number,
): DOMRect[] {
  return cursor.provenance[offset]?.spans.flatMap(sourceSpanRects) ?? [];
}

function sourceSpanRects(span: DomTextSpan): DOMRect[] {
  const range = span.node.ownerDocument.createRange();
  range.setStart(span.node, span.startUtf16);
  range.setEnd(span.node, span.endUtf16);
  const clientRects = Array.from(range.getClientRects());
  return clientRects.length > 0 ? clientRects : [range.getBoundingClientRect()];
}

export function captureVisibleCanonicalTextRange(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
): VisibleCanonicalTextRange | null {
  if (cursor.length === 0) {
    return null;
  }
  const viewport = container.getBoundingClientRect();
  const readingTop = viewport.top + getPaneScrollTopPaddingPx(container);
  const rectsByOffset = new Map<number, DOMRect[]>();
  const readRects = (offset: number): DOMRect[] => {
    const cached = rectsByOffset.get(offset);
    if (cached) {
      return cached;
    }
    const rects = canonicalOffsetRects(cursor, offset);
    rectsByOffset.set(offset, rects);
    return rects;
  };
  const intersectsViewport = (offset: number, top = viewport.top): boolean =>
    readRects(offset).some(
      (rect) =>
        rect.bottom > top &&
        rect.top < viewport.bottom &&
        rect.right > viewport.left &&
        rect.left < viewport.right,
    );
  const startsBeforeVisibleBottom = (offset: number): boolean =>
    readRects(offset).some((rect) => rect.top < viewport.bottom);
  const firstVisibleOffset = (start: number, end: number, top: number): number | null => {
    let low = start;
    let high = end;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (readRects(middle).some((rect) => rect.bottom > top)) high = middle;
      else low = middle + 1;
    }
    for (let offset = Math.max(start, low - 2); offset < end; offset += 1) {
      if (intersectsViewport(offset, top)) return offset;
    }
    return null;
  };

  const entries = cursor.nodes.filter(
    (entry) =>
      entry.node.parentElement !== null &&
      (entry.node.textContent ?? "").trim().length > 0,
  );
  if (entries.length === 0) {
    return null;
  }
  const relationByIndex = new Map<number, "before" | "inside" | "after">();
  const classifyEntry = (index: number): "before" | "inside" | "after" => {
    const cached = relationByIndex.get(index);
    if (cached) {
      return cached;
    }
    const entry = entries[index];
    const anchorElement = entry.node.parentElement;
    if (!anchorElement) {
      throw new Error("Canonical cursor text entries must remain connected.");
    }
    const elementRect = anchorElement.getBoundingClientRect();
    if (elementRect.bottom <= viewport.top) {
      relationByIndex.set(index, "before");
      return "before";
    }
    if (elementRect.top >= viewport.bottom) {
      relationByIndex.set(index, "after");
      return "after";
    }
    const edgeRects = [...readRects(entry.start), ...readRects(entry.end - 1)];
    if (
      edgeRects.length > 0 &&
      edgeRects.every((rect) => rect.bottom <= viewport.top)
    ) {
      relationByIndex.set(index, "before");
      return "before";
    }
    if (
      edgeRects.length > 0 &&
      edgeRects.every((rect) => rect.top >= viewport.bottom)
    ) {
      relationByIndex.set(index, "after");
      return "after";
    }
    relationByIndex.set(index, "inside");
    return "inside";
  };

  // Canonical text entries follow document order. Resolve the viewport edge by
  // binary search, then inspect only the entries that can intersect it. This
  // keeps scroll-frame layout reads proportional to visible content.
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (classifyEntry(middle) === "before") {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const firstCandidateIndex = low;
  const precedingBoundary =
    firstCandidateIndex > 0 ? entries[firstCandidateIndex - 1].end : null;
  let followingBoundary: number | null = null;
  let firstVisible: number | null = null;
  let lastVisible: number | null = null;
  let primaryVisible: number | null = null;

  for (let index = firstCandidateIndex; index < entries.length; index += 1) {
    const entry = entries[index];
    const relation = classifyEntry(index);
    if (relation === "after") {
      followingBoundary = entry.start;
      break;
    }
    if (relation === "before") {
      continue;
    }
    const anchorElement = entry.node.parentElement;
    if (!anchorElement) {
      throw new Error("Canonical cursor text entries must remain connected.");
    }
    const elementRect = anchorElement.getBoundingClientRect();
    if (
      elementRect.right <= viewport.left ||
      elementRect.left >= viewport.right
    ) {
      continue;
    }

    const first = firstVisibleOffset(entry.start, entry.end, viewport.top);
    if (first !== null) firstVisible = Math.min(firstVisible ?? first, first);
    if (primaryVisible === null) primaryVisible = firstVisibleOffset(entry.start, entry.end, readingTop);

    let lastLow = entry.start;
    let lastHigh = entry.end - 1;
    while (lastLow < lastHigh) {
      const middle = Math.ceil((lastLow + lastHigh) / 2);
      if (startsBeforeVisibleBottom(middle)) {
        lastLow = middle;
      } else {
        lastHigh = middle - 1;
      }
    }
    for (
      let offset = Math.min(entry.end - 1, lastLow + 2);
      offset >= entry.start;
      offset -= 1
    ) {
      if (intersectsViewport(offset)) {
        lastVisible = Math.max(lastVisible ?? offset, offset);
        break;
      }
    }
  }

  if (firstVisible !== null && lastVisible !== null) {
    return {
      startOffset: firstVisible,
      endOffset: Math.max(firstVisible, lastVisible + 1),
      // Navigation aligns to this same reading line. Context above it remains
      // in the visible band but does not select the preceding section. A short
      // document wholly above the line still has an exact visible primary.
      primaryOffset: primaryVisible ?? firstVisible,
    };
  }
  const startOffset = precedingBoundary ?? 0;
  return {
    startOffset,
    endOffset: Math.max(startOffset, followingBoundary ?? cursor.length),
    primaryOffset: null,
  };
}

/** Capture, placement and visibility use the same authored character geometry.
 * A collapsed caret can have no rectangle at an inline whitespace boundary. */
function canonicalAnchorOffset(
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): number | null {
  if (
    !Number.isInteger(canonicalOffset) ||
    canonicalOffset < 0 ||
    canonicalOffset > cursor.length
  ) return null;

  // Synthetic separators have no source span. Resolve to the next authored
  // character, or the last authored character at the end of the document.
  for (let offset = canonicalOffset; offset < cursor.length; offset += 1) {
    if (cursor.provenance[offset]?.spans.length) return offset;
  }
  for (let offset = canonicalOffset - 1; offset >= 0; offset -= 1) {
    if (cursor.provenance[offset]?.spans.length) return offset;
  }
  return null;
}

function canonicalAnchorRect(
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): DOMRect | null {
  const offset = canonicalAnchorOffset(cursor, canonicalOffset);
  if (offset === null) return null;
  const rects = canonicalOffsetRects(cursor, offset);
  return (offset < canonicalOffset
    ? rects.findLast((rect) => rect.width > 0 || rect.height > 0)
    : rects.find((rect) => rect.width > 0 || rect.height > 0)) ?? null;
}

/** Prepare the authored passage for programmatic focus, including after a sheet closes. */
export function readerSourceFocusElement(root: HTMLElement, element: Element): HTMLElement | null {
  if (!root.isConnected || !root.contains(element)) return null;
  const target = element.closest<HTMLElement>(
    "p, li, dt, dd, h1, h2, h3, h4, h5, h6, blockquote, pre, figcaption, caption, td, th, section, article, aside, figure, div",
  );
  if (!target || !root.contains(target) || target.closest("[hidden]")) return null;
  if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
  return target;
}

/** The same authored character owns positioning and the prepared focus target. */
export function canonicalTextFocusElement(
  root: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): HTMLElement | null {
  const offset = canonicalAnchorOffset(cursor, canonicalOffset);
  if (offset === null) return null;
  const spans = cursor.provenance[offset]!.spans;
  const ordered = offset < canonicalOffset ? spans.toReversed() : spans;
  const span = ordered.find((candidate) =>
    sourceSpanRects(candidate).some((rect) => rect.width > 0 || rect.height > 0),
  );
  const element = span?.node.parentElement;
  return element ? readerSourceFocusElement(root, element) : null;
}

export function measureCanonicalTextAnchorViewportDelta(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): number | null {
  const rect = canonicalAnchorRect(cursor, canonicalOffset);
  if (!rect) return null;
  const containerRect = container.getBoundingClientRect();
  const delta = rect.top - containerRect.top;
  return Number.isFinite(delta) ? delta : null;
}

export function restoreCanonicalTextAnchorViewportPosition(
  commands: ReaderScrollCommands,
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
  viewportTopDeltaPx: number,
  scrollLeft: number,
): boolean {
  if (!Number.isFinite(viewportTopDeltaPx) || !Number.isFinite(scrollLeft)) {
    return false;
  }
  const currentDelta = measureCanonicalTextAnchorViewportDelta(
    container,
    cursor,
    canonicalOffset,
  );
  if (currentDelta === null) return false;
  commands.adjustTop(container, currentDelta - viewportTopDeltaPx);
  container.scrollLeft = scrollLeft;
  const restoredDelta = measureCanonicalTextAnchorViewportDelta(
    container,
    cursor,
    canonicalOffset,
  );
  return (
    restoredDelta !== null &&
    Math.abs(restoredDelta - viewportTopDeltaPx) <= 1 &&
    Math.abs(container.scrollLeft - scrollLeft) <= 1
  );
}

export function scrollToExactCanonicalTextAnchor(
  commands: ReaderScrollCommands,
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): boolean {
  const rect = canonicalAnchorRect(cursor, canonicalOffset);
  if (!rect) return false;
  const targetTop = rect.top;
  const containerTop = container.getBoundingClientRect().top;
  if (!Number.isFinite(targetTop) || !Number.isFinite(containerTop)) {
    return false;
  }
  commands.setTop(
    container,
    Math.max(
      0,
      container.scrollTop +
        targetTop -
        containerTop -
        getPaneScrollTopPaddingPx(container),
    ),
  );
  return true;
}

export function isCanonicalTextAnchorVisible(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): boolean {
  const targetRect = canonicalAnchorRect(cursor, canonicalOffset);
  if (!targetRect) return false;
  const containerRect = container.getBoundingClientRect();
  const visibleTop =
    containerRect.top + Math.floor(getPaneScrollTopPaddingPx(container) / 2);
  return (
    (targetRect.width > 0 || targetRect.height > 0) &&
    targetRect.bottom > visibleTop && targetRect.top < containerRect.bottom &&
    targetRect.right >= containerRect.left && targetRect.left < containerRect.right
  );
}
