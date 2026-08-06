import { describe, expect, it } from "vitest";
import {
  assumeAppHref,
  assumeLecternItemId,
  assumeMediaId,
  type LecternItem,
} from "@/lib/lectern/contract";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import {
  CANONICAL_LECTERN_VIEW,
  LECTERN_SORT_OPTION_IDS,
  decodeLecternView,
  encodeLecternView,
  lecternSortOptionLabel,
  lecternSortOptionOf,
  lecternViewForSortOption,
  orderLecternItems,
} from "@/lib/lectern/view";

/**
 * Risk: the Lectern view is navigable URL state and the sole owner of the
 * client order over the complete bounded snapshot. A codec that normalized a
 * malformed address would serve a different order than the URL names; an order
 * that leaned on locale collation, raw instant text, or an unstable tie-break
 * would rank rows differently between runtimes and between renders.
 *
 * Oracle: the `Sort by` inventory and the Lectern order rules in
 * docs/cutovers/collection-refinement-capability-hard-cutover.md.
 */

const MEDIA_ID = "3f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071";

function item(idSuffix: string, title: string, addedAt: string): LecternItem {
  const href = `/media/${MEDIA_ID}`;
  return {
    itemId: assumeLecternItemId(
      `00000000-0000-4000-8000-00000000000${idSuffix}`,
    ),
    mediaId: assumeMediaId(MEDIA_ID),
    kind: "web_article",
    title,
    subtitle: { kind: "Absent" },
    href: assumeAppHref(href),
    addedAt,
    consumption: {
      state: "Unread",
      progress: { kind: "Absent" },
      progressResettable: false,
    },
    activation: { kind: "Readable" },
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "media", id: MEDIA_ID }),
    },
  };
}

// Equal instants spelled two ways, three titles that share one sort key, an
// empty title, and a decomposed Unicode title: every tie the order rules name.
const zebra = item("1", "Zebra", "2026-01-03T00:00:00Z");
const untitled = item("2", "", "2026-01-01T12:00:00+00:00");
const paddedAda = item("3", "  Ada  ", "2026-01-02T00:00:00Z");
const lowerAda = item("4", "ada", "2026-01-02T00:00:00+00:00");
// Decomposed "Éclair": under NFC its sort key starts at U+00E9 and follows
// "zebra"; left decomposed it would start at "e" and precede it.
const eclair = item("5", "E\u0301clair", "2026-01-01T13:00:00Z");
const upperAda = item("6", "Ada", "2026-01-04T00:00:00Z");

const snapshot: readonly LecternItem[] = [
  lowerAda,
  zebra,
  upperAda,
  untitled,
  eclair,
  paddedAda,
];

describe("Lectern view codec", () => {
  it.each(LECTERN_SORT_OPTION_IDS)(
    "restores the %s view from the URL that view encodes",
    (optionId) => {
      const view = lecternViewForSortOption(optionId);
      const encoded = encodeLecternView(view, new URLSearchParams());
      expect(decodeLecternView(encoded)).toEqual({ kind: "Valid", view });
      expect(lecternSortOptionOf(view)).toBe(optionId);
    },
  );

  it("addresses the canonical custom order with no owned keys", () => {
    expect(
      encodeLecternView(
        CANONICAL_LECTERN_VIEW,
        new URLSearchParams(),
      ).toString(),
    ).toBe("");
    expect(decodeLecternView(new URLSearchParams())).toEqual({
      kind: "Valid",
      view: CANONICAL_LECTERN_VIEW,
    });
  });

  it.each([
    ["a sort with no direction", "sort=title"],
    ["a direction with no sort", "direction=asc"],
    ["an unknown sort key", "sort=updated&direction=asc"],
    ["an unknown direction", "sort=title&direction=sideways"],
    ["an empty sort value", "sort=&direction=asc"],
    ["an empty direction value", "sort=title&direction="],
    ["a duplicated sort key", "sort=title&sort=added&direction=asc"],
    ["a duplicated direction key", "sort=title&direction=asc&direction=desc"],
  ])("rejects %s", (_case, query) => {
    expect(decodeLecternView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });

  it("replaces owned keys and preserves unrelated pane keys", () => {
    const current = new URLSearchParams("expanded=1&sort=title&direction=desc");
    expect(
      encodeLecternView(
        { kind: "Added", direction: "asc" },
        current,
      ).toString(),
    ).toBe("expanded=1&sort=added&direction=asc");
    expect(encodeLecternView(CANONICAL_LECTERN_VIEW, current).toString()).toBe(
      "expanded=1",
    );
  });

  it("offers the exact Sort by inventory in product order", () => {
    expect(LECTERN_SORT_OPTION_IDS.map(lecternSortOptionLabel)).toEqual([
      "Custom order",
      "Added — newest",
      "Added — oldest",
      "Title — A–Z",
      "Title — Z–A",
    ]);
  });
});

describe("Lectern client order", () => {
  it("keeps the authored snapshot order under Custom", () => {
    expect(orderLecternItems(CANONICAL_LECTERN_VIEW, snapshot)).toEqual(
      snapshot,
    );
  });

  it("ranks equal membership instants by item id ascending in both directions", () => {
    expect(
      orderLecternItems({ kind: "Added", direction: "asc" }, snapshot),
    ).toEqual([untitled, eclair, paddedAda, lowerAda, zebra, upperAda]);
    expect(
      orderLecternItems({ kind: "Added", direction: "desc" }, snapshot),
    ).toEqual([upperAda, zebra, paddedAda, lowerAda, eclair, untitled]);
  });

  it("ranks a shared title key by raw title in the requested direction", () => {
    expect(
      orderLecternItems({ kind: "Title", direction: "asc" }, snapshot),
    ).toEqual([untitled, paddedAda, upperAda, lowerAda, zebra, eclair]);
    expect(
      orderLecternItems({ kind: "Title", direction: "desc" }, snapshot),
    ).toEqual([eclair, zebra, lowerAda, upperAda, paddedAda, untitled]);
  });

  it("leaves the caller's snapshot array untouched while reordering", () => {
    const input = [...snapshot];
    orderLecternItems({ kind: "Title", direction: "asc" }, input);
    expect(input).toEqual(snapshot);
  });
});
