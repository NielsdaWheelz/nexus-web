"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  normalizeQuarterTurnRotation,
  projectPdfQuadToViewportRect,
  type PdfPageViewportTransform,
} from "@/lib/highlights/coordinateTransforms";
import { buildCanonicalCursor, type CanonicalNode } from "@/lib/highlights/canonicalCursor";
import { canonicalCpToRawCp } from "@/lib/highlights/canonicalText";
import { codepointToUtf16 } from "@/lib/highlights/codepoints";
import { escapeAttrValue } from "@/lib/highlights/escapeAttrValue";
import { compareStableString } from "@/lib/display/format";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import type { HighlightColor } from "@/lib/highlights/segmenter";

const MEASURE_DEBOUNCE_MS = 75;

export interface AnchoredReaderRow {
  id: string;
  exact: string;
  color: HighlightColor;
  linked_note_blocks?: {
    note_block_id: string;
    body_pm_json?: Record<string, unknown>;
    body_markdown?: string;
    body_text: string;
  }[];
  anchor?: {
    fragment_id?: string;
    start_offset: number;
    end_offset: number;
    t_start_ms?: number;
    t_end_ms?: number;
  };
  created_at?: string;
  updated_at?: string;
  prefix?: string;
  suffix?: string;
  stable_order_key?: string;
  linked_conversations?: { conversation_id: string; title: string }[];
  page_number?: number;
  quads?: PdfHighlightQuad[];
  is_owner?: boolean;
}

export interface AnchoredReaderProjection {
  row: AnchoredReaderRow;
  rect: { top: number; bottom: number };
}

export function findScrollParent(element: HTMLElement): HTMLElement {
  let parent = element.parentElement;
  while (parent) {
    const style = getComputedStyle(parent);
    if (style.overflowY === "auto" || style.overflowY === "scroll") {
      return parent;
    }
    parent = parent.parentElement;
  }
  return document.documentElement;
}

function readPdfPageViewportTransform(
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

function pickVisibleRect(
  rects: Array<{ top: number; bottom: number }>,
  viewportTop: number,
  viewportBottom: number,
) {
  for (const rect of rects) {
    const center = rect.top + (rect.bottom - rect.top) / 2;
    if (
      center >= viewportTop &&
      center <= viewportBottom &&
      rect.bottom > viewportTop &&
      rect.top < viewportBottom
    ) {
      return rect;
    }
  }

  let visibleRect: { top: number; bottom: number } | null = null;
  let visiblePixels = 0;
  for (const rect of rects) {
    const pixels =
      Math.min(rect.bottom, viewportBottom) - Math.max(rect.top, viewportTop);
    if (pixels > visiblePixels) {
      visiblePixels = pixels;
      visibleRect = rect;
    }
  }

  return visibleRect;
}

function boundaryAt(
  nodes: CanonicalNode[],
  offset: number,
): { node: Text; utf16Offset: number } | null {
  for (const entry of nodes) {
    if (offset >= entry.start && offset <= entry.end) {
      const text = entry.node.textContent ?? "";
      const rawCp = canonicalCpToRawCp(text, offset - entry.start, entry.trimLeadCp);
      return { node: entry.node, utf16Offset: codepointToUtf16(text, rawCp) };
    }
  }
  return null;
}

function textAnchorRects(
  contentElement: HTMLElement,
  row: AnchoredReaderRow,
  viewerRect: DOMRect,
  viewerScrollTop: number,
) {
  const anchor = row.anchor;
  if (!anchor?.fragment_id) return [];
  if (anchor.end_offset < anchor.start_offset) return [];
  const fragment = contentElement.querySelector<HTMLElement>(
    `[data-fragment-id="${escapeAttrValue(anchor.fragment_id)}"]`,
  );
  if (!fragment) return [];
  const cursor = buildCanonicalCursor(fragment);
  const start = boundaryAt(cursor.nodes, anchor.start_offset);
  const end = boundaryAt(cursor.nodes, anchor.end_offset);
  if (!start || !end) return [];

  const range = document.createRange();
  range.setStart(start.node, start.utf16Offset);
  range.setEnd(end.node, end.utf16Offset);
  return Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      top: rect.top - viewerRect.top + viewerScrollTop,
      bottom: rect.bottom - viewerRect.top + viewerScrollTop,
    }));
}

function elementRects(
  elements: Iterable<HTMLElement>,
  viewerRect: DOMRect,
  viewerScrollTop: number,
) {
  const rects: Array<{ top: number; bottom: number }> = [];
  for (const element of elements) {
    const clientRects = Array.from(element.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );

    for (const rect of clientRects) {
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const top = rect.top - viewerRect.top + viewerScrollTop;
      rects.push({ top, bottom: top + rect.height });
    }
  }
  return rects;
}

function sameRectMaps(
  left: Map<string, Array<{ top: number; bottom: number }>>,
  right: Map<string, Array<{ top: number; bottom: number }>>,
) {
  if (left.size !== right.size) return false;
  for (const [id, leftRects] of left) {
    const rightRects = right.get(id);
    if (!rightRects || leftRects.length !== rightRects.length) return false;
    for (let index = 0; index < leftRects.length; index += 1) {
      if (
        leftRects[index]?.top !== rightRects[index]?.top ||
        leftRects[index]?.bottom !== rightRects[index]?.bottom
      ) {
        return false;
      }
    }
  }
  return true;
}

function sameStringArray(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function useAnchoredReaderProjection({
  contentRef,
  rows,
  measureKey = 0,
  targetSelector,
  missingTargetLogName = "reader_row_target_missing",
}: {
  contentRef: RefObject<HTMLElement | null>;
  rows: AnchoredReaderRow[];
  measureKey?: string | number;
  targetSelector?: (escapedId: string) => string;
  missingTargetLogName?: string;
}) {
  const measureTimerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const [targetRects, setTargetRects] = useState(
    new Map<string, Array<{ top: number; bottom: number }>>(),
  );
  const [missingTargets, setMissingTargets] = useState<string[]>([]);
  const [viewportState, setViewportState] = useState({
    scrollTop: 0,
    clientHeight: 0,
  });

  const orderedRows = useMemo(() => {
    const sorted = [...rows];
    sorted.sort((left, right) => {
      if (
        left.stable_order_key &&
        right.stable_order_key &&
        left.stable_order_key !== right.stable_order_key
      ) {
        return compareStableString(left.stable_order_key, right.stable_order_key);
      }
      if (left.stable_order_key && !right.stable_order_key) {
        return -1;
      }
      if (!left.stable_order_key && right.stable_order_key) {
        return 1;
      }

      const leftStart = left.anchor?.start_offset ?? 0;
      const rightStart = right.anchor?.start_offset ?? 0;
      if (leftStart !== rightStart) {
        return leftStart - rightStart;
      }

      const leftEnd = left.anchor?.end_offset ?? 0;
      const rightEnd = right.anchor?.end_offset ?? 0;
      if (leftEnd !== rightEnd) {
        return leftEnd - rightEnd;
      }

      const leftCreatedAt = Date.parse(left.created_at ?? "");
      const rightCreatedAt = Date.parse(right.created_at ?? "");
      const leftCreatedAtMs = Number.isNaN(leftCreatedAt) ? 0 : leftCreatedAt;
      const rightCreatedAtMs = Number.isNaN(rightCreatedAt)
        ? 0
        : rightCreatedAt;
      if (leftCreatedAtMs !== rightCreatedAtMs) {
        return leftCreatedAtMs - rightCreatedAtMs;
      }

      return compareStableString(left.id, right.id);
    });
    return sorted;
  }, [rows]);

  const syncViewportState = useCallback((scrollParent: HTMLElement) => {
    setViewportState((previous) => {
      if (
        previous.scrollTop === scrollParent.scrollTop &&
        previous.clientHeight === scrollParent.clientHeight
      ) {
        return previous;
      }

      return {
        scrollTop: scrollParent.scrollTop,
        clientHeight: scrollParent.clientHeight,
      };
    });
  }, []);

  const measureTargets = useCallback(() => {
    if (!contentRef.current) {
      setTargetRects((previous) => (previous.size === 0 ? previous : new Map()));
      setMissingTargets((previous) => (previous.length === 0 ? previous : []));
      return;
    }

    const scrollParent = findScrollParent(contentRef.current);
    scrollParentRef.current = scrollParent;
    syncViewportState(scrollParent);

    const viewerRect = scrollParent.getBoundingClientRect();
    const viewerScrollTop = scrollParent.scrollTop;
    const pageElements = new Map<number, HTMLElement | null>();
    const nextTargetRects = new Map<
      string,
      Array<{ top: number; bottom: number }>
    >();
    const nextMissingTargets: string[] = [];

    for (const row of orderedRows) {
      const rects: Array<{ top: number; bottom: number }> = [];

      if (row.page_number && row.quads?.length) {
        let pageElement = pageElements.get(row.page_number);
        if (pageElement === undefined) {
          pageElement =
            contentRef.current.querySelector<HTMLElement>(
              `.page[data-page-number="${row.page_number}"]`,
            ) ??
            contentRef.current.querySelectorAll<HTMLElement>(".page")[
              row.page_number - 1
            ] ??
            null;
          pageElements.set(row.page_number, pageElement);
        }

        if (!pageElement) {
          nextMissingTargets.push(row.id);
          continue;
        }

        const transform = readPdfPageViewportTransform(pageElement);
        if (!transform) {
          nextMissingTargets.push(row.id);
          continue;
        }

        const pageRect = pageElement.getBoundingClientRect();
        for (const quad of row.quads) {
          const rect = projectPdfQuadToViewportRect(quad, transform);
          const top =
            pageRect.top - viewerRect.top + viewerScrollTop + rect.top;
          rects.push({ top, bottom: top + rect.height });
        }
      } else {
        const escapedId = escapeAttrValue(row.id);
        const segments = contentRef.current.querySelectorAll<HTMLElement>(
          targetSelector
            ? targetSelector(escapedId)
            : `[data-active-highlight-ids~="${escapedId}"]`,
        );
        rects.push(...elementRects(segments, viewerRect, viewerScrollTop));

        if (!targetSelector && rects.length === 0 && row.anchor?.fragment_id) {
          rects.push(
            ...textAnchorRects(
              contentRef.current,
              row,
              viewerRect,
              viewerScrollTop,
            ),
          );
        }
      }

      if (rects.length === 0) {
        nextMissingTargets.push(row.id);
        continue;
      }

      rects.sort((left, right) => {
        if (left.top !== right.top) {
          return left.top - right.top;
        }
        return left.bottom - right.bottom;
      });
      nextTargetRects.set(row.id, rects);
    }

    setTargetRects((previous) =>
      sameRectMaps(previous, nextTargetRects) ? previous : nextTargetRects,
    );
    setMissingTargets((previous) =>
      sameStringArray(previous, nextMissingTargets) ? previous : nextMissingTargets,
    );
  }, [contentRef, orderedRows, syncViewportState, targetSelector]);

  const scheduleMeasure = useCallback(() => {
    if (measureTimerRef.current != null) {
      window.clearTimeout(measureTimerRef.current);
    }
    measureTimerRef.current = window.setTimeout(() => {
      measureTimerRef.current = null;
      measureTargets();
    }, MEASURE_DEBOUNCE_MS);
  }, [measureTargets]);

  useEffect(() => {
    return () => {
      if (measureTimerRef.current != null) {
        window.clearTimeout(measureTimerRef.current);
      }
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setTargetRects((previous) => (previous.size === 0 ? previous : new Map()));
    setMissingTargets((previous) => (previous.length === 0 ? previous : []));
    let secondFrameId: number | null = null;
    const frameId = window.requestAnimationFrame(() => {
      measureTargets();
      secondFrameId = window.requestAnimationFrame(() => {
        measureTargets();
      });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      if (secondFrameId != null) {
        window.cancelAnimationFrame(secondFrameId);
      }
    };
  }, [measureKey, measureTargets]);

  useEffect(() => {
    if (!contentRef.current) {
      return;
    }

    const scrollParent = findScrollParent(contentRef.current);
    scrollParentRef.current = scrollParent;
    syncViewportState(scrollParent);

    const handleScroll = () => {
      if (scrollFrameRef.current != null) {
        return;
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        syncViewportState(scrollParent);
      });
    };

    scrollParent.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollParent.removeEventListener("scroll", handleScroll);
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [contentRef, orderedRows.length, measureKey, syncViewportState]);

  useEffect(() => {
    const contentElement = contentRef.current;
    if (!contentElement) {
      return;
    }

    const scrollParent =
      scrollParentRef.current ?? findScrollParent(contentElement);
    const observer = new ResizeObserver(() => {
      scheduleMeasure();
    });

    observer.observe(contentElement);
    if (scrollParent !== contentElement) {
      observer.observe(scrollParent);
    }

    return () => observer.disconnect();
  }, [contentRef, orderedRows.length, measureKey, scheduleMeasure]);

  useEffect(() => {
    const contentElement = contentRef.current;
    if (!contentElement) {
      return;
    }

    const images = contentElement.querySelectorAll("img");
    const handleImageLoad = () => {
      scheduleMeasure();
    };

    for (const image of images) {
      image.addEventListener("load", handleImageLoad);
      image.addEventListener("error", handleImageLoad);
    }

    return () => {
      for (const image of images) {
        image.removeEventListener("load", handleImageLoad);
        image.removeEventListener("error", handleImageLoad);
      }
    };
  }, [contentRef, measureKey, scheduleMeasure]);

  useEffect(() => {
    if (missingTargets.length === 0) {
      return;
    }
    console.warn(missingTargetLogName, { targetIds: missingTargets });
  }, [missingTargetLogName, missingTargets]);

  const projections = useMemo<AnchoredReaderProjection[]>(() => {
    const viewportTop = viewportState.scrollTop;
    const viewportBottom = viewportTop + viewportState.clientHeight;
    const out: AnchoredReaderProjection[] = [];

    for (const row of orderedRows) {
      const rects = targetRects.get(row.id);
      if (!rects) {
        continue;
      }

      const rect = pickVisibleRect(rects, viewportTop, viewportBottom);
      if (!rect) {
        continue;
      }

      out.push({ row, rect });
    }

    return out;
  }, [orderedRows, targetRects, viewportState]);

  return {
    orderedRows,
    projections,
    targetRects,
    missingTargets,
    viewportState,
    hasMeasuredTargets: targetRects.size > 0 || missingTargets.length > 0,
  };
}
