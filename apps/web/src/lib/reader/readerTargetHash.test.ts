import {
  decodeResolvedHighlightReaderTarget,
  parseReaderTargetHash,
} from "@/lib/reader/readerTargetHash";
import { describe, expect, it } from "vitest";

describe("parseReaderTargetHash", () => {
  it("parses a stable highlight identity without treating it as a locator", () => {
    expect(parseReaderTargetHash("#highlight-highlight-1")).toEqual({
      kind: "highlight",
      value: "highlight-1",
    });
  });

  it("rejects malformed and unknown targets", () => {
    expect(parseReaderTargetHash("#highlight-")).toBeNull();
    expect(parseReaderTargetHash("#unknown-value")).toBeNull();
    expect(parseReaderTargetHash("#page-0")).toBeNull();
  });
});

describe("decodeResolvedHighlightReaderTarget", () => {
  it.each([
    [
      {
        data: {
          kind: "WebTextOffsets",
          fragment_id: "fragment-1",
          start_offset: 4,
          end_offset: 12,
        },
      },
      {
        kind: "WebTextOffsets",
        fragmentId: "fragment-1",
        startOffset: 4,
        endOffset: 12,
      },
    ],
    [
      {
        data: {
          kind: "EpubTextOffsets",
          section_id: "chapter-2",
          fragment_id: "fragment-2",
          start_offset: 1,
          end_offset: 9,
        },
      },
      {
        kind: "EpubTextOffsets",
        sectionId: "chapter-2",
        fragmentId: "fragment-2",
        startOffset: 1,
        endOffset: 9,
      },
    ],
    [
      {
        data: {
          kind: "TranscriptTextOffsets",
          fragment_id: "fragment-3",
          start_offset: 2,
          end_offset: 7,
          time_range: {
            kind: "Present",
            value: { start_ms: 500, end_ms: 900 },
          },
        },
      },
      {
        kind: "TranscriptTextOffsets",
        fragmentId: "fragment-3",
        startOffset: 2,
        endOffset: 7,
        timeRange: {
          kind: "Present",
          value: { startMs: 500, endMs: 900 },
        },
      },
    ],
    [
      {
        data: {
          kind: "PdfPageGeometry",
          page_number: 7,
          quads: [
            { x1: 1, y1: 2, x2: 3, y2: 2, x3: 3, y3: 4, x4: 1, y4: 4 },
          ],
        },
      },
      {
        kind: "PdfPageGeometry",
        pageNumber: 7,
        quads: [
          { x1: 1, y1: 2, x2: 3, y2: 2, x3: 3, y3: 4, x4: 1, y4: 4 },
        ],
      },
    ],
  ])("decodes the closed current wire variants", (wire, expected) => {
    expect(decodeResolvedHighlightReaderTarget(wire)).toEqual(expected);
  });

  it("rejects stale ranges, empty PDF geometry, and extra fields", () => {
    expect(() =>
      decodeResolvedHighlightReaderTarget({
        data: {
          kind: "WebTextOffsets",
          fragment_id: "fragment-1",
          start_offset: 4,
          end_offset: 4,
        },
      }),
    ).toThrow(/non-empty range/);
    expect(() =>
      decodeResolvedHighlightReaderTarget({
        data: { kind: "PdfPageGeometry", page_number: 1, quads: [] },
      }),
    ).toThrow(/1 to 512/);
    expect(() =>
      decodeResolvedHighlightReaderTarget({
        data: {
          kind: "WebTextOffsets",
          fragment_id: "fragment-1",
          start_offset: 4,
          end_offset: 8,
          fallback_fragment_id: "fragment-2",
        },
      }),
    ).toThrow(/exactly/);
  });
});
