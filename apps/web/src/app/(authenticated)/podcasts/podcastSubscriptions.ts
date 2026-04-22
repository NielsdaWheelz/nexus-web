import type { LibraryTargetPickerItem } from "@/components/LibraryTargetPicker";
import { apiFetch } from "@/lib/api/client";

export type PodcastSubscriptionSyncStatus =
  | "pending"
  | "running"
  | "partial"
  | "complete"
  | "source_limited"
  | "failed";

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
  author: string | null;
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

function toPodcastLibraryMembership(
  library: PodcastLibraryResponseItem
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
  podcastId: string
): Promise<PodcastLibraryMembership[]> {
  const response = await apiFetch<{ data: PodcastLibraryResponseItem[] }>(
    `/api/podcasts/${podcastId}/libraries`
  );
  return response.data.map(toPodcastLibraryMembership);
}

export async function addPodcastToLibrary(
  podcastId: string,
  libraryId: string
): Promise<void> {
  await apiFetch(`/api/libraries/${libraryId}/podcasts`, {
    method: "POST",
    body: JSON.stringify({ podcast_id: podcastId }),
  });
}

export async function removePodcastFromLibrary(
  podcastId: string,
  libraryId: string
): Promise<void> {
  await apiFetch(`/api/libraries/${libraryId}/podcasts/${podcastId}`, {
    method: "DELETE",
  });
}

export async function refreshPodcastSubscriptionSync(
  podcastId: string
): Promise<PodcastSubscriptionSyncRefreshResult> {
  const response = await apiFetch<{ data: PodcastSubscriptionSyncRefreshResult }>(
    `/api/podcasts/subscriptions/${podcastId}/sync`,
    { method: "POST" }
  );
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
  }
): Promise<PodcastSubscriptionSettingsResponse> {
  const response = await apiFetch<{ data: PodcastSubscriptionSettingsResponse }>(
    `/api/podcasts/subscriptions/${podcastId}/settings`,
    {
      method: "PATCH",
      body: JSON.stringify({
        default_playback_speed: defaultPlaybackSpeed,
        auto_queue: autoQueue,
      }),
    }
  );
  return response.data;
}

export async function unsubscribeFromPodcast(podcastId: string): Promise<void> {
  await apiFetch(`/api/podcasts/subscriptions/${podcastId}`, {
    method: "DELETE",
  });
}

export async function subscribeToPodcast(
  input: PodcastSubscribeInput
): Promise<PodcastSubscribeResult> {
  const response = await apiFetch<{ data: PodcastSubscribeResult }>(
    "/api/podcasts/subscriptions",
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  return response.data;
}

export function buildPodcastUnsubscribeConfirmation(
  title: string,
  libraries: PodcastLibraryMembership[]
): string {
  const removableLibraries = libraries.filter(
    (library) => library.isInLibrary && library.canRemove
  );
  const retainedLibraries = libraries.filter(
    (library) => library.isInLibrary && !library.canRemove
  );
  const confirmationLines = [
    `Unsubscribe from "${title}"?`,
    removableLibraries.length === 0
      ? "This podcast is not in any libraries you can change."
      : `This will remove the podcast from ${removableLibraries.length} librar${removableLibraries.length === 1 ? "y" : "ies"}.`,
  ];
  if (retainedLibraries.length > 0) {
    confirmationLines.push(
      `It will remain in ${retainedLibraries.length} shared librar${retainedLibraries.length === 1 ? "y" : "ies"} you cannot administer.`
    );
  }
  return confirmationLines.join("\n\n");
}
