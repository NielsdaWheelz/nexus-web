"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import StateMessage from "@/components/ui/StateMessage";
import LinkedItemRow, { type LinkedItemRowHighlight } from "./LinkedItemRow";
import {
  normalizeQuarterTurnRotation,
  projectPdfQuadToViewportRect,
  type PdfPageViewportTransform,
} from "@/lib/highlights/coordinateTransforms";
import styles from "./LinkedItemsPane.module.css";

const ROW_HEIGHT = 44;
const ROW_GAP = 4;
const MEASURE_DEBOUNCE_MS = 75;

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function findScrollParent(element: HTMLElement): HTMLElement {
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

function readPdfPageViewportTransform(pageElement: HTMLElement): PdfPageViewportTransform | null {
  const scale = Number.parseFloat(pageElement.getAttribute("data-nexus-page-scale") ?? "");
  const viewportWidth = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-viewport-width") ?? ""
  );
  const viewportHeight = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-viewport-height") ?? ""
  );
  const dpiScale = Number.parseFloat(pageElement.getAttribute("data-nexus-page-dpi-scale") ?? "1");

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
    Number.parseInt(pageElement.getAttribute("data-nexus-page-rotation") ?? "0", 10)
  );

  return {
    scale,
    rotation,
    dpiScale,
    pageWidthPoints:
      rotation === 90 || rotation === 270 ? viewportHeight / scale : viewportWidth / scale,
    pageHeightPoints:
      rotation === 90 || rotation === 270 ? viewportWidth / scale : viewportHeight / scale,
  };
}

interface LinkedItemsPaneProps {
  highlights: LinkedItemRowHighlight[];
  contentRef: RefObject<HTMLElement | null>;
  focusedId: string | null;
  onHighlightClick: (highlightId: string) => void;
  highlightsVersion?: number;
  alignToContent?: boolean;
}

export default function LinkedItemsPane({
  highlights,
  contentRef,
  focusedId,
  onHighlightClick,
  highlightsVersion = 0,
  alignToContent = true,
}: LinkedItemsPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const measureTimerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [anchorPositions, setAnchorPositions] = useState(new Map<string, number>());
  const [alignedRows, setAlignedRows] = useState<Array<{ id: string; top: number }>>([]);
  const [overflowCount, setOverflowCount] = useState(0);
  const [missingAnchors, setMissingAnchors] = useState<string[]>([]);

  const measureAnchors = useCallback(() => {
    if (!alignToContent || !contentRef.current) {
      return;
    }

    const scrollParent = findScrollParent(contentRef.current);
    scrollParentRef.current = scrollParent;

    const viewerRect = scrollParent.getBoundingClientRect();
    const viewerScrollTop = scrollParent.scrollTop;
    const pageElements = new Map<number, HTMLElement | null>();
    const positions = new Map<string, number>();
    const nextMissingAnchors: string[] = [];

    for (const highlight of highlights) {
      if (highlight.page_number && highlight.quads?.length) {
        let pageElement = pageElements.get(highlight.page_number);
        if (pageElement === undefined) {
          pageElement =
            contentRef.current.querySelector<HTMLElement>(
              `.page[data-page-number="${highlight.page_number}"]`
            ) ??
            contentRef.current.querySelectorAll<HTMLElement>(".page")[highlight.page_number - 1] ??
            null;
          pageElements.set(highlight.page_number, pageElement);
        }

        if (!pageElement) {
          nextMissingAnchors.push(highlight.id);
          continue;
        }

        const transform = readPdfPageViewportTransform(pageElement);
        if (!transform) {
          nextMissingAnchors.push(highlight.id);
          continue;
        }

        const rect = projectPdfQuadToViewportRect(highlight.quads[0], transform);
        const pageRect = pageElement.getBoundingClientRect();
        positions.set(highlight.id, pageRect.top - viewerRect.top + viewerScrollTop + rect.top);
        continue;
      }

      const escapedId = escapeAttrValue(highlight.id);
      const anchor =
        contentRef.current.querySelector<HTMLElement>(`[data-highlight-anchor="${escapedId}"]`) ??
        contentRef.current.querySelector<HTMLElement>(`[data-active-highlight-ids~="${escapedId}"]`);
      if (!anchor) {
        nextMissingAnchors.push(highlight.id);
        continue;
      }

      const anchorRect = anchor.getBoundingClientRect();
      positions.set(highlight.id, anchorRect.top - viewerRect.top + viewerScrollTop);
    }

    setAnchorPositions(positions);
    setMissingAnchors(nextMissingAnchors);
  }, [alignToContent, contentRef, highlights]);

  const scheduleMeasure = useCallback(() => {
    if (measureTimerRef.current != null) {
      window.clearTimeout(measureTimerRef.current);
    }
    measureTimerRef.current = window.setTimeout(() => {
      measureTimerRef.current = null;
      measureAnchors();
    }, MEASURE_DEBOUNCE_MS);
  }, [measureAnchors]);

  const alignRows = useCallback(() => {
    if (!alignToContent || !containerRef.current) {
      return;
    }

    const contentElement = contentRef.current;
    if (!contentElement) {
      return;
    }

    const scrollParent = scrollParentRef.current ?? findScrollParent(contentElement);
    scrollParentRef.current = scrollParent;

    const baseline = scrollParent.getBoundingClientRect().top - containerRef.current.getBoundingClientRect().top;
    const scrollTop = scrollParent.scrollTop;
    const rows: Array<{
      highlight: LinkedItemRowHighlight;
      desiredTop: number;
    }> = [];

    for (const highlight of highlights) {
      const anchorTop = anchorPositions.get(highlight.id);
      if (anchorTop === undefined) {
        continue;
      }
      rows.push({
        highlight,
        desiredTop: anchorTop - scrollTop + baseline,
      });
    }

    rows.sort((left, right) => {
      if (left.desiredTop !== right.desiredTop) {
        return left.desiredTop - right.desiredTop;
      }

      const leftStart = left.highlight.start_offset ?? 0;
      const rightStart = right.highlight.start_offset ?? 0;
      if (leftStart !== rightStart) {
        return leftStart - rightStart;
      }

      const leftEnd = left.highlight.end_offset ?? 0;
      const rightEnd = right.highlight.end_offset ?? 0;
      if (leftEnd !== rightEnd) {
        return leftEnd - rightEnd;
      }

      const leftCreatedAt = Date.parse(left.highlight.created_at ?? "");
      const rightCreatedAt = Date.parse(right.highlight.created_at ?? "");
      const leftCreatedAtMs = Number.isNaN(leftCreatedAt) ? 0 : leftCreatedAt;
      const rightCreatedAtMs = Number.isNaN(rightCreatedAt) ? 0 : rightCreatedAt;
      if (leftCreatedAtMs !== rightCreatedAtMs) {
        return leftCreatedAtMs - rightCreatedAtMs;
      }

      return left.highlight.id.localeCompare(right.highlight.id);
    });

    let previousBottom = Number.NEGATIVE_INFINITY;
    const nextAlignedRows: Array<{ id: string; top: number }> = [];
    for (const row of rows) {
      const top = Math.max(row.desiredTop, previousBottom + ROW_GAP);
      nextAlignedRows.push({ id: row.highlight.id, top });
      previousBottom = top + ROW_HEIGHT;
    }

    setAlignedRows(nextAlignedRows);

    let nextOverflowCount = 0;
    for (const row of nextAlignedRows) {
      if (row.top + ROW_HEIGHT > containerRef.current.clientHeight) {
        nextOverflowCount += 1;
      }
    }
    setOverflowCount(nextOverflowCount);

    for (const row of nextAlignedRows) {
      rowRefs.current.get(row.id)?.style.setProperty("transform", `translateY(${row.top}px)`);
    }
  }, [alignToContent, anchorPositions, contentRef, highlights]);

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
    if (!alignToContent) {
      setAlignedRows([]);
      setOverflowCount(0);
      setMissingAnchors([]);
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      measureAnchors();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [alignToContent, highlightsVersion, measureAnchors]);

  useEffect(() => {
    if (!alignToContent || anchorPositions.size === 0) {
      return;
    }
    alignRows();
  }, [alignRows, alignToContent, anchorPositions]);

  useEffect(() => {
    if (!alignToContent || !contentRef.current) {
      return;
    }

    const scrollParent = findScrollParent(contentRef.current);
    scrollParentRef.current = scrollParent;

    const handleScroll = () => {
      if (scrollFrameRef.current != null) {
        return;
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        alignRows();
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
  }, [alignRows, alignToContent, contentRef, highlights.length, highlightsVersion]);

  useEffect(() => {
    if (!alignToContent || typeof ResizeObserver === "undefined") {
      return;
    }

    const contentElement = contentRef.current;
    const containerElement = containerRef.current;
    const scrollParent = scrollParentRef.current;
    if (!contentElement && !containerElement) {
      return;
    }

    const observer = new ResizeObserver(() => {
      scheduleMeasure();
    });

    if (contentElement) {
      observer.observe(contentElement);
    }
    if (containerElement) {
      observer.observe(containerElement);
    }
    if (scrollParent && scrollParent !== contentElement) {
      observer.observe(scrollParent);
    }

    return () => observer.disconnect();
  }, [alignToContent, contentRef, highlights.length, highlightsVersion, scheduleMeasure]);

  useEffect(() => {
    if (!alignToContent || !contentRef.current) {
      return;
    }

    const images = contentRef.current.querySelectorAll("img");
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
  }, [alignToContent, contentRef, highlightsVersion, scheduleMeasure]);

  useEffect(() => {
    if (!alignToContent || missingAnchors.length === 0) {
      return;
    }
    console.warn("highlight_anchor_missing", { highlightIds: missingAnchors });
  }, [alignToContent, missingAnchors]);

  const handleRowClick = useCallback(
    (highlightId: string) => {
      onHighlightClick(highlightId);

      if (!contentRef.current) {
        return;
      }

      const escapedId = escapeAttrValue(highlightId);
      const anchor =
        contentRef.current.querySelector<HTMLElement>(`[data-highlight-anchor="${escapedId}"]`) ??
        contentRef.current.querySelector<HTMLElement>(`[data-active-highlight-ids~="${escapedId}"]`);
      anchor?.scrollIntoView({ behavior: "auto", block: "center" });
    },
    [contentRef, onHighlightClick]
  );

  const handleRowMouseEnter = useCallback(
    (highlightId: string) => {
      if (!contentRef.current) {
        return;
      }

      const escapedId = escapeAttrValue(highlightId);
      const segments = contentRef.current.querySelectorAll(
        `[data-active-highlight-ids~="${escapedId}"]`
      );
      for (const segment of segments) {
        segment.classList.add("hl-hover-outline");
      }
    },
    [contentRef]
  );

  const handleRowMouseLeave = useCallback(() => {
    if (!contentRef.current) {
      return;
    }

    const outlinedElements = contentRef.current.querySelectorAll(".hl-hover-outline");
    for (const outlinedElement of outlinedElements) {
      outlinedElement.classList.remove("hl-hover-outline");
    }
  }, [contentRef]);

  const setRowRef = useCallback(
    (highlightId: string) => (element: HTMLButtonElement | null) => {
      if (element) {
        rowRefs.current.set(highlightId, element);
      } else {
        rowRefs.current.delete(highlightId);
      }
    },
    []
  );

  const listHighlights = useMemo(() => {
    if (alignToContent) {
      return [];
    }

    const sorted = [...highlights];
    sorted.sort((left, right) => {
      if (left.stable_order_key && right.stable_order_key && left.stable_order_key !== right.stable_order_key) {
        return left.stable_order_key.localeCompare(right.stable_order_key);
      }
      if (left.stable_order_key && !right.stable_order_key) {
        return -1;
      }
      if (!left.stable_order_key && right.stable_order_key) {
        return 1;
      }

      const leftFragment = left.fragment_idx ?? 0;
      const rightFragment = right.fragment_idx ?? 0;
      if (leftFragment !== rightFragment) {
        return leftFragment - rightFragment;
      }

      const leftStart = left.start_offset ?? 0;
      const rightStart = right.start_offset ?? 0;
      if (leftStart !== rightStart) {
        return leftStart - rightStart;
      }

      const leftEnd = left.end_offset ?? 0;
      const rightEnd = right.end_offset ?? 0;
      if (leftEnd !== rightEnd) {
        return leftEnd - rightEnd;
      }

      const leftCreatedAt = Date.parse(left.created_at ?? "");
      const rightCreatedAt = Date.parse(right.created_at ?? "");
      const leftCreatedAtMs = Number.isNaN(leftCreatedAt) ? 0 : leftCreatedAt;
      const rightCreatedAtMs = Number.isNaN(rightCreatedAt) ? 0 : rightCreatedAt;
      if (leftCreatedAtMs !== rightCreatedAtMs) {
        return leftCreatedAtMs - rightCreatedAtMs;
      }

      return left.id.localeCompare(right.id);
    });
    return sorted;
  }, [alignToContent, highlights]);

  useEffect(() => {
    if (alignToContent || !focusedId) {
      return;
    }
    rowRefs.current.get(focusedId)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [alignToContent, focusedId, highlightsVersion]);

  if (highlights.length === 0) {
    return (
      <div className={styles.linkedItemsContainer} data-testid="linked-items-container">
        <div className={styles.emptyStateMessage}>
          <StateMessage variant="empty">No highlights in this context.</StateMessage>
        </div>
      </div>
    );
  }

  if (!alignToContent) {
    return (
      <div
        ref={containerRef}
        className={`${styles.linkedItemsContainer} ${styles.listMode}`}
        data-testid="linked-items-container"
      >
        {listHighlights.map((highlight) => (
          <LinkedItemRow
            key={highlight.id}
            ref={setRowRef(highlight.id)}
            highlight={highlight}
            isFocused={focusedId === highlight.id}
            onClick={handleRowClick}
            onMouseEnter={handleRowMouseEnter}
            onMouseLeave={handleRowMouseLeave}
            className={styles.listModeRow}
          />
        ))}
      </div>
    );
  }

  const highlightMap = new Map(highlights.map((highlight) => [highlight.id, highlight]));

  return (
    <div
      ref={containerRef}
      className={styles.linkedItemsContainer}
      data-testid="linked-items-container"
    >
      {alignedRows.map((row) => {
        const highlight = highlightMap.get(row.id);
        if (!highlight) {
          return null;
        }

        return (
          <LinkedItemRow
            key={row.id}
            ref={setRowRef(row.id)}
            highlight={highlight}
            isFocused={focusedId === row.id}
            onClick={handleRowClick}
            onMouseEnter={handleRowMouseEnter}
            onMouseLeave={handleRowMouseLeave}
            style={{ transform: `translateY(${row.top}px)` }}
          />
        );
      })}
      {overflowCount > 0 ? (
        <div className={styles.overflowIndicator}>+{overflowCount} more below</div>
      ) : null}
    </div>
  );
}
