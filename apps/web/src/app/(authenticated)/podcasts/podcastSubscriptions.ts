import type { LibraryTargetPickerItem } from "@/components/LibraryTargetPicker";
import { apiFetch } from "@/lib/api/client";
import type { ContributorCredit } from "@/lib/contributors/types";

export type PodcastSubscriptionSyncStatus =
  | "pending"
  | "running"
  | "partial"
  | "complete"
  | "source_limited"
  | "failed";

export type LibrarySummary = {
  id: string;
  name: string;
  is_default: boolean;
  color?: string | null;
};

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

export type PodcastVisibleLibrary = {
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

export type PodcastSubscriptionDetail = PodcastSubscriptionRecord & {
  user_id: string;
};

export type PodcastDetailResponse = {
  podcast: PodcastSummary;
  subscription: PodcastSubscriptionDetail | null;
};

export type PodcastSubscriptionListItem = PodcastSubscriptionRecord & {
  unplayed_count: number;
  latest_episode_published_at: string | null;
  visible_libraries: PodcastVisibleLibrary[];
  podcast: PodcastSummary;
};

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

export type PodcastSubscriptionSettingsDraft = {
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

export type PodcastSubscribeInput = {
  provider_podcast_id: string;
  title: string;
  contributors: ContributorCredit[];
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
  library_id?: string | null;
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

type ContributorCreditInput = {
  credited_name: string;
  role: string;
  raw_role?: string;
  ordinal?: number;
  source: string;
  source_ref?: Record<string, unknown>;
  confidence?: string | number;
};

export function toPodcastContributorInputs(
  contributors: ContributorCredit[],
): ContributorCreditInput[] {
  return contributors.map((credit) => {
    const creditedName = credit.credited_name.trim();
    const role = credit.role?.trim();
    const source = credit.source?.trim();
    if (!creditedName || !role || !source) {
      throw new Error("Contributor credit payload is malformed");
    }

    return {
      credited_name: creditedName,
      role,
      ...(credit.raw_role?.trim() ? { raw_role: credit.raw_role.trim() } : {}),
      ...(typeof credit.ordinal === "number"
        ? { ordinal: credit.ordinal }
        : {}),
      source,
      ...(credit.source_ref ? { source_ref: credit.source_ref } : {}),
      ...(credit.confidence != null ? { confidence: credit.confidence } : {}),
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

export async function fetchNonDefaultLibraries(): Promise<LibrarySummary[]> {
  const response = await apiFetch<{ data: LibrarySummary[] }>("/api/libraries");
  return response.data.filter((library) => !library.is_default);
}

export async function fetchPodcastLibraries(
  podcastId: string,
): Promise<PodcastLibraryMembership[]> {
  const response = await apiFetch<{ data: PodcastLibraryResponseItem[] }>(
    `/api/podcasts/${podcastId}/libraries`,
  );
  return response.data.map(toPodcastLibraryMembership);
}

export function updatePodcastLibraryMemberships(
  libraries: PodcastLibraryMembership[],
  {
    libraryId,
    isInLibrary,
  }: {
    libraryId: string;
    isInLibrary: boolean;
  },
): PodcastLibraryMembership[] {
  return libraries.map((library) =>
    library.id === libraryId
      ? {
          ...library,
          isInLibrary,
          canAdd: !isInLibrary,
          canRemove: isInLibrary,
        }
      : library,
  );
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
      : `This will remove the podcast from ${removableLibraries.length} librar${removableLibraries.length === 1 ? "y" : "ies"}.`,
  ];
  if (retainedLibraries.length > 0) {
    confirmationLines.push(
      `It will remain in ${retainedLibraries.length} shared librar${retainedLibraries.length === 1 ? "y" : "ies"} you cannot administer.`,
    );
  }
  return confirmationLines.join("\n\n");
}
