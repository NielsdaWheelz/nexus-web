"use client";

// Podcast http for the web (docs/modules/podcast.md). Account-memory command
// owners retain exact request identities, publish acknowledgments and invalidate
// reads after uncertainty. Episode discovery and refresh publish at admission.

import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { AcquisitionGuard } from "@/lib/libraries/api";
import { mediaAcquisitionAvailable } from "@/lib/imports/ingest";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { stampedRead, type StampedRead } from "@/lib/consumption/listening";

export type PodcastDetail = Schema<"PodcastDetailOut">;
export type PodcastRow = Schema<"PodcastListItemOut">;
export type PodcastEpisodeRow = Schema<"PodcastEpisodeListItemOut">;
export type PodcastImport = Schema<"PodcastImportOut">;
export type PodcastSection = Schema<"LibraryPodcastsOut">;
export type LibraryPodcast = Schema<"LibraryPodcastOut">;
export type PodcastSettings = Schema<"PodcastPlaybackSettingsOut">;
export type PodcastTarget = Schema<"PodcastImportCreateRequest">["target"];
export type PodcastActionResult = Schema<"PodcastActionResultOut">;
export type PodcastActionResolution = PodcastActionResult["resolution"];
export type PodcastAdmission = Schema<"PodcastAdmissionOut">;
export type PodcastRemovalPreview = Schema<"PodcastRemovalPreviewOut">;
export type EpisodeState = Schema<"PodcastEpisodeSelection">["state"];
export type PodcastRefreshScope =
  | Schema<"PodcastRefreshPodcastScope">
  | Schema<"PodcastRefreshPodcastsScope">
  | Schema<"PodcastRefreshLibraryScope">;

export function podcastTargetKey(target: PodcastTarget): string {
  return JSON.stringify([target.kind, target.kind === "Canonical" ? target.podcast_id : target.target]);
}

/** Local identities and aggregate subscription facts; never calls the directory. */
export async function resolvePodcastActionFacts(
  targets: readonly PodcastTarget[], signal: AbortSignal,
): Promise<PodcastActionResult[]> {
  type Body = ApiJson<"/podcasts/action-facts/resolve", "post">;
  return (await apiFetch<Body>("/api/podcasts/action-facts/resolve", {
    method: "POST", body: JSON.stringify({ targets }), signal,
  })).data.items;
}

/** One page; its metadata is the page's consumption revision (fold with `oldestRevision`). */
export async function listPodcasts(query: URLSearchParams, signal: AbortSignal) {
  type Body = ApiJson<"/podcasts", "get">;
  const { data, consumption_revision } = stampedRead(await apiFetch<Body>(`/api/podcasts?${query}`, { signal }));
  return { ...data, metadata: { consumption_revision } };
}

/** Stamped with its read snapshot's consumption revision; observations reach native. */
export async function getPodcastDetail(podcastId: string, signal: AbortSignal): Promise<StampedRead<PodcastDetail>> {
  type Body = ApiJson<"/podcasts/{podcast_id}", "get">;
  return stampedRead(await apiFetch<Body>(`/api/podcasts/${podcastId}`, { signal }));
}

/** One page; its metadata is the page's consumption revision (fold with `oldestRevision`). */
export async function listEpisodes(podcastId: string, query: URLSearchParams, signal: AbortSignal) {
  type Body = ApiJson<"/podcasts/{podcast_id}/episodes", "get">;
  const { data, consumption_revision } = stampedRead(await apiFetch<Body>(`/api/podcasts/${podcastId}/episodes?${query}`, { signal }));
  return { ...data, metadata: { consumption_revision } };
}

/** Contextless admission reads the default destination's actual revision. */
export async function getDefaultPodcastLibrary(signal: AbortSignal): Promise<string> {
  return (await apiFetch<ApiJson<"/me", "get">>("/api/me", { signal })).data.default_library_id;
}

/** Stamped with its read snapshot's consumption revision (a title-only header: no rows). */
export async function getLibraryPodcasts(libraryId: string, signal: AbortSignal): Promise<StampedRead<PodcastSection>> {
  return stampedRead(await apiFetch<ApiJson<"/libraries/{library_id}/podcasts", "get">>(`/api/libraries/${libraryId}/podcasts`, { signal }));
}

/** Exact selected relationship; the default section is an aggregate, not membership. */
export async function getLibraryPodcast(libraryId: string, podcastId: string, signal: AbortSignal): Promise<LibraryPodcast> {
  return (await apiFetch<ApiJson<"/libraries/{library_id}/podcasts/{podcast_id}", "get">>(`/api/libraries/${libraryId}/podcasts/${podcastId}`, { signal })).data;
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
