import type { PdfHighlightOut } from "@/components/PdfReader";
import type { Highlight } from "./mediaHighlights";

type TimestampedHighlight = {
  id: string;
  created_at: string;
};

function readCreatedAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareCreatedAtThenId(
  left: TimestampedHighlight,
  right: TimestampedHighlight
): number {
  const leftCreatedAtMs = readCreatedAtMs(left.created_at);
  const rightCreatedAtMs = readCreatedAtMs(right.created_at);
  if (leftCreatedAtMs !== rightCreatedAtMs) {
    return leftCreatedAtMs - rightCreatedAtMs;
  }
  return left.id.localeCompare(right.id);
}

export function sortContextualPdfHighlights(
  highlights: PdfHighlightOut[]
): PdfHighlightOut[] {
  return [...highlights].sort((left, right) => {
    const leftTop = left.anchor.quads[0]?.y1 ?? 0;
    const rightTop = right.anchor.quads[0]?.y1 ?? 0;
    if (leftTop !== rightTop) {
      return leftTop - rightTop;
    }

    const leftLeft = left.anchor.quads[0]?.x1 ?? 0;
    const rightLeft = right.anchor.quads[0]?.x1 ?? 0;
    if (leftLeft !== rightLeft) {
      return leftLeft - rightLeft;
    }

    return compareCreatedAtThenId(left, right);
  });
}

export function sortContextualFragmentHighlights(
  highlights: Highlight[]
): Highlight[] {
  return [...highlights].sort((left, right) => {
    if (left.anchor.start_offset !== right.anchor.start_offset) {
      return left.anchor.start_offset - right.anchor.start_offset;
    }
    if (left.anchor.end_offset !== right.anchor.end_offset) {
      return left.anchor.end_offset - right.anchor.end_offset;
    }

    return compareCreatedAtThenId(left, right);
  });
}
