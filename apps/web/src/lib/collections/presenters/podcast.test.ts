import { describe, expect, it } from "vitest";
import type {
  PodcastPresenterContext,
  PodcastPresenterItem,
} from "./podcast";
import { presentPodcast } from "./podcast";

function item(
  overrides: Partial<PodcastPresenterItem> = {},
): PodcastPresenterItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Signal Path",
    contributors: [],
    unplayedCount: { kind: "Present", value: { value: 3 } },
    syncStatus: { kind: "Present", value: "Complete" },
    publicationDate: { kind: "Absent" },
    ...overrides,
  };
}

function ctx(): PodcastPresenterContext {
  return {
    settings: { kind: "Unavailable" },
    checkForNewEpisodes: { kind: "Unavailable" },
    subscription: { kind: "Unavailable" },
    busyIds: new Set(),
  };
}

describe("presentPodcast", () => {
  it.each(["Pending", "Running"] as const)(
    "presents %s as row activity",
    (status) => {
      const view = presentPodcast(
        item({ syncStatus: { kind: "Present", value: status } }),
        ctx(),
      );

      expect(view.activity).toEqual({
        kind: "Present",
        value: { kind: "PodcastSync", status },
      });
      expect(view.exceptionalStatus).toEqual({ kind: "Absent" });
    },
  );

  it("presents Failed as exceptional", () => {
    const view = presentPodcast(
      item({ syncStatus: { kind: "Present", value: "Failed" } }),
      ctx(),
    );

    expect(view.exceptionalStatus).toEqual({
      kind: "Present",
      value: { kind: "PodcastSync", status: "Failed" },
    });
  });

  it.each(["Complete", "SourceLimited"] as const)(
    "keeps %s healthy and silent",
    (status) => {
      const view = presentPodcast(
        item({
          unplayedCount: { kind: "Absent" },
          syncStatus: { kind: "Present", value: status },
        }),
        ctx(),
      );

      expect(view.activity).toEqual({ kind: "Absent" });
      expect(view.exceptionalStatus).toEqual({ kind: "Absent" });
    },
  );
});
