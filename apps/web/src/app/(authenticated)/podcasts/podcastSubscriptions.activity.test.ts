import { describe, expect, it } from "vitest";
import {
  decodePodcastSubscriptionListItem,
  type PodcastSubscriptionListItemWire,
} from "./podcastSubscriptions";

function wire(
  overrides: Partial<PodcastSubscriptionListItemWire> = {},
): PodcastSubscriptionListItemWire {
  return {
    podcast_id: "podcast-1",
    status: "active",
    sync_status: "complete",
    sync_error_code: null,
    sync_error_message: null,
    sync_attempts: 0,
    sync_started_at: null,
    sync_completed_at: null,
    last_synced_at: null,
    updated_at: "2026-07-20T12:00:00Z",
    unplayed_count: 2,
    latest_episode_published_at: "2026-07-20T12:00:00Z",
    visible_libraries: [],
    podcast: {
      id: "podcast-1",
      provider: "rss",
      provider_podcast_id: "feed-1",
      title: "Signal Path",
      contributors: [],
      feed_url: "https://example.test/feed.xml",
      website_url: null,
      image_url: null,
      description: null,
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-20T12:00:00Z",
    },
    ...overrides,
  };
}

describe("decodePodcastSubscriptionListItem activity facts", () => {
  it("decodes the rendered facts once at the subscription boundary", () => {
    expect(decodePodcastSubscriptionListItem(wire())).toMatchObject({
      unplayedCount: { kind: "Present", value: { value: 2 } },
      publicationDate: {
        kind: "Present",
        value: "2026-07-20T12:00:00Z",
      },
      syncStatus: { kind: "Present", value: "complete" },
    });
  });

  it("rejects an unknown sync status", () => {
    expect(() =>
      decodePodcastSubscriptionListItem(
        wire({ sync_status: "stale" as PodcastSubscriptionListItemWire["sync_status"] }),
      ),
    ).toThrow(/podcast sync_status/);
  });

  it("rejects an unreal latest-episode date", () => {
    expect(() =>
      decodePodcastSubscriptionListItem(
        wire({ latest_episode_published_at: "2026-02-30" }),
      ),
    ).toThrow(/latest_episode_published_at/);
  });
});
