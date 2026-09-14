import type { Highlight } from "@/lib/highlights/api";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import type { AnchoredReaderRow } from "./useAnchoredReaderProjection";

/**
 * Fields shared by every `Highlight` and `PdfHighlight` that flow into an
 * `AnchoredReaderRow`. Both row constructors copy these through unchanged.
 */
type HighlightMetadata = Pick<
  Highlight,
  | "id"
  | "exact"
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

export function toPdfAnchoredReaderRow(
  highlight: HighlightMetadata,
  pageNumber: number,
  quads: PdfHighlightQuad[],
): AnchoredReaderRow {
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

/**
 * Accumulate the per-page PDF highlights the reader streams in as the user pages
 * through a document. The reader emits `(pageNumber, highlightsForThatPage)`; we
 * keep every rendered page's slice (focus and note state reference highlights
 * across pages) and replace the slice for `pageNumber` wholesale on each emit.
 *
 * Dedup is by highlight id as well as by page slot. During navigation the reader
 * can emit a stale pair `(newPage, previousPageHighlights)` for one render — its
 * page number advances a beat before its per-page highlight fetch transitions to
 * loading — so a page-slot-only replace would re-append an already-held highlight
 * (its `page_number` does not match `pageNumber`, so the slot filter misses it)
 * and the store would carry that highlight twice. Excluding the incoming ids from
 * the retained set keeps the store free of duplicate highlight rows.
 */
export function mergePdfPageHighlights<
  T extends { id: string; anchor: { page_number: number } },
>(current: T[], pageNumber: number, pageHighlights: T[]): T[] {
  const incomingIds = new Set(pageHighlights.map((highlight) => highlight.id));
  const retained = current.filter(
    (highlight) =>
      highlight.anchor.page_number !== pageNumber &&
      !incomingIds.has(highlight.id),
  );
  return [...retained, ...pageHighlights];
}

/**
 * Evidence is scoped to the page whose geometry the reader is currently showing:
 * a PDF highlight is listed only while its own page is the active page. Returns
 * every highlight untouched until the reader reports a page (initial mount).
 */
export function pdfHighlightsForActivePage<
  T extends { anchor: { page_number: number } },
>(highlights: T[], activePageNumber: number | null | undefined): T[] {
  if (activePageNumber == null) return highlights;
  return highlights.filter(
    (highlight) => highlight.anchor.page_number === activePageNumber,
  );
}

export function toTextAnchoredReaderRow(
  highlight: HighlightMetadata,
  anchor: {
    fragment_id: string | null;
    start_offset: number | null;
    end_offset: number | null;
  },
  fragment: TextAnchorFragmentTiming | null,
): AnchoredReaderRow {
  // Unresolved locator cache (null offsets after a reindex/refresh dropped the
  // cached fragment row): the highlight stays in the evidence list but carries
  // no paintable anchor. The projection treats an anchorless row as a missing
  // target, and — lacking a stable_order_key — it sorts after every resolved
  // row, so it never paints at a wrong location (universal-link-authoring-hard-
  // cutover.md, Highlight Durability).
  if (
    anchor.fragment_id === null ||
    anchor.start_offset === null ||
    anchor.end_offset === null
  ) {
    return { ...highlight };
  }
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
