import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeConversationIndexItem,
  fetchConversationIndex,
} from "@/lib/conversations/indexApi";

describe("conversation index API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes only the compact list row", () => {
    expect(
      decodeConversationIndexItem({
        id: "11111111-0000-4000-8000-000000000001",
        title: "Chat",
        message_count: 2,
        updated_at: "2026-07-29T00:00:00Z",
      }),
    ).toEqual({
      id: "11111111-0000-4000-8000-000000000001",
      title: "Chat",
      message_count: 2,
      updated_at: "2026-07-29T00:00:00Z",
    });
    expect(() =>
      decodeConversationIndexItem({
        id: "11111111-0000-4000-8000-000000000001",
        title: "Chat",
        sharing: "private",
        message_count: 2,
        updated_at: "2026-07-29T00:00:00Z",
      }),
    ).toThrow(/exactly/);
  });

  it("sends cursor and revision together and strictly decodes the page", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          data: {
            items: [],
            collectionRevision: 7,
            nextCursor: { kind: "Absent" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchConversationIndex({
      cursor: "cursor-2" as never,
      collectionRevision: 7 as never,
      limit: 100,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "cursor=cursor-2&collection_revision=7&limit=100",
    );
  });
});
