import { describe, expect, it } from "vitest";
import {
  CANONICAL_UPDATED_TITLE_INDEX_VIEW,
  UPDATED_TITLE_SORT_OPTION_IDS,
  decodeUpdatedTitleIndexView,
  encodeUpdatedTitleIndexView,
  updatedTitleIndexViewQuery,
  updatedTitleSortOptionLabel,
  updatedTitleSortOptionOf,
  updatedTitleViewForSortOption,
} from "@/lib/collections/updatedTitleIndexView";

/**
 * Risk: this navigable view selects the server-side collection order. A codec
 * that normalizes a malformed address or loses a round-trip would silently
 * serve a collection other than the one its URL names.
 */
describe("updated-title collection view codec", () => {
  it.each(UPDATED_TITLE_SORT_OPTION_IDS)(
    "restores the %s view from the URL that view encodes",
    (optionId) => {
      const view = updatedTitleViewForSortOption(optionId);
      const encoded = encodeUpdatedTitleIndexView(
        view,
        new URLSearchParams(),
      );
      expect(decodeUpdatedTitleIndexView(encoded)).toEqual({
        kind: "Valid",
        view,
      });
      expect(updatedTitleSortOptionOf(view)).toBe(optionId);
    },
  );

  it("addresses the canonical updated-newest view with no owned keys", () => {
    expect(
      encodeUpdatedTitleIndexView(
        CANONICAL_UPDATED_TITLE_INDEX_VIEW,
        new URLSearchParams(),
      ).toString(),
    ).toBe("");
    expect(decodeUpdatedTitleIndexView(new URLSearchParams())).toEqual({
      kind: "Valid",
      view: CANONICAL_UPDATED_TITLE_INDEX_VIEW,
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
    expect(decodeUpdatedTitleIndexView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });

  it("replaces owned keys and preserves unrelated pane keys", () => {
    const current = new URLSearchParams(
      "scope=all&page=daily&sort=title&direction=desc",
    );
    expect(
      encodeUpdatedTitleIndexView(
        { kind: "Title", direction: "asc" },
        current,
      ).toString(),
    ).toBe("scope=all&page=daily&sort=title&direction=asc");
    expect(
      encodeUpdatedTitleIndexView(
        CANONICAL_UPDATED_TITLE_INDEX_VIEW,
        current,
      ).toString(),
    ).toBe("scope=all&page=daily");
  });

  it.each([
    ["updated-newest", ""],
    ["updated-oldest", "?sort=updated&direction=asc"],
    ["title-asc", "?sort=title&direction=asc"],
    ["title-desc", "?sort=title&direction=desc"],
  ] as const)("requests %s from the API as %s", (optionId, query) => {
    expect(
      updatedTitleIndexViewQuery(updatedTitleViewForSortOption(optionId)),
    ).toBe(query);
  });

  it("offers the exact Sort by inventory in product order", () => {
    expect(UPDATED_TITLE_SORT_OPTION_IDS.map(updatedTitleSortOptionLabel)).toEqual(
      [
        "Updated — newest",
        "Updated — oldest",
        "Title — A–Z",
        "Title — Z–A",
      ],
    );
  });
});
