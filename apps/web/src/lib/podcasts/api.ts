"use client";

// Podcast http for the web (docs/modules/podcast.md). Account-memory command
// owners retain exact request identities, publish acknowledgments and invalidate
// reads after uncertainty. Episode discovery and refresh publish at admission.

import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { AcquisitionGuard } from "@/lib/libraries/api";
import { mediaAcquisitionAvailable } from "@/lib/imports/ingest";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type PodcastDetail = Schema<"PodcastDetailOut">;
export type PodcastRow = Schema<"PodcastListItemOut">;
export type PodcastEpisodeRow = Schema<"PodcastEpisodeListItemOut">;
export type PodcastImport = Schema<"PodcastImportOut">;
export type PodcastSection = Schema<"LibraryPodcastsOut">;
export type PodcastSettings = Schema<"PodcastPlaybackSettingsOut">;
export type PodcastTarget = Schema<"PodcastImportCreateRequest">["target"];
export type PodcastAdmission = Schema<"PodcastAdmissionOut">;
export type PodcastRemovalPreview = Schema<"PodcastRemovalPreviewOut">;
export type EpisodeState = Schema<"PodcastEpisodeSelection">["state"];
export type PodcastRefreshScope =
  | Schema<"PodcastRefreshPodcastScope">
  | Schema<"PodcastRefreshPodcastsScope">
  | Schema<"PodcastRefreshLibraryScope">;

export async function listPodcasts(
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<ApiJson<"/podcasts", "get">["data"]> {
  const path = `/api/podcasts?${query}` as const;
  type Body = ApiJson<"/podcasts", "get">;
  return (await apiFetch<Body>(path, { signal })).data;
}

export async function getPodcastDetail(
  podcastId: string,
  signal: AbortSignal,
): Promise<PodcastDetail> {
  type Body = ApiJson<"/podcasts/{podcast_id}", "get">;
  return (await apiFetch<Body>(`/api/podcasts/${podcastId}`, { signal })).data;
}

export async function listEpisodes(
  podcastId: string,
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<ApiJson<"/podcasts/{podcast_id}/episodes", "get">["data"]> {
  const path = `/api/podcasts/${podcastId}/episodes?${query}` as const;
  type Body = ApiJson<"/podcasts/{podcast_id}/episodes", "get">;
  return (await apiFetch<Body>(path, { signal })).data;
}

/** Contextless admission reads the default destination's actual revision. */
export async function getDefaultPodcastLibrary(signal: AbortSignal): Promise<string> {
  return (await apiFetch<ApiJson<"/me", "get">>("/api/me", { signal })).data.default_library_id;
}

export async function getLibraryPodcasts(libraryId: string, signal: AbortSignal): Promise<PodcastSection> {
  return (await apiFetch<ApiJson<"/libraries/{library_id}/podcasts", "get">>(`/api/libraries/${libraryId}/podcasts`, { signal })).data;
}

export async function getPodcastImport(libraryId: string, importId: string, signal: AbortSignal): Promise<PodcastImport> {
  return (await apiFetch<ApiJson<"/libraries/{library_id}/podcast-imports/{import_id}", "get">>(`/api/libraries/${libraryId}/podcast-imports/${importId}`, { signal })).data;
}

/** Transport only. Account commands retain client ids and frozen guards. */
export async function admitPodcast(libraryId: string, mode: "follow" | "current_episodes", body: string, signal: AbortSignal): Promise<PodcastAdmission> {
  const path = mode === "follow" ? `/api/libraries/${libraryId}/podcast-subscriptions` as const : `/api/libraries/${libraryId}/podcast-imports` as const;
  return (await apiFetch<{ data: PodcastAdmission }>(path, { method: "POST", body, signal })).data;
}

export async function changePodcastImport(libraryId: string, importId: string, action: "cancel" | "retry", body: string, signal: AbortSignal): Promise<PodcastImport> {
  return (await apiFetch<{ data: PodcastImport }>(`/api/libraries/${libraryId}/podcast-imports/${importId}/${action}`, { method: "POST", body, signal })).data;
}

export async function getPodcastRemovalPreview(podcastId: string, scope: "all" | "library", episodes: "keep" | "remove", libraryId: string | null, signal: AbortSignal): Promise<PodcastRemovalPreview> {
  const query = new URLSearchParams({ scope, episodes });
  if (libraryId !== null) query.set("library_id", libraryId);
  return (await apiFetch<ApiJson<"/podcasts/{podcast_id}/removal-preview", "get">>(`/api/podcasts/${podcastId}/removal-preview?${query}`, { signal })).data;
}

export async function stopPodcast(podcastId: string, body: string, signal: AbortSignal): Promise<Schema<"PodcastStopOut">> {
  return (await apiFetch<ApiJson<"/podcasts/{podcast_id}/stop", "post">>(`/api/podcasts/${podcastId}/stop`, { method: "POST", body, signal })).data;
}

export async function getPodcastSettings(podcastId: string, signal: AbortSignal): Promise<PodcastSettings> {
  return (await apiFetch<ApiJson<"/podcasts/{podcast_id}/settings", "get">>(`/api/podcasts/${podcastId}/settings`, { signal })).data;
}

/** Exact desired pair retries are inert; changing a pair requires its captured version. */
export async function savePodcastSettings(podcastId: string, patch: Schema<"PodcastPlaybackSettingsRequest">, signal?: AbortSignal): Promise<PodcastSettings> {
  const result = (await apiFetch<ApiJson<"/podcasts/{podcast_id}/settings", "put">>(`/api/podcasts/${podcastId}/settings`, { method: "PUT", body: JSON.stringify(patch), signal })).data;
  publishChange("Podcasts");
  return result;
}

export async function addEpisodeFromDiscovery(input: {
  readonly target: string;
  readonly guard: AcquisitionGuard;
  readonly signal?: AbortSignal;
  readonly onAccepted?: (receipt: ApiJson<"/podcast-episodes/from-discovery", "post">["data"]) => void;
}): Promise<ApiJson<"/podcast-episodes/from-discovery", "post">["data"] & { available: boolean }> {
  const { target, guard } = input;
  type Body = ApiJson<"/podcast-episodes/from-discovery", "post">;
  const response = await apiFetch<Body>(
    "/api/podcast-episodes/from-discovery",
    {
      method: "POST",
      body: JSON.stringify({ target, ...guard }),
      signal: input.signal,
    },
  );
  publishChange("Entries");
  input.onAccepted?.(response.data);
  return { ...response.data, available: await mediaAcquisitionAvailable(response.data.media_id, input.signal) };
}

/** Admits a refresh of every subscription in scope; returns how many. */
export async function requestPodcastRefresh(
  scope: PodcastRefreshScope,
  signal?: AbortSignal,
): Promise<number> {
  type Body = ApiJson<"/podcasts/refresh", "post">;
  const response = await apiFetch<Body>("/api/podcasts/refresh", {
    method: "POST",
    body: JSON.stringify(scope),
    signal,
  });
  publishChange("Podcasts");
  return response.data.requested_count;
}

export function podcastRefreshRequestAnnouncement(count: number): string {
  return count === 0
    ? "Nothing to refresh"
    : `Refresh requested for ${count} show${count === 1 ? "" : "s"}`;
}

/** Read-only snapshot; apply retries use these exact observed versions. */
export async function prepareEpisodeConsumption(
  podcastId: string, state: EpisodeState, signal: AbortSignal,
): Promise<Schema<"PodcastEpisodeConsumptionPreparedOut">> {
  return (await apiFetch<ApiJson<"/podcasts/{podcast_id}/episodes/consumption/prepare", "post">>(
    `/api/podcasts/${podcastId}/episodes/consumption/prepare`,
    { method: "POST", body: JSON.stringify({ state }), signal },
  )).data;
}

/** Transport only. The account command owner retains exact retry bytes and publishes outcomes. */
export async function applyEpisodeConsumption(podcastId: string, body: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/podcasts/{podcast_id}/episodes/consumption", "put">>(
    `/api/podcasts/${podcastId}/episodes/consumption`, { method: "PUT", body, signal },
  )).data;
}

const transcriptTarget = (podcastId: string, state: EpisodeState) => ({
  kind: "PodcastEpisodeQuery",
  podcast_id: podcastId,
  selection: { state },
  reason: "search",
});

export async function forecastEpisodeTranscripts(
  podcastId: string,
  state: EpisodeState,
  signal: AbortSignal,
): Promise<ApiJson<"/media/transcript/forecasts", "post">["data"]> {
  type Body = ApiJson<"/media/transcript/forecasts", "post">;
  const response = await apiFetch<Body>("/api/media/transcript/forecasts", {
    method: "POST",
    body: JSON.stringify(transcriptTarget(podcastId, state)),
    signal,
  });
  return response.data;
}

/** Transport only; a lost batch acknowledgment cannot safely replay its fingerprint. */
export async function requestEpisodeTranscripts(body: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/media/transcript/request/batch", "post">>(
    "/api/media/transcript/request/batch", { method: "POST", body, signal },
  )).data;
}
