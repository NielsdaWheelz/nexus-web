/**
 * Highlights module - Highlight rendering and interaction.
 *
 * This module provides functionality for rendering and interacting with
 * highlights on web articles.
 * It includes:
 * - Overlap segmentation (PR-07)
 * - Canonical cursor building (PR-08)
 * - Segment application to DOM (PR-08)
 * - Selection → offset conversion (PR-09)
 * - Highlight interaction (focus, cycling) (PR-09)
 * - Memoization for performance
 *
 * Usage:
 * ```ts
 * import {
 *   applyHighlightsToHtml,
 *   applyHighlightsToHtmlMemoized,
 *   segmentHighlights,
 *   selectionToOffsets,
 *   useHighlightInteraction,
 *   HIGHLIGHT_COLORS,
 * } from '@/lib/highlights';
 * ```
 *
 * @see docs/v1/s2/s2_prs/s2_pr07.md - Segmenter
 * @see docs/v1/s2/s2_prs/s2_pr08.md - Rendering
 * @see docs/v1/s2/s2_prs/s2_pr09.md - Creation/Editing
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

// Re-export from selection to offsets (PR-09)
export {
  selectionToOffsets,
  selectionIntersectsCodeBlock,
  findDuplicateHighlight,
  utf16ToCodepoint,
  codepointToUtf16,
  MIN_HIGHLIGHT_LENGTH,
  MAX_HIGHLIGHT_LENGTH,
  type SelectionResult,
  type SelectionError,
  type SelectionErrorCode,
  type SelectionConversionResult,
} from "./selectionToOffsets";

// Re-export from use highlight interaction (PR-09)
export {
  useHighlightInteraction,
  parseHighlightElement,
  findHighlightElement,
  applyFocusClass,
  reconcileFocusAfterRefetch,
  type HighlightFocusState,
  type HighlightClickData,
  type UseHighlightInteractionReturn,
} from "./useHighlightInteraction";

// Re-export from alignment engine (PR-10)
export {
  measureAnchorPositions,
  computeAlignedRows,
  computeScrollTarget,
  createMeasureScheduler,
  createScrollHandler,
  compareRowsForAlignment,
  applyCollisionResolution,
  ROW_HEIGHT,
  ROW_GAP,
  SCROLL_TARGET_FRACTION,
  MEASURE_DEBOUNCE_MS,
  type AlignmentHighlight,
  type AlignedRow,
  type AlignmentResult,
} from "./alignmentEngine";
