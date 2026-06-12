import { describe, expect, it } from "vitest";
import type { ReaderNavigationSection } from "@/lib/media/readerNavigation";
import { type OverviewPositionFragment, positionHighlights } from "./overviewPositions";
import type { AnchoredReaderRow } from "./useAnchoredReaderProjection";

function fragment(
  id: string,
  idx: number,
  canonical_text: string,
): OverviewPositionFragment {
  return {
    id,
    idx,
    canonical_text,
  };
}

function epubSection(
  fragment_id: string,
  ordinal: number,
  char_count: number,
): ReaderNavigationSection {
  return {
    fragment_id,
    section_id: `sec-${fragment_id}`,
    label: `Section ${ordinal}`,
    fragment_idx: ordinal,
    level: null,
    depth: null,
    start_offset: null,
    end_offset: null,
    href_path: null,
    href_fragment: null,
    anchor_id: null,
    ordinal,
    char_count,
  };
}

function fragmentHighlight(
  id: string,
  fragment_id: string,
  start_offset: number,
): AnchoredReaderRow {
  return {
    id,
    exact: id,
    color: "yellow",
    anchor: { fragment_id, start_offset, end_offset: start_offset + 1 },
  };
}

function pdfHighlight(id: string, page_number: number): AnchoredReaderRow {
  return { id, exact: id, color: "yellow", page_number };
}

describe("positionHighlights", () => {
  it("positions web highlights by cumulative codepoint offset", () => {
    const fragments = [
      fragment("f0", 0, "0123456789"), // 10 cp
      fragment("f1", 1, "0123456789"), // 10 cp
    ];
    const result = positionHighlights({
      mediaKind: "web",
      highlights: [
        fragmentHighlight("h-second", "f1", 5), // (10 + 5) / 20
        fragmentHighlight("h-first", "f0", 4), // (0 + 4) / 20
      ],
      fragments,
      epubSections: [],
      numPages: null,
    });

    expect(result.map((row) => row.highlight.id)).toEqual([
      "h-first",
      "h-second",
    ]);
    expect(result[0].position).toBeCloseTo(4 / 20);
    expect(result[1].position).toBeCloseTo(15 / 20);
  });

  it("orders transcript fragments by idx, not array order", () => {
    const fragments = [
      fragment("late", 2, "aaaa"), // 4 cp
      fragment("early", 0, "bb"), // 2 cp
      fragment("mid", 1, "ccc"), // 3 cp
    ];
    const result = positionHighlights({
      mediaKind: "transcript",
      highlights: [fragmentHighlight("h", "late", 1)],
      fragments,
      epubSections: [],
      numPages: null,
    });

    // "late" follows "early" (2) + "mid" (3) = offset 5; total 9.
    expect(result[0].position).toBeCloseTo((5 + 1) / 9);
  });

  it("positions epub highlights by section char_count ordered by ordinal", () => {
    const sections = [
      epubSection("frag-b", 1, 100),
      epubSection("frag-a", 0, 50),
    ];
    const result = positionHighlights({
      mediaKind: "epub",
      highlights: [
        fragmentHighlight("h-b", "frag-b", 20), // (50 + 20) / 150
        fragmentHighlight("h-a", "frag-a", 10), // (0 + 10) / 150
      ],
      fragments: [],
      epubSections: sections,
      numPages: null,
    });

    expect(result.map((row) => row.highlight.id)).toEqual(["h-a", "h-b"]);
    expect(result[0].position).toBeCloseTo(10 / 150);
    expect(result[1].position).toBeCloseTo(70 / 150);
  });

  it("positions pdf highlights at (page - 0.5) / numPages, clamped", () => {
    const result = positionHighlights({
      mediaKind: "pdf",
      highlights: [
        pdfHighlight("h-1", 1), // 0.5 / 10
        pdfHighlight("h-10", 10), // 9.5 / 10
      ],
      fragments: [],
      epubSections: [],
      numPages: 10,
    });

    expect(result.map((row) => row.highlight.id)).toEqual(["h-1", "h-10"]);
    expect(result[0].position).toBeCloseTo(0.05);
    expect(result[1].position).toBeCloseTo(0.95);
  });

  it("counts astral characters as one codepoint each", () => {
    // "𐐷" is a single codepoint but two UTF-16 units.
    const fragments = [
      fragment("f0", 0, "𐐷𐐷𐐷"), // 3 cp, 6 UTF-16 units
      fragment("f1", 1, "ab"), // 2 cp
    ];
    const result = positionHighlights({
      mediaKind: "web",
      highlights: [fragmentHighlight("h", "f1", 0)],
      fragments,
      epubSections: [],
      numPages: null,
    });

    // Total is 5 codepoints, not 8. The highlight starts at offset 3.
    expect(result[0].position).toBeCloseTo(3 / 5);
  });

  it("drops highlights whose fragment is not in the document", () => {
    const result = positionHighlights({
      mediaKind: "web",
      highlights: [
        fragmentHighlight("known", "f0", 0),
        fragmentHighlight("unknown", "missing", 0),
      ],
      fragments: [fragment("f0", 0, "abcd")],
      epubSections: [],
      numPages: null,
    });

    expect(result.map((row) => row.highlight.id)).toEqual(["known"]);
  });

  it("drops pdf highlights when numPages is null", () => {
    const result = positionHighlights({
      mediaKind: "pdf",
      highlights: [pdfHighlight("h-1", 1)],
      fragments: [],
      epubSections: [],
      numPages: null,
    });

    expect(result).toEqual([]);
  });

  it("returns nothing for empty inputs", () => {
    expect(
      positionHighlights({
        mediaKind: "web",
        highlights: [],
        fragments: [],
        epubSections: [],
        numPages: null,
      }),
    ).toEqual([]);
    expect(
      positionHighlights({
        mediaKind: "epub",
        highlights: [fragmentHighlight("h", "frag-a", 0)],
        fragments: [],
        epubSections: [],
        numPages: null,
      }),
    ).toEqual([]);
  });
});
