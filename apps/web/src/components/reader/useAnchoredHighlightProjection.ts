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
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import type { HighlightColor } from "@/lib/highlights/segmenter";

const MEASURE_DEBOUNCE_MS = 75;

export interface AnchoredHighlightRow {
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

export interface AnchoredHighlightProjection {
  highlight: AnchoredHighlightRow;
  rect: { top: number; bottom: number };
}

export function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

export function useAnchoredHighlightProjection({
  contentRef,
  highlights,
  measureKey = 0,
}: {
  contentRef: RefObject<HTMLElement | null>;
  highlights: AnchoredHighlightRow[];
  measureKey?: string | number;
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

  const orderedHighlights = useMemo(() => {
    const sorted = [...highlights];
    sorted.sort((left, right) => {
      if (
        left.stable_order_key &&
        right.stable_order_key &&
        left.stable_order_key !== right.stable_order_key
      ) {
        return left.stable_order_key.localeCompare(right.stable_order_key);
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

      return left.id.localeCompare(right.id);
    });
    return sorted;
  }, [highlights]);

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
      setTargetRects(new Map());
      setMissingTargets([]);
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

    for (const highlight of orderedHighlights) {
      const rects: Array<{ top: number; bottom: number }> = [];

      if (highlight.page_number && highlight.quads?.length) {
        let pageElement = pageElements.get(highlight.page_number);
        if (pageElement === undefined) {
          pageElement =
            contentRef.current.querySelector<HTMLElement>(
              `.page[data-page-number="${highlight.page_number}"]`,
            ) ??
            contentRef.current.querySelectorAll<HTMLElement>(".page")[
              highlight.page_number - 1
            ] ??
            null;
          pageElements.set(highlight.page_number, pageElement);
        }

        if (!pageElement) {
          nextMissingTargets.push(highlight.id);
          continue;
        }

        const transform = readPdfPageViewportTransform(pageElement);
        if (!transform) {
          nextMissingTargets.push(highlight.id);
          continue;
        }

        const pageRect = pageElement.getBoundingClientRect();
        for (const quad of highlight.quads) {
          const rect = projectPdfQuadToViewportRect(quad, transform);
          const top =
            pageRect.top - viewerRect.top + viewerScrollTop + rect.top;
          rects.push({ top, bottom: top + rect.height });
        }
      } else {
        const escapedId = escapeAttrValue(highlight.id);
        const segments = contentRef.current.querySelectorAll<HTMLElement>(
          `[data-active-highlight-ids~="${escapedId}"]`,
        );

        for (const segment of segments) {
          const clientRects = Array.from(segment.getClientRects()).filter(
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
      }

      if (rects.length === 0) {
        nextMissingTargets.push(highlight.id);
        continue;
      }

      rects.sort((left, right) => {
        if (left.top !== right.top) {
          return left.top - right.top;
        }
        return left.bottom - right.bottom;
      });
      nextTargetRects.set(highlight.id, rects);
    }

    setTargetRects(nextTargetRects);
    setMissingTargets(nextMissingTargets);
  }, [contentRef, orderedHighlights, syncViewportState]);

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
    setTargetRects(new Map());
    setMissingTargets([]);
    const frameId = window.requestAnimationFrame(() => {
      measureTargets();
    });
    return () => window.cancelAnimationFrame(frameId);
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
  }, [
    contentRef,
    orderedHighlights.length,
    measureKey,
    syncViewportState,
  ]);

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
  }, [contentRef, orderedHighlights.length, measureKey, scheduleMeasure]);

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
    console.warn("highlight_target_missing", { highlightIds: missingTargets });
  }, [missingTargets]);

  const projections = useMemo<AnchoredHighlightProjection[]>(() => {
    const viewportTop = viewportState.scrollTop;
    const viewportBottom = viewportTop + viewportState.clientHeight;
    const out: AnchoredHighlightProjection[] = [];

    for (const highlight of orderedHighlights) {
      const rects = targetRects.get(highlight.id);
      if (!rects) {
        continue;
      }

      const rect = pickVisibleRect(rects, viewportTop, viewportBottom);
      if (!rect) {
        continue;
      }

      out.push({ highlight, rect });
    }

    return out;
  }, [orderedHighlights, targetRects, viewportState]);

  return {
    orderedHighlights,
    projections,
    targetRects,
    missingTargets,
    viewportState,
    hasMeasuredTargets: targetRects.size > 0 || missingTargets.length > 0,
  };
}
