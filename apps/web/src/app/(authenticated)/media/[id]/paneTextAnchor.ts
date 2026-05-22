/**
 * Reader pane text-anchor scroll helpers.
 *
 * Operate on the workspace pane scroll container (`[data-pane-content]`) plus
 * a CanonicalCursorResult to find, scroll to, and check visibility of
 * canonical text offsets in the reader.
 */

import { type CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import { canonicalCpToRawCp } from "@/lib/highlights/canonicalText";
import { codepointToUtf16 } from "@/lib/highlights/codepoints";

const TEXT_ANCHOR_TOP_PADDING_PX = 56;

export function getPaneScrollContainer(
  contentNode: HTMLElement | null,
): HTMLElement | null {
  if (!contentNode) {
    return null;
  }

  const paneContent = contentNode.closest<HTMLElement>(
    '[data-pane-content="true"]',
  );
  if (paneContent) {
    return paneContent;
  }

  if (typeof document !== "undefined" && document.scrollingElement) {
    return document.scrollingElement as HTMLElement;
  }
  return null;
}

function getPaneScrollTopPaddingPx(container: HTMLElement): number {
  if (typeof window === "undefined") {
    return TEXT_ANCHOR_TOP_PADDING_PX;
  }

  const parsed = Number.parseFloat(
    window.getComputedStyle(container).scrollPaddingTop,
  );
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return TEXT_ANCHOR_TOP_PADDING_PX;
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
    return entry.start;
  }
  return null;
}

type CanonicalAnchor = {
  node: CanonicalCursorResult["nodes"][number];
  rawUtf16Offset: number;
};

function resolveCanonicalAnchor(
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): CanonicalAnchor | null {
  if (cursor.nodes.length === 0) {
    return null;
  }

  const clampedOffset = Math.max(0, Math.min(canonicalOffset, cursor.length));
  const node =
    cursor.nodes.find(
      (entry) => clampedOffset >= entry.start && clampedOffset < entry.end,
    ) ??
    cursor.nodes.find((entry) => entry.start >= clampedOffset) ??
    cursor.nodes[cursor.nodes.length - 1];

  if (!node) {
    return null;
  }

  const rawText = node.node.textContent ?? "";
  const nodeCanonicalLength = Math.max(0, node.end - node.start);
  const localCanonicalOffset = Math.max(
    0,
    Math.min(clampedOffset - node.start, nodeCanonicalLength),
  );
  const localRawCpOffset = canonicalCpToRawCp(
    rawText,
    localCanonicalOffset,
    node.trimLeadCp,
  );
  const rawUtf16Offset = Math.max(
    0,
    Math.min(codepointToUtf16(rawText, localRawCpOffset), rawText.length),
  );

  return { node, rawUtf16Offset };
}

function anchorRect(anchor: CanonicalAnchor): {
  rect: DOMRect;
  fallbackElement: HTMLElement | null;
} {
  const range = document.createRange();
  range.setStart(anchor.node.node, anchor.rawUtf16Offset);
  range.collapse(true);
  return {
    rect: range.getBoundingClientRect(),
    fallbackElement: anchor.node.node.parentElement,
  };
}

export function scrollToCanonicalTextAnchor(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): boolean {
  const anchor = resolveCanonicalAnchor(cursor, canonicalOffset);
  if (!anchor) {
    return false;
  }

  const { rect: targetRect, fallbackElement } = anchorRect(anchor);
  const containerRect = container.getBoundingClientRect();
  const topPaddingPx = getPaneScrollTopPaddingPx(container);
  if (targetRect.width > 0 || targetRect.height > 0) {
    const delta = targetRect.top - containerRect.top - topPaddingPx;
    container.scrollTop = Math.max(0, container.scrollTop + delta);
    return true;
  }

  if (fallbackElement) {
    fallbackElement.scrollIntoView({ block: "start", behavior: "auto" });
    return true;
  }
  return false;
}

export function isCanonicalTextAnchorVisible(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number,
): boolean {
  const anchor = resolveCanonicalAnchor(cursor, canonicalOffset);
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
