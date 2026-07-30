/**
 * Episode + transcript types, constants, and pure-state helpers shared by
 * the podcast-detail pane. Owns the episode-state derivation
 * (unplayed/in_progress/played), transcript request/forecast/batch payload
 * shapes, and the polling / can-request / progress / summary helpers.
 */

import { decodePresence, type Presence } from "@/lib/api/presence";
import type {
  PositiveMinutes,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import { decodeContributorCredit } from "@/lib/contributors/credit";
import type { ContributorCredit } from "@/lib/contributors/types";
import {
  decodeOptionalPublicationDate,
  type PublicationDate,
} from "@/lib/dates/publicationDate";
import {
  canRequestTranscript,
  shouldPollTranscriptProvisioning,
  type TranscriptCoverage,
  type TranscriptState,
} from "@/lib/media/transcriptView";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectNonnegativeInteger,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export const TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS = 3000;

export type TranscriptRequestReason = "search" | "highlight" | "quote";
export type EpisodeState = "unplayed" | "in_progress" | "played";
export type EpisodeStateFilter = "all" | EpisodeState;
export type EpisodeSort = "newest" | "oldest" | "duration_asc" | "duration_desc";

export const EPISODE_WIDE_COMMAND_LABELS = {
  all: {
    transcript: "Transcribe all episodes",
    markPlayed: "Mark all episodes as played",
  },
  unplayed: {
    transcript: "Transcribe all unplayed episodes",
    markPlayed: "Mark all unplayed episodes as played",
  },
  in_progress: {
    transcript: "Transcribe all in-progress episodes",
    markPlayed: "Mark all in-progress episodes as played",
  },
  played: {
    transcript: "Transcribe all played episodes",
    markPlayed: "All played episodes are already played",
  },
} as const satisfies Record<
  EpisodeStateFilter,
  { readonly transcript: string; readonly markPlayed: string }
>;

export interface PodcastEpisodeListPlayerDescriptor {
  kind: "FooterAudio";
  mediaId: string;
}

interface MediaCapabilities {
  can_delete: boolean;
  can_retry: boolean;
  can_refresh_source: boolean;
  can_retry_metadata: boolean;
  can_edit_authors: boolean;
}

export interface PodcastEpisodeMedia {
  id: string;
  kind: string;
  title: string;
  canonical_source_url: string | null;
  offline_download_eligible: boolean;
  processing_status: string;
  transcript_state: TranscriptState;
  transcript_coverage: TranscriptCoverage;
  /**
   * Chapter/image-free list fact for the FooterAudio play affordance. Wire key
   * is pinned camelCase `playerDescriptor` even inside this snake_case DTO.
   * `Present` gates play/Lectern actions; the Lectern mutation returns the full
   * player activation only when the user invokes one.
   */
  playerDescriptor: Presence<PodcastEpisodeListPlayerDescriptor>;
  listening_state: {
    position_ms: number;
    duration_ms: number | null;
    playback_speed: number;
  } | null;
  episode_state: EpisodeState;
  progress_resettable: boolean;
  capabilities: MediaCapabilities;
  contributors: ContributorCredit[];
  author_mode: "automatic" | "manual";
  published_date: string | null;
  /** Lazy detail enrichment; never present in the compact list wire value. */
  description_text: string | null;
  has_show_notes: boolean;
  duration_seconds: number | null;
}

export function decodePodcastEpisodeMedia(raw: unknown): PodcastEpisodeMedia {
  const item = expectExactRecord(
    raw,
    [
      "id",
      "kind",
      "title",
      "canonical_source_url",
      "offline_download_eligible",
      "processing_status",
      "transcript_state",
      "transcript_coverage",
      "listening_state",
      "episode_state",
      "progress_resettable",
      "capabilities",
      "contributors",
      "author_mode",
      "published_date",
      "duration_seconds",
      "has_show_notes",
      "playerDescriptor",
    ],
    "PodcastEpisodeListItem",
  );
  const canonicalSourceUrl = decodePresence(
    item.canonical_source_url,
    (value) => expectString(value, "canonical_source_url.value"),
  );
  const publishedDate = decodePresence(
    item.published_date,
    (value) => expectString(value, "published_date.value"),
  );
  const durationSeconds = decodePresence(
    item.duration_seconds,
    (value) => expectNonnegativeInteger(value, "duration_seconds.value"),
  );
  const listening = decodePresence(item.listening_state, (value) => {
    const state = expectExactRecord(
      value,
      ["position_ms", "duration_ms", "playback_speed"],
      "listening_state.value",
    );
    const duration = decodePresence(
      state.duration_ms,
      (rawDuration) =>
        expectNonnegativeInteger(rawDuration, "listening_state.duration_ms.value"),
    );
    return {
      position_ms: expectNonnegativeInteger(
        state.position_ms,
        "listening_state.position_ms",
      ),
      duration_ms: duration.kind === "Present" ? duration.value : null,
      playback_speed: expectFiniteNumber(
        state.playback_speed,
        "listening_state.playback_speed",
      ),
    };
  });
  const capabilities = expectExactRecord(
    item.capabilities,
    [
      "can_retry",
      "can_refresh_source",
      "can_retry_metadata",
      "can_edit_authors",
      "can_delete",
    ],
    "capabilities",
  );
  return {
    id: expectString(item.id, "id"),
    kind: expectOneOf(item.kind, ["podcast_episode"] as const, "kind"),
    title: expectString(item.title, "title"),
    canonical_source_url:
      canonicalSourceUrl.kind === "Present" ? canonicalSourceUrl.value : null,
    offline_download_eligible: expectBoolean(
      item.offline_download_eligible,
      "offline_download_eligible",
    ),
    processing_status: expectString(
      item.processing_status,
      "processing_status",
    ),
    transcript_state: expectOneOf(
      item.transcript_state,
      [
        "not_requested",
        "queued",
        "running",
        "failed_provider",
        "failed_quota",
        "unavailable",
        "ready",
        "partial",
      ] as const,
      "transcript_state",
    ),
    transcript_coverage: expectOneOf(
      item.transcript_coverage,
      ["none", "partial", "full"] as const,
      "transcript_coverage",
    ),
    playerDescriptor: decodePresence(item.playerDescriptor, (value) => {
      const descriptor = expectExactRecord(
        value,
        ["kind", "mediaId"],
        "playerDescriptor.value",
      );
      return {
        kind: expectOneOf(
          descriptor.kind,
          ["FooterAudio"] as const,
          "playerDescriptor.value.kind",
        ),
        mediaId: expectString(
          descriptor.mediaId,
          "playerDescriptor.value.mediaId",
        ),
      };
    }),
    listening_state: listening.kind === "Present" ? listening.value : null,
    episode_state: expectOneOf(
      item.episode_state,
      ["unplayed", "in_progress", "played"] as const,
      "episode_state",
    ),
    progress_resettable: expectBoolean(
      item.progress_resettable,
      "progress_resettable",
    ),
    capabilities: {
      can_retry: expectBoolean(capabilities.can_retry, "capabilities.can_retry"),
      can_refresh_source: expectBoolean(
        capabilities.can_refresh_source,
        "capabilities.can_refresh_source",
      ),
      can_retry_metadata: expectBoolean(
        capabilities.can_retry_metadata,
        "capabilities.can_retry_metadata",
      ),
      can_edit_authors: expectBoolean(
        capabilities.can_edit_authors,
        "capabilities.can_edit_authors",
      ),
      can_delete: expectBoolean(
        capabilities.can_delete,
        "capabilities.can_delete",
      ),
    },
    contributors: expectArray(
      item.contributors,
      (credit, index) =>
        decodeContributorCredit(
          credit,
          index,
          "Podcast episode contributors",
        ),
      "contributors",
    ),
    author_mode: expectOneOf(
      item.author_mode,
      ["automatic", "manual"] as const,
      "author_mode",
    ),
    published_date:
      publishedDate.kind === "Present" ? publishedDate.value : null,
    description_text: null,
    has_show_notes: expectBoolean(item.has_show_notes, "has_show_notes"),
    duration_seconds:
      durationSeconds.kind === "Present" ? durationSeconds.value : null,
  };
}

export interface TranscriptRequestResult {
  media_id: string;
  processing_status: string;
  transcript_state: TranscriptState;
  transcript_coverage: TranscriptCoverage;
  required_minutes: number;
  remaining_minutes: number | null;
  fits_budget: boolean;
  request_enqueued: boolean;
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
  switch (episode.episode_state) {
    case "unplayed":
    case "in_progress":
    case "played":
      return episode.episode_state;
    default: {
      const invalid: never = episode.episode_state;
      throw new TypeError(`Unsupported episode_state: ${String(invalid)}`);
    }
  }
}

/**
 * Return the already-decoded list playback fact. The transport boundary
 * requires strict `Presence`; `Absent` hides play/Lectern affordances.
 */
export function episodePlayerDescriptor(
  episode: PodcastEpisodeMedia,
): Presence<PodcastEpisodeListPlayerDescriptor> {
  return episode.playerDescriptor;
}

export function episodeMatchesFilter(
  episodeState: EpisodeState,
  filter: EpisodeStateFilter,
): boolean {
  return filter === "all" || episodeState === filter;
}

export interface EpisodeActivityFacts {
  totalMinutes: Presence<PositiveMinutes>;
  fraction: Presence<ProgressFraction>;
  remainingMinutes: Presence<PositiveMinutes>;
}

export function decodeEpisodePublicationDate(
  raw: PodcastEpisodeMedia["published_date"],
): Presence<PublicationDate> {
  return decodeOptionalPublicationDate(raw, "episode published_date");
}

export function decodeEpisodeTimingFacts(
  state: PodcastEpisodeMedia["listening_state"],
): EpisodeActivityFacts {
  if (state === null) {
    return {
      totalMinutes: { kind: "Absent" },
      fraction: { kind: "Absent" },
      remainingMinutes: { kind: "Absent" },
    };
  }
  if (!Number.isInteger(state.position_ms) || state.position_ms < 0) {
    throw new TypeError("episode listening position_ms must be a non-negative integer");
  }
  if (state.duration_ms === null) {
    return {
      totalMinutes: { kind: "Absent" },
      fraction: { kind: "Absent" },
      remainingMinutes: { kind: "Absent" },
    };
  }
  if (
    !Number.isInteger(state.duration_ms) ||
    state.duration_ms <= 0 ||
    state.position_ms > state.duration_ms
  ) {
    throw new TypeError(
      "episode listening duration_ms must be a positive integer at least position_ms",
    );
  }
  const remainingMs = state.duration_ms - state.position_ms;
  return {
    totalMinutes: {
      kind: "Present",
      value: { value: Math.ceil(state.duration_ms / 60_000) },
    },
    fraction: {
      kind: "Present",
      value: { value: state.position_ms / state.duration_ms },
    },
    remainingMinutes:
      remainingMs > 0
        ? {
            kind: "Present",
            value: { value: Math.ceil(remainingMs / 60_000) },
          }
        : { kind: "Absent" },
  };
}

export function canRequestTranscriptForEpisode(
  episode: PodcastEpisodeMedia,
): boolean {
  return canRequestTranscript(episode.transcript_state);
}

export function shouldPollTranscriptProvisioningForEpisode(
  episode: PodcastEpisodeMedia,
): boolean {
  return shouldPollTranscriptProvisioning(episode.transcript_state);
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
