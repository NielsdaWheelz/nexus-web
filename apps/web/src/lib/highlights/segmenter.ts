/**
 * Pure, deterministic overlap segmenter for highlights.
 *
 * This module performs no DOM work and has no backend dependencies.
 * It is the canonical frontend implementation of overlap semantics
 * used by highlight rendering and interaction.
 */

import { compareStableString } from "@/lib/display/format";

// =============================================================================
// Types
// =============================================================================

/**
 * Allowed highlight colors (must match backend).
 */
export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";

/**
 * Valid highlight colors for validation.
 */
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = [
  "yellow",
  "green",
  "blue",
  "pink",
  "purple",
] as const;

/**
 * Normalized highlight input to segmenter.
 * All inputs must be normalized upstream before passing to segmenter.
 */
export type NormalizedHighlight = {
  id: string;
  start: number; // inclusive; same coordinate unit as textLen
  end: number; // exclusive; same coordinate unit as textLen
  color: HighlightColor;
  created_at_ms: number; // Date.parse(created_at)
};

/**
 * A disjoint segment of text with active highlights.
 */
export type Segment = {
  start: number; // inclusive
  end: number; // exclusive
  activeIds: string[]; // ordered by (created_at_ms DESC, id ASC)
  topmostId: string;
  topmostColor: HighlightColor;
};

/**
 * Result of segmentation.
 */
export type SegmentResult = {
  segments: Segment[];
  droppedIds: string[]; // invalid highlights ignored
};

// =============================================================================
// Internal Types
// =============================================================================

type EventType = "start" | "end";

type Event = {
  pos: number;
  type: EventType;
  highlight: NormalizedHighlight;
};

// =============================================================================
// Comparators
// =============================================================================

/**
 * Topmost comparator: (created_at_ms DESC, id ASC)
 * Returns negative if a should come before b (a is "more topmost")
 */
function compareHighlightsTopmost(
  a: NormalizedHighlight,
  b: NormalizedHighlight
): number {
  // created_at_ms DESC (larger = more recent = comes first)
  if (a.created_at_ms !== b.created_at_ms) {
    return b.created_at_ms - a.created_at_ms;
  }
  // id ASC (lexicographic tiebreaker)
  return compareStableString(a.id, b.id);
}

/**
 * Event sort comparator:
 * 1. pos ASC
 * 2. type: "end" before "start" (half-open ranges: end at pos removes before start adds)
 * 3. Highlight order: (created_at_ms DESC, id ASC) — ensures deterministic output
 */
function compareEvents(a: Event, b: Event): number {
  // pos ASC
  if (a.pos !== b.pos) {
    return a.pos - b.pos;
  }
  // type: "end" before "start"
  if (a.type !== b.type) {
    return a.type === "end" ? -1 : 1;
  }
  // Highlight order for determinism
  return compareHighlightsTopmost(a.highlight, b.highlight);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Offsets must fit the text extent in the caller's coordinate space.
 */
function isValidHighlight(h: NormalizedHighlight, textLen: number): boolean {
  return h.start >= 0 && h.end > h.start && h.end <= textLen;
}

// =============================================================================
// Main Algorithm
// =============================================================================

/**
 * Segment highlights into disjoint ranges.
 *
 * Given:
 * - textLen: text extent in the same coordinate unit as highlight offsets
 * - highlights: list of normalized highlights
 *
 * Produces:
 * - segments: disjoint segments covering only highlighted ranges
 * - droppedIds: IDs of invalid highlights that were ignored
 *
 * Algorithm: Event sweep
 * Time: O(n log n) where n = number of highlights
 * Space: O(n)
 *
 * Invariants guaranteed:
 * 1. Segments are strictly ordered: segments[i].end <= segments[i+1].start
 * 2. segment.start < segment.end (no zero-width segments)
 * 3. segment.activeIds.length >= 1
 * 4. segment.topmostId ∈ segment.activeIds
 * 5. segment.topmostId === segment.activeIds[0]
 * 6. Output does not depend on input order (deterministic)
 * 7. No adjacent duplicates: no two consecutive segments have identical activeIds sets
 * 8. Coverage: union of emitted segment ranges equals union of valid highlight ranges
 */
export function segmentHighlights(
  textLen: number,
  highlights: NormalizedHighlight[]
): SegmentResult {
  // Partition valid and invalid highlights
  const validHighlights: NormalizedHighlight[] = [];
  const droppedIds: string[] = [];

  for (const h of highlights) {
    if (isValidHighlight(h, textLen)) {
      validHighlights.push(h);
    } else {
      droppedIds.push(h.id);
    }
  }

  // Empty input → empty output
  if (validHighlights.length === 0) {
    return { segments: [], droppedIds };
  }

  // Create events
  const events: Event[] = [];
  for (const h of validHighlights) {
    events.push({ pos: h.start, type: "start", highlight: h });
    events.push({ pos: h.end, type: "end", highlight: h });
  }

  // Sort events
  events.sort(compareEvents);

  // Sweep and build segments
  const segments: Segment[] = [];
  const activeMap = new Map<string, NormalizedHighlight>();
  let prevPos = -1;

  for (const event of events) {
    const { pos, type, highlight } = event;

    // Emit segment for range [prevPos, pos) if active set is non-empty
    if (pos > prevPos && prevPos >= 0 && activeMap.size > 0) {
      const segment = buildSegment(prevPos, pos, activeMap);
      if (segment) {
        // Merge with previous segment if identical activeIds
        const last = segments[segments.length - 1];
        if (last && last.end === segment.start && areActiveIdsSame(last.activeIds, segment.activeIds)) {
          // Extend previous segment
          last.end = segment.end;
        } else {
          segments.push(segment);
        }
      }
    }

    // Update active set
    if (type === "start") {
      activeMap.set(highlight.id, highlight);
    } else {
      activeMap.delete(highlight.id);
    }

    prevPos = pos;
  }

  return { segments, droppedIds };
}

/**
 * Build a segment from the current active set.
 */
function buildSegment(
  start: number,
  end: number,
  activeMap: Map<string, NormalizedHighlight>
): Segment | null {
  if (activeMap.size === 0) {
    return null;
  }

  // Get all active highlights and sort by topmost rule
  const activeHighlights = Array.from(activeMap.values());
  activeHighlights.sort(compareHighlightsTopmost);

  const topmost = activeHighlights[0];
  const activeIds = activeHighlights.map((h) => h.id);

  return {
    start,
    end,
    activeIds,
    topmostId: topmost.id,
    topmostColor: topmost.color,
  };
}

/**
 * Check if two activeIds arrays have the same elements (order matters here
 * since they're both sorted by the same comparator).
 */
function areActiveIdsSame(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
