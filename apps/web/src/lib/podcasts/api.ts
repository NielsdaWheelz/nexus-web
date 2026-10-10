"use client";

// Podcast http for the web (docs/modules/podcast.md). Every podcast write
// here bumps one process-local revision after success; podcast panes put it
// in their refetch token, so they refetch after a podcast change made from
// anywhere (a pane, a resource action, the settings overlay, the player).

import { useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import { sseClientDirect } from "@/lib/api/sse-client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";

export type PodcastDetail = Schema<"PodcastDetailOut">;
export type PodcastSubscription = Schema<"PodcastSubscriptionStatusOut">;
export type PodcastSubscriptionRow = Schema<"PodcastSubscriptionListItemOut">;
export type PodcastEpisodeRow = Schema<"PodcastEpisodeListItemOut">;
export type PodcastLifecycle =
  Schema<"PodcastSubscriptionLifecycleSnapshotOut">;
export type EpisodeState = Schema<"PodcastEpisodeSelection">["state"];
export type PodcastRefreshScope =
  | Schema<"PodcastRefreshPodcastScope">
  | Schema<"PodcastRefreshPodcastsScope">
  | Schema<"PodcastRefreshLibraryScope">;

let revision = 0;
const listeners = new Set<() => void>();

function bump(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribeRevision(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePodcastRevision(): number {
  return useSyncExternalStore(
    subscribeRevision,
    () => revision,
    () => 0,
  );
}

export async function listSubscriptions(
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<ApiJson<"/podcasts/subscriptions", "get">["data"]> {
  const path = `/api/podcasts/subscriptions?${query}` as const;
  type Body = ApiJson<"/podcasts/subscriptions", "get">;
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

export async function getSubscription(
  podcastId: string,
  signal: AbortSignal,
): Promise<PodcastSubscription> {
  const path = `/api/podcasts/subscriptions/${podcastId}` as const;
  type Body = ApiJson<"/podcasts/subscriptions/{podcast_id}", "get">;
  return (await apiFetch<Body>(path, { signal })).data;
}

/** An episode's show notes, read once when its row first expands. */
export async function getShowNotes(mediaId: string): Promise<string | null> {
  type Body = ApiJson<"/media/{media_id}", "get">;
  return (await apiFetch<Body>(`/api/media/${mediaId}`)).data.description_text;
}

/** Observe one subscription's sync and backfill until it is terminal. */
export function observeSubscription(
  podcastId: string,
  signal: AbortSignal,
  onState: (snapshot: PodcastLifecycle) => void,
  onLost: (error: Error) => void,
): void {
  type Frame = { readonly type: string; readonly data: PodcastLifecycle };
  sseClientDirect<Frame, PodcastLifecycle>({
    path: `/stream/podcast-subscriptions/${podcastId}/events`,
    signal,
    decode: (type, data) => ({ type, data }),
    isTerminal: (frame) => frame.type === "done",
    onEvent: (frame) => onState(frame.data),
    onError: onLost,
  });
}

export async function subscribeToPodcast(input: {
  readonly target: Schema<"PodcastSubscribeRequest">["target"];
  readonly namedLibraryIds: readonly string[];
  readonly replacementConfirmation: Presence<{
    readonly conflictFingerprint: string;
  }>;
}): Promise<ApiJson<"/podcasts/subscriptions", "post">["data"]> {
  const { target, namedLibraryIds, replacementConfirmation } = input;
  type Body = ApiJson<"/podcasts/subscriptions", "post">;
  const response = await apiFetch<Body>("/api/podcasts/subscriptions", {
    method: "POST",
    body: JSON.stringify({ target, namedLibraryIds, replacementConfirmation }),
  });
  const named = [...input.namedLibraryIds];
  publishLibraryPlacementChange(named.length > 0 ? named : "Unknown");
  bump();
  return response.data;
}

export async function addEpisodeFromDiscovery(input: {
  readonly target: string;
  readonly namedLibraryIds: readonly string[];
}): Promise<ApiJson<"/podcast-episodes/from-discovery", "post">["data"]> {
  const { target, namedLibraryIds } = input;
  type Body = ApiJson<"/podcast-episodes/from-discovery", "post">;
  const response = await apiFetch<Body>(
    "/api/podcast-episodes/from-discovery",
    {
      method: "POST",
      body: JSON.stringify({ target, namedLibraryIds }),
    },
  );
  publishLibraryPlacementChange([...input.namedLibraryIds]);
  return response.data;
}

export async function unsubscribeFromPodcast(podcastId: string): Promise<void> {
  await apiFetch(`/api/podcasts/subscriptions/${podcastId}`, {
    method: "DELETE",
  });
  publishLibraryPlacementChange("Unknown");
  bump();
}

export async function retryPodcastSubscriptionBackfill(
  podcastId: string,
): Promise<void> {
  await apiFetch(`/api/podcasts/subscriptions/${podcastId}/backfill/retry`, {
    method: "POST",
  });
  bump();
}

export async function savePodcastSubscriptionSettings(
  podcastId: string,
  patch: Schema<"PodcastSubscriptionSettingsPatchRequest">,
): Promise<void> {
  await apiFetch(`/api/podcasts/subscriptions/${podcastId}/settings`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  bump();
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
  bump();
  return response.data.requestedCount;
}

export function podcastRefreshRequestAnnouncement(count: number): string {
  return count === 0
    ? "Nothing to refresh"
    : `Refresh requested for ${count} show${count === 1 ? "" : "s"}`;
}

export async function markEpisodesPlayed(
  podcastId: string,
  state: EpisodeState,
): Promise<void> {
  await apiFetch(`/api/podcasts/${podcastId}/episodes/mark-played`, {
    method: "POST",
    body: JSON.stringify({ state }),
  });
  bump();
}

const transcriptTarget = (podcastId: string, state: EpisodeState) => ({
  kind: "PodcastEpisodeQuery",
  podcastId,
  selection: { state },
  reason: "search",
});

export async function forecastEpisodeTranscripts(
  podcastId: string,
  state: EpisodeState,
): Promise<ApiJson<"/media/transcript/forecasts", "post">["data"]> {
  type Body = ApiJson<"/media/transcript/forecasts", "post">;
  const response = await apiFetch<Body>("/api/media/transcript/forecasts", {
    method: "POST",
    body: JSON.stringify(transcriptTarget(podcastId, state)),
  });
  return response.data;
}

export async function requestEpisodeTranscripts(
  podcastId: string,
  state: EpisodeState,
  selectionFingerprint: string,
): Promise<ApiJson<"/media/transcript/request/batch", "post">["data"]> {
  const target = transcriptTarget(podcastId, state);
  type Body = ApiJson<"/media/transcript/request/batch", "post">;
  const response = await apiFetch<Body>("/api/media/transcript/request/batch", {
    method: "POST",
    body: JSON.stringify({ target, selectionFingerprint }),
  });
  bump();
  return response.data;
}
