/**
 * Highlights module - Read-only highlight rendering.
 *
 * This module provides functionality for rendering highlights on web articles.
 * It includes:
 * - Overlap segmentation (PR-07)
 * - Canonical cursor building (PR-08)
 * - Segment application to DOM (PR-08)
 * - Memoization for performance
 *
 * Usage:
 * ```ts
 * import {
 *   applyHighlightsToHtml,
 *   applyHighlightsToHtmlMemoized,
 *   segmentHighlights,
 *   HIGHLIGHT_COLORS,
 * } from '@/lib/highlights';
 * ```
 *
 * @see docs/v1/s2/s2_prs/s2_pr07.md - Segmenter
 * @see docs/v1/s2/s2_prs/s2_pr08.md - Rendering
 */

// Re-export from segmenter (PR-07)
export {
  segmentHighlights,
  HIGHLIGHT_COLORS,
  type HighlightColor,
  type NormalizedHighlight,
  type Segment,
  type SegmentResult,
} from "./segmenter";

// Re-export from canonical cursor (PR-08)
export {
  buildCanonicalCursor,
  validateCanonicalText,
  codepointLength,
  BLOCK_ELEMENTS,
  type CanonicalNode,
  type CanonicalCursorResult,
} from "./canonicalCursor";

// Re-export from apply segments (PR-08)
export {
  applyHighlightsToHtml,
  applyHighlightsToHtmlMemoized,
  clearHighlightCache,
  computeHighlightsHash,
  normalizeHighlights,
  type HighlightInput,
  type ApplyHighlightsResult,
} from "./applySegments";
