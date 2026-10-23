"use client";

// Podcast http for the web (docs/modules/podcast.md). Every podcast write
// publishes after success, except episode-wide commands: their account-memory
// owner publishes acknowledgment or requests rereads after uncertainty.

import { apiFetch, isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { openStream } from "@/lib/api/stream";
import { placements, type AcquisitionGuard } from "@/lib/libraries/api";
import { mediaAcquisitionAvailable } from "@/lib/imports/ingest";
import type { ApiJson, Schema } from "@/lib/api/wire";

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

/** Observe one subscription's sync and backfill until it is terminal. */
export function observeSubscription(
  podcastId: string,
  signal: AbortSignal,
  onState: (snapshot: PodcastLifecycle) => void,
  onLost: (error: Error) => void,
): void {
  type Frame = { readonly type: string; readonly data: PodcastLifecycle };
  openStream<Frame, PodcastLifecycle>({
    path: `/api/stream/podcast-subscriptions/${encodeURIComponent(podcastId)}/events`,
    signal,
    decode: (type, data) => ({ type, data }),
    isTerminal: (frame) => frame.type === "done",
    onEvent: (frame) => {
      onState(frame.data);
    },
    onError: onLost,
  });
}

export async function subscribeToPodcast(input: {
  readonly target: Schema<"PodcastSubscribeRequest">["target"];
  readonly guard: AcquisitionGuard;
  /** Confirms that the show replaces episodes a destination files directly. */
  readonly replaceEpisodes: boolean;
}): Promise<ApiJson<"/podcasts/subscriptions", "post">["data"] & { available: boolean }> {
  const { target, guard, replaceEpisodes } = input;
  type Body = ApiJson<"/podcasts/subscriptions", "post">;
  const response = await apiFetch<Body>("/api/podcasts/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      target,
      ...guard,
      replace_episodes: replaceEpisodes,
    }),
  });
  publishChange("Podcasts", "Entries");
  let available = true;
  try {
    await getSubscription(response.data.podcast_id, AbortSignal.timeout(30_000));
    await placements({ kind: "Podcast", id: response.data.podcast_id });
  } catch (error) {
    if (isApiError(error) && error.status === 404) available = false;
    else throw error;
  }
  return { ...response.data, available };
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

export async function unsubscribeFromPodcast(podcastId: string): Promise<void> {
  await apiFetch(`/api/podcasts/subscriptions/${podcastId}`, {
    method: "DELETE",
  });
  publishChange("Podcasts", "Entries");
}

/** A retry captures its traversal: repeats cannot replace a newer repair. */
export async function retryPodcastSubscriptionBackfill(
  podcastId: string,
  expectedBackfillId: string,
): Promise<ApiJson<"/podcasts/subscriptions/{podcast_id}/backfill/retry", "post">["data"]> {
  type Body = ApiJson<"/podcasts/subscriptions/{podcast_id}/backfill/retry", "post">;
  const response = await apiFetch<Body>(`/api/podcasts/subscriptions/${podcastId}/backfill/retry`, {
    method: "POST",
    body: JSON.stringify({ expected_backfill_id: expectedBackfillId }),
  });
  publishChange("Podcasts");
  return response.data;
}

/** Save one captured pair/version. An exact accepted replay is inert. */
export async function savePodcastSubscriptionSettings(
  podcastId: string,
  patch: Schema<"PodcastSubscriptionSettingsPatchRequest">,
): Promise<PodcastSubscription> {
  type Body = ApiJson<"/podcasts/subscriptions/{podcast_id}/settings", "patch">;
  const response = await apiFetch<Body>(`/api/podcasts/subscriptions/${podcastId}/settings`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  publishChange("Podcasts");
  return response.data;
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
