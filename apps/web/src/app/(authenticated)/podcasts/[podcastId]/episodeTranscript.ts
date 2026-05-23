/**
 * Episode + transcript types, constants, and pure-state helpers shared by
 * the podcast-detail pane. Owns the episode-state derivation
 * (unplayed/in_progress/played), transcript request/forecast/batch payload
 * shapes, and the polling / can-request / progress / summary helpers.
 */

import type { ContributorCredit } from "@/lib/contributors/types";
import { formatContributorCreditSummary } from "@/lib/contributors/formatting";

export const TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS = 3000;
export const TRANSCRIPT_FORECAST_BATCH_SIZE = 100;

export type TranscriptRequestReason = "search" | "highlight" | "quote";
export type EpisodeState = "unplayed" | "in_progress" | "played";
export type EpisodeStateFilter = "all" | EpisodeState;
export type EpisodeSort = "newest" | "oldest" | "duration_asc" | "duration_desc";
export type EpisodeTranscriptState =
  | "not_requested"
  | "queued"
  | "running"
  | "failed_provider"
  | "failed_quota"
  | "unavailable"
  | "ready"
  | "partial"
  | null;
export type EpisodeTranscriptCoverage = "none" | "partial" | "full" | null;

export interface MediaCapabilities {
  can_read: boolean;
  can_highlight: boolean;
  can_quote: boolean;
  can_search: boolean;
  can_play: boolean;
  can_download_file: boolean;
  can_delete?: boolean;
  can_retry?: boolean;
  can_refresh_source?: boolean;
}

export interface PodcastEpisodeMedia {
  id: string;
  kind: string;
  title: string;
  canonical_source_url: string | null;
  processing_status: string;
  transcript_state: EpisodeTranscriptState;
  transcript_coverage: EpisodeTranscriptCoverage;
  failure_stage: string | null;
  last_error_code: string | null;
  playback_source: {
    kind: "external_audio" | "external_video";
    stream_url: string;
    source_url: string;
  } | null;
  listening_state: {
    position_ms: number;
    duration_ms: number | null;
    playback_speed: number;
    is_completed: boolean;
  } | null;
  subscription_default_playback_speed?: number | null;
  episode_state: EpisodeState | null;
  capabilities: MediaCapabilities;
  contributors: ContributorCredit[];
  published_date: string | null;
  publisher: string | null;
  language: string | null;
  description: string | null;
  description_html: string | null;
  description_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface TranscriptRequestResult {
  media_id: string;
  processing_status: string;
  transcript_state: EpisodeTranscriptState;
  transcript_coverage: EpisodeTranscriptCoverage;
  required_minutes: number;
  remaining_minutes: number | null;
  fits_budget: boolean;
  request_enqueued: boolean;
}

export interface TranscriptForecastBatchRequest {
  requests: Array<{
    media_id: string;
    reason: TranscriptRequestReason;
  }>;
}

export interface TranscriptForecastBatchResponse {
  data: TranscriptRequestResult[];
}

export type TranscriptBatchStatus =
  | "queued"
  | "already_ready"
  | "already_queued"
  | "rejected_quota"
  | "rejected_invalid";

export interface TranscriptBatchResult {
  media_id: string;
  status: TranscriptBatchStatus;
  required_minutes?: number | null;
  remaining_minutes?: number | null;
  error?: string | null;
}

export interface TranscriptBatchRequest {
  media_ids: string[];
  reason: TranscriptRequestReason;
}

export interface TranscriptBatchResponse {
  data: {
    results: TranscriptBatchResult[];
  };
}

export interface TranscriptRequestForecastState {
  required_minutes: number;
  remaining_minutes: number | null;
  fits_budget: boolean;
  request_enqueued: boolean;
  reason: TranscriptRequestReason;
  source: "forecast" | "request";
}

export function deriveEpisodeState(episode: PodcastEpisodeMedia): EpisodeState {
  if (episode.episode_state === "unplayed") {
    return "unplayed";
  }
  if (episode.episode_state === "in_progress") {
    return "in_progress";
  }
  if (episode.episode_state === "played") {
    return "played";
  }
  if (episode.listening_state?.is_completed) {
    return "played";
  }
  if ((episode.listening_state?.position_ms ?? 0) > 0) {
    return "in_progress";
  }
  return "unplayed";
}

export function episodeMatchesFilter(
  episodeState: EpisodeState,
  filter: EpisodeStateFilter,
): boolean {
  return filter === "all" || episodeState === filter;
}

export function getEpisodeProgressPercent(episode: PodcastEpisodeMedia): number {
  const listeningState = episode.listening_state;
  if (
    !listeningState ||
    listeningState.duration_ms == null ||
    listeningState.duration_ms <= 0
  ) {
    return 0;
  }
  const rawPercent = Math.floor(
    (listeningState.position_ms / listeningState.duration_ms) * 100,
  );
  return Math.max(0, Math.min(100, rawPercent));
}

export function formatAuthorSummary(
  contributors: ContributorCredit[] | null | undefined,
  maxNames: number = 1,
): string | null {
  return formatContributorCreditSummary(contributors, maxNames);
}

export function canRequestTranscriptForEpisode(
  episode: PodcastEpisodeMedia,
): boolean {
  const transcriptState = episode.transcript_state;
  if (transcriptState === null) {
    return false;
  }
  return !(
    transcriptState === "queued" ||
    transcriptState === "running" ||
    transcriptState === "ready" ||
    transcriptState === "partial" ||
    transcriptState === "unavailable"
  );
}

export function shouldPollTranscriptProvisioningForEpisode(
  episode: PodcastEpisodeMedia,
): boolean {
  return (
    episode.transcript_state === "queued" ||
    episode.transcript_state === "running"
  );
}

export function applyTranscriptResponseToEpisode(
  episode: PodcastEpisodeMedia,
  response: Pick<
    TranscriptRequestResult,
    "transcript_state" | "transcript_coverage"
  >,
): PodcastEpisodeMedia {
  return {
    ...episode,
    transcript_state: response.transcript_state,
    transcript_coverage: response.transcript_coverage,
  };
}

export function toTranscriptForecastState(
  response: TranscriptRequestResult,
  reason: TranscriptRequestReason,
  source: "forecast" | "request",
): TranscriptRequestForecastState {
  return {
    required_minutes: response.required_minutes,
    remaining_minutes: response.remaining_minutes,
    fits_budget: response.fits_budget,
    request_enqueued: response.request_enqueued,
    reason,
    source,
  };
}

export function summarizeBatchTranscriptResults(
  results: TranscriptBatchResult[],
): string | null {
  if (results.length === 0) {
    return null;
  }

  let queued = 0;
  let alreadyReady = 0;
  let alreadyQueued = 0;
  let rejectedQuota = 0;
  let rejectedInvalid = 0;
  for (const result of results) {
    if (result.status === "queued") {
      queued += 1;
    } else if (result.status === "already_ready") {
      alreadyReady += 1;
    } else if (result.status === "already_queued") {
      alreadyQueued += 1;
    } else if (result.status === "rejected_quota") {
      rejectedQuota += 1;
    } else if (result.status === "rejected_invalid") {
      rejectedInvalid += 1;
    }
  }

  const parts: string[] = [];
  if (queued > 0) {
    parts.push(`${queued} queued`);
  }
  if (alreadyReady > 0) {
    parts.push(`${alreadyReady} already ready`);
  }
  if (alreadyQueued > 0) {
    parts.push(`${alreadyQueued} already queued`);
  }
  if (rejectedQuota > 0) {
    parts.push(`${rejectedQuota} rejected (quota)`);
  }
  if (rejectedInvalid > 0) {
    parts.push(`${rejectedInvalid} rejected (invalid)`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `Batch transcript result: ${parts.join(", ")}.`;
}
