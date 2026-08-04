import { describe, expect, it } from "vitest";
import {
  CANONICAL_NOTES_INDEX_VIEW,
  NOTES_SORT_OPTION_IDS,
  decodeNotesIndexView,
  encodeNotesIndexView,
  notesIndexViewQuery,
  notesSortOptionLabel,
  notesSortOptionOf,
  notesViewForSortOption,
} from "@/lib/notes/pageIndexView";

/**
 * Risk: the Notes index view is navigable URL state that selects which server
 * order is requested. A codec that normalized a malformed address instead of
 * rejecting it would silently serve a different collection than the URL names,
 * and a lossy round-trip would drop the view across reload/Back.
 *
 * Oracle: the `Sort by` inventory, canonical default, and Invalid matrix in
 * docs/cutovers/collection-refinement-capability-hard-cutover.md.
 */

describe("Notes index view codec", () => {
  it.each(NOTES_SORT_OPTION_IDS)(
    "restores the %s view from the URL that view encodes",
    (optionId) => {
      const view = notesViewForSortOption(optionId);
      const encoded = encodeNotesIndexView(view, new URLSearchParams());
      expect(decodeNotesIndexView(encoded)).toEqual({ kind: "Valid", view });
      expect(notesSortOptionOf(view)).toBe(optionId);
    },
  );

  it("addresses the canonical updated-newest view with no owned keys", () => {
    expect(
      encodeNotesIndexView(
        CANONICAL_NOTES_INDEX_VIEW,
        new URLSearchParams(),
      ).toString(),
    ).toBe("");
    expect(decodeNotesIndexView(new URLSearchParams())).toEqual({
      kind: "Valid",
      view: CANONICAL_NOTES_INDEX_VIEW,
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
    expect(decodeNotesIndexView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });

  it("replaces owned keys and preserves unrelated pane keys", () => {
    const current = new URLSearchParams("page=daily&sort=title&direction=desc");
    expect(
      encodeNotesIndexView(
        { kind: "Title", direction: "asc" },
        current,
      ).toString(),
    ).toBe("page=daily&sort=title&direction=asc");
    expect(
      encodeNotesIndexView(CANONICAL_NOTES_INDEX_VIEW, current).toString(),
    ).toBe("page=daily");
  });

  it.each([
    ["updated-newest", ""],
    ["updated-oldest", "?sort=updated&direction=asc"],
    ["title-asc", "?sort=title&direction=asc"],
    ["title-desc", "?sort=title&direction=desc"],
  ] as const)("requests %s from the API as %s", (optionId, query) => {
    expect(notesIndexViewQuery(notesViewForSortOption(optionId))).toBe(query);
  });

  it("offers the exact Sort by inventory in product order", () => {
    expect(NOTES_SORT_OPTION_IDS.map(notesSortOptionLabel)).toEqual([
      "Updated — newest",
      "Updated — oldest",
      "Title — A–Z",
      "Title — Z–A",
    ]);
  });
});
