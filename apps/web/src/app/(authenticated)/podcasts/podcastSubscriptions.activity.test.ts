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
    title: "Signal Path",
    contributors: [],
    sync_status: "Complete",
    default_playback_speed: { kind: "Absent" },
    pause_shortening_mode: { kind: "Absent" },
    auto_queue: false,
    unplayed_count: 2,
    latest_episode_published_at: {
      kind: "Present",
      value: "2026-07-20T12:00:00Z",
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
      syncStatus: { kind: "Present", value: "Complete" },
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
        wire({
          latest_episode_published_at: {
            kind: "Present",
            value: "2026-02-30",
          },
        }),
      ),
    ).toThrow(/latest_episode_published_at/);
  });

  it("strictly decodes embedded contributor credits", () => {
    const validCredit = {
      contributor_handle: "ada-lovelace",
      contributor_display_name: "Ada Lovelace",
      href: "/authors/ada-lovelace",
      credited_name: "A. Lovelace",
      role: "host",
      raw_role: null,
      ordinal: 0,
    };
    expect(
      decodePodcastSubscriptionListItem(
        wire({ contributors: [validCredit] }),
      ).contributors,
    ).toEqual([validCredit]);

    expect(() =>
      decodePodcastSubscriptionListItem(
        wire({
          contributors: [{ ...validCredit, unexpected: true }] as never,
        }),
      ),
    ).toThrow(/Podcast subscription contributors/);
    expect(() =>
      decodePodcastSubscriptionListItem(
        wire({
          contributors: [{ ...validCredit, credited_name: 42 }] as never,
        }),
      ),
    ).toThrow(/credited_name/);
  });
});
