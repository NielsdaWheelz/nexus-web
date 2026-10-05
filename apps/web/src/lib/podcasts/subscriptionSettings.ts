"use client";

import { apiFetch } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  ZERO_REVISION,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import type { ApiJson } from "@/lib/api/wire";
import type { PauseShorteningMode } from "@/lib/player/playbackRate";

export type PodcastSubscriptionSettingsPatch = {
  defaultPlaybackSpeed?: Presence<number>;
  pauseShorteningMode?: Presence<PauseShorteningMode>;
  autoQueue?: boolean;
};

export type PodcastSubscriptionSettingsResponse =
  ApiJson<"/podcasts/subscriptions/{podcast_id}/settings", "patch">["data"] & {
    readonly collectionRevision: CollectionRevision;
    readonly libraryEntriesCollectionRevision: CollectionRevision;
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

const confirmedLibraryEntriesRevisions = new Map<string, CollectionRevision>();

export function confirmedLibraryEntriesRevision(accountId: string): CollectionRevision {
  return confirmedLibraryEntriesRevisions.get(accountId) ?? ZERO_REVISION;
}

async function publishInstall(
  install: PodcastSubscriptionSettingsInstall,
): Promise<void> {
  if (install.kind === "Settings") {
    const { user_id, libraryEntriesCollectionRevision } = install.settings;
    if (libraryEntriesCollectionRevision > confirmedLibraryEntriesRevision(user_id)) {
      confirmedLibraryEntriesRevisions.set(user_id, libraryEntriesCollectionRevision);
    }
  }
  await Promise.all(
    [...listeners].map((listener) => listener(install)),
  );
}

export type PodcastSubscriptionSettingsSource = Pick<
  ApiJson<"/podcasts/subscriptions/{podcast_id}", "get">["data"],
  "podcast_id" | "default_playback_speed" | "pause_shortening_mode" | "auto_queue"
>;

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
  const status = (
    await apiFetch<ApiJson<"/podcasts/subscriptions/{podcast_id}", "get">>(
      `/api/podcasts/subscriptions/${podcastId}`,
      { signal },
    )
  ).data;
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
    const wire = (
      await apiFetch<
        ApiJson<"/podcasts/subscriptions/{podcast_id}/settings", "patch">
      >(
        `/api/podcasts/subscriptions/${podcastId}/settings`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      )
    ).data;
    const settings: PodcastSubscriptionSettingsResponse = {
      ...wire,
      collectionRevision: decodeCollectionRevision(wire.collectionRevision),
      libraryEntriesCollectionRevision: decodeCollectionRevision(
        wire.libraryEntriesCollectionRevision,
      ),
    };
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
