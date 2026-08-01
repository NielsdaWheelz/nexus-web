/**
 * Reader pane text-anchor scroll helpers.
 *
 * Operate on the workspace pane scroll container (`[data-pane-content]`) plus
 * a CanonicalCursorResult to find, scroll to, and check visibility of
 * canonical text offsets in the reader.
 */

import {
  type CanonicalCursorResult,
  type CanonicalDomSpan,
} from "@/lib/highlights/canonicalCursor";
import {
  getPaneScrollContainer,
  getPaneScrollTopPaddingPx,
  isElementInPaneView,
  type ReaderScrollCommands,
} from "@/lib/reader/paneScroll";

export const READER_END_TOLERANCE_PX = 2;

export { getPaneScrollContainer, isElementInPaneView };

export interface VisibleCanonicalTextRange {
  startOffset: number;
  endOffset: number;
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
    captureVisibleCanonicalTextRange(container, cursor)?.startOffset ?? null
  );
}

function canonicalOffsetRects(
  cursor: CanonicalCursorResult,
  offset: number,
): DOMRect[] {
  const provenance = cursor.provenance[offset];
  if (!provenance) {
    return [];
  }
  return provenance.spans.flatMap((span) => {
    const range = span.node.ownerDocument.createRange();
    range.setStart(span.node, span.startUtf16);
    range.setEnd(span.node, span.endUtf16);
    const clientRects = Array.from(range.getClientRects());
    return clientRects.length > 0
      ? clientRects
      : [range.getBoundingClientRect()];
  });
}

export function captureVisibleCanonicalTextRange(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
): VisibleCanonicalTextRange | null {
  if (cursor.length === 0) {
    return null;
  }
  const viewport = container.getBoundingClientRect();
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
  const intersectsViewport = (offset: number): boolean =>
    readRects(offset).some(
      (rect) =>
        rect.bottom > viewport.top &&
        rect.top < viewport.bottom &&
        rect.right > viewport.left &&
        rect.left < viewport.right,
    );
  const reachesVisibleTop = (offset: number): boolean =>
    readRects(offset).some((rect) => rect.bottom > viewport.top);
  const startsBeforeVisibleBottom = (offset: number): boolean =>
    readRects(offset).some((rect) => rect.top < viewport.bottom);

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

    let firstLow = entry.start;
    let firstHigh = entry.end;
    while (firstLow < firstHigh) {
      const middle = Math.floor((firstLow + firstHigh) / 2);
      if (reachesVisibleTop(middle)) {
        firstHigh = middle;
      } else {
        firstLow = middle + 1;
      }
    }
    for (
      let offset = Math.max(entry.start, firstLow - 2);
      offset < entry.end;
      offset += 1
    ) {
      if (intersectsViewport(offset)) {
        firstVisible = Math.min(firstVisible ?? offset, offset);
        break;
      }
    }

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
    };
  }
  const startOffset = precedingBoundary ?? 0;
  return {
    startOffset,
    endOffset: Math.max(startOffset, followingBoundary ?? cursor.length),
  };
}

export type CanonicalTextAnchor = {
  node: Text;
  rawUtf16Offset: number;
};

export type CanonicalTextAnchorAffinity = "Forward" | "Backward";

function firstSourceAnchor(
  cursor: CanonicalCursorResult,
  startIndex: number,
): CanonicalTextAnchor | null {
  for (let index = startIndex; index < cursor.provenance.length; index += 1) {
    const span = cursor.provenance[index]?.spans[0];
    if (span) {
      return { node: span.node, rawUtf16Offset: span.startUtf16 };
    }
  }
  return null;
}

function lastSourceAnchor(
  cursor: CanonicalCursorResult,
  startIndex: number,
): CanonicalTextAnchor | null {
  for (let index = startIndex; index >= 0; index -= 1) {
    const spans = cursor.provenance[index]?.spans;
    const span = spans?.[spans.length - 1];
    if (span) {
      return { node: span.node, rawUtf16Offset: span.endUtf16 };
    }
  }
  return null;
}

export function resolveCanonicalTextAnchor(
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
  affinity: CanonicalTextAnchorAffinity,
): CanonicalTextAnchor | null {
  if (
    !Number.isInteger(canonicalOffset) ||
    canonicalOffset < 0 ||
    canonicalOffset > cursor.length
  ) {
    return null;
  }

  if (affinity === "Forward") {
    return (
      firstSourceAnchor(cursor, canonicalOffset) ??
      lastSourceAnchor(cursor, canonicalOffset - 1)
    );
  }
  return (
    lastSourceAnchor(cursor, canonicalOffset - 1) ??
    firstSourceAnchor(cursor, canonicalOffset)
  );
}

function compareDomSpans(
  left: CanonicalDomSpan,
  right: CanonicalDomSpan,
): number {
  if (left.node === right.node) {
    return left.startUtf16 - right.startUtf16 || left.endUtf16 - right.endUtf16;
  }
  const position = left.node.compareDocumentPosition(right.node);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
    return -1;
  }
  if (position & Node.DOCUMENT_POSITION_PRECEDING) {
    return 1;
  }
  throw new Error("Canonical provenance spans must share one document tree.");
}

function mergeDomSpans(spans: CanonicalDomSpan[]): CanonicalDomSpan[] {
  const ordered = [...spans].sort(compareDomSpans);
  const merged: CanonicalDomSpan[] = [];
  for (const span of ordered) {
    const previous = merged[merged.length - 1];
    if (previous?.node === span.node && span.startUtf16 <= previous.endUtf16) {
      previous.endUtf16 = Math.max(previous.endUtf16, span.endUtf16);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

export function resolveCanonicalTextRanges(
  cursor: CanonicalCursorResult,
  startCanonicalOffset: number,
  endCanonicalOffset: number,
): Range[] | null {
  if (
    !Number.isInteger(startCanonicalOffset) ||
    !Number.isInteger(endCanonicalOffset) ||
    startCanonicalOffset < 0 ||
    endCanonicalOffset <= startCanonicalOffset ||
    endCanonicalOffset > cursor.length
  ) {
    return null;
  }

  const spans = mergeDomSpans(
    cursor.provenance
      .slice(startCanonicalOffset, endCanonicalOffset)
      .flatMap((entry) => entry.spans),
  );
  if (spans.length === 0) {
    return null;
  }

  return spans.map((span) => {
    const range = span.node.ownerDocument.createRange();
    range.setStart(span.node, span.startUtf16);
    range.setEnd(span.node, span.endUtf16);
    return range;
  });
}

function anchorRect(anchor: CanonicalTextAnchor): {
  rect: DOMRect;
  fallbackElement: HTMLElement | null;
} {
  const range = anchor.node.ownerDocument.createRange();
  range.setStart(anchor.node, anchor.rawUtf16Offset);
  range.collapse(true);
  return {
    rect: range.getBoundingClientRect(),
    fallbackElement: anchor.node.parentElement,
  };
}

export function measureCanonicalTextAnchorViewportDelta(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): number | null {
  const anchor = resolveCanonicalTextAnchor(cursor, canonicalOffset, "Forward");
  if (!anchor) return null;
  const { rect } = anchorRect(anchor);
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

export function scrollToCanonicalTextAnchor(
  commands: ReaderScrollCommands,
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): boolean {
  const anchor = resolveCanonicalTextAnchor(cursor, canonicalOffset, "Forward");
  if (!anchor) {
    return false;
  }

  const { rect: targetRect, fallbackElement } = anchorRect(anchor);
  const containerRect = container.getBoundingClientRect();
  const topPaddingPx = getPaneScrollTopPaddingPx(container);
  if (targetRect.width > 0 || targetRect.height > 0) {
    const delta = targetRect.top - containerRect.top - topPaddingPx;
    commands.setTop(container, Math.max(0, container.scrollTop + delta));
    return true;
  }

  if (fallbackElement) {
    commands.reveal(container, fallbackElement);
    return true;
  }
  return false;
}

export function scrollToExactCanonicalTextAnchor(
  commands: ReaderScrollCommands,
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): boolean {
  const anchor = resolveCanonicalTextAnchor(cursor, canonicalOffset, "Forward");
  if (!anchor) {
    return false;
  }
  const range = anchor.node.ownerDocument.createRange();
  range.setStart(anchor.node, anchor.rawUtf16Offset);
  range.collapse(true);
  const targetTop = range.getBoundingClientRect().top;
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
  const anchor = resolveCanonicalTextAnchor(cursor, canonicalOffset, "Forward");
  if (!anchor) {
    return false;
  }

  const { rect: targetRect, fallbackElement } = anchorRect(anchor);
  const containerRect = container.getBoundingClientRect();
  const visibleTop =
    containerRect.top + Math.floor(getPaneScrollTopPaddingPx(container) / 2);
  if (targetRect.width > 0 || targetRect.height > 0) {
    return (
      targetRect.bottom > visibleTop && targetRect.top < containerRect.bottom
    );
  }

  if (!fallbackElement) {
    return false;
  }
  const fallbackRect = fallbackElement.getBoundingClientRect();
  return (
    fallbackRect.bottom > visibleTop && fallbackRect.top < containerRect.bottom
  );
}
