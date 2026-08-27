"use client";

import { apiFetch, decodeApiPayload } from "@/lib/api/client";
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
  decodePodcastBackfillState,
  decodePodcastSyncStatus,
  type PodcastBackfillState,
  type PodcastSyncStatus,
} from "@/lib/podcasts/types";
import {
  expectBoolean,
  expectExactRecord,
  expectIsoInstant,
  expectNonnegativeInteger,
  expectNullableString,
  expectString,
} from "@/lib/validation";

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

type PodcastSubscriptionStatus = Omit<
  PodcastSubscriptionSettingsResponse,
  "collectionRevision" | "libraryEntriesCollectionRevision"
>;

const PODCAST_SUBSCRIPTION_STATUS_KEYS = [
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
] as const;

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

function decodeNullableIsoInstant(raw: unknown, name: string): string | null {
  return raw === null ? null : expectIsoInstant(raw, name);
}

function decodePodcastSubscriptionStatus(
  data: Record<string, unknown>,
  context: string,
  backfillCountKeys: {
    readonly processed: "processed_count" | "processedCount";
    readonly added: "added_count" | "addedCount";
  },
): PodcastSubscriptionStatus {
  const backfill = expectExactRecord(
    data.backfill,
    ["id", "state", backfillCountKeys.processed, backfillCountKeys.added],
    `${context}.backfill`,
  );
  return {
    user_id: expectString(data.user_id, `${context}.user_id`),
    podcast_id: expectString(data.podcast_id, `${context}.podcast_id`),
    default_playback_speed: decodePresence(
      data.default_playback_speed,
      (value) =>
        parsePlaybackRate(value, `${context}.default_playback_speed.value`),
    ),
    pause_shortening_mode: decodePresence(
      data.pause_shortening_mode,
      (value) =>
        parsePauseShorteningMode(
          value,
          `${context}.pause_shortening_mode.value`,
        ),
    ),
    auto_queue: expectBoolean(data.auto_queue, `${context}.auto_queue`),
    sync_status: decodePodcastSyncStatus(
      data.sync_status,
      `${context}.sync_status`,
    ),
    sync_error_code: expectNullableString(
      data.sync_error_code,
      `${context}.sync_error_code`,
    ),
    sync_error_message: expectNullableString(
      data.sync_error_message,
      `${context}.sync_error_message`,
    ),
    sync_attempts: expectNonnegativeInteger(
      data.sync_attempts,
      `${context}.sync_attempts`,
    ),
    sync_started_at: decodeNullableIsoInstant(
      data.sync_started_at,
      `${context}.sync_started_at`,
    ),
    sync_completed_at: decodeNullableIsoInstant(
      data.sync_completed_at,
      `${context}.sync_completed_at`,
    ),
    last_checked_at: decodeNullableIsoInstant(
      data.last_checked_at,
      `${context}.last_checked_at`,
    ),
    updated_at: expectIsoInstant(data.updated_at, `${context}.updated_at`),
    backfill: {
      id: expectString(backfill.id, `${context}.backfill.id`),
      state: decodePodcastBackfillState(
        backfill.state,
        `${context}.backfill.state`,
      ),
      processedCount: expectNonnegativeInteger(
        backfill[backfillCountKeys.processed],
        `${context}.backfill.${backfillCountKeys.processed}`,
      ),
      addedCount: expectNonnegativeInteger(
        backfill[backfillCountKeys.added],
        `${context}.backfill.${backfillCountKeys.added}`,
      ),
    },
  };
}

function decodePodcastSubscriptionSettingsResponse(
  raw: unknown,
): PodcastSubscriptionSettingsResponse {
  return decodeApiPayload(
    raw,
    (payload) => {
      const data = expectExactRecord(
        expectExactRecord(
          payload,
          ["data"],
          "PodcastSubscriptionSettingsResponse",
        ).data,
        [
          ...PODCAST_SUBSCRIPTION_STATUS_KEYS,
          "collectionRevision",
          "libraryEntriesCollectionRevision",
        ],
        "PodcastSubscriptionSettingsResponse.data",
      );
      return {
        ...decodePodcastSubscriptionStatus(
          data,
          "PodcastSubscriptionSettingsResponse.data",
          { processed: "processedCount", added: "addedCount" },
        ),
        collectionRevision: decodeCollectionRevision(data.collectionRevision),
        libraryEntriesCollectionRevision: decodeCollectionRevision(
          data.libraryEntriesCollectionRevision,
        ),
      };
    },
    "Podcast subscription settings command",
  );
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
  const status = decodeApiPayload(
    raw,
    (payload) => {
      const data = expectExactRecord(
        expectExactRecord(
          payload,
          ["data"],
          "PodcastSubscriptionSettingsSource",
        ).data,
        PODCAST_SUBSCRIPTION_STATUS_KEYS,
        "PodcastSubscriptionSettingsSource.data",
      );
      return decodePodcastSubscriptionStatus(
        data,
        "PodcastSubscriptionSettingsSource.data",
        { processed: "processed_count", added: "added_count" },
      );
    },
    "Podcast subscription settings source",
  );
  return {
    podcast_id: status.podcast_id,
    default_playback_speed: status.default_playback_speed,
    pause_shortening_mode: status.pause_shortening_mode,
    auto_queue: status.auto_queue,
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
