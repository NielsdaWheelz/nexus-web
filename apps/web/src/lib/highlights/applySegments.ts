/**
 * Apply highlight segments to DOM.
 *
 * This module transforms sanitized HTML by wrapping highlighted text ranges
 * in <span> elements with appropriate data attributes and classes.
 *
 * The algorithm:
 * 1. Parse html_sanitized into a detached DOM tree
 * 2. Build canonical cursor (maps text nodes to canonical offsets)
 * 3. Run segmenter on highlights to get disjoint segments
 * 4. Split text nodes at segment boundaries
 * 5. Wrap segments in <span> with data-highlight-ids, data-highlight-top, class
 * 6. Insert highlight anchors (one per highlight at its start position)
 * 7. Serialize DOM back to HTML string
 *
 * All DOM work happens on a detached DOM tree, never mutating the live DOM.
 *
 * @see docs/v1/s2/s2_prs/s2_pr08.md §6
 */

import {
  buildCanonicalCursor,
  validateCanonicalText,
  codepointLength,
  type CanonicalCursorResult,
  type CanonicalNode,
} from "./canonicalCursor";
import {
  segmentHighlights,
  type NormalizedHighlight,
  type Segment,
  type HighlightColor,
} from "./segmenter";

// =============================================================================
// Types
// =============================================================================

/**
 * Input highlight data for rendering.
 * This is the shape returned by the API after normalization.
 */
export type HighlightInput = {
  id: string;
  start_offset: number;
  end_offset: number;
  color: HighlightColor;
  created_at: string; // ISO timestamp
};

/**
 * Result of applying highlights to HTML.
 */
export type ApplyHighlightsResult = {
  /** The transformed HTML with highlight spans */
  html: string;
  /** IDs of highlights that failed to render */
  failedIds: string[];
  /** Whether canonical text validation passed */
  validationPassed: boolean;
};

// =============================================================================
// Constants
// =============================================================================

/**
 * Highlight color CSS classes.
 */
const COLOR_CLASSES: Record<HighlightColor, string> = {
  yellow: "hl-yellow",
  green: "hl-green",
  blue: "hl-blue",
  pink: "hl-pink",
  purple: "hl-purple",
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Compute a stable hash of highlights for memoization.
 * Per spec §10.2, this should be cheap and stable.
 */
export function computeHighlightsHash(highlights: NormalizedHighlight[]): string {
  return highlights
    .map((h) => `${h.id}:${h.start}:${h.end}:${h.color}:${h.created_at_ms}`)
    .sort()
    .join("|");
}

/**
 * Normalize highlight input from API to the format expected by segmenter.
 */
export function normalizeHighlights(
  highlights: HighlightInput[]
): NormalizedHighlight[] {
  return highlights.map((h) => ({
    id: h.id,
    start: h.start_offset,
    end: h.end_offset,
    color: h.color,
    created_at_ms: Date.parse(h.created_at),
  }));
}

/**
 * Find the text node and offset within it for a given canonical offset.
 * Returns null if the offset doesn't fall within any mapped text node.
 */
function findNodeAtOffset(
  nodes: CanonicalNode[],
  canonicalOffset: number
): { node: Text; offsetInNode: number } | null {
  for (const mapping of nodes) {
    if (canonicalOffset >= mapping.start && canonicalOffset < mapping.end) {
      return {
        node: mapping.node,
        offsetInNode: canonicalOffset - mapping.start,
      };
    }
  }
  // Special case: offset at the very end of the last node
  if (nodes.length > 0) {
    const last = nodes[nodes.length - 1];
    if (canonicalOffset === last.end) {
      // Return position at end of last node
      const nodeText = [...(last.node.textContent || "")];
      return {
        node: last.node,
        offsetInNode: nodeText.length,
      };
    }
  }
  return null;
}

/**
 * Convert codepoint offset to UTF-16 offset within a text node.
 * This is necessary because JavaScript strings use UTF-16.
 */
function codepointToUtf16Offset(text: string, codepointOffset: number): number {
  const codepoints = [...text];
  let utf16Offset = 0;
  for (let i = 0; i < codepointOffset && i < codepoints.length; i++) {
    utf16Offset += codepoints[i].length;
  }
  return utf16Offset;
}

// =============================================================================
// DOM Manipulation
// =============================================================================

/**
 * Create a highlight span element.
 */
function createHighlightSpan(
  doc: Document,
  segment: Segment
): HTMLSpanElement {
  const span = doc.createElement("span");
  span.setAttribute("data-highlight-ids", segment.activeIds.join(","));
  span.setAttribute("data-highlight-top", segment.topmostId);
  span.className = COLOR_CLASSES[segment.topmostColor];
  return span;
}

/**
 * Create a highlight anchor element.
 */
function createHighlightAnchor(doc: Document, highlightId: string): HTMLSpanElement {
  const anchor = doc.createElement("span");
  anchor.setAttribute("data-highlight-anchor", highlightId);
  return anchor;
}

/**
 * Wrap a portion of text in a highlight span.
 * Handles the case where the range spans across the entire text node.
 */
function wrapTextRange(
  doc: Document,
  node: Text,
  startOffset: number,
  endOffset: number,
  segment: Segment
): HTMLSpanElement {
  const text = node.textContent || "";
  const codepoints = [...text];
  const totalCodepoints = codepoints.length;

  // Clamp offsets
  const clampedStart = Math.max(0, Math.min(startOffset, totalCodepoints));
  const clampedEnd = Math.max(clampedStart, Math.min(endOffset, totalCodepoints));

  // Convert to UTF-16 offsets
  const utf16Start = codepointToUtf16Offset(text, clampedStart);
  const utf16End = codepointToUtf16Offset(text, clampedEnd);

  // Create the span
  const span = createHighlightSpan(doc, segment);

  if (utf16Start === 0 && utf16End >= text.length) {
    // Wrap entire node
    const parent = node.parentNode;
    if (parent) {
      parent.replaceChild(span, node);
      span.appendChild(node);
    }
  } else {
    // Need to split
    let targetNode = node;

    // Split at start if needed
    if (utf16Start > 0) {
      targetNode = node.splitText(utf16Start);
    }

    // Split at end if needed (relative to target node now)
    const targetText = targetNode.textContent || "";
    const relativeEnd = utf16End - utf16Start;
    if (relativeEnd < targetText.length) {
      targetNode.splitText(relativeEnd);
    }

    // Wrap the target node
    const parent = targetNode.parentNode;
    if (parent) {
      parent.replaceChild(span, targetNode);
      span.appendChild(targetNode);
    }
  }

  return span;
}

// =============================================================================
// Main Functions
// =============================================================================

/**
 * Apply highlight segments to a DOM tree.
 *
 * This is the core rendering function that transforms the DOM by:
 * 1. Splitting text nodes at segment boundaries
 * 2. Wrapping highlighted text in span elements
 * 3. Inserting highlight anchors
 *
 * @param root - The root element to transform (will be mutated)
 * @param cursorResult - The canonical cursor result
 * @param segments - The highlight segments from segmenter
 * @param highlights - The original highlights (for anchor placement)
 * @returns Set of highlight IDs that were successfully rendered
 */
function applySegmentsToDom(
  root: Element,
  cursorResult: CanonicalCursorResult,
  segments: Segment[],
  highlights: NormalizedHighlight[]
): Set<string> {
  const doc = root.ownerDocument;
  const renderedHighlightIds = new Set<string>();
  const anchorInserted = new Set<string>();

  // Build a map of highlight ID to highlight for anchor placement
  const highlightMap = new Map<string, NormalizedHighlight>();
  for (const h of highlights) {
    highlightMap.set(h.id, h);
  }

  // Process segments in reverse order to avoid offset invalidation
  // (Later segments have higher offsets, processing them first means
  // earlier segments' offsets remain valid)
  const sortedSegments = [...segments].sort((a, b) => b.start - a.start);

  // Track span start offsets for anchor placement
  const spanStartOffsets = new Map<HTMLSpanElement, number>();

  for (const segment of sortedSegments) {
    // Find all text nodes that this segment spans
    const nodeMappings: Array<{
      mapping: CanonicalNode;
      startInNode: number;
      endInNode: number;
    }> = [];

    for (const mapping of cursorResult.nodes) {
      // Check if this mapping overlaps with the segment
      const overlapStart = Math.max(segment.start, mapping.start);
      const overlapEnd = Math.min(segment.end, mapping.end);

      if (overlapStart < overlapEnd) {
        nodeMappings.push({
          mapping,
          startInNode: overlapStart - mapping.start,
          endInNode: overlapEnd - mapping.start,
        });
      }
    }

    // Process nodes in reverse order (within this segment)
    nodeMappings.sort((a, b) => b.mapping.start - a.mapping.start);

    let firstSpanForSegment: HTMLSpanElement | null = null;
    let firstSpanStart = Infinity;

    for (const { mapping, startInNode, endInNode } of nodeMappings) {
      try {
        const span = wrapTextRange(
          doc,
          mapping.node,
          startInNode,
          endInNode,
          segment
        );

        const spanStart = mapping.start + startInNode;
        spanStartOffsets.set(span, spanStart);

        // Track the first span (will be the one with lowest offset)
        if (spanStart < firstSpanStart) {
          firstSpanForSegment = span;
          firstSpanStart = spanStart;
        }

        // Mark all active highlights as rendered
        for (const id of segment.activeIds) {
          renderedHighlightIds.add(id);
        }
      } catch (error) {
        console.warn("highlight_render_failed", {
          segmentStart: segment.start,
          segmentEnd: segment.end,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    // Insert anchors for highlights that start in this segment
    if (firstSpanForSegment) {
      for (const highlightId of segment.activeIds) {
        if (anchorInserted.has(highlightId)) continue;

        const highlight = highlightMap.get(highlightId);
        if (!highlight) continue;

        // Check if this highlight starts within this segment
        if (highlight.start >= segment.start && highlight.start < segment.end) {
          // Insert anchor before the first span of this segment
          const anchor = createHighlightAnchor(doc, highlightId);
          const parent = firstSpanForSegment.parentNode;
          if (parent) {
            parent.insertBefore(anchor, firstSpanForSegment);
            anchorInserted.add(highlightId);
          }
        }
      }
    }
  }

  // Insert anchors for any highlights that weren't covered
  // (This handles edge cases where a highlight's start is exactly at a segment boundary)
  for (const highlight of highlights) {
    if (anchorInserted.has(highlight.id)) continue;
    if (!renderedHighlightIds.has(highlight.id)) continue;

    // Find where to insert the anchor
    const location = findNodeAtOffset(cursorResult.nodes, highlight.start);
    if (location) {
      const anchor = createHighlightAnchor(doc, highlight.id);
      const parent = location.node.parentNode;
      if (parent) {
        parent.insertBefore(anchor, location.node);
        anchorInserted.add(highlight.id);
      }
    }
  }

  return renderedHighlightIds;
}

/**
 * Apply highlights to sanitized HTML.
 *
 * This is the main entry point for highlight rendering. It:
 * 1. Parses the HTML into a detached DOM
 * 2. Validates canonical text (aborts if mismatch)
 * 3. Runs the segmenter
 * 4. Applies segments to DOM
 * 5. Serializes back to HTML
 *
 * @param htmlSanitized - The sanitized HTML from the fragment
 * @param canonicalText - The canonical text from the fragment
 * @param fragmentId - The fragment ID (for logging)
 * @param highlights - The highlights to render
 * @returns The result with transformed HTML
 */
export function applyHighlightsToHtml(
  htmlSanitized: string,
  canonicalText: string,
  fragmentId: string,
  highlights: HighlightInput[]
): ApplyHighlightsResult {
  // If no highlights, return original HTML
  if (highlights.length === 0) {
    return {
      html: htmlSanitized,
      failedIds: [],
      validationPassed: true,
    };
  }

  // Parse HTML into detached DOM
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<div id="__highlight_root__">${htmlSanitized}</div>`,
    "text/html"
  );
  const root = doc.getElementById("__highlight_root__");

  if (!root) {
    console.warn("highlight_render_failed", {
      fragmentId,
      reason: "Failed to parse HTML",
    });
    return {
      html: htmlSanitized,
      failedIds: highlights.map((h) => h.id),
      validationPassed: false,
    };
  }

  // Build canonical cursor
  const cursorResult = buildCanonicalCursor(root);

  // Validate canonical text
  const validationPassed = validateCanonicalText(
    cursorResult,
    canonicalText,
    fragmentId
  );

  if (!validationPassed) {
    // Abort highlight rendering, return original HTML
    return {
      html: htmlSanitized,
      failedIds: highlights.map((h) => h.id),
      validationPassed: false,
    };
  }

  // Normalize highlights for segmenter
  const normalized = normalizeHighlights(highlights);

  // Run segmenter
  const textLength = codepointLength(canonicalText);
  const { segments, droppedIds } = segmentHighlights(textLength, normalized);

  // Apply segments to DOM
  const renderedIds = applySegmentsToDom(root, cursorResult, segments, normalized);

  // Calculate failed IDs
  const failedIds = [
    ...droppedIds,
    ...highlights
      .filter((h) => !renderedIds.has(h.id) && !droppedIds.includes(h.id))
      .map((h) => h.id),
  ];

  // Log any failed highlights
  for (const id of failedIds) {
    if (!droppedIds.includes(id)) {
      console.warn("highlight_render_failed", {
        highlightId: id,
        fragmentId,
        reason: "Could not apply to DOM",
      });
    }
  }

  // Serialize back to HTML
  const html = root.innerHTML;

  return {
    html,
    failedIds,
    validationPassed: true,
  };
}

/**
 * Memoized version of applyHighlightsToHtml.
 *
 * Caches results by (fragmentId, highlightsHash) to avoid recomputation.
 * This is important for performance when highlights don't change.
 */
const highlightCache = new Map<string, ApplyHighlightsResult>();
const MAX_CACHE_SIZE = 50;

export function applyHighlightsToHtmlMemoized(
  htmlSanitized: string,
  canonicalText: string,
  fragmentId: string,
  highlights: HighlightInput[]
): ApplyHighlightsResult {
  const normalized = normalizeHighlights(highlights);
  const highlightsHash = computeHighlightsHash(normalized);
  const cacheKey = `${fragmentId}:${highlightsHash}`;

  const cached = highlightCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result = applyHighlightsToHtml(
    htmlSanitized,
    canonicalText,
    fragmentId,
    highlights
  );

  // Simple LRU-ish cache management
  if (highlightCache.size >= MAX_CACHE_SIZE) {
    // Delete oldest entry
    const firstKey = highlightCache.keys().next().value;
    if (firstKey) {
      highlightCache.delete(firstKey);
    }
  }

  highlightCache.set(cacheKey, result);

  return result;
}

/**
 * Clear the highlight cache.
 * Useful for testing or when fragment content changes.
 */
export function clearHighlightCache(): void {
  highlightCache.clear();
}
