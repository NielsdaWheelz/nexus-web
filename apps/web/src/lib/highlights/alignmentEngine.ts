/**
 * Alignment Engine for Linked-Items Vertical Alignment.
 *
 * This module provides deterministic alignment logic for positioning linked-items
 * pane rows relative to highlight anchors in the content pane.
 *
 * The algorithm operates in two phases:
 * 1. Layout Measurement: Measure anchor positions in document space (expensive, debounced)
 * 2. Scroll Alignment: Compute row positions from cached positions + scrollTop (cheap, per-frame)
 *
 * Key invariants:
 * - Rows never overlap (push-down collision resolution)
 * - Order is deterministic (sorted by visual position, then canonical tie-breakers)
 * - No layout reads during scroll alignment (all reads happen in measurement phase)
 *
 * @see docs/v1/s2/s2_prs/s2_pr10.md
 */

// =============================================================================
// Constants
// =============================================================================

/** Fixed height for each linked-item row in pixels */
export const ROW_HEIGHT = 28;

/** Minimum vertical gap between adjacent rows in pixels */
export const ROW_GAP = 4;

/** Fraction from top of viewport when scrolling to a highlight */
export const SCROLL_TARGET_FRACTION = 0.2;

/** Debounce interval for layout measurement in milliseconds */
export const MEASURE_DEBOUNCE_MS = 75;

// =============================================================================
// Types
// =============================================================================

/**
 * Highlight data required for alignment calculations.
 * This is a subset of the full highlight data.
 */
export interface AlignmentHighlight {
  id: string;
  start_offset: number;
  end_offset: number;
  created_at: string; // ISO timestamp
}

/**
 * A row with computed position information.
 */
export interface AlignedRow {
  /** The highlight this row represents */
  highlight: AlignmentHighlight;
  /** The desired Y position based on anchor location */
  desiredY: number;
  /** The final Y position after collision resolution */
  top: number;
}

/**
 * Result of the alignment computation.
 */
export interface AlignmentResult {
  /** Aligned rows in display order */
  rows: AlignedRow[];
  /** IDs of highlights that couldn't be aligned (missing anchors) */
  missingAnchorIds: string[];
}

// =============================================================================
// Sorting Logic
// =============================================================================

/**
 * Parse created_at timestamp to milliseconds.
 * Handles both ISO strings and pre-parsed millisecond values.
 */
function parseCreatedAtMs(createdAt: string): number {
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Canonical sort comparator for rows.
 *
 * Sort order:
 * 1. desiredY ASC (visual position in document)
 * 2. start_offset ASC (earlier in text)
 * 3. end_offset ASC (shorter highlight first)
 * 4. created_at_ms ASC (older first)
 * 5. id ASC (lexicographic tiebreaker)
 *
 * This ensures deterministic ordering when multiple highlights
 * have the same visual position.
 */
export function compareRowsForAlignment(
  a: { highlight: AlignmentHighlight; desiredY: number },
  b: { highlight: AlignmentHighlight; desiredY: number }
): number {
  // 1. desiredY ASC
  if (a.desiredY !== b.desiredY) {
    return a.desiredY - b.desiredY;
  }

  // 2. start_offset ASC
  if (a.highlight.start_offset !== b.highlight.start_offset) {
    return a.highlight.start_offset - b.highlight.start_offset;
  }

  // 3. end_offset ASC
  if (a.highlight.end_offset !== b.highlight.end_offset) {
    return a.highlight.end_offset - b.highlight.end_offset;
  }

  // 4. created_at_ms ASC
  const aMs = parseCreatedAtMs(a.highlight.created_at);
  const bMs = parseCreatedAtMs(b.highlight.created_at);
  if (aMs !== bMs) {
    return aMs - bMs;
  }

  // 5. id ASC
  return a.highlight.id.localeCompare(b.highlight.id);
}

// =============================================================================
// Collision Resolution
// =============================================================================

/**
 * Apply push-down collision resolution to sorted rows.
 *
 * For each row in sorted order:
 *   top = max(desiredY, previousBottom + ROW_GAP)
 *   previousBottom = top + ROW_HEIGHT
 *
 * This ensures:
 * - No rows overlap
 * - Rows are pushed down, never up
 * - Minimum gap between rows is maintained
 *
 * @param sortedRows - Rows pre-sorted by compareRowsForAlignment
 * @returns Rows with final `top` positions computed
 */
export function applyCollisionResolution(
  sortedRows: Array<{ highlight: AlignmentHighlight; desiredY: number }>
): AlignedRow[] {
  const result: AlignedRow[] = [];
  let previousBottom = -Infinity;

  for (const row of sortedRows) {
    const top = Math.max(row.desiredY, previousBottom + ROW_GAP);
    result.push({
      highlight: row.highlight,
      desiredY: row.desiredY,
      top,
    });
    previousBottom = top + ROW_HEIGHT;
  }

  return result;
}

// =============================================================================
// Main Alignment Functions
// =============================================================================

/**
 * Compute aligned row positions for the given scroll state.
 *
 * This is the "per-frame" function that runs on scroll. It uses only cached
 * anchor positions and scrollTop - no DOM reads allowed.
 *
 * @param highlights - The highlights to align
 * @param anchorPositions - Map of highlightId -> anchorTopInDocument
 * @param scrollTop - Current scroll position of content container
 * @returns Aligned rows and list of highlights with missing anchors
 */
export function computeAlignedRows(
  highlights: AlignmentHighlight[],
  anchorPositions: Map<string, number>,
  scrollTop: number
): AlignmentResult {
  const missingAnchorIds: string[] = [];

  // Build rows with desiredY computed from cached positions
  const rowsWithDesiredY: Array<{ highlight: AlignmentHighlight; desiredY: number }> = [];

  for (const highlight of highlights) {
    const anchorTop = anchorPositions.get(highlight.id);

    if (anchorTop === undefined) {
      // Anchor not found - exclude from aligned list
      missingAnchorIds.push(highlight.id);
      continue;
    }

    // desiredY = anchorTopInDocument - scrollTop
    const desiredY = anchorTop - scrollTop;
    rowsWithDesiredY.push({ highlight, desiredY });
  }

  // Sort by visual position + canonical tiebreakers
  rowsWithDesiredY.sort(compareRowsForAlignment);

  // Apply collision resolution
  const rows = applyCollisionResolution(rowsWithDesiredY);

  return { rows, missingAnchorIds };
}

/**
 * Measure anchor positions for all highlights.
 *
 * This is the "expensive" function that reads from the DOM.
 * It should be called:
 * - On initial render / highlight list change
 * - On content pane resize
 * - On image load
 * - Debounced to avoid reflow storms
 *
 * @param contentRoot - The content container element
 * @param highlights - The highlights to measure anchors for
 * @returns Map of highlightId -> anchorTopInDocument
 */
export function measureAnchorPositions(
  contentRoot: Element,
  highlights: AlignmentHighlight[]
): Map<string, number> {
  const positions = new Map<string, number>();
  const contentRect = contentRoot.getBoundingClientRect();
  const scrollTop = (contentRoot as HTMLElement).scrollTop || 0;

  for (const highlight of highlights) {
    const anchor = contentRoot.querySelector(
      `[data-highlight-anchor="${highlight.id}"]`
    );

    if (!anchor) {
      console.warn("highlight_anchor_missing", { highlightId: highlight.id });
      continue;
    }

    const anchorRect = anchor.getBoundingClientRect();
    // Convert viewport-relative position to document-relative position
    const anchorTopInDocument = anchorRect.top - contentRect.top + scrollTop;
    positions.set(highlight.id, anchorTopInDocument);
  }

  return positions;
}

/**
 * Compute scroll target to make a highlight anchor visible.
 *
 * The target is computed so the highlight appears at SCROLL_TARGET_FRACTION
 * from the top of the container.
 *
 * @param anchorTop - The anchor's position in document space
 * @param containerHeight - The height of the scroll container
 * @returns The scrollTop value to scroll to
 */
export function computeScrollTarget(
  anchorTop: number,
  containerHeight: number
): number {
  return anchorTop - containerHeight * SCROLL_TARGET_FRACTION;
}

// =============================================================================
// Debounce Utility
// =============================================================================

/**
 * Create a debounced measurement scheduler.
 *
 * Returns a function that schedules measurement after MEASURE_DEBOUNCE_MS,
 * coalescing rapid calls.
 *
 * @param callback - The measurement function to call
 * @returns Object with schedule() and cancel() methods
 */
export function createMeasureScheduler(callback: () => void): {
  schedule: () => void;
  cancel: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule() {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        timeoutId = null;
        callback();
      }, MEASURE_DEBOUNCE_MS);
    },
    cancel() {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
}

// =============================================================================
// RAF Scroll Handler
// =============================================================================

/**
 * Create a scroll handler that throttles to requestAnimationFrame.
 *
 * Ensures only one alignment computation per frame, avoiding unnecessary work.
 *
 * @param callback - The alignment function to call on scroll
 * @returns Object with handleScroll() and cancel() methods
 */
export function createScrollHandler(callback: () => void): {
  handleScroll: () => void;
  cancel: () => void;
} {
  let rafId: number | null = null;

  return {
    handleScroll() {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          callback();
        });
      }
    },
    cancel() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
  };
}
