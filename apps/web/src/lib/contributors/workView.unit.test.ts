import { describe, expect, it } from "vitest";
import {
  AUTHOR_WORKS_SORT_OPTION_IDS,
  authorWorksSortOptionLabel,
  authorWorksSortOptionOf,
  authorWorksViewForSortOption,
  authorWorksViewQuery,
  CANONICAL_AUTHOR_WORKS_VIEW,
  decodeAuthorWorksView,
  encodeAuthorWorksView,
} from "@/lib/contributors/workView";

/**
 * Risk: the Author works view is navigable URL state that selects which server
 * order is requested. A codec that normalized a malformed address instead of
 * rejecting it would silently serve a different collection than the URL names,
 * and a lossy round-trip would drop the view across reload/Back.
 *
 * Oracle: the `Sort by` inventory, canonical default, and Invalid matrix in
 * docs/cutovers/collection-refinement-capability-hard-cutover.md.
 */

describe("Author works view codec", () => {
  it.each(AUTHOR_WORKS_SORT_OPTION_IDS)(
    "restores the %s view from the URL that view encodes",
    (optionId) => {
      const view = authorWorksViewForSortOption(optionId);
      const encoded = encodeAuthorWorksView(view, new URLSearchParams());
      expect(decodeAuthorWorksView(encoded)).toEqual({ kind: "Valid", view });
      expect(authorWorksSortOptionOf(view)).toBe(optionId);
    },
  );

  it("addresses the canonical published-newest view with no owned keys", () => {
    expect(
      encodeAuthorWorksView(
        CANONICAL_AUTHOR_WORKS_VIEW,
        new URLSearchParams(),
      ).toString(),
    ).toBe("");
    expect(decodeAuthorWorksView(new URLSearchParams())).toEqual({
      kind: "Valid",
      view: CANONICAL_AUTHOR_WORKS_VIEW,
    });
  });

  it.each([
    ["a sort with no direction", "sort=title"],
    ["a direction with no sort", "direction=asc"],
    ["the redundant explicit default pair", "sort=published&direction=desc"],
    ["an unknown sort key", "sort=added&direction=asc"],
    ["an unknown direction", "sort=title&direction=sideways"],
    ["an empty sort value", "sort=&direction=asc"],
    ["an empty direction value", "sort=title&direction="],
    ["a duplicated sort key", "sort=title&sort=published&direction=asc"],
    ["a duplicated direction key", "sort=title&direction=asc&direction=desc"],
  ])("rejects %s", (_case, query) => {
    expect(decodeAuthorWorksView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });

  it("replaces owned keys and preserves unrelated pane keys", () => {
    const current = new URLSearchParams("tab=works&sort=title&direction=desc");
    expect(
      encodeAuthorWorksView(
        { kind: "Title", direction: "asc" },
        current,
      ).toString(),
    ).toBe("tab=works&sort=title&direction=asc");
    expect(
      encodeAuthorWorksView(CANONICAL_AUTHOR_WORKS_VIEW, current).toString(),
    ).toBe("tab=works");
  });

  it.each([
    ["published-newest", ""],
    ["published-oldest", "?sort=published&direction=asc"],
    ["title-asc", "?sort=title&direction=asc"],
    ["title-desc", "?sort=title&direction=desc"],
  ] as const)("requests %s from the API as %s", (optionId, query) => {
    expect(authorWorksViewQuery(authorWorksViewForSortOption(optionId))).toBe(
      query,
    );
  });

  it("offers the exact Sort by inventory in product order", () => {
    expect(
      AUTHOR_WORKS_SORT_OPTION_IDS.map(authorWorksSortOptionLabel),
    ).toEqual([
      "Published — newest",
      "Published — oldest",
      "Title — A–Z",
      "Title — Z–A",
    ]);
  });
});
