import { describe, expect, it } from "vitest";
import type { PdfHighlightOut } from "@/components/PdfReader";
import {
  sortContextualFragmentHighlights,
  sortContextualPdfHighlights,
} from "./mediaHighlightOrdering";
import type { Highlight } from "./mediaHighlights";

function makeFragmentHighlight({
  id,
  startOffset,
  endOffset,
  createdAt,
}: {
  id: string;
  startOffset: number;
  endOffset: number;
  createdAt: string;
}): Highlight {
  return {
    id,
    anchor: {
      type: "fragment_offsets",
      media_id: "media-1",
      fragment_id: "fragment-1",
      start_offset: startOffset,
      end_offset: endOffset,
    },
    color: "yellow",
    exact: id,
    prefix: "",
    suffix: "",
    created_at: createdAt,
    updated_at: createdAt,
    author_user_id: "user-1",
    is_owner: true,
    linked_note_blocks: [],
    linked_conversations: [],
  };
}

function makePdfHighlight({
  id,
  top,
  left,
  createdAt,
}: {
  id: string;
  top: number;
  left: number;
  createdAt: string;
}): PdfHighlightOut {
  return {
    id,
    anchor: {
      type: "pdf_page_geometry",
      media_id: "media-1",
      page_number: 1,
      quads: [
        {
          x1: left,
          y1: top,
          x2: left + 1,
          y2: top,
          x3: left + 1,
          y3: top + 1,
          x4: left,
          y4: top + 1,
        },
      ],
    },
    color: "blue",
    exact: id,
    prefix: "",
    suffix: "",
    created_at: createdAt,
    updated_at: createdAt,
    linked_note_blocks: [],
    author_user_id: "user-1",
    is_owner: true,
    linked_conversations: [],
  };
}

describe("mediaHighlightOrdering", () => {
  it("sorts fragment highlights by canonical offsets before timestamp fallback", () => {
    const sorted = sortContextualFragmentHighlights([
      makeFragmentHighlight({
        id: "later-offset",
        startOffset: 10,
        endOffset: 20,
        createdAt: "2026-01-01T00:00:00Z",
      }),
      makeFragmentHighlight({
        id: "same-offset-later",
        startOffset: 1,
        endOffset: 5,
        createdAt: "2026-01-03T00:00:00Z",
      }),
      makeFragmentHighlight({
        id: "same-offset-earlier",
        startOffset: 1,
        endOffset: 5,
        createdAt: "2026-01-02T00:00:00Z",
      }),
    ]);

    expect(sorted.map((highlight) => highlight.id)).toEqual([
      "same-offset-earlier",
      "same-offset-later",
      "later-offset",
    ]);
  });

  it("sorts pdf highlights by page geometry before timestamp fallback", () => {
    const sorted = sortContextualPdfHighlights([
      makePdfHighlight({
        id: "lower-on-page",
        top: 40,
        left: 12,
        createdAt: "2026-01-01T00:00:00Z",
      }),
      makePdfHighlight({
        id: "same-spot-later",
        top: 10,
        left: 8,
        createdAt: "2026-01-03T00:00:00Z",
      }),
      makePdfHighlight({
        id: "same-spot-earlier",
        top: 10,
        left: 8,
        createdAt: "2026-01-02T00:00:00Z",
      }),
      makePdfHighlight({
        id: "same-row-further-left",
        top: 10,
        left: 4,
        createdAt: "2026-01-04T00:00:00Z",
      }),
    ]);

    expect(sorted.map((highlight) => highlight.id)).toEqual([
      "same-row-further-left",
      "same-spot-earlier",
      "same-spot-later",
      "lower-on-page",
    ]);
  });
});
