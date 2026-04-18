import { describe, expect, it } from "vitest";
import {
  comparePdfStableOrderKeys,
  encodePdfStableOrderKey,
  sortPdfHighlightsByStableKey,
  toPdfStableOrderKey,
} from "./highlightIndexAdapter";

function makePdfHighlight(params: {
  id: string;
  page: number;
  top: number;
  left: number;
  createdAt: string;
}) {
  const { id, page, top, left, createdAt } = params;
  return {
    id,
    anchor: {
      type: "pdf_page_geometry" as const,
      media_id: "media-id",
      page_number: page,
      quads: [
        {
          x1: left,
          y1: top,
          x2: left + 40,
          y2: top,
          x3: left + 40,
          y3: top + 12,
          x4: left,
          y4: top + 12,
        },
      ],
    },
    color: "yellow" as const,
    exact: id,
    prefix: "",
    suffix: "",
    annotation: null,
    author_user_id: "user-1",
    is_owner: true,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe("highlightIndexAdapter", () => {
  it("sorts document highlights by stable key (page/top/left/created_at/id)", () => {
    const highlights = [
      makePdfHighlight({
        id: "c-id",
        page: 2,
        top: 100,
        left: 10,
        createdAt: "2026-01-03T00:00:00Z",
      }),
      makePdfHighlight({
        id: "b-id",
        page: 1,
        top: 100,
        left: 20,
        createdAt: "2026-01-02T00:00:00Z",
      }),
      makePdfHighlight({
        id: "a-id",
        page: 1,
        top: 100,
        left: 20,
        createdAt: "2026-01-02T00:00:00Z",
      }),
      makePdfHighlight({
        id: "d-id",
        page: 1,
        top: 90,
        left: 50,
        createdAt: "2026-01-05T00:00:00Z",
      }),
    ];

    const sorted = sortPdfHighlightsByStableKey(highlights);
    expect(sorted.map((highlight) => highlight.id)).toEqual(["d-id", "a-id", "b-id", "c-id"]);
  });

  it("emits deterministic stable_order_key for pane list mode", () => {
    const highlights = [
      makePdfHighlight({
        id: "uuid-2",
        page: 1,
        top: 100,
        left: 25,
        createdAt: "2026-01-01T00:00:00Z",
      }),
      makePdfHighlight({
        id: "uuid-1",
        page: 1,
        top: 100,
        left: 25,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ];

    const stableKeys = sortPdfHighlightsByStableKey(highlights).map((highlight) =>
      encodePdfStableOrderKey(toPdfStableOrderKey(highlight))
    );

    expect(stableKeys).toHaveLength(2);
    expect(stableKeys[0]).toBeTruthy();
    expect(stableKeys[1]).toBeTruthy();
    expect(stableKeys[0] < stableKeys[1]).toBe(true);
  });

  it("keeps comparator and encoded key ordering consistent", () => {
    const a = toPdfStableOrderKey(
      makePdfHighlight({
        id: "id-a",
        page: 1,
        top: 10,
        left: 5,
        createdAt: "2026-01-01T00:00:00Z",
      })
    );
    const b = toPdfStableOrderKey(
      makePdfHighlight({
        id: "id-b",
        page: 1,
        top: 10,
        left: 5,
        createdAt: "2026-01-01T00:00:00Z",
      })
    );
    expect(comparePdfStableOrderKeys(a, b)).toBeLessThan(0);
    expect(encodePdfStableOrderKey(a) < encodePdfStableOrderKey(b)).toBe(true);
  });

  it("normalizes missing quads to a stable zero-based key", () => {
    const highlight = {
      ...makePdfHighlight({
        id: "id-no-quads",
        page: 3,
        top: 10,
        left: 5,
        createdAt: "2026-01-01T00:00:00Z",
      }),
      anchor: {
        type: "pdf_page_geometry" as const,
        media_id: "media-id",
        page_number: 3,
        quads: [],
      },
    };

    expect(toPdfStableOrderKey(highlight)).toEqual({
      page_number: 3,
      sort_top: 0,
      sort_left: 0,
      created_at: "2026-01-01T00:00:00Z",
      id: "id-no-quads",
    });
  });
});
