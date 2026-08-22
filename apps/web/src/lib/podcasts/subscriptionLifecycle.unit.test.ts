import { describe, expect, it } from "vitest";
import { decodePodcastSubscriptionLifecycleEvent } from "./subscriptionLifecycle";

const PODCAST_ID = "44444444-4444-4444-8444-444444444444";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    podcastId: PODCAST_ID,
    syncStatus: "Running",
    backfill: {
      id: "77777777-7777-4777-8777-777777777777",
      state: "Pending",
      processedCount: 0,
      addedCount: 0,
    },
    ...overrides,
  };
}

describe("Podcast subscription lifecycle stream", () => {
  it("treats a malformed owner snapshot as one fatal protocol failure", () => {
    expect(() =>
      decodePodcastSubscriptionLifecycleEvent(
        "state",
        { podcastId: PODCAST_ID },
        PODCAST_ID,
      ),
    ).toThrowError("Invalid SSE payload for Podcast subscription lifecycle");
  });

  it("treats unknown event types, identity drift, and premature done as fatal protocol failures", () => {
    expect(() =>
      decodePodcastSubscriptionLifecycleEvent(
        "progress",
        snapshot(),
        PODCAST_ID,
      ),
    ).toThrowError("Unknown SSE event type: progress");
    expect(() =>
      decodePodcastSubscriptionLifecycleEvent(
        "state",
        snapshot({
          podcastId: "55555555-5555-4555-8555-555555555555",
        }),
        PODCAST_ID,
      ),
    ).toThrowError("Invalid SSE payload for Podcast subscription lifecycle");
    expect(() =>
      decodePodcastSubscriptionLifecycleEvent("done", snapshot(), PODCAST_ID),
    ).toThrowError("Invalid SSE payload for Podcast subscription lifecycle");
  });
});
