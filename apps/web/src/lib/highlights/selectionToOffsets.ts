import type { DomTextCursor } from "./domTextCursor";
import { resolveDomRangeOffsets } from "./domTextRanges";

export type SelectionConversionResult =
  | {
      success: true;
      startOffset: number;
      endOffset: number;
      selectedText: string;
    }
  | {
      success: false;
      error:
        | "COLLAPSED"
        | "OUTSIDE_CONTENT"
        | "CODE_BLOCK"
        | "TOO_SHORT"
        | "TOO_LONG"
        | "EMPTY_AFTER_TRIM"
        | "MISMATCH_STATE";
      message: string;
    };

const MIN_HIGHLIGHT_LENGTH = 2;
const MAX_HIGHLIGHT_LENGTH = 2000;

/** Translate selection through provenance, then enforce highlight policy. */
export function selectionToOffsets(
  range: Range,
  cursor: DomTextCursor,
  canonicalText: string,
  mismatchDisabled = false,
): SelectionConversionResult {
  if (mismatchDisabled) {
    return {
      success: false,
      error: "MISMATCH_STATE",
      message: "Highlights disabled due to content mismatch. Try reloading.",
    };
  }
  if (range.collapsed) {
    return {
      success: false,
      error: "COLLAPSED",
      message: "No text selected.",
    };
  }
  const offsets = resolveDomRangeOffsets(cursor, range);
  if (offsets === null) {
    return {
      success: false,
      error: "OUTSIDE_CONTENT",
      message: "Selection is outside rendered content.",
    };
  }
  let { startOffset, endOffset } = offsets;
  if (
    cursor.provenance.slice(startOffset, endOffset).some((entry) =>
      entry.spans.some(
        (span) => span.node.parentElement?.closest("pre, code") != null,
      ),
    )
  ) {
    return {
      success: false,
      error: "CODE_BLOCK",
      message: "Highlighting code blocks is not supported yet.",
    };
  }

  const codepoints = [...canonicalText];
  while (startOffset < endOffset && /\s/.test(codepoints[startOffset])) {
    startOffset += 1;
  }
  while (endOffset > startOffset && /\s/.test(codepoints[endOffset - 1])) {
    endOffset -= 1;
  }
  if (startOffset === endOffset) {
    return {
      success: false,
      error: "EMPTY_AFTER_TRIM",
      message: "Selection contains only whitespace.",
    };
  }
  const length = endOffset - startOffset;
  if (length < MIN_HIGHLIGHT_LENGTH) {
    return {
      success: false,
      error: "TOO_SHORT",
      message: `Selection must be at least ${MIN_HIGHLIGHT_LENGTH} characters.`,
    };
  }
  if (length > MAX_HIGHLIGHT_LENGTH) {
    return {
      success: false,
      error: "TOO_LONG",
      message: `Selection must be at most ${MAX_HIGHLIGHT_LENGTH} characters.`,
    };
  }
  return {
    success: true,
    startOffset,
    endOffset,
    selectedText: codepoints.slice(startOffset, endOffset).join(""),
  };
}
