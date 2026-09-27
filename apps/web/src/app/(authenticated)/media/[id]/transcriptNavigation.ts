import {
  buildCanonicalCursor,
  validateCanonicalText,
} from "@/lib/highlights/canonicalCursor";
import { resolveDomTextRanges } from "@/lib/highlights/domTextRanges";
import {
  findFirstVisibleCanonicalOffset,
  measureCanonicalViewportOrigin,
  measureCanonicalTextAnchorViewportDelta,
  restoreCanonicalTextAnchorViewportPosition,
  scrollToExactCanonicalTextAnchor,
  type CanonicalTextReaderPlacement,
} from "@/lib/reader/canonicalTextAnchor";
import {
  getPaneScrollTopPaddingPx,
  type ReaderScrollPositioner,
} from "@/lib/reader/paneScroll";
import type { ReaderNavigationOutcome } from "@/lib/reader/useReaderNavigation";

export interface TranscriptPlacement {
  readonly fragmentId: string;
  readonly canonicalText: string;
  readonly text: CanonicalTextReaderPlacement;
  readonly scrollport: "List" | "Viewport" | "Offscreen";
  readonly listViewportTopDeltaPx: number;
  readonly viewportScrollLeft: number;
  readonly listVisible: boolean;
  readonly layout: {
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly viewportScrollHeight: number;
    readonly listWidth: number;
    readonly listHeight: number;
    readonly listScrollHeight: number;
  };
}

function transcriptText(list: HTMLElement, fragmentId: string) {
  const rows = list.querySelectorAll<HTMLElement>(
    `[data-transcript-fragment-id="${CSS.escape(fragmentId)}"]`,
  );
  if (rows.length !== 1) return null;
  const row = rows[0];
  const texts = row.querySelectorAll<HTMLElement>("[data-transcript-fragment-text]");
  if (texts.length !== 1) return null;
  const text = texts[0];
  const cursor = buildCanonicalCursor(text);
  return validateCanonicalText(cursor, text.textContent ?? "")
    ? { row, cursor }
    : null;
}

function transcriptLayout(viewport: HTMLElement, list: HTMLElement) {
  if (!viewport.isConnected || !list.isConnected || !viewport.contains(list)) return null;
  const layout = {
    viewportWidth: viewport.clientWidth,
    viewportHeight: viewport.clientHeight,
    viewportScrollHeight: viewport.scrollHeight,
    listWidth: list.clientWidth,
    listHeight: list.clientHeight,
    listScrollHeight: list.scrollHeight,
  };
  return Object.values(layout).every((value) => value > 0) ? layout : null;
}

function intersects(left: DOMRect, right: DOMRect): boolean {
  return left.bottom > right.top && left.top < right.bottom &&
    left.right > right.left && left.left < right.right;
}

function listClipsContent(list: HTMLElement): boolean {
  return getComputedStyle(list).overflowY !== "visible";
}

/** Capture the timeline's actual scrollport; the route owns separate detail text. */
export function captureTranscriptPlacement(
  viewport: HTMLElement,
  list: HTMLElement,
): TranscriptPlacement | null {
  const layout = transcriptLayout(viewport, list);
  if (!layout) return null;
  const listRect = list.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  const listVisible = intersects(listRect, viewportRect);
  const scrollport = listClipsContent(list) ? "List" : listVisible ? "Viewport" : "Offscreen";
  const container = scrollport === "Viewport" ? viewport : list;
  const readingTop = container.getBoundingClientRect().top + getPaneScrollTopPaddingPx(container);
  let firstVisible: TranscriptPlacement | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("[data-transcript-fragment-id]")) {
    const rowRect = row.getBoundingClientRect();
    if (!intersects(rowRect, listRect) ||
        (scrollport === "Viewport" && !intersects(rowRect, viewportRect))) continue;
    const fragmentId = row.dataset.transcriptFragmentId;
    if (!fragmentId) return null;
    const source = transcriptText(list, fragmentId);
    if (!source) return null;
    if (findFirstVisibleCanonicalOffset(container, source.cursor) === null) continue;
    const text = measureCanonicalViewportOrigin(container, source.cursor);
    if (!text) continue;
    const placement: TranscriptPlacement = {
      fragmentId,
      canonicalText: source.cursor.emitted,
      text,
      scrollport,
      listViewportTopDeltaPx: listRect.top - viewportRect.top,
      viewportScrollLeft: viewport.scrollLeft,
      listVisible,
      layout,
    };
    firstVisible ??= placement;
    const ranges = resolveDomTextRanges(source.cursor, text.anchorCp, text.anchorCp + 1);
    if (ranges?.some((range) => [...range.getClientRects()].some((rect) => rect.bottom > readingTop))) {
      return placement;
    }
  }
  return firstVisible;
}

export async function positionTranscriptMatch(
  viewport: HTMLElement,
  list: HTMLElement,
  fragmentId: string,
  canonicalText: string,
  startOffset: number,
  endOffset: number,
  focusDestination: (element: HTMLElement) => boolean,
  signal: AbortSignal,
  positioner: ReaderScrollPositioner,
): Promise<ReaderNavigationOutcome> {
  if (signal.aborted) return { kind: "Cancelled", displaced: false };
  const source = transcriptText(list, fragmentId);
  if (!transcriptLayout(viewport, list) || !source ||
      !validateCanonicalText(source.cursor, canonicalText) ||
      !Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) ||
      startOffset < 0 || endOffset < startOffset || endOffset > source.cursor.length ||
      source.cursor.length === 0) {
    return { kind: "Unavailable", reason: "TargetUnavailable", displaced: false };
  }
  // A point at the end addresses the last authored character, as in text readers.
  const anchor = Math.min(startOffset, source.cursor.length - 1);
  const ranges = resolveDomTextRanges(source.cursor, anchor, anchor + 1);
  if (!ranges) return { kind: "Unavailable", reason: "TargetUnavailable", displaced: false };
  const anchorRect = () => ranges.flatMap((range) => [...range.getClientRects()])
    .find((rect) => rect.width > 0 && rect.height > 0);
  const visible = () => {
    const rect = anchorRect();
    return source.row.isConnected && !!rect && [list, viewport].every((container) => {
      const bounds = container.getBoundingClientRect();
      return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 &&
        rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
    });
  };
  if (visible()) return focusDestination(source.row)
    ? { kind: "Unchanged" }
    : { kind: "Unavailable", reason: "PositioningFailed", displaced: false };
  const before = [viewport.scrollTop, viewport.scrollLeft, list.scrollTop, list.scrollLeft];
  const displaced = () => [viewport.scrollTop, viewport.scrollLeft, list.scrollTop, list.scrollLeft]
    .some((value, index) => value !== before[index]);
  await positioner.run((commands) => {
    if (signal.aborted) return;
    for (const container of listClipsContent(list) ? [list, viewport] : [viewport]) {
      if (!scrollToExactCanonicalTextAnchor(commands, container, source.cursor, anchor)) return;
      const rect = anchorRect();
      if (!rect) return;
      const bounds = container.getBoundingClientRect();
      if (rect.left < bounds.left) container.scrollLeft += rect.left - bounds.left;
      else if (rect.right > bounds.right) container.scrollLeft += rect.right - bounds.right;
    }
  });
  if (signal.aborted) return { kind: "Cancelled", displaced: displaced() };
  return visible() && focusDestination(source.row)
    ? { kind: "Arrived" }
    : { kind: "Unavailable", reason: "PositioningFailed", displaced: displaced() };
}

export async function restoreTranscriptPlacement(
  viewport: HTMLElement,
  list: HTMLElement,
  placement: TranscriptPlacement,
  signal: AbortSignal,
  positioner: ReaderScrollPositioner,
): Promise<ReaderNavigationOutcome> {
  if (signal.aborted) return { kind: "Cancelled", displaced: false };
  const layout = transcriptLayout(viewport, list);
  const source = transcriptText(list, placement.fragmentId);
  if (!layout || !source || !validateCanonicalText(source.cursor, placement.canonicalText)) {
    return { kind: "Unavailable", reason: "TargetUnavailable", displaced: false };
  }
  const scrollport = placement.scrollport;
  if (listClipsContent(list) !== (scrollport === "List")) {
    return { kind: "Unavailable", reason: "PositioningFailed", displaced: false };
  }
  // When the list was offscreen, its delta identifies the outer spot only in
  // the same layout; it cannot describe reflow in the separate active content.
  if (!placement.listVisible && (
    layout.viewportWidth !== placement.layout.viewportWidth ||
    layout.viewportHeight !== placement.layout.viewportHeight ||
    layout.viewportScrollHeight !== placement.layout.viewportScrollHeight ||
    layout.listWidth !== placement.layout.listWidth ||
    layout.listHeight !== placement.layout.listHeight ||
    layout.listScrollHeight !== placement.layout.listScrollHeight
  )) return { kind: "Unavailable", reason: "PositioningFailed", displaced: false };
  const before = [viewport.scrollTop, viewport.scrollLeft, list.scrollTop, list.scrollLeft];
  const displaced = () => [viewport.scrollTop, viewport.scrollLeft, list.scrollTop, list.scrollLeft]
    .some((value, index) => value !== before[index]);
  const container = scrollport === "Viewport" ? viewport : list;
  let restored = false;
  await positioner.run((commands) => {
    if (signal.aborted) return;
    restored = restoreCanonicalTextAnchorViewportPosition(
      commands, container, source.cursor, placement.text.anchorCp,
      placement.text.viewportTopDeltaPx, placement.text.scrollLeft,
    );
    if (!restored) return;
    if (scrollport !== "Viewport") {
      commands.adjustTop(viewport, list.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top - placement.listViewportTopDeltaPx);
      viewport.scrollLeft = placement.viewportScrollLeft;
    }
  });
  if (signal.aborted) return { kind: "Cancelled", displaced: displaced() };
  const delta = list.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  const textDelta = measureCanonicalTextAnchorViewportDelta(container, source.cursor, placement.text.anchorCp);
  return restored && source.row.isConnected &&
    textDelta !== null && Math.abs(textDelta - placement.text.viewportTopDeltaPx) <= 1 &&
    Math.abs(container.scrollLeft - placement.text.scrollLeft) <= 1 &&
    (scrollport === "Viewport" || Math.abs(delta - placement.listViewportTopDeltaPx) <= 1) &&
    Math.abs(viewport.scrollLeft - placement.viewportScrollLeft) <= 1
    ? { kind: "Arrived" }
    : { kind: "Unavailable", reason: "PositioningFailed", displaced: displaced() };
}
