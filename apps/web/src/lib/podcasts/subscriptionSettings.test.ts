import { afterEach, describe, expect, it, vi } from "vitest";
import { absent, present } from "@/lib/api/presence";
import {
  savePodcastSubscriptionSettings,
  subscribePodcastSubscriptionSettingsInstalls,
} from "./subscriptionSettings";

function response(defaultPlaybackSpeed: unknown) {
  return {
    data: {
      user_id: "user-1",
      podcast_id: "podcast-1",
      default_playback_speed: defaultPlaybackSpeed,
      auto_queue: true,
      sync_status: "Complete",
      sync_error_code: null,
      sync_error_message: null,
      sync_attempts: 1,
      sync_started_at: null,
      sync_completed_at: null,
      last_checked_at: null,
      updated_at: "2026-07-30T00:00:00Z",
      backfill: {
        id: "backfill-1",
        state: "Complete",
        processedCount: 10,
        addedCount: 8,
      },
      collectionRevision: 7,
      libraryEntriesCollectionRevision: 11,
    },
  };
}

describe("podcast subscription settings client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends owned absence and publishes the strictly decoded install", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(response(absent())));
    const listener = vi.fn();
    const unsubscribe =
      subscribePodcastSubscriptionSettingsInstalls(listener);

    const saved = await savePodcastSubscriptionSettings("podcast-1", {
      defaultPlaybackSpeed: absent(),
      autoQueue: true,
    });
    unsubscribe();

    expect(saved.default_playback_speed).toEqual(absent());
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(saved);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      default_playback_speed: absent(),
      auto_queue: true,
    });
  });

  it("keeps an arbitrary valid rate exact and omits unrelated patch keys", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(response(present(1.85))));

    await expect(
      savePodcastSubscriptionSettings("podcast-1", {
        defaultPlaybackSpeed: present(1.85),
      }),
    ).resolves.toMatchObject({
      podcast_id: "podcast-1",
      default_playback_speed: present(1.85),
    });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      default_playback_speed: present(1.85),
    });
  });

  it("rejects raw nullable response absence without publishing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(response(null)),
    );
    const listener = vi.fn();
    const unsubscribe =
      subscribePodcastSubscriptionSettingsInstalls(listener);

    await expect(
      savePodcastSubscriptionSettings("podcast-1", {
        defaultPlaybackSpeed: absent(),
      }),
    ).rejects.toThrow("Invalid Presence");
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
