import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPodcastUnsubscribeConfirmation,
  getPodcastSubscriptionSettingsDraft,
  getPodcastSubscriptionSettingsPatch,
  getPodcastSubscriptionSyncPatch,
  parsePodcastSubscriptionDefaultPlaybackSpeed,
  savePodcastSubscriptionSettings,
  subscribeToPodcast,
  unsubscribeFromPodcast,
} from "./podcastSubscriptions";
import type { LibraryPlacementOption } from "@/lib/libraries/libraryPlacement";
import { libraryPlacementSnapshot } from "@/lib/libraries/placementRevision";
import type { CollectionRevision } from "@/lib/api/collectionPage";

const REVISION = 7 as CollectionRevision;

function createLibraryPlacement(
  overrides: Partial<LibraryPlacementOption> = {},
): LibraryPlacementOption {
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

  it("returns explicit sync and settings patches", () => {
    expect(
      getPodcastSubscriptionSyncPatch({
        podcast_id: "podcast-1",
        sync_status: "running",
        sync_error_code: "timeout",
        sync_error_message: "Upstream timed out",
        sync_attempts: 3,
        sync_enqueued: true,
        collectionRevision: REVISION,
        libraryEntriesCollectionRevision: REVISION,
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
          user_id: "user-1",
          podcast_id: "podcast-1",
          status: "active",
          default_playback_speed: 1.25,
          auto_queue: true,
          sync_status: "complete",
          sync_error_code: null,
          sync_error_message: null,
          sync_attempts: 1,
          sync_started_at: null,
          sync_completed_at: null,
          last_synced_at: null,
          updated_at: "2026-04-22T00:00:00Z",
          collectionRevision: REVISION,
          libraryEntriesCollectionRevision: REVISION,
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
      createLibraryPlacement({
        id: "library-1",
        isInLibrary: true,
        canAdd: false,
        canRemove: true,
      }),
      createLibraryPlacement({
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

describe("podcastSubscriptions placement revision publishing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("publishes the selected library ids after subscribe", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: {} }),
    );
    const before = libraryPlacementSnapshot().revision;

    await subscribeToPodcast({
      provider_podcast_id: "provider-podcast-1",
      title: "Show",
      contributors: [],
      feed_url: "https://example.com/feed.xml",
      website_url: null,
      image_url: null,
      description: null,
      library_ids: ["library-1", "library-2"],
    });

    const after = libraryPlacementSnapshot();
    expect(after.revision).toBe(before + 1);
    expect(after.affectedLibraryIds).toEqual(["library-1", "library-2"]);
  });

  it("strictly decodes the revision-bearing settings response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          user_id: "user-1",
          podcast_id: "podcast-1",
          status: "active",
          default_playback_speed: 1.5,
          auto_queue: true,
          sync_status: "complete",
          sync_error_code: null,
          sync_error_message: null,
          sync_attempts: 1,
          sync_started_at: null,
          sync_completed_at: null,
          last_synced_at: null,
          updated_at: "2026-07-29T00:00:00Z",
          collectionRevision: 7,
          libraryEntriesCollectionRevision: 11,
        },
      }),
    );

    await expect(
      savePodcastSubscriptionSettings("podcast-1", {
        defaultPlaybackSpeed: 1.5,
        autoQueue: true,
      }),
    ).resolves.toMatchObject({
      user_id: "user-1",
      podcast_id: "podcast-1",
      collectionRevision: 7,
      libraryEntriesCollectionRevision: 11,
    });
  });

  it("publishes one Unknown placement change after unsubscribe", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            podcast_id: "podcast-1",
            status: "unsubscribed",
            removed_from_library_count: 2,
            retained_shared_library_count: 1,
            collectionRevision: 7,
            libraryEntriesCollectionRevision: 11,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const before = libraryPlacementSnapshot().revision;

    await expect(unsubscribeFromPodcast("podcast-1")).resolves.toEqual({
      podcast_id: "podcast-1",
      status: "unsubscribed",
      removed_from_library_count: 2,
      retained_shared_library_count: 1,
      collectionRevision: 7,
      libraryEntriesCollectionRevision: 11,
    });

    const after = libraryPlacementSnapshot();
    expect(after.revision).toBe(before + 1);
    expect(after.affectedLibraryIds).toBe("Unknown");
  });
});
