"use client";
/** Podcast-only playback, audio resolution and transcript commands. */
import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson, Schema } from "@/lib/api/wire";
export type PodcastSettings = Schema<"PodcastPlaybackSettingsOut">;
export type EpisodeState = Schema<"PodcastEpisodeSelection">["state"];
export async function getPodcastSettings(podcastId: string, signal: AbortSignal): Promise<PodcastSettings> {
  return (await apiFetch<ApiJson<"/podcasts/{podcast_id}/settings", "get">>(`/api/podcasts/${podcastId}/settings`, { signal })).data;
}

/** Exact desired pair retries are inert; changing a pair requires its captured version. */
export async function savePodcastSettings(podcastId: string, patch: Schema<"PodcastPlaybackSettingsRequest">, signal?: AbortSignal): Promise<PodcastSettings> {
  const result = (await apiFetch<ApiJson<"/podcasts/{podcast_id}/settings", "put">>(`/api/podcasts/${podcastId}/settings`, { method: "PUT", body: JSON.stringify(patch), signal })).data;
  publishChange("Feeds");
  return result;
}

/** Source-deduplicated catalogue resolution; only a separate placement saves it. */
export async function resolvePodcastEpisode(target: string, signal?: AbortSignal) {
  const { data } = await apiFetch<ApiJson<"/podcast-episodes/resolve", "post">>("/api/podcast-episodes/resolve", {
    method: "POST", body: JSON.stringify({ target }), signal,
  });
  publishChange("Feeds", "PodcastEpisodes", "Entries");
  return data;
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
