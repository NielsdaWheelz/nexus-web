import { describe, expect, it } from "vitest";
import {
  CANONICAL_CONVERSATION_INDEX_VIEW,
  CONVERSATION_SORT_OPTION_IDS,
  conversationIndexViewQuery,
  conversationSortOptionLabel,
  conversationSortOptionOf,
  conversationViewForSortOption,
  decodeConversationIndexView,
  encodeConversationIndexView,
} from "@/lib/conversations/indexView";

/**
 * Risk: the Chats index view is navigable URL state that selects which server
 * order is requested. A codec that normalized a malformed address instead of
 * rejecting it would silently serve a different collection than the URL names,
 * and a lossy round-trip would drop the view across reload/Back.
 *
 * Oracle: the `Sort by` inventory, canonical default, and Invalid matrix in
 * docs/cutovers/collection-refinement-capability-hard-cutover.md.
 */

describe("Chats index view codec", () => {
  it.each(CONVERSATION_SORT_OPTION_IDS)(
    "restores the %s view from the URL that view encodes",
    (optionId) => {
      const view = conversationViewForSortOption(optionId);
      const encoded = encodeConversationIndexView(view, new URLSearchParams());
      expect(decodeConversationIndexView(encoded)).toEqual({ kind: "Valid", view });
      expect(conversationSortOptionOf(view)).toBe(optionId);
    },
  );

  it("addresses the canonical updated-newest view with no owned keys", () => {
    expect(
      encodeConversationIndexView(
        CANONICAL_CONVERSATION_INDEX_VIEW,
        new URLSearchParams(),
      ).toString(),
    ).toBe("");
    expect(decodeConversationIndexView(new URLSearchParams())).toEqual({
      kind: "Valid",
      view: CANONICAL_CONVERSATION_INDEX_VIEW,
    });
  });

  it.each([
    ["a sort with no direction", "sort=title"],
    ["a direction with no sort", "direction=asc"],
    ["the redundant explicit default pair", "sort=updated&direction=desc"],
    ["an unknown sort key", "sort=created&direction=asc"],
    ["an unknown direction", "sort=title&direction=sideways"],
    ["an empty sort value", "sort=&direction=asc"],
    ["an empty direction value", "sort=title&direction="],
    ["a duplicated sort key", "sort=title&sort=updated&direction=asc"],
    ["a duplicated direction key", "sort=title&direction=asc&direction=desc"],
  ])("rejects %s", (_case, query) => {
    expect(decodeConversationIndexView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });

  it("replaces owned keys and preserves unrelated pane keys", () => {
    const current = new URLSearchParams("scope=all&sort=title&direction=desc");
    expect(
      encodeConversationIndexView(
        { kind: "Title", direction: "asc" },
        current,
      ).toString(),
    ).toBe("scope=all&sort=title&direction=asc");
    expect(
      encodeConversationIndexView(CANONICAL_CONVERSATION_INDEX_VIEW, current).toString(),
    ).toBe("scope=all");
  });

  it.each([
    ["updated-newest", ""],
    ["updated-oldest", "?sort=updated&direction=asc"],
    ["title-asc", "?sort=title&direction=asc"],
    ["title-desc", "?sort=title&direction=desc"],
  ] as const)("requests %s from the API as %s", (optionId, query) => {
    expect(conversationIndexViewQuery(conversationViewForSortOption(optionId))).toBe(query);
  });

  it("offers the exact Sort by inventory in product order", () => {
    expect(CONVERSATION_SORT_OPTION_IDS.map(conversationSortOptionLabel)).toEqual([
      "Updated — newest",
      "Updated — oldest",
      "Title — A–Z",
      "Title — Z–A",
    ]);
  });
});
