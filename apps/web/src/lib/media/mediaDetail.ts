import { decodePresence, type Presence } from "@/lib/api/presence";
import { decodeContributorCredit } from "@/lib/contributors/credit";
import type { ContributorCredit } from "@/lib/contributors/types";
import {
  decodePlayerDescriptor,
  parseMediaId,
  type MediaId,
  type PlayerDescriptor,
} from "@/lib/lectern/contract";
import {
  decodeDocumentEmbedSummary,
  decodeMediaPlaybackSource,
  type DocumentEmbedSummary,
} from "@/lib/media/documentEmbeds";
import {
  MEDIA_PROCESSING_PROJECTION_STATUSES,
  type MediaProcessingProjectionStatus,
} from "@/lib/media/documentReadiness";
import {
  decodeMediaActionCapabilities,
  type MediaActionCapabilities,
} from "@/lib/media/mediaActionCapabilities";
import { MEDIA_KINDS, type MediaKind } from "@/lib/media/kind";
import type { MediaPlaybackSource } from "@/lib/media/playback";
import {
  decodeTranscriptCoverage,
  decodeTranscriptState,
  type TranscriptChapter,
  type TranscriptCoverage,
  type TranscriptState,
} from "@/lib/media/transcriptView";
import {
  decodeMediaSourceProgress,
  type MediaSourceProgress,
} from "@/lib/media/sourceProgress";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectIsoInstant,
  expectNonnegativeInteger,
  expectNullableNonnegativeInteger,
  expectNullableString,
  expectOneOf,
  expectString,
} from "@/lib/validation";

const MEDIA_DETAIL_KEYS = [
  "id",
  "kind",
  "title",
  "canonical_source_url",
  "processing_status",
  "source_progress",
  "transcript_state",
  "transcript_coverage",
  "transcript_origin",
  "retrieval_status",
  "retrieval_status_reason",
  "failure_stage",
  "last_error_code",
  "playback_source",
  "listening_state",
  "episode_state",
  "chapters",
  "capabilities",
  "document_embed_summary",
  "contributors",
  "author_mode",
  "published_date",
  "publisher",
  "language",
  "description",
  "description_html",
  "description_text",
  "metadata_enriched_at",
  "read_state",
  "progress_fraction",
  "progress_resettable",
  "last_engaged_at",
  "playerDescriptor",
  "created_at",
  "updated_at",
] as const;

interface MediaListeningState {
  position_ms: number;
  duration_ms: number | null;
  is_completed: boolean;
}

export interface MediaDetail {
  id: MediaId;
  kind: MediaKind;
  title: string;
  canonical_source_url: string | null;
  processing_status: MediaProcessingProjectionStatus;
  source_progress: Presence<MediaSourceProgress>;
  transcript_state: TranscriptState;
  transcript_coverage: TranscriptCoverage;
  transcript_origin: Presence<"Publisher" | "Imported" | "Generated">;
  retrieval_status: string | null;
  retrieval_status_reason: string | null;
  failure_stage: string | null;
  last_error_code: string | null;
  playback_source: MediaPlaybackSource | null;
  listening_state: MediaListeningState | null;
  episode_state: "unplayed" | "in_progress" | "played" | null;
  chapters: TranscriptChapter[];
  capabilities: MediaActionCapabilities;
  document_embed_summary: DocumentEmbedSummary | null;
  contributors: ContributorCredit[];
  author_mode: "automatic" | "manual";
  published_date: string | null;
  publisher: string | null;
  language: string | null;
  description: string | null;
  description_html: string | null;
  description_text: string | null;
  metadata_enriched_at: string | null;
  read_state: "unread" | "in_progress" | "finished" | null;
  progress_fraction: number | null;
  progress_resettable: boolean;
  last_engaged_at: string | null;
  playerDescriptor: Presence<PlayerDescriptor>;
  created_at: string;
  updated_at: string;
}

function decodeNullableOneOf<const T extends readonly string[]>(
  raw: unknown,
  values: T,
  name: string,
): T[number] | null {
  return raw === null ? null : expectOneOf(raw, values, name);
}

function decodeListeningState(raw: unknown): MediaListeningState {
  const value = expectExactRecord(
    raw,
    ["position_ms", "duration_ms", "is_completed"],
    "MediaOut.listening_state",
  );
  return {
    position_ms: expectNonnegativeInteger(
      value.position_ms,
      "MediaOut.listening_state.position_ms",
    ),
    duration_ms: expectNullableNonnegativeInteger(
      value.duration_ms,
      "MediaOut.listening_state.duration_ms",
    ),
    is_completed: expectBoolean(
      value.is_completed,
      "MediaOut.listening_state.is_completed",
    ),
  };
}

function decodeChapter(raw: unknown, index: number): TranscriptChapter {
  const name = `MediaOut.chapters[${index}]`;
  const value = expectExactRecord(
    raw,
    ["chapter_idx", "title", "t_start_ms", "t_end_ms", "url", "image_url"],
    name,
  );
  return {
    chapter_idx: expectNonnegativeInteger(
      value.chapter_idx,
      `${name}.chapter_idx`,
    ),
    title: expectString(value.title, `${name}.title`),
    t_start_ms: expectNonnegativeInteger(
      value.t_start_ms,
      `${name}.t_start_ms`,
    ),
    t_end_ms: expectNullableNonnegativeInteger(
      value.t_end_ms,
      `${name}.t_end_ms`,
    ),
    url: expectNullableString(value.url, `${name}.url`),
    image_url: expectNullableString(value.image_url, `${name}.image_url`),
  };
}

export function decodeMediaDetail(
  raw: unknown,
  expectedMediaId?: string,
): MediaDetail {
  const value = expectExactRecord(raw, MEDIA_DETAIL_KEYS, "MediaOut");
  const id = parseMediaId(expectString(value.id, "MediaOut.id"));
  if (expectedMediaId !== undefined && id !== parseMediaId(expectedMediaId)) {
    throw new TypeError("MediaOut.id must match the requested media");
  }
  const progressFraction =
    value.progress_fraction === null
      ? null
      : expectFiniteNumber(value.progress_fraction, "MediaOut.progress_fraction");
  if (
    progressFraction !== null &&
    (progressFraction < 0 || progressFraction > 1)
  ) {
    throw new TypeError("MediaOut.progress_fraction must be between 0 and 1");
  }
  return {
    id,
    kind: expectOneOf(value.kind, MEDIA_KINDS, "MediaOut.kind"),
    title: expectString(value.title, "MediaOut.title"),
    canonical_source_url: expectNullableString(
      value.canonical_source_url,
      "MediaOut.canonical_source_url",
    ),
    processing_status: expectOneOf(
      value.processing_status,
      MEDIA_PROCESSING_PROJECTION_STATUSES,
      "MediaOut.processing_status",
    ),
    source_progress: decodePresence(
      value.source_progress,
      decodeMediaSourceProgress,
    ),
    transcript_state: decodeTranscriptState(
      value.transcript_state,
      "MediaOut.transcript_state",
    ),
    transcript_coverage: decodeTranscriptCoverage(
      value.transcript_coverage,
      "MediaOut.transcript_coverage",
    ),
    transcript_origin: decodePresence(value.transcript_origin, (origin) =>
      expectOneOf(
        origin,
        ["Publisher", "Imported", "Generated"] as const,
        "MediaOut.transcript_origin.value",
      ),
    ),
    retrieval_status: expectNullableString(
      value.retrieval_status,
      "MediaOut.retrieval_status",
    ),
    retrieval_status_reason: expectNullableString(
      value.retrieval_status_reason,
      "MediaOut.retrieval_status_reason",
    ),
    failure_stage: expectNullableString(
      value.failure_stage,
      "MediaOut.failure_stage",
    ),
    last_error_code: expectNullableString(
      value.last_error_code,
      "MediaOut.last_error_code",
    ),
    playback_source:
      value.playback_source === null
        ? null
        : decodeMediaPlaybackSource(
            value.playback_source,
            "MediaOut.playback_source",
          ),
    listening_state:
      value.listening_state === null
        ? null
        : decodeListeningState(value.listening_state),
    episode_state: decodeNullableOneOf(
      value.episode_state,
      ["unplayed", "in_progress", "played"] as const,
      "MediaOut.episode_state",
    ),
    chapters: expectArray(value.chapters, decodeChapter, "MediaOut.chapters"),
    capabilities: decodeMediaActionCapabilities(
      value.capabilities,
      "MediaOut.capabilities",
    ),
    document_embed_summary:
      value.document_embed_summary === null
        ? null
        : decodeDocumentEmbedSummary(
            value.document_embed_summary,
            "MediaOut.document_embed_summary",
          ),
    contributors: expectArray(
      value.contributors,
      (credit, index) =>
        decodeContributorCredit(credit, index, "MediaOut.contributors"),
      "MediaOut.contributors",
    ),
    author_mode: expectOneOf(
      value.author_mode,
      ["automatic", "manual"] as const,
      "MediaOut.author_mode",
    ),
    published_date: expectNullableString(
      value.published_date,
      "MediaOut.published_date",
    ),
    publisher: expectNullableString(value.publisher, "MediaOut.publisher"),
    language: expectNullableString(value.language, "MediaOut.language"),
    description: expectNullableString(
      value.description,
      "MediaOut.description",
    ),
    description_html: expectNullableString(
      value.description_html,
      "MediaOut.description_html",
    ),
    description_text: expectNullableString(
      value.description_text,
      "MediaOut.description_text",
    ),
    metadata_enriched_at:
      value.metadata_enriched_at === null
        ? null
        : expectIsoInstant(
            value.metadata_enriched_at,
            "MediaOut.metadata_enriched_at",
          ),
    read_state: decodeNullableOneOf(
      value.read_state,
      ["unread", "in_progress", "finished"] as const,
      "MediaOut.read_state",
    ),
    progress_fraction: progressFraction,
    progress_resettable: expectBoolean(
      value.progress_resettable,
      "MediaOut.progress_resettable",
    ),
    last_engaged_at:
      value.last_engaged_at === null
        ? null
        : expectIsoInstant(value.last_engaged_at, "MediaOut.last_engaged_at"),
    playerDescriptor: decodePresence(
      value.playerDescriptor,
      decodePlayerDescriptor,
    ),
    created_at: expectIsoInstant(value.created_at, "MediaOut.created_at"),
    updated_at: expectIsoInstant(value.updated_at, "MediaOut.updated_at"),
  };
}

export function decodeMediaDetailResponse(
  raw: unknown,
  expectedMediaId: string,
): MediaDetail {
  const envelope = expectExactRecord(raw, ["data"], "Media detail response");
  return decodeMediaDetail(envelope.data, expectedMediaId);
}
