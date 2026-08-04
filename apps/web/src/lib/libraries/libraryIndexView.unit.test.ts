import { describe, expect, it } from "vitest";
import {
  CANONICAL_LIBRARIES_INDEX_VIEW,
  LIBRARIES_SORT_OPTION_IDS,
  decodeLibrariesIndexView,
  encodeLibrariesIndexView,
  librariesIndexViewQuery,
  librariesSortOptionLabel,
  librariesSortOptionOf,
  librariesViewForSortOption,
} from "@/lib/libraries/libraryIndexView";

/**
 * Risk: the Libraries index view is navigable URL state that selects which
 * server order is requested. A codec that normalized a malformed address
 * instead of rejecting it would silently serve a different collection than the
 * URL names, and a lossy round-trip would drop the view across reload/Back.
 *
 * Oracle: the `Sort by` inventory, canonical default, and Invalid matrix in
 * docs/cutovers/collection-refinement-capability-hard-cutover.md.
 */

describe("Libraries index view codec", () => {
  it.each(LIBRARIES_SORT_OPTION_IDS)(
    "restores the %s view from the URL that view encodes",
    (optionId) => {
      const view = librariesViewForSortOption(optionId);
      const encoded = encodeLibrariesIndexView(view, new URLSearchParams());
      expect(decodeLibrariesIndexView(encoded)).toEqual({
        kind: "Valid",
        view,
      });
      expect(librariesSortOptionOf(view)).toBe(optionId);
    },
  );

  it("addresses the canonical created-oldest view with no owned keys", () => {
    expect(
      encodeLibrariesIndexView(
        CANONICAL_LIBRARIES_INDEX_VIEW,
        new URLSearchParams(),
      ).toString(),
    ).toBe("");
    expect(decodeLibrariesIndexView(new URLSearchParams())).toEqual({
      kind: "Valid",
      view: CANONICAL_LIBRARIES_INDEX_VIEW,
    });
  });

  it.each([
    ["a sort with no direction", "sort=name"],
    ["a direction with no sort", "direction=desc"],
    ["the redundant explicit default pair", "sort=created&direction=asc"],
    ["an unknown sort key", "sort=title&direction=asc"],
    ["an unknown direction", "sort=name&direction=sideways"],
    ["an empty sort value", "sort=&direction=asc"],
    ["an empty direction value", "sort=name&direction="],
    ["a duplicated sort key", "sort=name&sort=created&direction=asc"],
    ["a duplicated direction key", "sort=name&direction=asc&direction=desc"],
  ])("rejects %s", (_case, query) => {
    expect(decodeLibrariesIndexView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });

  it("replaces owned keys and preserves unrelated pane keys", () => {
    const current = new URLSearchParams("view=grid&sort=name&direction=desc");
    expect(
      encodeLibrariesIndexView(
        { kind: "Name", direction: "asc" },
        current,
      ).toString(),
    ).toBe("view=grid&sort=name&direction=asc");
    expect(
      encodeLibrariesIndexView(
        CANONICAL_LIBRARIES_INDEX_VIEW,
        current,
      ).toString(),
    ).toBe("view=grid");
  });

  it.each([
    ["created-oldest", ""],
    ["created-newest", "?sort=created&direction=desc"],
    ["name-asc", "?sort=name&direction=asc"],
    ["name-desc", "?sort=name&direction=desc"],
  ] as const)("requests %s from the API as %s", (optionId, query) => {
    expect(
      librariesIndexViewQuery(librariesViewForSortOption(optionId)),
    ).toBe(query);
  });

  it("offers the exact Sort by inventory in product order", () => {
    expect(LIBRARIES_SORT_OPTION_IDS.map(librariesSortOptionLabel)).toEqual([
      "Created — oldest",
      "Created — newest",
      "Name — A–Z",
      "Name — Z–A",
    ]);
  });
});
