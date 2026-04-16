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

import { useRef, useEffect, useState, useCallback, useMemo, type RefObject } from "react";
import LinkedItemRow, { type LinkedItemRowHighlight } from "./LinkedItemRow";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import {
  computeAlignedRows,
  createMeasureScheduler,
  createScrollHandler,
  findScrollParent,
  ROW_HEIGHT,
  type AlignmentHighlight,
  type AlignedRow,
} from "@/lib/highlights/alignmentEngine";
import {
  DEFAULT_HTML_ANCHOR_PROVIDER,
  type AnchorDescriptor,
  type AnchorProvider,
} from "@/lib/highlights/anchorProviders";
import {
  paneBaselineOffsetFromContainers,
  paneYFromViewerViewportY,
  toViewerViewportY,
} from "@/lib/highlights/coordinateTransforms";
import StateMessage from "@/components/ui/StateMessage";
import styles from "./LinkedItemsPane.module.css";

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

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
  /** Callback for quote-to-chat trigger (S3 PR-07). */
  onSendToChat?: (highlightId: string) => void;
  /** Layout strategy: anchor alignment (chapter) or static list (book index). */
  layoutMode?: "aligned" | "list";
  /** Optional explicit anchor descriptors for provider-driven alignment. */
  anchorDescriptors?: AnchorDescriptor[];
  /** Renderer-specific anchor provider. Defaults to HTML anchor lookup. */
  anchorProvider?: AnchorProvider;
  /** Save annotation inline. */
  onAnnotationSave?: (highlightId: string, body: string) => Promise<void>;
  /** Delete annotation inline. */
  onAnnotationDelete?: (highlightId: string) => Promise<void>;
  /** Per-row action menu options builder. */
  rowOptions?: (highlightId: string) => ActionMenuOption[];
  /** Callback when a linked conversation is opened from a highlight row. */
  onOpenConversation?: (conversationId: string, title: string) => void;
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
  onSendToChat,
  layoutMode = "aligned",
  anchorDescriptors,
  anchorProvider,
  onAnnotationSave,
  onAnnotationDelete,
  rowOptions,
  onOpenConversation,
}: LinkedItemsPaneProps) {
  const isAlignedMode = layoutMode === "aligned";
  const resolvedAnchorProvider = anchorProvider ?? DEFAULT_HTML_ANCHOR_PROVIDER;

  // Container ref for sizing calculations
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolved scroll parent (nearest ancestor with overflow-y: auto/scroll)
  const scrollParentRef = useRef<HTMLElement | null>(null);

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
    if (!isAlignedMode || !contentRef.current) return;

    // Resolve scroll parent on first measurement (or if contentRef changed)
    if (!scrollParentRef.current) {
      scrollParentRef.current = findScrollParent(contentRef.current as HTMLElement);
    }

    const descriptors =
      anchorDescriptors ??
      highlights.map((highlight) => ({
        kind: "html" as const,
        id: highlight.id,
      }));
    const positions = resolvedAnchorProvider.measureViewerAnchorPositions(descriptors, {
      contentRoot: contentRef.current,
      viewerScrollContainer: scrollParentRef.current,
    });

    setAnchorPositions(positions);
  }, [anchorDescriptors, contentRef, highlights, isAlignedMode, resolvedAnchorProvider]);

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
    if (!isAlignedMode || !scrollParentRef.current || anchorPositions.size === 0) return;

    const scrollTop = scrollParentRef.current.scrollTop;
    const containerHeight = containerRef.current?.clientHeight ?? 0;
    const paneBaselineOffset =
      containerRef.current
        ? paneBaselineOffsetFromContainers(scrollParentRef.current, containerRef.current)
        : 0;

    // Convert highlights to alignment format with full data
    const alignmentHighlights: AlignmentHighlight[] = highlights.map((h) => ({
      id: h.id,
      start_offset: h.start_offset ?? 0,
      end_offset: h.end_offset ?? 0,
      created_at: h.created_at ?? "",
    }));

    // Compute aligned rows
    const result = computeAlignedRows(
      alignmentHighlights,
      anchorPositions,
      scrollTop
    );
    const rowsInPaneSpace = result.rows.map((row) => ({
      ...row,
      top: paneYFromViewerViewportY(toViewerViewportY(row.top), paneBaselineOffset) as number,
    }));

    // Update state for initial render
    setAlignedRows(rowsInPaneSpace);
    setMissingAnchors(result.missingAnchorIds);

    // Count overflow
    let overflow = 0;
    for (const row of rowsInPaneSpace) {
      if (row.top + ROW_HEIGHT > containerHeight) {
        overflow++;
      }
    }
    setOverflowCount(overflow);

    // Direct DOM manipulation for smooth scroll
    for (const row of rowsInPaneSpace) {
      const el = rowRefs.current.get(row.highlight.id);
      if (el) {
        el.style.transform = `translateY(${row.top}px)`;
      }
    }
  }, [anchorPositions, highlights, isAlignedMode]);

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
    if (!isAlignedMode) return;

    // Measure on mount and after render stabilizes
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        measure();
      });
    });
  }, [measure, highlightsVersion, isAlignedMode]);

  // Align after measurement completes
  useEffect(() => {
    if (isAlignedMode && anchorPositions.size > 0) {
      alignRows();
    }
  }, [anchorPositions, alignRows, isAlignedMode]);

  // Resolve scroll parent when contentRef becomes available
  useEffect(() => {
    if (!isAlignedMode) return;
    if (contentRef.current) {
      scrollParentRef.current = findScrollParent(contentRef.current as HTMLElement);
    }
  }, [contentRef, highlightsVersion, isAlignedMode, highlights.length]);

  // Scroll event listener on the actual scrolling ancestor
  useEffect(() => {
    if (!isAlignedMode) return;
    if (contentRef.current) {
      scrollParentRef.current = findScrollParent(contentRef.current as HTMLElement);
    }
    const scrollEl = scrollParentRef.current;
    if (!scrollEl) return;

    const handleScroll = () => scrollHandler.current.handleScroll();
    scrollEl.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      scrollEl.removeEventListener("scroll", handleScroll);
    };
  }, [contentRef, highlightsVersion, isAlignedMode, highlights.length]);

  // ResizeObserver for content, scroll parent, and container
  useEffect(() => {
    if (!isAlignedMode) return;
    const contentEl = contentRef.current;
    const containerEl = containerRef.current;
    const scrollEl = scrollParentRef.current;
    if (!contentEl && !containerEl) return;

    const observer = new ResizeObserver(() => {
      measureScheduler.current.schedule();
    });

    if (contentEl) observer.observe(contentEl);
    if (containerEl) observer.observe(containerEl);
    if (scrollEl && scrollEl !== contentEl) observer.observe(scrollEl);

    return () => observer.disconnect();
  }, [contentRef, isAlignedMode, highlightsVersion, highlights.length]);

  // Image load listeners
  useEffect(() => {
    if (!isAlignedMode) return;
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
  }, [contentRef, highlightsVersion, isAlignedMode]);

  // ==========================================================================
  // Interaction Handlers
  // ==========================================================================

  const handleRowClick = useCallback(
    (highlightId: string) => {
      onHighlightClick(highlightId);

      const contentEl = contentRef.current;
      if (!contentEl) {
        return;
      }

      // Prefer anchor.scrollIntoView so the nearest real scroll container moves,
      // even when contentRef itself is not the element with overflow scrolling.
      const escapedId = escapeAttrValue(highlightId);
      const anchor =
        contentEl.querySelector<HTMLElement>(`[data-highlight-anchor="${escapedId}"]`) ??
        contentEl.querySelector<HTMLElement>(`[data-active-highlight-ids~="${escapedId}"]`);
      if (anchor) {
        anchor.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
    [onHighlightClick, contentRef]
  );

  const handleRowMouseEnter = useCallback(
    (highlightId: string) => {
      hoveredIdRef.current = highlightId;

      // Apply hover outline to content pane highlights
      if (contentRef.current) {
        const escapedId = escapeAttrValue(highlightId);
        const selector = `[data-active-highlight-ids~="${escapedId}"]`;
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
    if (isAlignedMode && missingAnchors.length > 0) {
      console.warn("highlight_anchor_missing", { highlightIds: missingAnchors });
    }
  }, [missingAnchors, isAlignedMode]);

  useEffect(() => {
    if (isAlignedMode || !focusedId) {
      return;
    }
    const focusedRow = rowRefs.current.get(focusedId);
    if (focusedRow) {
      focusedRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focusedId, highlightsVersion, isAlignedMode]);

  // Build a map for fast lookup
  const highlightMap = new Map(highlights.map((h) => [h.id, h]));

  const listModeHighlights = useMemo(() => {
    if (isAlignedMode) return [];
    const sorted = [...highlights];
    sorted.sort((a, b) => {
      const aStableKey = a.stable_order_key;
      const bStableKey = b.stable_order_key;
      if (aStableKey && bStableKey && aStableKey !== bStableKey) {
        return aStableKey.localeCompare(bStableKey);
      }
      if (aStableKey && !bStableKey) {
        return -1;
      }
      if (!aStableKey && bStableKey) {
        return 1;
      }

      const aFragmentIdx = a.fragment_idx ?? 0;
      const bFragmentIdx = b.fragment_idx ?? 0;
      if (aFragmentIdx !== bFragmentIdx) {
        return aFragmentIdx - bFragmentIdx;
      }

      const aStart = a.start_offset ?? 0;
      const bStart = b.start_offset ?? 0;
      if (aStart !== bStart) {
        return aStart - bStart;
      }

      const aEnd = a.end_offset ?? 0;
      const bEnd = b.end_offset ?? 0;
      if (aEnd !== bEnd) {
        return aEnd - bEnd;
      }

      const aMs = Date.parse(a.created_at ?? "");
      const bMs = Date.parse(b.created_at ?? "");
      const normalizedAMs = Number.isNaN(aMs) ? 0 : aMs;
      const normalizedBMs = Number.isNaN(bMs) ? 0 : bMs;
      if (normalizedAMs !== normalizedBMs) {
        return normalizedAMs - normalizedBMs;
      }

      return a.id.localeCompare(b.id);
    });
    return sorted;
  }, [highlights, isAlignedMode]);

  if (highlights.length === 0) {
    return (
      <div className={styles.linkedItemsContainer} data-testid="linked-items-container">
        <div className={styles.emptyStateMessage}>
          <StateMessage variant="empty">
            No highlights yet. Select text to create one.
          </StateMessage>
        </div>
      </div>
    );
  }

  if (!isAlignedMode) {
    return (
      <div
        ref={containerRef}
        className={`${styles.linkedItemsContainer} ${styles.listMode}`}
        data-testid="linked-items-container"
      >
        {listModeHighlights.map((highlight) => (
          <LinkedItemRow
            key={highlight.id}
            ref={setRowRef(highlight.id)}
            highlight={highlight}
            className={styles.listModeRow}
            isFocused={focusedId === highlight.id}
            onClick={handleRowClick}
            onMouseEnter={handleRowMouseEnter}
            onMouseLeave={handleRowMouseLeave}
            onSendToChat={onSendToChat}
            onAnnotationSave={onAnnotationSave}
            onAnnotationDelete={onAnnotationDelete}
            options={rowOptions?.(highlight.id)}
            onOpenConversation={onOpenConversation}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={styles.linkedItemsContainer}
      data-testid="linked-items-container"
    >
      {alignedRows.map((row) => {
        const highlight = highlightMap.get(row.highlight.id);
        if (!highlight) return null;

        return (
          <LinkedItemRow
            key={row.highlight.id}
            ref={setRowRef(row.highlight.id)}
            highlight={highlight}
            style={{ transform: `translateY(${row.top}px)` }}
            isFocused={focusedId === row.highlight.id}
            onClick={handleRowClick}
            onMouseEnter={handleRowMouseEnter}
            onMouseLeave={handleRowMouseLeave}
            onSendToChat={onSendToChat}
            onAnnotationSave={onAnnotationSave}
            onAnnotationDelete={onAnnotationDelete}
            options={rowOptions?.(row.highlight.id)}
            onOpenConversation={onOpenConversation}
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
