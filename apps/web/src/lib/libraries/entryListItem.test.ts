import { describe, expect, it } from "vitest";
import { decodeLibraryEntryListItem } from "./entryListItem";

const ABSENT = { kind: "Absent" } as const;

function podcastEntry() {
  return {
    kind: "podcast",
    placement: {
      kind: "Present",
      value: { libraryEntryId: "entry-1", position: 4 },
    },
    addedAt: "2026-07-29T00:00:00Z",
    podcast: {
      id: "podcast-1",
      title: "Systems",
      contributors: [],
      unplayedCount: 3,
      publishedDate: {
        kind: "Present",
        value: "2026-07-28T00:00:00Z",
      },
    },
    subscription: {
      kind: "Present",
      value: {
        defaultPlaybackSpeed: 1.25,
        autoQueue: true,
        syncStatus: "Complete",
      },
    },
    readingTimeEstimate: ABSENT,
  };
}

describe("decodeLibraryEntryListItem", () => {
  it("decodes the hard-cut Podcast placement and subscription Presence contract", () => {
    expect(decodeLibraryEntryListItem(podcastEntry())).toMatchObject({
      placement: {
        kind: "Present",
        value: { libraryEntryId: "entry-1", position: 4 },
      },
      addedAt: "2026-07-29T00:00:00Z",
      podcast: {
        id: "podcast-1",
        unplayedCount: { kind: "Present", value: { value: 3 } },
        publicationDate: {
          kind: "Present",
          value: "2026-07-28T00:00:00Z",
        },
        syncStatus: { kind: "Present", value: "Complete" },
      },
      subscription: {
        kind: "Present",
        value: {
          defaultPlaybackSpeed: 1.25,
          autoQueue: true,
          syncStatus: "Complete",
        },
      },
    });
  });

  it("accepts virtual Default Podcasts without fabricating placement", () => {
    const raw = podcastEntry();
    raw.placement = ABSENT as typeof raw.placement;
    raw.subscription = ABSENT as typeof raw.subscription;

    expect(decodeLibraryEntryListItem(raw)).toMatchObject({
      placement: ABSENT,
      subscription: ABSENT,
      podcast: { syncStatus: ABSENT },
    });
  });

  it("rejects legacy top-level placement and subscription status fields", () => {
    const legacy = {
      ...podcastEntry(),
      id: "entry-1",
      position: 4,
      created_at: "2026-07-29T00:00:00Z",
    };
    expect(() => decodeLibraryEntryListItem(legacy)).toThrow();

    const status = podcastEntry();
    status.subscription = {
      kind: "Present",
      value: {
        ...status.subscription.value,
        status: "active",
      } as unknown as typeof status.subscription.value,
    };
    expect(() => decodeLibraryEntryListItem(status)).toThrow();
  });
});
