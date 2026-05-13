import { describe, expect, it } from "vitest";
import {
  buildPodcastUnsubscribeConfirmation,
  getPodcastSubscriptionSettingsDraft,
  getPodcastSubscriptionSettingsPatch,
  getPodcastSubscriptionSyncPatch,
  parsePodcastSubscriptionDefaultPlaybackSpeed,
  updatePodcastLibraryMemberships,
  type PodcastLibraryMembership,
} from "./podcastSubscriptions";

function createLibraryMembership(
  overrides: Partial<PodcastLibraryMembership> = {}
): PodcastLibraryMembership {
  return {
    id: "library-1",
    name: "Inbox",
    color: null,
    isInLibrary: false,
    canAdd: true,
    canRemove: false,
    ...overrides,
  };
}

describe("podcastSubscriptions helpers", () => {
  it("builds settings draft state from nullable subscription fields", () => {
    expect(getPodcastSubscriptionSettingsDraft(null)).toEqual({
      defaultSpeed: "default",
      autoQueue: false,
    });
    expect(
      getPodcastSubscriptionSettingsDraft({
        default_playback_speed: 1.8,
        auto_queue: true,
      })
    ).toEqual({
      defaultSpeed: "1.8",
      autoQueue: true,
    });
  });

  it("parses playback speed form values", () => {
    expect(parsePodcastSubscriptionDefaultPlaybackSpeed("default")).toBeNull();
    expect(parsePodcastSubscriptionDefaultPlaybackSpeed("1.5")).toBe(1.5);
  });

  it("applies podcast library membership updates only to the targeted library", () => {
    const nextLibraries = updatePodcastLibraryMemberships(
      [
        createLibraryMembership(),
        createLibraryMembership({
          id: "library-2",
          name: "Shared",
          isInLibrary: true,
          canAdd: false,
          canRemove: true,
        }),
      ],
      { libraryId: "library-1", isInLibrary: true }
    );

    expect(nextLibraries).toEqual([
      createLibraryMembership({
        isInLibrary: true,
        canAdd: false,
        canRemove: true,
      }),
      createLibraryMembership({
        id: "library-2",
        name: "Shared",
        isInLibrary: true,
        canAdd: false,
        canRemove: true,
      }),
    ]);
  });

  it("returns explicit sync and settings patches", () => {
    expect(
      getPodcastSubscriptionSyncPatch({
        podcast_id: "podcast-1",
        sync_status: "running",
        sync_error_code: "timeout",
        sync_error_message: "Upstream timed out",
        sync_attempts: 3,
        sync_enqueued: true,
      })
    ).toEqual({
      sync_status: "running",
      sync_error_code: "timeout",
      sync_error_message: "Upstream timed out",
      sync_attempts: 3,
    });

    expect(
      getPodcastSubscriptionSettingsPatch({
        response: {
          podcast_id: "podcast-1",
          default_playback_speed: 1.25,
          auto_queue: true,
          updated_at: "2026-04-22T00:00:00Z",
        },
        updatedAt: "2026-01-01T00:00:00Z",
      })
    ).toEqual({
      default_playback_speed: 1.25,
      auto_queue: true,
      updated_at: "2026-04-22T00:00:00Z",
    });
  });

  it("describes unsubscribe side effects with removable and retained libraries", () => {
    const message = buildPodcastUnsubscribeConfirmation("Debug Show", [
      createLibraryMembership({
        id: "library-1",
        isInLibrary: true,
        canAdd: false,
        canRemove: true,
      }),
      createLibraryMembership({
        id: "library-2",
        name: "Shared",
        isInLibrary: true,
        canAdd: false,
        canRemove: false,
      }),
    ]);

    expect(message).toContain('Unsubscribe from "Debug Show"?');
    expect(message).toContain("remove the podcast from 1 library");
    expect(message).toContain("remain in 1 shared library");
  });
});
