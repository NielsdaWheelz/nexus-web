"use client";

import { apiFetch } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { decodePresence, type Presence } from "@/lib/api/presence";
import { parsePlaybackRate } from "@/lib/player/playbackRate";
import {
  decodePodcastSyncStatus,
  type PodcastSyncStatus,
} from "@/lib/podcasts/types";
import {
  expectBoolean,
  expectExactRecord,
  expectNonnegativeInteger,
  expectNullableString,
  expectString,
} from "@/lib/validation";

type PodcastBackfillState =
  | "Pending"
  | "Running"
  | "Complete"
  | "SourceLimited"
  | "Failed";

type PodcastSubscriptionSettingsBackfill = {
  id: string;
  state: PodcastBackfillState;
  processedCount: number;
  addedCount: number;
};

export type PodcastSubscriptionSettingsPatch = {
  defaultPlaybackSpeed?: Presence<number>;
  autoQueue?: boolean;
};

export type PodcastSubscriptionSettingsResponse = {
  user_id: string;
  podcast_id: string;
  default_playback_speed: Presence<number>;
  auto_queue: boolean;
  sync_status: PodcastSyncStatus;
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_started_at: string | null;
  sync_completed_at: string | null;
  last_checked_at: string | null;
  updated_at: string;
  backfill: PodcastSubscriptionSettingsBackfill;
  collectionRevision: CollectionRevision;
  libraryEntriesCollectionRevision: CollectionRevision;
};

const listeners = new Set<
  (settings: PodcastSubscriptionSettingsResponse) => void
>();

function decodeBackfillState(
  raw: unknown,
  context: string,
): PodcastBackfillState {
  const state = expectString(raw, context);
  if (
    state !== "Pending" &&
    state !== "Running" &&
    state !== "Complete" &&
    state !== "SourceLimited" &&
    state !== "Failed"
  ) {
    throw new TypeError(`${context} is invalid`);
  }
  return state;
}

function decodePodcastSubscriptionSettingsResponse(
  raw: unknown,
): PodcastSubscriptionSettingsResponse {
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], "PodcastSubscriptionSettingsResponse")
      .data,
    [
      "user_id",
      "podcast_id",
      "default_playback_speed",
      "auto_queue",
      "sync_status",
      "sync_error_code",
      "sync_error_message",
      "sync_attempts",
      "sync_started_at",
      "sync_completed_at",
      "last_checked_at",
      "updated_at",
      "backfill",
      "collectionRevision",
      "libraryEntriesCollectionRevision",
    ],
    "PodcastSubscriptionSettingsResponse.data",
  );
  const backfill = expectExactRecord(
    data.backfill,
    ["id", "state", "processedCount", "addedCount"],
    "backfill",
  );
  return {
    user_id: expectString(data.user_id, "user_id"),
    podcast_id: expectString(data.podcast_id, "podcast_id"),
    default_playback_speed: decodePresence(
      data.default_playback_speed,
      (value) => parsePlaybackRate(value, "default_playback_speed.value"),
    ),
    auto_queue: expectBoolean(data.auto_queue, "auto_queue"),
    sync_status: decodePodcastSyncStatus(data.sync_status, "sync_status"),
    sync_error_code: expectNullableString(
      data.sync_error_code,
      "sync_error_code",
    ),
    sync_error_message: expectNullableString(
      data.sync_error_message,
      "sync_error_message",
    ),
    sync_attempts: expectNonnegativeInteger(
      data.sync_attempts,
      "sync_attempts",
    ),
    sync_started_at: expectNullableString(
      data.sync_started_at,
      "sync_started_at",
    ),
    sync_completed_at: expectNullableString(
      data.sync_completed_at,
      "sync_completed_at",
    ),
    last_checked_at: expectNullableString(
      data.last_checked_at,
      "last_checked_at",
    ),
    updated_at: expectString(data.updated_at, "updated_at"),
    backfill: {
      id: expectString(backfill.id, "backfill.id"),
      state: decodeBackfillState(backfill.state, "backfill.state"),
      processedCount: expectNonnegativeInteger(
        backfill.processedCount,
        "backfill.processedCount",
      ),
      addedCount: expectNonnegativeInteger(
        backfill.addedCount,
        "backfill.addedCount",
      ),
    },
    collectionRevision: decodeCollectionRevision(data.collectionRevision),
    libraryEntriesCollectionRevision: decodeCollectionRevision(
      data.libraryEntriesCollectionRevision,
    ),
  };
}

export async function savePodcastSubscriptionSettings(
  podcastId: string,
  patch: PodcastSubscriptionSettingsPatch,
): Promise<PodcastSubscriptionSettingsResponse> {
  const body: {
    default_playback_speed?: Presence<number>;
    auto_queue?: boolean;
  } = {};
  if ("defaultPlaybackSpeed" in patch) {
    body.default_playback_speed = patch.defaultPlaybackSpeed;
  }
  if ("autoQueue" in patch) {
    body.auto_queue = patch.autoQueue;
  }

  const settings = decodePodcastSubscriptionSettingsResponse(
    await apiFetch<unknown>(
      `/api/podcasts/subscriptions/${podcastId}/settings`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    ),
  );
  for (const listener of listeners) listener(settings);
  return settings;
}

export function subscribePodcastSubscriptionSettingsInstalls(
  listener: (settings: PodcastSubscriptionSettingsResponse) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
