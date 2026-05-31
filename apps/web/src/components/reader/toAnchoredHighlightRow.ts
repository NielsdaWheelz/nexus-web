import type { Highlight } from "@/lib/highlights/api";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import type { AnchoredHighlightRow } from "./useAnchoredHighlightProjection";

/**
 * Fields shared by every `Highlight` and `PdfHighlight` that flow into an
 * `AnchoredHighlightRow`. Both row constructors copy these through unchanged.
 */
type HighlightMetadata = Pick<
  Highlight,
  | "id"
  | "exact"
  | "source_version"
  | "color"
  | "linked_note_blocks"
  | "created_at"
  | "updated_at"
  | "prefix"
  | "suffix"
  | "is_owner"
  | "linked_conversations"
>;

interface TextAnchorFragmentTiming {
  t_start_ms?: number | null;
  t_end_ms?: number | null;
}

export function toPdfAnchoredHighlightRow(
  highlight: HighlightMetadata,
  pageNumber: number,
  quads: PdfHighlightQuad[],
): AnchoredHighlightRow {
  const firstQuad = quads[0];
  return {
    ...highlight,
    page_number: pageNumber,
    quads,
    stable_order_key: [
      String(pageNumber).padStart(6, "0"),
      (firstQuad?.y1 ?? 0).toFixed(3).padStart(12, "0"),
      (firstQuad?.x1 ?? 0).toFixed(3).padStart(12, "0"),
      highlight.created_at,
      highlight.id,
    ].join(":"),
  };
}

export function toTextAnchoredHighlightRow(
  highlight: HighlightMetadata,
  anchor: { fragment_id: string; start_offset: number; end_offset: number },
  fragment: TextAnchorFragmentTiming | null,
): AnchoredHighlightRow {
  return {
    ...highlight,
    anchor: {
      fragment_id: anchor.fragment_id,
      start_offset: anchor.start_offset,
      end_offset: anchor.end_offset,
      ...(fragment
        ? {
            t_start_ms: fragment.t_start_ms ?? undefined,
            t_end_ms: fragment.t_end_ms ?? undefined,
          }
        : {}),
    },
    stable_order_key: [
      String(anchor.start_offset).padStart(12, "0"),
      String(anchor.end_offset).padStart(12, "0"),
      highlight.created_at,
      highlight.id,
    ].join(":"),
  };
}
