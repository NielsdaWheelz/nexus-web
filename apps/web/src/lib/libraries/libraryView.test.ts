import { describe, expect, it } from "vitest";
import {
  buildLibraryEntriesQuery,
  decodeLibraryView,
  encodeLibraryView,
  orderPresetIdsFor,
  orderToPresetId,
  presetIdToOrder,
  type LibraryEntryView,
  type LibraryOrderPresetId,
} from "./libraryView";

const ALL_PRESET_IDS: readonly LibraryOrderPresetId[] = [
  "canonical",
  "title-asc",
  "title-desc",
  "creator-asc",
  "creator-desc",
  "published-newest",
  "published-oldest",
  "added-newest",
  "added-oldest",
];

describe("libraryView presets", () => {
  it.each(ALL_PRESET_IDS)("round-trips preset %s at completion=all", (id) => {
    const order = presetIdToOrder(id);
    const view: LibraryEntryView = { order, completion: "all" };
    const encoded = encodeLibraryView(view, new URLSearchParams());
    const decoded = decodeLibraryView(encoded);
    expect(decoded).toEqual({ kind: "Valid", view });
    expect(orderToPresetId(order)).toBe(id);
  });

  it.each(ALL_PRESET_IDS)(
    "round-trips preset %s at completion=unfinished",
    (id) => {
      const order = presetIdToOrder(id);
      const view: LibraryEntryView = { order, completion: "unfinished" };
      const encoded = encodeLibraryView(view, new URLSearchParams());
      const decoded = decodeLibraryView(encoded);
      expect(decoded).toEqual({ kind: "Valid", view });
    },
  );
});

describe("encodeLibraryView", () => {
  it("preserves unrelated params", () => {
    const current = new URLSearchParams("paneWidth=2");
    const view: LibraryEntryView = {
      order: { kind: "Title", direction: "asc" },
      completion: "unfinished",
    };
    const encoded = encodeLibraryView(view, current);
    expect(encoded.get("paneWidth")).toBe("2");
    expect(encoded.get("sort")).toBe("title");
    expect(encoded.get("direction")).toBe("asc");
    expect(encoded.get("completion")).toBe("unfinished");
  });

  it("omits sort/direction for Canonical and completion for all", () => {
    const current = new URLSearchParams("sort=title&direction=asc&completion=unfinished");
    const view: LibraryEntryView = { order: { kind: "Canonical" }, completion: "all" };
    const encoded = encodeLibraryView(view, current);
    expect(encoded.has("sort")).toBe(false);
    expect(encoded.has("direction")).toBe(false);
    expect(encoded.has("completion")).toBe(false);
  });
});

describe("buildLibraryEntriesQuery", () => {
  it("is empty for canonical + all", () => {
    expect(
      buildLibraryEntriesQuery({ order: { kind: "Canonical" }, completion: "all" }),
    ).toBe("");
  });

  it("includes sort, direction, completion for a factual+unfinished view", () => {
    expect(
      buildLibraryEntriesQuery({
        order: { kind: "Title", direction: "asc" },
        completion: "unfinished",
      }),
    ).toBe("?sort=title&direction=asc&completion=unfinished");
  });
});

describe("decodeLibraryView invalid cases", () => {
  const invalidQueries = [
    "direction=asc",
    "sort=position",
    "sort=resonance",
    "sort=title",
    "sort=title&direction=sideways",
    "completion=all",
    "completion=xyz",
  ];

  it.each(invalidQueries)("%s -> Invalid", (query) => {
    expect(decodeLibraryView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });
});

describe("decodeLibraryView completion independence", () => {
  it("canonical + unfinished", () => {
    expect(
      decodeLibraryView(new URLSearchParams("completion=unfinished")),
    ).toEqual({
      kind: "Valid",
      view: { order: { kind: "Canonical" }, completion: "unfinished" },
    });
  });

  it("title-asc + unfinished", () => {
    expect(
      decodeLibraryView(
        new URLSearchParams("sort=title&direction=asc&completion=unfinished"),
      ),
    ).toEqual({
      kind: "Valid",
      view: {
        order: { kind: "Title", direction: "asc" },
        completion: "unfinished",
      },
    });
  });
});

describe("orderPresetIdsFor", () => {
  it("omits added-newest for the default library", () => {
    expect(orderPresetIdsFor(true)).not.toContain("added-newest");
  });

  it("includes added-newest for non-default libraries", () => {
    expect(orderPresetIdsFor(false)).toContain("added-newest");
  });
});
