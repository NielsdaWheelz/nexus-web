import { describe, expect, it } from "vitest";
import {
  comparePdfStableOrderKeys,
  encodePdfStableOrderKey,
  sortPdfHighlightsByStableKey,
  toPdfDocumentPaneItems,
  toPdfPagePaneItems,
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

    const paneItems = toPdfDocumentPaneItems(highlights);
    expect(paneItems[0]?.id).toBe("uuid-1");
    expect(paneItems[1]?.id).toBe("uuid-2");
    expect(paneItems[0]?.stable_order_key).toBeTruthy();
    expect(paneItems[1]?.stable_order_key).toBeTruthy();
    expect((paneItems[0]?.stable_order_key ?? "") < (paneItems[1]?.stable_order_key ?? "")).toBe(
      true
    );
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

  it("preserves linked conversations in page and document pane items", () => {
    const highlight = {
      ...makePdfHighlight({
        id: "id-linked",
        page: 1,
        top: 10,
        left: 5,
        createdAt: "2026-01-01T00:00:00Z",
      }),
      linked_conversations: [{ conversation_id: "conv-1", title: "Linked chat" }],
    };
    const pageItems = toPdfPagePaneItems([highlight]);
    const documentItems = toPdfDocumentPaneItems([highlight]);
    expect(pageItems[0]?.linked_conversations).toEqual([
      { conversation_id: "conv-1", title: "Linked chat" },
    ]);
    expect(documentItems[0]?.linked_conversations).toEqual([
      { conversation_id: "conv-1", title: "Linked chat" },
    ]);
  });
});
