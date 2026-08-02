import { describe, expect, it } from "vitest";
import {
  CANONICAL_LIBRARY_VIEW,
  LIBRARY_ENTRY_TYPE_OPTION_IDS,
  activeLibraryDomainControlCount,
  buildLibraryEntriesQuery,
  decodeLibraryView,
  encodeLibraryView,
  entryTypeOptionLabel,
  entryTypeOptionOf,
  formatLibraryView,
  isInitialLibraryView,
  projectionSupportsCompletion,
  withCompletion,
  withEntryTypeOption,
  withProjectionOption,
  type LibraryExactEntryType,
  type LibraryEntryTypeOptionId,
  type LibraryEntryView,
} from "./libraryView";

const ORDER = { kind: "Title", direction: "asc" } as const;
const ALL_ITEMS = { kind: "AllItems", completion: "all" } as const;
const ALL_TYPES = { kind: "AllTypes" } as const;

function exactType(value: LibraryExactEntryType) {
  return { kind: "ExactType", value } as const;
}

describe("Library entry type product contract", () => {
  it("exposes exactly All plus the six ordered, canonical labels", () => {
    expect(LIBRARY_ENTRY_TYPE_OPTION_IDS).toEqual([
      "all-types",
      "web_article",
      "epub",
      "pdf",
      "video",
      "podcast_episode",
      "podcast",
    ]);
    expect(
      LIBRARY_ENTRY_TYPE_OPTION_IDS.map((id) => entryTypeOptionLabel(id)),
    ).toEqual([
      "All types",
      "Web articles",
      "EPUBs",
      "PDFs",
      "Videos",
      "Podcast episodes",
      "Podcast shows",
    ]);
  });
});

describe("Library entry type URL and API codec", () => {
  it("decodes omission as All types and every exact wire value without aliases", () => {
    expect(decodeLibraryView(new URLSearchParams())).toEqual({
      kind: "Valid",
      view: CANONICAL_LIBRARY_VIEW,
    });
    expect(
      decodeLibraryView(new URLSearchParams("paneWidth=2")),
    ).toEqual({ kind: "Valid", view: CANONICAL_LIBRARY_VIEW });

    const exactValues = [
      "web_article",
      "epub",
      "pdf",
      "video",
      "podcast_episode",
      "podcast",
    ] as const;
    for (const value of exactValues) {
      expect(
        decodeLibraryView(new URLSearchParams({ entry_type: value })),
      ).toEqual({
        kind: "Valid",
        view: {
          order: { kind: "Canonical" },
          projection: ALL_ITEMS,
          entryType: exactType(value === "podcast" ? "podcast" : value),
        },
      });
    }
  });

  it.each([
    "entry_type=",
    "entry_type=all",
    "entry_type=article",
    "entry_type=pdf&entry_type=video",
    "kind=pdf",
    "type=pdf",
    "types=pdf",
    "entry_type=podcast&projection=unfiled",
    "entry_type=podcast&projection=in-progress",
    "entry_type=podcast&completion=unfinished",
  ])("rejects invalid raw state: %s", (query) => {
    expect(decodeLibraryView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });

  it("emits exact type, omits All types, and clears stale owned state", () => {
    const pdfView: LibraryEntryView = {
      order: ORDER,
      projection: ALL_ITEMS,
      entryType: exactType("pdf"),
    };
    expect(buildLibraryEntriesQuery(pdfView)).toBe(
      "?sort=title&direction=asc&entry_type=pdf",
    );

    const encoded = encodeLibraryView(
      CANONICAL_LIBRARY_VIEW,
      new URLSearchParams(
        "entry_type=pdf&kind=pdf&type=pdf&types=pdf&paneWidth=2",
      ),
    );
    expect(encoded.toString()).toBe("paneWidth=2");
  });
});

describe("Library entry type transitions", () => {
  it("selecting Podcast shows preserves order and normalizes projection", () => {
    const next = withEntryTypeOption(
      {
        order: ORDER,
        projection: { kind: "Unfiled", completion: "unfinished" },
        entryType: exactType("pdf"),
      },
      "podcast",
    );
    expect(next).toEqual({
      order: ORDER,
      projection: ALL_ITEMS,
      entryType: exactType("podcast"),
    });
  });

  it.each(["unfiled", "in-progress"] as const)(
    "selecting %s from Podcast shows preserves order and restores All types",
    (option) => {
      const next = withProjectionOption(
        {
          order: ORDER,
          projection: ALL_ITEMS,
          entryType: exactType("podcast"),
        },
        option,
      );
      expect(next.order).toEqual(ORDER);
      expect(next.entryType).toEqual(ALL_TYPES);
      expect(entryTypeOptionOf(next)).toBe("all-types");
    },
  );

  it("preserves compatible projection and order for every other Type change", () => {
    const original: LibraryEntryView = {
      order: ORDER,
      projection: { kind: "Unfiled", completion: "unfinished" },
      entryType: ALL_TYPES,
    };
    const optionIds: readonly LibraryEntryTypeOptionId[] = [
      "all-types",
      "web_article",
      "epub",
      "pdf",
      "video",
      "podcast_episode",
    ];
    for (const optionId of optionIds) {
      const next = withEntryTypeOption(original, optionId);
      expect(next.order).toEqual(ORDER);
      expect(next.projection).toEqual(original.projection);
      expect(entryTypeOptionOf(next)).toBe(optionId);
    }
  });

  it("makes Hide finished inapplicable and completion changes inert for Podcast shows", () => {
    const podcastView: LibraryEntryView = {
      order: ORDER,
      projection: ALL_ITEMS,
      entryType: exactType("podcast"),
    };
    expect(projectionSupportsCompletion(podcastView)).toBe(false);
    expect(withCompletion(podcastView, "unfinished")).toBe(podcastView);
  });
});

describe("Library entry type derived view behavior", () => {
  it("owns canonical identity and counts each active Type as one control", () => {
    expect(isInitialLibraryView(CANONICAL_LIBRARY_VIEW)).toBe(true);
    expect(activeLibraryDomainControlCount(CANONICAL_LIBRARY_VIEW)).toBe(0);

    const pdfView = withEntryTypeOption(CANONICAL_LIBRARY_VIEW, "pdf");
    expect(isInitialLibraryView(pdfView)).toBe(false);
    expect(activeLibraryDomainControlCount(pdfView)).toBe(1);
  });

  it("adds only an active Type to the concise requested-view label", () => {
    expect(formatLibraryView(CANONICAL_LIBRARY_VIEW, true)).toBe(
      "All items · Recently added",
    );
    expect(
      formatLibraryView(
        withEntryTypeOption(CANONICAL_LIBRARY_VIEW, "pdf"),
        true,
      ),
    ).toBe("All items · PDFs · Recently added");
  });
});
