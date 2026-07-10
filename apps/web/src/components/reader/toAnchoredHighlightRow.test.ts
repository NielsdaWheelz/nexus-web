import { describe, expect, it } from "vitest";
import {
  mergePdfPageHighlights,
  pdfHighlightsForActivePage,
  toPdfAnchoredReaderRow,
  toTextAnchoredReaderRow,
} from "./toAnchoredHighlightRow";

function pdfHighlight(id: string, pageNumber: number) {
  return { id, anchor: { page_number: pageNumber } };
}

const baseHighlight = {
  id: "h-1",
  exact: "matter",
  color: "yellow" as const,
  created_at: "2026-05-01T00:00:00.000Z",
  updated_at: "2026-05-01T00:00:00.000Z",
  prefix: "no ",
  suffix: " here",
  is_owner: true,
  linked_conversations: undefined,
  linked_note_blocks: undefined,
};

describe("toPdfAnchoredReaderRow", () => {
  it("derives a deterministic stable_order_key from the first quad's coordinates", () => {
    const row = toPdfAnchoredReaderRow(baseHighlight, 7, [
      { x1: 12.345, y1: 67.891, x2: 0, y2: 0, x3: 0, y3: 0, x4: 0, y4: 0 },
    ]);
    expect(row).toEqual({
      ...baseHighlight,
      page_number: 7,
      quads: [{ x1: 12.345, y1: 67.891, x2: 0, y2: 0, x3: 0, y3: 0, x4: 0, y4: 0 }],
      stable_order_key:
        "000007:00000067.891:00000012.345:2026-05-01T00:00:00.000Z:h-1",
    });
  });

  it("falls back to zero coordinates when the quad list is empty", () => {
    const row = toPdfAnchoredReaderRow(baseHighlight, 1, []);
    expect(row.stable_order_key).toBe(
      "000001:00000000.000:00000000.000:2026-05-01T00:00:00.000Z:h-1",
    );
  });
});

describe("toTextAnchoredReaderRow", () => {
  it("includes fragment timing fields when a fragment is supplied", () => {
    const row = toTextAnchoredReaderRow(
      baseHighlight,
      { fragment_id: "frag-1", start_offset: 12, end_offset: 34 },
      { t_start_ms: 1000, t_end_ms: 2000 },
    );
    expect(row.anchor).toEqual({
      fragment_id: "frag-1",
      start_offset: 12,
      end_offset: 34,
      t_start_ms: 1000,
      t_end_ms: 2000,
    });
    expect(row.stable_order_key).toBe(
      "000000000012:000000000034:2026-05-01T00:00:00.000Z:h-1",
    );
  });

  it("omits timing fields when no fragment is supplied", () => {
    const row = toTextAnchoredReaderRow(
      baseHighlight,
      { fragment_id: "frag-1", start_offset: 0, end_offset: 5 },
      null,
    );
    expect(row.anchor).toEqual({
      fragment_id: "frag-1",
      start_offset: 0,
      end_offset: 5,
    });
  });
});

describe("mergePdfPageHighlights", () => {
  it("replaces the slice for the rendered page while retaining other pages", () => {
    const current = [pdfHighlight("p1", 1)];
    expect(mergePdfPageHighlights(current, 2, [pdfHighlight("p2", 2)])).toEqual([
      pdfHighlight("p1", 1),
      pdfHighlight("p2", 2),
    ]);
  });

  it("clears the slice for the rendered page on an empty emit", () => {
    const current = [pdfHighlight("p1", 1), pdfHighlight("p2", 2)];
    expect(mergePdfPageHighlights(current, 2, [])).toEqual([
      pdfHighlight("p1", 1),
    ]);
  });

  it("does not duplicate a highlight when a stale (newPage, oldPageHighlights) pair arrives", () => {
    // The reader's page number can advance a render before its per-page highlight
    // fetch does, so it can emit page 1's highlight tagged with next page 2.
    const afterStaleEmit = mergePdfPageHighlights([pdfHighlight("p1", 1)], 2, [
      pdfHighlight("p1", 1),
    ]);
    expect(afterStaleEmit).toEqual([pdfHighlight("p1", 1)]);

    // The real page-2 slice then lands without resurrecting the duplicate.
    expect(
      mergePdfPageHighlights(afterStaleEmit, 2, [pdfHighlight("p2", 2)]),
    ).toEqual([pdfHighlight("p1", 1), pdfHighlight("p2", 2)]);
  });

  it("re-emitting the same page's highlights is idempotent", () => {
    const current = [pdfHighlight("p1", 1)];
    expect(mergePdfPageHighlights(current, 1, [pdfHighlight("p1", 1)])).toEqual([
      pdfHighlight("p1", 1),
    ]);
  });
});

describe("pdfHighlightsForActivePage", () => {
  const highlights = [
    pdfHighlight("p1", 1),
    pdfHighlight("p2", 2),
    pdfHighlight("p2b", 2),
  ];

  it("keeps only the highlights on the active page", () => {
    expect(pdfHighlightsForActivePage(highlights, 2)).toEqual([
      pdfHighlight("p2", 2),
      pdfHighlight("p2b", 2),
    ]);
  });

  it("returns every highlight before the reader reports a page", () => {
    expect(pdfHighlightsForActivePage(highlights, null)).toEqual(highlights);
    expect(pdfHighlightsForActivePage(highlights, undefined)).toEqual(highlights);
  });
});
