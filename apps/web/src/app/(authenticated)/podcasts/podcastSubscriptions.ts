import type { LibraryTargetPickerItem } from "@/lib/media/mediaLibraries";
import { apiFetch } from "@/lib/api/client";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { Presence } from "@/lib/api/presence";
import type { PositiveCount } from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import { decodeOptionalPublicationDate } from "@/lib/dates/publicationDate";
import { decodePodcastUnplayedCount } from "@/lib/podcasts/activityFacts";
import { pluralize } from "@/lib/text/pluralize";
import {
  decodePodcastSyncStatus,
  type PodcastSyncStatus,
} from "@/lib/status/podcastSync";

export type PodcastSubscriptionSyncStatus = PodcastSyncStatus;

export type PodcastSummary = {
  id: string;
  provider: string;
  provider_podcast_id: string;
  title: string;
  contributors: ContributorCredit[];
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};

type PodcastVisibleLibrary = {
  id: string;
  name: string;
  color: string | null;
};

export type PodcastSubscriptionRecord = {
  podcast_id: string;
  status: "active" | "unsubscribed";
  default_playback_speed?: number | null;
  auto_queue?: boolean;
  sync_status: PodcastSubscriptionSyncStatus;
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_started_at: string | null;
  sync_completed_at: string | null;
  last_synced_at: string | null;
  updated_at: string;
};

type PodcastSubscriptionDetail = PodcastSubscriptionRecord & {
  user_id: string;
};

export type PodcastDetailResponse = {
  podcast: PodcastSummary;
  subscription: PodcastSubscriptionDetail | null;
};

export type PodcastSubscriptionListItemWire = PodcastSubscriptionRecord & {
  unplayed_count: number;
  latest_episode_published_at: string | null;
  visible_libraries: PodcastVisibleLibrary[];
  podcast: PodcastSummary;
};

export type PodcastSubscriptionListItem = PodcastSubscriptionListItemWire & {
  unplayedCount: Presence<PositiveCount>;
  publicationDate: Presence<PublicationDate>;
  syncStatus: Presence<PodcastSyncStatus>;
};

export function decodePodcastSubscriptionListItem(
  item: PodcastSubscriptionListItemWire,
): PodcastSubscriptionListItem {
  return {
    ...item,
    unplayedCount: decodePodcastUnplayedCount(item.unplayed_count),
    publicationDate: decodeOptionalPublicationDate(
      item.latest_episode_published_at,
      "podcast latest_episode_published_at",
    ),
    syncStatus: {
      kind: "Present",
      value: decodePodcastSyncStatus(
        item.sync_status,
        "podcast sync_status",
      ),
    },
  };
}

type PodcastLibraryResponseItem = {
  id: string;
  name: string;
  color: string | null;
  is_in_library: boolean;
  can_add: boolean;
  can_remove: boolean;
};

export type PodcastLibraryMembership = LibraryTargetPickerItem & {
  isInLibrary: boolean;
  canAdd: boolean;
  canRemove: boolean;
};

type PodcastSubscriptionSettingsFields = Pick<
  PodcastSubscriptionRecord,
  "default_playback_speed" | "auto_queue"
>;

type PodcastSubscriptionSettingsDraft = {
  defaultSpeed: string;
  autoQueue: boolean;
};

export type PodcastSubscriptionSettingsResponse = {
  podcast_id: string;
  default_playback_speed: number | null;
  auto_queue: boolean;
  updated_at: string;
};

export type PodcastSubscriptionSyncRefreshResult = {
  podcast_id: string;
  sync_status: PodcastSubscriptionSyncStatus;
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_enqueued: boolean;
};

type PodcastSubscribeInput = {
  provider_podcast_id: string;
  title: string;
  contributors: ContributorCredit[];
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
  library_ids: string[];
};

export type PodcastSubscribeResult = {
  podcast_id: string;
  subscription_created: boolean;
  sync_status: PodcastSubscriptionSyncStatus;
  sync_enqueued: boolean;
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  last_synced_at: string | null;
  window_size: number;
};

// v2 subscribe payload (D-4): the strict snake-case `ContributorCreditIn`. The
// server owns ordinal (list order), source, source_ref, and confidence — the
// client sends only the observed credit facts.
type ContributorCreditInput = {
  credited_name: string;
  role: string;
  raw_role?: string;
};

export function toPodcastContributorInputs(
  contributors: ContributorCredit[],
): ContributorCreditInput[] {
  return contributors.map((credit) => {
    const creditedName = credit.credited_name.trim();
    const role = credit.role?.trim();
    if (!creditedName || !role) {
      throw new Error("Contributor credit payload is malformed");
    }

    return {
      credited_name: creditedName,
      role,
      ...(credit.raw_role?.trim() ? { raw_role: credit.raw_role.trim() } : {}),
    };
  });
}

function toPodcastLibraryMembership(
  library: PodcastLibraryResponseItem,
): PodcastLibraryMembership {
  return {
    id: library.id,
    name: library.name,
    color: library.color,
    isInLibrary: library.is_in_library,
    canAdd: library.can_add,
    canRemove: library.can_remove,
  };
}

export async function fetchPodcastLibraries(
  podcastId: string,
): Promise<PodcastLibraryMembership[]> {
  const response = await apiFetch<{ data: PodcastLibraryResponseItem[] }>(
    `/api/podcasts/${podcastId}/libraries`,
  );
  return response.data.map(toPodcastLibraryMembership);
}

export function getPodcastSubscriptionSettingsDraft(
  subscription: PodcastSubscriptionSettingsFields | null | undefined,
): PodcastSubscriptionSettingsDraft {
  return {
    defaultSpeed:
      subscription?.default_playback_speed == null
        ? "default"
        : String(subscription.default_playback_speed),
    autoQueue: Boolean(subscription?.auto_queue),
  };
}

export function parsePodcastSubscriptionDefaultPlaybackSpeed(
  value: string,
): number | null {
  return value === "default" ? null : Number.parseFloat(value);
}

export function getPodcastSubscriptionSyncPatch(
  result: PodcastSubscriptionSyncRefreshResult,
) {
  return {
    sync_status: result.sync_status,
    sync_error_code: result.sync_error_code,
    sync_error_message: result.sync_error_message,
    sync_attempts: result.sync_attempts,
  };
}

export function getPodcastSubscriptionSettingsPatch({
  response,
  updatedAt,
}: {
  response: PodcastSubscriptionSettingsResponse;
  updatedAt: string;
}) {
  return {
    default_playback_speed: response.default_playback_speed,
    auto_queue: response.auto_queue,
    updated_at: response.updated_at ?? updatedAt,
  };
}

export async function addPodcastToLibrary(
  podcastId: string,
  libraryId: string,
): Promise<void> {
  await apiFetch(`/api/libraries/${libraryId}/podcasts`, {
    method: "POST",
    body: JSON.stringify({ podcast_id: podcastId }),
  });
}

export async function removePodcastFromLibrary(
  podcastId: string,
  libraryId: string,
): Promise<void> {
  await apiFetch(`/api/libraries/${libraryId}/podcasts/${podcastId}`, {
    method: "DELETE",
  });
}

export async function refreshPodcastSubscriptionSync(
  podcastId: string,
): Promise<PodcastSubscriptionSyncRefreshResult> {
  const response = await apiFetch<{
    data: PodcastSubscriptionSyncRefreshResult;
  }>(`/api/podcasts/subscriptions/${podcastId}/sync`, { method: "POST" });
  return response.data;
}

export async function savePodcastSubscriptionSettings(
  podcastId: string,
  {
    defaultPlaybackSpeed,
    autoQueue,
  }: {
    defaultPlaybackSpeed: number | null;
    autoQueue: boolean;
  },
): Promise<PodcastSubscriptionSettingsResponse> {
  const response = await apiFetch<{
    data: PodcastSubscriptionSettingsResponse;
  }>(`/api/podcasts/subscriptions/${podcastId}/settings`, {
    method: "PATCH",
    body: JSON.stringify({
      default_playback_speed: defaultPlaybackSpeed,
      auto_queue: autoQueue,
    }),
  });
  return response.data;
}

export async function unsubscribeFromPodcast(podcastId: string): Promise<void> {
  await apiFetch(`/api/podcasts/subscriptions/${podcastId}`, {
    method: "DELETE",
  });
}

export async function subscribeToPodcast(
  input: PodcastSubscribeInput,
): Promise<PodcastSubscribeResult> {
  const response = await apiFetch<{ data: PodcastSubscribeResult }>(
    "/api/podcasts/subscriptions",
    {
      method: "POST",
      body: JSON.stringify({
        ...input,
        contributors: toPodcastContributorInputs(input.contributors),
      }),
    },
  );
  return response.data;
}

export function buildPodcastUnsubscribeConfirmation(
  title: string,
  libraries: PodcastLibraryMembership[],
): string {
  const removableLibraries = libraries.filter(
    (library) => library.isInLibrary && library.canRemove,
  );
  const retainedLibraries = libraries.filter(
    (library) => library.isInLibrary && !library.canRemove,
  );
  const confirmationLines = [
    `Unsubscribe from "${title}"?`,
    removableLibraries.length === 0
      ? "This podcast is not in any libraries you can change."
      : `This will remove the podcast from ${pluralize(removableLibraries.length, "library", "libraries")}.`,
  ];
  if (retainedLibraries.length > 0) {
    confirmationLines.push(
      `It will remain in ${pluralize(retainedLibraries.length, "shared library", "shared libraries")} you cannot administer.`,
    );
  }
  return confirmationLines.join("\n\n");
}
