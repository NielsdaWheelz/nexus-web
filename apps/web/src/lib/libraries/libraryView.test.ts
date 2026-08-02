import { describe, expect, it } from "vitest";
import {
  buildLibraryEntriesQuery,
  completionOf,
  decodeLibraryView,
  encodeLibraryView,
  formatLibraryView,
  orderPresetIdsFor,
  orderToPresetId,
  presetIdToOrder,
  projectionOptionLabel,
  projectionOptionOf,
  projectionOptionsFor,
  projectionSupportsCompletion,
  withCompletion,
  withProjectionOption,
  type Completion,
  type LibraryEntryOrder,
  type LibraryEntryProjection,
  type LibraryEntryView,
  type LibraryOrderPresetId,
  type ProjectionOptionId,
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

function allItems(completion: Completion): LibraryEntryProjection {
  return { kind: "AllItems", completion };
}
function unfiled(completion: Completion): LibraryEntryProjection {
  return { kind: "Unfiled", completion };
}
const inProgress: LibraryEntryProjection = { kind: "InProgress" };

const CANONICAL = { kind: "Canonical" } as const;
const ALL_TYPES = { kind: "AllTypes" } as const;

function allTypesView(
  order: LibraryEntryOrder,
  projection: LibraryEntryProjection,
): LibraryEntryView {
  return { order, projection, entryType: ALL_TYPES };
}

describe("decodeLibraryView projection + completion", () => {
  it("defaults to AllItems(all) with canonical order for empty params", () => {
    expect(decodeLibraryView(new URLSearchParams())).toEqual({
      kind: "Valid",
      view: allTypesView(CANONICAL, allItems("all")),
    });
  });

  it("decodes AllItems + unfinished", () => {
    expect(
      decodeLibraryView(new URLSearchParams("completion=unfinished")),
    ).toEqual({
      kind: "Valid",
      view: allTypesView(CANONICAL, allItems("unfinished")),
    });
  });

  it("decodes Unfiled + all", () => {
    expect(
      decodeLibraryView(new URLSearchParams("projection=unfiled")),
    ).toEqual({
      kind: "Valid",
      view: allTypesView(CANONICAL, unfiled("all")),
    });
  });

  it("decodes Unfiled + unfinished", () => {
    expect(
      decodeLibraryView(
        new URLSearchParams("projection=unfiled&completion=unfinished"),
      ),
    ).toEqual({
      kind: "Valid",
      view: allTypesView(CANONICAL, unfiled("unfinished")),
    });
  });

  it("decodes InProgress (no completion)", () => {
    expect(
      decodeLibraryView(new URLSearchParams("projection=in-progress")),
    ).toEqual({
      kind: "Valid",
      view: allTypesView(CANONICAL, inProgress),
    });
  });

  it("decodes a factual order together with a projection", () => {
    expect(
      decodeLibraryView(
        new URLSearchParams(
          "sort=title&direction=asc&projection=unfiled&completion=unfinished",
        ),
      ),
    ).toEqual({
      kind: "Valid",
      view: allTypesView(
        { kind: "Title", direction: "asc" },
        unfiled("unfinished"),
      ),
    });
  });
});

describe("decodeLibraryView order coverage", () => {
  it.each(ALL_PRESET_IDS)("decodes order preset %s", (id) => {
    const order = presetIdToOrder(id);
    const encoded = encodeLibraryView(
      allTypesView(order, allItems("all")),
      new URLSearchParams(),
    );
    expect(decodeLibraryView(encoded)).toEqual({
      kind: "Valid",
      view: allTypesView(order, allItems("all")),
    });
  });
});

describe("decodeLibraryView invalid cases", () => {
  const invalidQueries = [
    "completion=all", // "all" is the omitted default, never emitted explicitly
    "completion=xyz",
    "projection=recent",
    "projection=", // empty string is not a recognized projection
    "projection=in-progress&completion=unfinished", // unrepresentable union
    "direction=asc", // direction without sort
    "sort=position", // unknown sort key
    "sort=resonance",
    "sort=title", // sort without direction
    "sort=title&direction=sideways",
  ];

  it.each(invalidQueries)("%s -> Invalid", (query) => {
    expect(decodeLibraryView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });
});

describe("encode/decode round-trips", () => {
  const projections: readonly LibraryEntryProjection[] = [
    allItems("all"),
    allItems("unfinished"),
    unfiled("all"),
    unfiled("unfinished"),
    inProgress,
  ];

  for (const id of ALL_PRESET_IDS) {
    for (const projection of projections) {
      it(`round-trips ${id} + ${JSON.stringify(projection)}`, () => {
        const view: LibraryEntryView = {
          order: presetIdToOrder(id),
          projection,
          entryType: ALL_TYPES,
        };
        const encoded = encodeLibraryView(view, new URLSearchParams());
        expect(decodeLibraryView(encoded)).toEqual({ kind: "Valid", view });
      });
    }
  }
});

describe("encodeLibraryView key emission", () => {
  it("canonical AllItems(all) emits no keys", () => {
    const view: LibraryEntryView = {
      order: CANONICAL,
      projection: allItems("all"),
      entryType: ALL_TYPES,
    };
    const encoded = encodeLibraryView(view, new URLSearchParams());
    expect([...encoded.keys()]).toEqual([]);
  });

  it("omits the projection key for AllItems but keeps completion", () => {
    const view: LibraryEntryView = {
      order: CANONICAL,
      projection: allItems("unfinished"),
      entryType: ALL_TYPES,
    };
    const encoded = encodeLibraryView(view, new URLSearchParams());
    expect(encoded.has("projection")).toBe(false);
    expect(encoded.get("completion")).toBe("unfinished");
  });

  it("emits projection but never completion for InProgress", () => {
    const view = allTypesView(CANONICAL, inProgress);
    const encoded = encodeLibraryView(view, new URLSearchParams());
    expect(encoded.get("projection")).toBe("in-progress");
    expect(encoded.has("completion")).toBe(false);
  });

  it("preserves unrelated params and replaces the view-owned keys", () => {
    const current = new URLSearchParams(
      "paneWidth=2&sort=added&direction=desc&projection=in-progress",
    );
    const view: LibraryEntryView = {
      order: { kind: "Title", direction: "asc" },
      projection: unfiled("unfinished"),
      entryType: ALL_TYPES,
    };
    const encoded = encodeLibraryView(view, current);
    expect(encoded.get("paneWidth")).toBe("2");
    expect(encoded.get("sort")).toBe("title");
    expect(encoded.get("direction")).toBe("asc");
    expect(encoded.get("projection")).toBe("unfiled");
    expect(encoded.get("completion")).toBe("unfinished");
  });

  it("clears stale view-owned keys when the new view omits them", () => {
    const current = new URLSearchParams(
      "sort=title&direction=asc&projection=unfiled&completion=unfinished",
    );
    const view: LibraryEntryView = {
      order: CANONICAL,
      projection: allItems("all"),
      entryType: ALL_TYPES,
    };
    const encoded = encodeLibraryView(view, current);
    expect(encoded.has("sort")).toBe(false);
    expect(encoded.has("direction")).toBe(false);
    expect(encoded.has("projection")).toBe(false);
    expect(encoded.has("completion")).toBe(false);
  });
});

describe("buildLibraryEntriesQuery", () => {
  it("is empty for canonical AllItems(all)", () => {
    expect(
      buildLibraryEntriesQuery({
        order: CANONICAL,
        projection: allItems("all"),
        entryType: ALL_TYPES,
      }),
    ).toBe("");
  });

  it("emits sort/direction/completion for a factual unfinished AllItems view", () => {
    expect(
      buildLibraryEntriesQuery({
        order: { kind: "Title", direction: "asc" },
        projection: allItems("unfinished"),
        entryType: ALL_TYPES,
      }),
    ).toBe("?sort=title&direction=asc&completion=unfinished");
  });

  it("emits the projection key for Unfiled", () => {
    expect(
      buildLibraryEntriesQuery({
        order: CANONICAL,
        projection: unfiled("all"),
        entryType: ALL_TYPES,
      }),
    ).toBe("?projection=unfiled");
  });

  it("emits projection + completion for unfinished Unfiled", () => {
    expect(
      buildLibraryEntriesQuery({
        order: CANONICAL,
        projection: unfiled("unfinished"),
        entryType: ALL_TYPES,
      }),
    ).toBe("?projection=unfiled&completion=unfinished");
  });

  it("emits only the projection key for InProgress", () => {
    expect(
      buildLibraryEntriesQuery({
        order: { kind: "Added", direction: "desc" },
        projection: inProgress,
        entryType: ALL_TYPES,
      }),
    ).toBe("?sort=added&direction=desc&projection=in-progress");
  });
});

describe("projectionOptionsFor", () => {
  it("offers all three options for the default library", () => {
    expect(projectionOptionsFor(true)).toEqual([
      "all-items",
      "unfiled",
      "in-progress",
    ]);
  });

  it("omits Unfiled for non-default libraries", () => {
    expect(projectionOptionsFor(false)).toEqual(["all-items", "in-progress"]);
  });
});

describe("projectionOptionLabel", () => {
  it.each([
    ["all-items", "All items"],
    ["unfiled", "Unfiled"],
    ["in-progress", "In Progress"],
  ] as const)("labels %s as %s", (id: ProjectionOptionId, label) => {
    expect(projectionOptionLabel(id)).toBe(label);
  });
});

describe("projectionOptionOf", () => {
  it("maps each projection to its option id", () => {
    expect(
      projectionOptionOf(allTypesView(CANONICAL, allItems("all"))),
    ).toBe("all-items");
    expect(
      projectionOptionOf(allTypesView(CANONICAL, unfiled("all"))),
    ).toBe("unfiled");
    expect(
      projectionOptionOf(allTypesView(CANONICAL, inProgress)),
    ).toBe("in-progress");
  });
});

describe("completionOf / projectionSupportsCompletion", () => {
  it("reads the carried completion for AllItems and Unfiled", () => {
    expect(
      completionOf(allTypesView(CANONICAL, allItems("unfinished"))),
    ).toBe("unfinished");
    expect(
      completionOf(allTypesView(CANONICAL, unfiled("all"))),
    ).toBe("all");
  });

  it("reports 'all' and no completion support for InProgress", () => {
    const view = allTypesView(CANONICAL, inProgress);
    expect(completionOf(view)).toBe("all");
    expect(projectionSupportsCompletion(view)).toBe(false);
  });

  it("supports completion for AllItems and Unfiled", () => {
    expect(
      projectionSupportsCompletion(allTypesView(CANONICAL, allItems("all"))),
    ).toBe(true);
    expect(
      projectionSupportsCompletion(
        allTypesView(CANONICAL, unfiled("unfinished")),
      ),
    ).toBe(true);
  });
});

describe("withProjectionOption completion transitions", () => {
  const order = { kind: "Title", direction: "asc" } as const;

  it("preserves order when switching projection", () => {
    const next = withProjectionOption(
      allTypesView(order, allItems("all")),
      "unfiled",
    );
    expect(next.order).toEqual(order);
  });

  it("carries completion across all-items <-> unfiled", () => {
    const toUnfiled = withProjectionOption(
      allTypesView(CANONICAL, allItems("unfinished")),
      "unfiled",
    );
    expect(toUnfiled.projection).toEqual(unfiled("unfinished"));

    const backToAll = withProjectionOption(
      allTypesView(CANONICAL, unfiled("unfinished")),
      "all-items",
    );
    expect(backToAll.projection).toEqual(allItems("unfinished"));
  });

  it("drops completion when entering In Progress", () => {
    const next = withProjectionOption(
      allTypesView(CANONICAL, allItems("unfinished")),
      "in-progress",
    );
    expect(next.projection).toEqual(inProgress);
  });

  it("leaves In Progress with finished shown (completion all)", () => {
    const toAll = withProjectionOption(
      allTypesView(CANONICAL, inProgress),
      "all-items",
    );
    expect(toAll.projection).toEqual(allItems("all"));

    const toUnfiled = withProjectionOption(
      allTypesView(CANONICAL, inProgress),
      "unfiled",
    );
    expect(toUnfiled.projection).toEqual(unfiled("all"));
  });
});

describe("withCompletion", () => {
  it("sets completion on AllItems and Unfiled, preserving order", () => {
    const order = { kind: "Added", direction: "desc" } as const;
    expect(
      withCompletion(allTypesView(order, allItems("all")), "unfinished"),
    ).toEqual(allTypesView(order, allItems("unfinished")));
    expect(
      withCompletion(
        allTypesView(CANONICAL, unfiled("unfinished")),
        "all",
      ),
    ).toEqual(allTypesView(CANONICAL, unfiled("all")));
  });

  it("is a no-op for InProgress", () => {
    const view = allTypesView(CANONICAL, inProgress);
    expect(withCompletion(view, "unfinished")).toEqual(view);
  });
});

describe("formatLibraryView", () => {
  it("formats AllItems + canonical for the default library", () => {
    expect(
      formatLibraryView(
        allTypesView(CANONICAL, allItems("all")),
        true,
      ),
    ).toBe("All items · Recently added");
  });

  it("formats a factual In Progress view", () => {
    expect(
      formatLibraryView(
        allTypesView(
          { kind: "Title", direction: "asc" },
          inProgress,
        ),
        false,
      ),
    ).toBe("In Progress · Title — A–Z");
  });

  it("appends 'unfinished only' for an unfinished Unfiled view", () => {
    expect(
      formatLibraryView(
        allTypesView(CANONICAL, unfiled("unfinished")),
        true,
      ),
    ).toBe("Unfiled · Recently added · unfinished only");
  });

  it("never appends 'unfinished only' for In Progress", () => {
    expect(
      formatLibraryView(
        allTypesView(CANONICAL, inProgress),
        true,
      ),
    ).toBe("In Progress · Recently added");
  });

  it("uses 'Custom order' for a non-default canonical order", () => {
    expect(
      formatLibraryView(
        allTypesView(CANONICAL, allItems("all")),
        false,
      ),
    ).toBe("All items · Custom order");
  });
});

describe("order preset helpers", () => {
  it.each(ALL_PRESET_IDS)("round-trips preset id %s", (id) => {
    expect(orderToPresetId(presetIdToOrder(id))).toBe(id);
  });

  it("omits added-newest for the default library", () => {
    expect(orderPresetIdsFor(true)).not.toContain("added-newest");
  });

  it("includes added-newest for non-default libraries", () => {
    expect(orderPresetIdsFor(false)).toContain("added-newest");
  });
});
