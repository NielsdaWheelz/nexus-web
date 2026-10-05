/**
 * Episode + transcript types, constants, and pure-state helpers shared by
 * the podcast-detail pane. Owns the episode payload decoder and the
 * polling / can-request helpers.
 */

import { decodePresence, type Presence } from "@/lib/api/presence";
import type { EpisodeStateFilter } from "@/lib/podcasts/episodeView";
import { decodeMediaSummary, type MediaSummary } from "@/lib/media/mediaSummary";
import {
  canRequestTranscript,
  shouldPollTranscriptProvisioning,
  type TranscriptCoverage,
  type TranscriptState,
} from "@/lib/media/transcriptView";
import {
  expectBoolean,
  expectExactRecord,
  expectNonnegativeInteger,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export const TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS = 3000;

export type TranscriptRequestReason = "search" | "highlight" | "quote";
export type EpisodeState = "unplayed" | "in_progress" | "played";

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

interface PodcastEpisodeListPlayerDescriptor {
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
  mediaSummary: MediaSummary;
  canonical_source_url: string | null;
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
  } | null;
  episode_state: EpisodeState;
  progress_resettable: boolean;
  capabilities: MediaCapabilities;
  author_mode: "automatic" | "manual";
  /** Lazy detail enrichment; never present in the compact list wire value. */
  description_text: string | null;
  has_show_notes: boolean;
}

export function decodePodcastEpisodeMedia(raw: unknown): PodcastEpisodeMedia {
  const item = expectExactRecord(
    raw,
    [
      "id",
      "mediaSummary",
      "canonical_source_url",
      "transcript_state",
      "transcript_coverage",
      "listening_state",
      "episode_state",
      "progress_resettable",
      "capabilities",
      "author_mode",
      "has_show_notes",
      "playerDescriptor",
    ],
    "PodcastEpisodeListItem",
  );
  const canonicalSourceUrl = decodePresence(
    item.canonical_source_url,
    (value) => expectString(value, "canonical_source_url.value"),
  );
  const mediaSummary = decodeMediaSummary(item.mediaSummary);
  const id = expectString(item.id, "id");
  if (id !== mediaSummary.mediaId || mediaSummary.mediaKind !== "podcast_episode") {
    throw new TypeError("Podcast episode list media identity mismatch");
  }
  const listening = decodePresence(item.listening_state, (value) => {
    const state = expectExactRecord(
      value,
      ["position_ms", "duration_ms"],
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
    id,
    mediaSummary,
    canonical_source_url:
      canonicalSourceUrl.kind === "Present" ? canonicalSourceUrl.value : null,
    transcript_state: expectOneOf(
      item.transcript_state,
      [
        "not_requested",
        "queued",
        "running",
        "failed_provider",
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
    author_mode: expectOneOf(
      item.author_mode,
      ["automatic", "manual"] as const,
      "author_mode",
    ),
    description_text: null,
    has_show_notes: expectBoolean(item.has_show_notes, "has_show_notes"),
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
