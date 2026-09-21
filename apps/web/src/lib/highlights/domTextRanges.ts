import type { DomTextCursor, DomTextSpan } from "./domTextCursor";

/** Canonical offsets and DOM UTF-16 ranges share the cursor's provenance. */
export function resolveDomTextRanges(
  cursor: DomTextCursor,
  startOffset: number,
  endOffset: number,
): Range[] | null {
  if (
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > cursor.length
  ) {
    return null;
  }

  const ordered = cursor.provenance
    .slice(startOffset, endOffset)
    .flatMap((entry) => entry.spans)
    .sort((left, right) => {
      if (left.node === right.node) {
        return (
          left.startUtf16 - right.startUtf16 || left.endUtf16 - right.endUtf16
        );
      }
      const position = left.node.compareDocumentPosition(right.node);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      throw new Error("Canonical provenance spans must share one document tree.");
    });
  const spans: DomTextSpan[] = [];
  for (const span of ordered) {
    const previous = spans[spans.length - 1];
    if (previous?.node === span.node && span.startUtf16 <= previous.endUtf16) {
      previous.endUtf16 = Math.max(previous.endUtf16, span.endUtf16);
    } else {
      spans.push({ ...span });
    }
  }
  if (spans.length === 0) return null;
  return spans.map((span) => {
    const range = span.node.ownerDocument.createRange();
    range.setStart(span.node, span.startUtf16);
    range.setEnd(span.node, span.endUtf16);
    return range;
  });
}

/** Selecting any part of a source codepoint includes its canonical output. */
export function resolveDomRangeOffsets(
  cursor: DomTextCursor,
  range: Range,
): { startOffset: number; endOffset: number } | null {
  const selectedNodes = new Map<Text, { start: number; end: number }>();
  for (const { node } of cursor.nodes) {
    if (range.intersectsNode(node)) {
      selectedNodes.set(node, {
        start: node === range.startContainer ? range.startOffset : 0,
        end: node === range.endContainer ? range.endOffset : node.length,
      });
    }
  }
  let startOffset: number | null = null;
  let endOffset = 0;
  for (const entry of cursor.provenance) {
    if (
      entry.spans.some((span) => {
        const selected = selectedNodes.get(span.node);
        return (
          selected !== undefined &&
          span.startUtf16 < selected.end &&
          span.endUtf16 > selected.start
        );
      })
    ) {
      startOffset ??= entry.start;
      endOffset = entry.end;
    }
  }
  return startOffset === null ? null : { startOffset, endOffset };
}
