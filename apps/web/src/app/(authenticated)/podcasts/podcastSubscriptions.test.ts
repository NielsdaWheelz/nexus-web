import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPodcastUnsubscribeConfirmation,
  decodePodcastDetailResponse,
  getPodcastSubscriptionSettingsDraft,
  getPodcastSubscriptionSettingsPatch,
  parsePodcastSubscriptionDefaultPlaybackSpeed,
  retryPodcastSubscriptionBackfill,
  savePodcastSubscriptionSettings,
  unsubscribeFromPodcast,
} from "./podcastSubscriptions";
import type { LibraryPlacementOption } from "@/lib/libraries/libraryPlacement";
import { libraryPlacementSnapshot } from "@/lib/libraries/placementRevision";
import type { CollectionRevision } from "@/lib/api/collectionPage";

const REVISION = 7 as CollectionRevision;

function podcastDetailWire() {
  return {
    data: {
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
        created_at: "2026-07-29T00:00:00Z",
        updated_at: "2026-07-30T00:00:00Z",
      },
      subscription: {
        user_id: "user-1",
        podcast_id: "podcast-1",
        default_playback_speed: null,
        auto_queue: false,
        sync_status: "Complete",
        sync_error_code: null,
        sync_error_message: null,
        sync_attempts: 1,
        sync_started_at: null,
        sync_completed_at: "2026-07-30T00:00:00Z",
        last_checked_at: "2026-07-30T00:00:00Z",
        updated_at: "2026-07-30T00:00:00Z",
        backfill: {
          id: "backfill-1",
          state: "Complete",
          processed_count: 10,
          added_count: 8,
        },
      },
    },
  };
}

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
      }),
    ).toEqual({
      defaultSpeed: "1.8",
      autoQueue: true,
    });
  });

  it("parses playback speed form values", () => {
    expect(parsePodcastSubscriptionDefaultPlaybackSpeed("default")).toBeNull();
    expect(parsePodcastSubscriptionDefaultPlaybackSpeed("1.5")).toBe(1.5);
  });

  it("returns an explicit settings patch", () => {
    expect(
      getPodcastSubscriptionSettingsPatch({
        response: {
          user_id: "user-1",
          podcast_id: "podcast-1",
          default_playback_speed: 1.25,
          auto_queue: true,
          sync_status: "Complete",
          sync_error_code: null,
          sync_error_message: null,
          sync_attempts: 1,
          sync_started_at: null,
          sync_completed_at: null,
          last_checked_at: null,
          updated_at: "2026-04-22T00:00:00Z",
          backfill: {
            id: "backfill-1",
            state: "Complete",
            processedCount: 10,
            addedCount: 8,
          },
          collectionRevision: REVISION,
          libraryEntriesCollectionRevision: REVISION,
        },
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    ).toEqual({
      default_playback_speed: 1.25,
      auto_queue: true,
      updated_at: "2026-04-22T00:00:00Z",
    });
  });

  it("hard-requires last_checked_at on podcast detail", () => {
    expect(decodePodcastDetailResponse(podcastDetailWire())).toMatchObject({
      subscription: {
        sync_status: "Complete",
        last_checked_at: "2026-07-30T00:00:00Z",
      },
    });

    const canonical = podcastDetailWire();
    const {
      last_checked_at: _lastCheckedAt,
      ...legacySubscription
    } = canonical.data.subscription;
    expect(() =>
      decodePodcastDetailResponse({
        data: {
          ...canonical.data,
          subscription: {
            ...legacySubscription,
            last_synced_at: "2026-07-30T00:00:00Z",
          },
        },
      }),
    ).toThrow(/PodcastDetailResponse.subscription/);
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

  it("strictly decodes the revision-bearing settings response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          user_id: "user-1",
          podcast_id: "podcast-1",
          default_playback_speed: 1.5,
          auto_queue: true,
          sync_status: "Complete",
          sync_error_code: null,
          sync_error_message: null,
          sync_attempts: 1,
          sync_started_at: null,
          sync_completed_at: null,
          last_checked_at: null,
          updated_at: "2026-07-29T00:00:00Z",
          backfill: {
            id: "backfill-1",
            state: "Running",
            processedCount: 5,
            addedCount: 4,
          },
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
      backfill: {
        id: "backfill-1",
        state: "Running",
        processedCount: 5,
        addedCount: 4,
      },
    });
  });

  it("strictly decodes Failed backfill Retry and sends one header idempotency key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          podcastId: "podcast-1",
          outcome: "Retried",
          backfill: {
            id: "backfill-2",
            state: "Pending",
            processedCount: 0,
            addedCount: 0,
          },
        },
      }),
    );

    await expect(
      retryPodcastSubscriptionBackfill("podcast-1"),
    ).resolves.toEqual({
      podcastId: "podcast-1",
      outcome: "Retried",
      backfill: {
        id: "backfill-2",
        state: "Pending",
        processedCount: 0,
        addedCount: 0,
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
  });

  it("publishes one Unknown placement change after unsubscribe", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            outcome: "Unsubscribed",
            podcast_id: "podcast-1",
            removed_placement_count: 2,
            retained_shared_count: 1,
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
      outcome: "Unsubscribed",
      podcast_id: "podcast-1",
      removed_placement_count: 2,
      retained_shared_count: 1,
      collectionRevision: 7,
      libraryEntriesCollectionRevision: 11,
    });

    const after = libraryPlacementSnapshot();
    expect(after.revision).toBe(before + 1);
    expect(after.affectedLibraryIds).toBe("Unknown");
  });
});
