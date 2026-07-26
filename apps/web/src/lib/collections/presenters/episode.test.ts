import { describe, expect, it, vi } from "vitest";
import { presentEpisode, type EpisodePresenterContext, type EpisodePresenterItem } from "./episode";

function item(overrides: Partial<EpisodePresenterItem> = {}): EpisodePresenterItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Exact Episode",
    kind: "podcast_episode",
    processing_status: "ready_for_reading",
    episode_state: "in_progress",
    canonical_source_url: "https://example.test/episode",
    contributors: [],
    publicationDate: { kind: "Absent" },
    activityFacts: {
      totalMinutes: { kind: "Absent" },
      fraction: { kind: "Present", value: { value: 0.42 } },
      remainingMinutes: { kind: "Absent" },
    },
    ...overrides,
  };
}

function ctx(overrides: Partial<EpisodePresenterContext> = {}): EpisodePresenterContext {
  return {
    retryProcessing: { kind: "Unavailable" },
    refreshSource: { kind: "Unavailable" },
    retryMetadata: { kind: "Unavailable" },
    editAuthors: { kind: "Unavailable" },
    progressReset: { kind: "Unavailable" },
    lecternMembership: { kind: "Unavailable" },
    removeMedia: { kind: "Unavailable" },
    playedState: { kind: "Unavailable" },
    busyIds: new Set(),
    view: [],
    ...overrides,
  };
}

describe("presentEpisode", () => {
  it("publishes reset progress immediately after the played-state action", () => {
    const reset = vi.fn();
    const view = presentEpisode(
      item(),
      ctx({
        playedState: { kind: "MarkPlayed", execute: vi.fn() },
        progressReset: { kind: "Available", execute: reset },
      }),
    );

    expect(view.actionPublication.kind).toBe("ResourceMenu");
    if (view.actionPublication.kind !== "ResourceMenu") {
      throw new Error("Expected resource menu publication");
    }
    const operations = view.actionPublication.groups.operations;
    const markPlayedIndex = operations.findIndex(
      (action) => action.id === "ResourceOperation.Episode.MarkPlayed",
    );
    expect(operations[markPlayedIndex + 1]?.id).toBe(
      "ResourceOperation.Media.ResetProgress",
    );
    const action = operations[markPlayedIndex + 1];
    if (action?.kind !== "command") throw new Error("Expected command action");
    action.onSelect({ triggerEl: null });
    expect(reset).toHaveBeenCalledOnce();
  });
});
