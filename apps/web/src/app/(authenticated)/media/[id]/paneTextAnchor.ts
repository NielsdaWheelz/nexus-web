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

export {
  getPaneScrollContainer,
  isElementInPaneView,
};

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
  const containerRect = container.getBoundingClientRect();
  const topPaddingPx = getPaneScrollTopPaddingPx(container);
  const probeTop =
    containerRect.top +
    Math.min(
      topPaddingPx,
      Math.max(8, Math.floor(containerRect.height * 0.12)),
    );

  const isVisibleOffset = (offset: number): boolean => {
    const ranges = resolveCanonicalTextRanges(cursor, offset, offset + 1);
    if (!ranges) return false;
    return ranges.some((range) => {
      const rect = range.getBoundingClientRect();
      return (
        rect.bottom > probeTop &&
        rect.top < containerRect.bottom &&
        rect.right > containerRect.left &&
        rect.left < containerRect.right
      );
    });
  };

  for (const entry of cursor.nodes) {
    const anchorElement = entry.node.parentElement;
    if (!anchorElement) {
      continue;
    }
    const rect = anchorElement.getBoundingClientRect();
    if (rect.bottom < probeTop || rect.top > containerRect.bottom) {
      continue;
    }
    if ((entry.node.textContent ?? "").trim().length === 0) {
      continue;
    }
    let low = entry.start;
    let high = entry.end;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const ranges = resolveCanonicalTextRanges(cursor, middle, middle + 1);
      const reachesVisibleTop =
        ranges?.some(
          (range) => range.getBoundingClientRect().bottom > probeTop,
        ) ?? false;
      if (reachesVisibleTop) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    // A composed codepoint may span nodes and synthetic boundaries are not
    // renderable. Probe the small boundary neighborhood, then scan forward.
    for (
      let offset = Math.max(entry.start, low - 2);
      offset < entry.end;
      offset += 1
    ) {
      if (isVisibleOffset(offset)) return offset;
    }
  }
  return null;
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

function compareDomSpans(left: CanonicalDomSpan, right: CanonicalDomSpan): number {
  if (left.node === right.node) {
    return (
      left.startUtf16 - right.startUtf16 || left.endUtf16 - right.endUtf16
    );
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
    if (
      previous?.node === span.node &&
      span.startUtf16 <= previous.endUtf16
    ) {
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
