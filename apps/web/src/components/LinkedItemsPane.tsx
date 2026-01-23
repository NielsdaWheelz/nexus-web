/**
 * LinkedItemsPane - Container for vertically aligned linked-items.
 *
 * This pane displays highlight rows that align vertically with their
 * corresponding highlight anchors in the content pane.
 *
 * The alignment works in two phases:
 * 1. Measurement (expensive, debounced): Measure anchor positions in document space
 * 2. Scroll alignment (cheap, per-frame): Position rows based on cached positions
 *
 * Key invariants:
 * - Rows never overlap (collision resolution pushes down)
 * - Alignment is deterministic (sorted by visual position, then canonical)
 * - No layout reads during scroll (all reads in measurement phase)
 *
 * @see docs/v1/s2/s2_prs/s2_pr10.md
 */

"use client";

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type RefObject,
} from "react";
import LinkedItemRow, { type LinkedItemRowHighlight } from "./LinkedItemRow";
import {
  measureAnchorPositions,
  computeAlignedRows,
  computeScrollTarget,
  createMeasureScheduler,
  createScrollHandler,
  ROW_HEIGHT,
  type AlignmentHighlight,
  type AlignedRow,
} from "@/lib/highlights/alignmentEngine";
import styles from "./LinkedItemsPane.module.css";

// =============================================================================
// Types
// =============================================================================

export interface LinkedItemsPaneProps {
  /** Highlights to display in the pane */
  highlights: LinkedItemRowHighlight[];
  /** Ref to the content pane's scroll container */
  contentRef: RefObject<HTMLElement | null>;
  /** Currently focused highlight ID */
  focusedId: string | null;
  /** Callback when a highlight is clicked */
  onHighlightClick: (highlightId: string) => void;
  /** Version number that changes when highlights change (triggers re-measurement) */
  highlightsVersion?: number;
}

// =============================================================================
// Component
// =============================================================================

export default function LinkedItemsPane({
  highlights,
  contentRef,
  focusedId,
  onHighlightClick,
  highlightsVersion = 0,
}: LinkedItemsPaneProps) {
  // Container ref for sizing calculations
  const containerRef = useRef<HTMLDivElement>(null);

  // Row refs for direct DOM manipulation during scroll
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // Cached anchor positions (document space)
  const [anchorPositions, setAnchorPositions] = useState<Map<string, number>>(
    new Map()
  );

  // Aligned rows state (for initial render and re-renders)
  const [alignedRows, setAlignedRows] = useState<AlignedRow[]>([]);

  // Missing anchors (for debugging/logging)
  const [missingAnchors, setMissingAnchors] = useState<string[]>([]);

  // Hovered highlight ID (for outline effect) - stored in ref since only used for DOM manipulation
  const hoveredIdRef = useRef<string | null>(null);

  // Count of rows below visible area
  const [overflowCount, setOverflowCount] = useState(0);

  // ==========================================================================
  // Measurement Phase
  // ==========================================================================

  /**
   * Measure anchor positions from the content pane.
   * This is the "expensive" operation that reads layout from DOM.
   */
  const measure = useCallback(() => {
    if (!contentRef.current) return;

    // Convert highlights to AlignmentHighlight format
    const alignmentHighlights: AlignmentHighlight[] = highlights.map((h) => ({
      id: h.id,
      start_offset: 0, // Not used for measurement, only for tie-breaking
      end_offset: 0,
      created_at: "", // Not used for measurement
    }));

    const positions = measureAnchorPositions(
      contentRef.current,
      alignmentHighlights
    );

    setAnchorPositions(positions);
  }, [contentRef, highlights]);

  // Create debounced measurement scheduler
  const measureScheduler = useRef(createMeasureScheduler(measure));

  // Re-create scheduler when measure function changes
  useEffect(() => {
    measureScheduler.current.cancel();
    measureScheduler.current = createMeasureScheduler(measure);
    return () => measureScheduler.current.cancel();
  }, [measure]);

  // ==========================================================================
  // Scroll Alignment Phase
  // ==========================================================================

  /**
   * Align rows based on current scroll position.
   * This is the "cheap" operation that only does math and DOM writes.
   */
  const alignRows = useCallback(() => {
    if (!contentRef.current || anchorPositions.size === 0) return;

    const scrollTop = contentRef.current.scrollTop;
    const containerHeight = containerRef.current?.clientHeight ?? 0;

    // Convert highlights to alignment format with full data
    const alignmentHighlights: AlignmentHighlight[] = highlights.map((h) => ({
      id: h.id,
      start_offset: 0, // We don't have offsets here, but we have positions
      end_offset: 0,
      created_at: "", // Not needed since we're using measured positions
    }));

    // Compute aligned rows
    const result = computeAlignedRows(
      alignmentHighlights,
      anchorPositions,
      scrollTop
    );

    // Update state for initial render
    setAlignedRows(result.rows);
    setMissingAnchors(result.missingAnchorIds);

    // Count overflow
    let overflow = 0;
    for (const row of result.rows) {
      if (row.top + ROW_HEIGHT > containerHeight) {
        overflow++;
      }
    }
    setOverflowCount(overflow);

    // Direct DOM manipulation for smooth scroll
    for (const row of result.rows) {
      const el = rowRefs.current.get(row.highlight.id);
      if (el) {
        el.style.transform = `translateY(${row.top}px)`;
      }
    }
  }, [contentRef, anchorPositions, highlights]);

  // Create RAF-throttled scroll handler
  const scrollHandler = useRef(createScrollHandler(alignRows));

  // Re-create scroll handler when alignRows changes
  useEffect(() => {
    scrollHandler.current.cancel();
    scrollHandler.current = createScrollHandler(alignRows);
    return () => scrollHandler.current.cancel();
  }, [alignRows]);

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  // Initial measurement and on highlight changes
  useEffect(() => {
    // Measure on mount and after render stabilizes
    requestAnimationFrame(() => {
      measure();
    });
  }, [measure, highlightsVersion]);

  // Align after measurement completes
  useEffect(() => {
    if (anchorPositions.size > 0) {
      alignRows();
    }
  }, [anchorPositions, alignRows]);

  // Scroll event listener
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    const handleScroll = () => scrollHandler.current.handleScroll();
    contentEl.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      contentEl.removeEventListener("scroll", handleScroll);
    };
  }, [contentRef]);

  // ResizeObserver for content and container
  useEffect(() => {
    const contentEl = contentRef.current;
    const containerEl = containerRef.current;
    if (!contentEl && !containerEl) return;

    const observer = new ResizeObserver(() => {
      measureScheduler.current.schedule();
    });

    if (contentEl) observer.observe(contentEl);
    if (containerEl) observer.observe(containerEl);

    return () => observer.disconnect();
  }, [contentRef]);

  // Image load listeners
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    const images = contentEl.querySelectorAll("img");
    const handleImageLoad = () => measureScheduler.current.schedule();

    images.forEach((img) => {
      img.addEventListener("load", handleImageLoad);
      img.addEventListener("error", handleImageLoad);
    });

    return () => {
      images.forEach((img) => {
        img.removeEventListener("load", handleImageLoad);
        img.removeEventListener("error", handleImageLoad);
      });
    };
  }, [contentRef, highlightsVersion]);

  // ==========================================================================
  // Interaction Handlers
  // ==========================================================================

  const handleRowClick = useCallback(
    (highlightId: string) => {
      onHighlightClick(highlightId);

      // Scroll content to highlight anchor
      const anchorTop = anchorPositions.get(highlightId);
      if (anchorTop !== undefined && contentRef.current) {
        const target = computeScrollTarget(
          anchorTop,
          contentRef.current.clientHeight
        );
        contentRef.current.scrollTo({
          top: Math.max(0, target),
          behavior: "smooth",
        });
      }
    },
    [onHighlightClick, anchorPositions, contentRef]
  );

  const handleRowMouseEnter = useCallback(
    (highlightId: string) => {
      hoveredIdRef.current = highlightId;

      // Apply hover outline to content pane highlights
      if (contentRef.current) {
        const selector = `[data-active-highlight-ids~="${highlightId}"]`;
        const segments = contentRef.current.querySelectorAll(selector);
        segments.forEach((el) => el.classList.add("hl-hover-outline"));
      }
    },
    [contentRef]
  );

  const handleRowMouseLeave = useCallback(() => {
    hoveredIdRef.current = null;

    // Remove hover outline from content pane
    if (contentRef.current) {
      const outlinedElements =
        contentRef.current.querySelectorAll(".hl-hover-outline");
      outlinedElements.forEach((el) => el.classList.remove("hl-hover-outline"));
    }
  }, [contentRef]);

  // Register row ref
  const setRowRef = useCallback(
    (highlightId: string) => (el: HTMLDivElement | null) => {
      if (el) {
        rowRefs.current.set(highlightId, el);
      } else {
        rowRefs.current.delete(highlightId);
      }
    },
    []
  );

  // ==========================================================================
  // Render
  // ==========================================================================

  // Log missing anchors in development
  useEffect(() => {
    if (missingAnchors.length > 0) {
      console.warn("highlight_anchor_missing", { highlightIds: missingAnchors });
    }
  }, [missingAnchors]);

  if (highlights.length === 0) {
    return (
      <div className={styles.linkedItemsContainer}>
        <div className={styles.emptyState}>
          <p>No highlights yet.</p>
          <p className={styles.hint}>Select text to create a highlight.</p>
        </div>
      </div>
    );
  }

  // Build a map for fast lookup
  const highlightMap = new Map(highlights.map((h) => [h.id, h]));

  return (
    <div ref={containerRef} className={styles.linkedItemsContainer}>
      {alignedRows.map((row) => {
        const highlight = highlightMap.get(row.highlight.id);
        if (!highlight) return null;

        return (
          <LinkedItemRow
            key={row.highlight.id}
            ref={setRowRef(row.highlight.id)}
            highlight={highlight}
            isFocused={focusedId === row.highlight.id}
            onClick={handleRowClick}
            onMouseEnter={handleRowMouseEnter}
            onMouseLeave={handleRowMouseLeave}
          />
        );
      })}
      {overflowCount > 0 && (
        <div className={styles.overflowIndicator}>
          {overflowCount} more below
        </div>
      )}
    </div>
  );
}
