"use client";

import { apiFetch } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { decodePresence, type Presence } from "@/lib/api/presence";
import { parsePlaybackRate } from "@/lib/player/playbackRate";
import {
  parsePauseShorteningMode,
  type PauseShorteningMode,
} from "@/lib/player/pauseShortening";
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
  pauseShorteningMode?: Presence<PauseShorteningMode>;
  autoQueue?: boolean;
};

export type PodcastSubscriptionSettingsResponse = {
  user_id: string;
  podcast_id: string;
  default_playback_speed: Presence<number>;
  pause_shortening_mode: Presence<PauseShorteningMode>;
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

export type PodcastSubscriptionSettingsInstall =
  | {
      kind: "Settings";
      settings: PodcastSubscriptionSettingsResponse;
      owner: object | null;
    }
  | { kind: "Unsubscribed"; podcastId: string; owner: null };

const listeners = new Set<
  (
    install: PodcastSubscriptionSettingsInstall,
  ) => void | Promise<void>
>();
let settingsMutationTail: Promise<void> = Promise.resolve();

export function runPodcastSubscriptionSettingsMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = settingsMutationTail
    .catch(() => {})
    .then(operation);
  settingsMutationTail = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function publishInstall(
  install: PodcastSubscriptionSettingsInstall,
): Promise<void> {
  await Promise.all(
    [...listeners].map((listener) => listener(install)),
  );
}

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
      "pause_shortening_mode",
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
    pause_shortening_mode: decodePresence(
      data.pause_shortening_mode,
      (value) =>
        parsePauseShorteningMode(value, "pause_shortening_mode.value"),
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

export interface PodcastSubscriptionSettingsSource {
  readonly podcast_id: string;
  readonly default_playback_speed: Presence<number>;
  readonly pause_shortening_mode: Presence<PauseShorteningMode>;
  readonly auto_queue: boolean;
}

/**
 * Read just the editable subscription-settings fields for one podcast. The app
 * resource-action runtime opens the settings overlay with only a podcast id, so
 * the overlay self-loads its current values here (mirroring how the share
 * overlay self-loads its snapshot) rather than receiving them from a caller.
 */
export async function fetchPodcastSubscriptionSettingsSource(
  podcastId: string,
  signal?: AbortSignal,
): Promise<PodcastSubscriptionSettingsSource> {
  const raw = await apiFetch<unknown>(
    `/api/podcasts/subscriptions/${podcastId}`,
    { signal },
  );
  if (typeof raw !== "object" || raw === null || !("data" in raw)) {
    throw new TypeError("PodcastSubscriptionSettingsSource envelope is invalid");
  }
  const data = (raw as { data: unknown }).data;
  if (typeof data !== "object" || data === null) {
    throw new TypeError("PodcastSubscriptionSettingsSource.data is invalid");
  }
  const record = data as Record<string, unknown>;
  return {
    podcast_id: expectString(record.podcast_id, "podcast_id"),
    default_playback_speed: decodePresence(record.default_playback_speed, (value) =>
      parsePlaybackRate(value, "default_playback_speed.value"),
    ),
    pause_shortening_mode: decodePresence(record.pause_shortening_mode, (value) =>
      parsePauseShorteningMode(value, "pause_shortening_mode.value"),
    ),
    auto_queue: expectBoolean(record.auto_queue, "auto_queue"),
  };
}

export async function savePodcastSubscriptionSettings(
  podcastId: string,
  patch: PodcastSubscriptionSettingsPatch,
  options: { installOwner?: object } = {},
): Promise<PodcastSubscriptionSettingsResponse> {
  const body: {
    default_playback_speed?: Presence<number>;
    pause_shortening_mode?: Presence<PauseShorteningMode>;
    auto_queue?: boolean;
  } = {};
  if ("defaultPlaybackSpeed" in patch) {
    body.default_playback_speed = patch.defaultPlaybackSpeed;
  }
  if ("pauseShorteningMode" in patch) {
    body.pause_shortening_mode = patch.pauseShorteningMode;
  }
  if ("autoQueue" in patch) {
    body.auto_queue = patch.autoQueue;
  }

  return runPodcastSubscriptionSettingsMutation(async () => {
    const settings = decodePodcastSubscriptionSettingsResponse(
      await apiFetch<unknown>(
        `/api/podcasts/subscriptions/${podcastId}/settings`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      ),
    );
    await publishInstall({
      kind: "Settings",
      settings,
      owner: options.installOwner ?? null,
    });
    return settings;
  });
}

export async function publishPodcastSubscriptionUnsubscribed(
  podcastId: string,
): Promise<void> {
  await publishInstall({ kind: "Unsubscribed", podcastId, owner: null });
}

export function subscribePodcastSubscriptionSettingsInstalls(
  listener: (
    install: PodcastSubscriptionSettingsInstall,
  ) => void | Promise<void>,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
