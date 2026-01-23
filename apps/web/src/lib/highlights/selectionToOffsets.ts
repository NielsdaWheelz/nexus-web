/**
 * Selection → Offset Conversion for highlight creation.
 *
 * This module converts browser text selections (Range objects) to canonical
 * offsets that can be sent to the backend for highlight creation.
 *
 * The algorithm:
 * 1. Normalize backwards selections (right→left)
 * 2. Map DOM positions to canonical text offsets using the cursor
 * 3. Convert UTF-16 indices to codepoint indices
 * 4. Trim leading/trailing whitespace
 * 5. Validate length constraints
 * 6. Reject selections intersecting <pre>/<code>
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md §4
 */

import type { CanonicalCursorResult, CanonicalNode } from "./canonicalCursor";

// =============================================================================
// Types
// =============================================================================

/**
 * Result of a successful selection conversion.
 */
export type SelectionResult = {
  success: true;
  startOffset: number;
  endOffset: number;
  selectedText: string;
};

/**
 * Error types for selection failures.
 */
export type SelectionErrorCode =
  | "COLLAPSED" // Empty selection
  | "OUTSIDE_CONTENT" // Selection outside rendered content
  | "CODE_BLOCK" // Selection intersects <pre> or <code>
  | "TOO_SHORT" // Less than 2 codepoints after trimming
  | "TOO_LONG" // More than 2000 codepoints after trimming
  | "EMPTY_AFTER_TRIM" // Selection is only whitespace
  | "MISMATCH_STATE"; // Canonical text mismatch (highlighting disabled)

/**
 * Result of a failed selection conversion.
 */
export type SelectionError = {
  success: false;
  error: SelectionErrorCode;
  message: string;
};

/**
 * Combined result type.
 */
export type SelectionConversionResult = SelectionResult | SelectionError;

// =============================================================================
// Constants
// =============================================================================

/**
 * Minimum highlight length in codepoints.
 */
export const MIN_HIGHLIGHT_LENGTH = 2;

/**
 * Maximum highlight length in codepoints.
 */
export const MAX_HIGHLIGHT_LENGTH = 2000;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert a UTF-16 string index to a codepoint offset.
 * This handles astral characters (emoji, etc.) correctly.
 *
 * @param str - The string to measure
 * @param utf16Index - The UTF-16 code unit index
 * @returns The codepoint offset
 */
export function utf16ToCodepoint(str: string, utf16Index: number): number {
  return [...str.slice(0, utf16Index)].length;
}

/**
 * Convert a codepoint offset to a UTF-16 string index.
 *
 * @param str - The string to measure
 * @param codepointOffset - The codepoint offset
 * @returns The UTF-16 code unit index
 */
export function codepointToUtf16(str: string, codepointOffset: number): number {
  const codepoints = [...str];
  let utf16Index = 0;
  for (let i = 0; i < codepointOffset && i < codepoints.length; i++) {
    utf16Index += codepoints[i].length;
  }
  return utf16Index;
}

/**
 * Get the codepoint length of a string.
 */
export function codepointLength(str: string): number {
  return [...str].length;
}

/**
 * Check if a DOM node is inside a <pre> or <code> element.
 */
function isInsideCodeBlock(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const tag = (current as Element).tagName.toLowerCase();
      if (tag === "pre" || tag === "code") {
        return true;
      }
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Find a text node in the cursor mapping.
 */
function findNodeInCursor(
  cursor: CanonicalCursorResult,
  node: Text
): CanonicalNode | null {
  for (const entry of cursor.nodes) {
    if (entry.node === node) {
      return entry;
    }
  }
  return null;
}

/**
 * Find the first non-whitespace codepoint index from the start.
 */
function findFirstNonWhitespace(text: string): number {
  const codepoints = [...text];
  for (let i = 0; i < codepoints.length; i++) {
    if (!/\s/.test(codepoints[i])) {
      return i;
    }
  }
  return codepoints.length; // All whitespace
}

/**
 * Find the last non-whitespace codepoint index from the end.
 * Returns the index AFTER the last non-whitespace character (exclusive end).
 */
function findLastNonWhitespace(text: string): number {
  const codepoints = [...text];
  for (let i = codepoints.length - 1; i >= 0; i--) {
    if (!/\s/.test(codepoints[i])) {
      return i + 1;
    }
  }
  return 0; // All whitespace
}

/**
 * Normalize a Range so that start is always before end.
 * Handles backwards selections (right-to-left).
 */
function normalizeRange(range: Range): {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
} {
  // If the selection is collapsed, just return as-is
  if (range.collapsed) {
    return {
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
    };
  }

  // Use compareBoundaryPoints to check if start is after end
  // This can happen with backwards selections
  const comparison = range.compareBoundaryPoints(
    Range.START_TO_END,
    range
  );

  // If comparison > 0, start is after end (backwards selection)
  // In practice, the browser normalizes this for us in most cases,
  // but we check anyway for robustness
  if (comparison < 0) {
    // Swap start and end
    return {
      startContainer: range.endContainer,
      startOffset: range.endOffset,
      endContainer: range.startContainer,
      endOffset: range.startOffset,
    };
  }

  return {
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
  };
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Check if a selection intersects any code blocks.
 *
 * A selection is rejected if any spanned text node is inside <pre> or <code>.
 *
 * @param cursor - The canonical cursor result
 * @param absStart - Absolute start offset (codepoints)
 * @param absEnd - Absolute end offset (codepoints)
 * @returns true if selection intersects a code block
 */
export function selectionIntersectsCodeBlock(
  cursor: CanonicalCursorResult,
  absStart: number,
  absEnd: number
): boolean {
  // Find all text nodes whose range intersects [absStart, absEnd)
  for (const entry of cursor.nodes) {
    // Check if ranges intersect: !(entry.end <= absStart || entry.start >= absEnd)
    if (entry.start < absEnd && entry.end > absStart) {
      // Check ancestor chain for pre or code
      if (isInsideCodeBlock(entry.node)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Convert a browser selection Range to canonical offsets.
 *
 * This is the main entry point for selection → offset conversion.
 * It handles all the complexity of:
 * - Backwards selection normalization
 * - UTF-16 to codepoint conversion
 * - Whitespace trimming
 * - Length validation
 * - Code block rejection
 *
 * @param range - The browser Range object from the selection
 * @param cursor - The canonical cursor mapping from the rendered content
 * @param canonicalText - The canonical text from the fragment
 * @param mismatchDisabled - Whether highlighting is disabled due to mismatch
 * @returns Conversion result with offsets or error
 */
export function selectionToOffsets(
  range: Range,
  cursor: CanonicalCursorResult,
  canonicalText: string,
  mismatchDisabled: boolean = false
): SelectionConversionResult {
  // Guard: Check mismatch state first
  if (mismatchDisabled) {
    return {
      success: false,
      error: "MISMATCH_STATE",
      message: "Highlights disabled due to content mismatch. Try reloading.",
    };
  }

  // Guard: Check if selection is collapsed (empty)
  if (range.collapsed) {
    return {
      success: false,
      error: "COLLAPSED",
      message: "No text selected.",
    };
  }

  // Normalize backwards selections
  const normalized = normalizeRange(range);

  // Get the text nodes at start and end positions
  let startContainer = normalized.startContainer;
  let endContainer = normalized.endContainer;
  let startUtf16Offset = normalized.startOffset;
  let endUtf16Offset = normalized.endOffset;

  // If container is not a text node, find the text node
  if (startContainer.nodeType !== Node.TEXT_NODE) {
    // Navigate to the actual text node
    const walker = document.createTreeWalker(
      startContainer,
      NodeFilter.SHOW_TEXT
    );
    const firstText = walker.nextNode();
    if (!firstText) {
      return {
        success: false,
        error: "OUTSIDE_CONTENT",
        message: "Selection is outside text content.",
      };
    }
    startContainer = firstText;
    startUtf16Offset = 0;
  }

  if (endContainer.nodeType !== Node.TEXT_NODE) {
    // Navigate to the actual text node
    const walker = document.createTreeWalker(
      endContainer,
      NodeFilter.SHOW_TEXT
    );
    let lastText: Node | null = null;
    while (walker.nextNode()) {
      lastText = walker.currentNode;
    }
    if (!lastText) {
      return {
        success: false,
        error: "OUTSIDE_CONTENT",
        message: "Selection is outside text content.",
      };
    }
    endContainer = lastText;
    endUtf16Offset = (lastText as Text).textContent?.length ?? 0;
  }

  // Find the text nodes in the cursor mapping
  const startNode = findNodeInCursor(cursor, startContainer as Text);
  const endNode = findNodeInCursor(cursor, endContainer as Text);

  if (!startNode) {
    return {
      success: false,
      error: "OUTSIDE_CONTENT",
      message: "Selection start is outside rendered content.",
    };
  }

  if (!endNode) {
    return {
      success: false,
      error: "OUTSIDE_CONTENT",
      message: "Selection end is outside rendered content.",
    };
  }

  // Convert UTF-16 offsets to codepoint offsets within each node
  const startText = startNode.node.textContent || "";
  const endText = endNode.node.textContent || "";

  const startLocalCp = utf16ToCodepoint(startText, startUtf16Offset);
  const endLocalCp = utf16ToCodepoint(endText, endUtf16Offset);

  // Compute absolute offsets in canonical text space
  let absStart = startNode.start + startLocalCp;
  let absEnd = endNode.start + endLocalCp;

  // Ensure absStart < absEnd (should already be true after normalization)
  if (absStart >= absEnd) {
    return {
      success: false,
      error: "COLLAPSED",
      message: "Selection is empty after processing.",
    };
  }

  // Check for code block intersection BEFORE trimming
  if (selectionIntersectsCodeBlock(cursor, absStart, absEnd)) {
    return {
      success: false,
      error: "CODE_BLOCK",
      message: "Highlighting code blocks is not supported yet.",
    };
  }

  // Extract the selected text from canonical_text
  const selectedText = [...canonicalText].slice(absStart, absEnd).join("");

  // Trim leading and trailing whitespace
  const trimStartDelta = findFirstNonWhitespace(selectedText);
  const trimmedText = selectedText.trim();

  if (!trimmedText) {
    return {
      success: false,
      error: "EMPTY_AFTER_TRIM",
      message: "Selection contains only whitespace.",
    };
  }

  // Calculate new offsets after trimming
  const trimEndDelta = codepointLength(selectedText) - findLastNonWhitespace(selectedText);
  absStart += trimStartDelta;
  absEnd -= trimEndDelta;

  // Validate length constraints
  const finalLength = codepointLength(trimmedText);

  if (finalLength < MIN_HIGHLIGHT_LENGTH) {
    return {
      success: false,
      error: "TOO_SHORT",
      message: `Selection must be at least ${MIN_HIGHLIGHT_LENGTH} characters.`,
    };
  }

  if (finalLength > MAX_HIGHLIGHT_LENGTH) {
    return {
      success: false,
      error: "TOO_LONG",
      message: `Selection must be at most ${MAX_HIGHLIGHT_LENGTH} characters.`,
    };
  }

  return {
    success: true,
    startOffset: absStart,
    endOffset: absEnd,
    selectedText: trimmedText,
  };
}

/**
 * Check if an existing highlight already has the same span.
 * Used for duplicate detection before API call.
 *
 * @param highlights - Array of existing highlights
 * @param startOffset - Start offset to check
 * @param endOffset - End offset to check
 * @returns The matching highlight ID or null
 */
export function findDuplicateHighlight(
  highlights: Array<{ id: string; start_offset: number; end_offset: number }>,
  startOffset: number,
  endOffset: number
): string | null {
  for (const h of highlights) {
    if (h.start_offset === startOffset && h.end_offset === endOffset) {
      return h.id;
    }
  }
  return null;
}
