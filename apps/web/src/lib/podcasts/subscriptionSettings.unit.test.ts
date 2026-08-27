import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/client";
import {
  fetchPodcastSubscriptionSettingsSource,
  savePodcastSubscriptionSettings,
  subscribePodcastSubscriptionSettingsInstalls,
} from "@/lib/podcasts/subscriptionSettings";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PODCAST_ID = "22222222-2222-4222-8222-222222222222";
const BACKFILL_ID = "33333333-3333-4333-8333-333333333333";

function statusData() {
  return {
    user_id: USER_ID,
    podcast_id: PODCAST_ID,
    default_playback_speed: { kind: "Present", value: 1.25 },
    pause_shortening_mode: { kind: "Present", value: "Natural" },
    auto_queue: true,
    sync_status: "Complete",
    sync_error_code: null,
    sync_error_message: null,
    sync_attempts: 1,
    sync_started_at: "2026-08-25T10:00:00Z",
    sync_completed_at: "2026-08-25T10:00:01Z",
    last_checked_at: "2026-08-25T10:00:01Z",
    updated_at: "2026-08-25T10:00:01Z",
    backfill: {
      id: BACKFILL_ID,
      state: "Complete",
      processed_count: 4,
      added_count: 3,
    },
  };
}

function settingsData() {
  const status = statusData();
  return {
    ...status,
    backfill: {
      id: status.backfill.id,
      state: status.backfill.state,
      processedCount: status.backfill.processed_count,
      addedCount: status.backfill.added_count,
    },
    collectionRevision: 7,
    libraryEntriesCollectionRevision: 11,
  };
}

function invalidResponse(): ApiError {
  return expect.objectContaining({
    name: "ApiError",
    code: "E_INVALID_RESPONSE",
  }) as ApiError;
}

describe("Podcast subscription settings transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("strictly decodes the complete subscription status before projecting editable fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: statusData() })),
    );

    await expect(
      fetchPodcastSubscriptionSettingsSource(PODCAST_ID),
    ).resolves.toEqual({
      podcast_id: PODCAST_ID,
      default_playback_speed: { kind: "Present", value: 1.25 },
      pause_shortening_mode: { kind: "Present", value: "Natural" },
      auto_queue: true,
    });
  });

  it("rejects extra envelope data and malformed status fields the editor does not render", async () => {
    const responses = [
      { data: statusData(), compatibility: true },
      { data: { ...statusData(), compatibility: true } },
      {
        data: {
          ...statusData(),
          sync_status: undefined,
        },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(responses.shift())),
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        fetchPodcastSubscriptionSettingsSource(PODCAST_ID),
      ).rejects.toEqual(invalidResponse());
    }
  });

  it("publishes one canonical install after a settings command succeeds", async () => {
    const installs: unknown[] = [];
    const unsubscribe = subscribePodcastSubscriptionSettingsInstalls(
      (install) => {
        installs.push(install);
      },
    );
    let requestBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        return Response.json({ data: settingsData() });
      }),
    );

    try {
      const settings = await savePodcastSubscriptionSettings(PODCAST_ID, {
        defaultPlaybackSpeed: { kind: "Present", value: 1.25 },
        pauseShorteningMode: { kind: "Present", value: "Natural" },
        autoQueue: true,
      });

      expect(requestBody).toEqual({
        default_playback_speed: { kind: "Present", value: 1.25 },
        pause_shortening_mode: { kind: "Present", value: "Natural" },
        auto_queue: true,
      });
      expect(installs).toEqual([
        { kind: "Settings", settings, owner: null },
      ]);
    } finally {
      unsubscribe();
    }
  });
});
