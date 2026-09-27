import { decodePresence, type Presence } from "@/lib/api/presence";
import { decodeContributorCredit } from "@/lib/contributors/credit";
import type { ContributorCredit } from "@/lib/contributors/types";
import { decodePublicationDateOnly, type PublicationDate } from "@/lib/dates/publicationDate";
import { MEDIA_KINDS, type MediaKind } from "@/lib/media/kind";
import { decodeReadingTimeEstimate, type ReadingTimeEstimate } from "@/lib/media/readingTime";
import type { MediaProcessingStatus } from "@/lib/status/mediaProcessing";
import {
  expectArray,
  expectCanonicalUuid,
  expectExactRecord,
  expectOneOf,
  expectString,
} from "@/lib/validation";

const PROCESSING_STATUSES = [
  "pending",
  "extracting",
  "ready_for_reading",
  "failed",
  "suspended",
] as const satisfies readonly MediaProcessingStatus[];

export interface MediaDuration {
  readonly modality: "Read" | "Listen";
  readonly estimate: ReadingTimeEstimate;
}

export interface MediaSummary {
  readonly mediaId: string;
  readonly mediaKind: MediaKind;
  readonly title: string;
  readonly contributors: readonly ContributorCredit[];
  readonly originalPublishedDate: Presence<PublicationDate>;
  readonly processingStatus: MediaProcessingStatus;
  readonly duration: Presence<MediaDuration>;
}

export function decodeMediaDuration(raw: unknown): MediaDuration {
  const duration = expectExactRecord(
    raw,
    ["modality", "estimate"],
    "MediaDuration",
  );
  return {
    modality: expectOneOf(
      duration.modality,
      ["Read", "Listen"] as const,
      "MediaDuration.modality",
    ),
    estimate: decodeReadingTimeEstimate(duration.estimate),
  };
}

export function decodeMediaSummary(raw: unknown): MediaSummary {
  const value = expectExactRecord(
    raw,
    [
      "mediaId",
      "mediaKind",
      "title",
      "contributors",
      "originalPublishedDate",
      "processingStatus",
      "duration",
    ],
    "MediaSummaryOut",
  );
  const summary: MediaSummary = {
    mediaId: expectCanonicalUuid(value.mediaId, "MediaSummaryOut.mediaId"),
    mediaKind: expectOneOf(value.mediaKind, MEDIA_KINDS, "MediaSummaryOut.mediaKind"),
    title: expectString(value.title, "MediaSummaryOut.title"),
    contributors: expectArray(
      value.contributors,
      (credit, index) => decodeContributorCredit(credit, index, "MediaSummaryOut.contributors"),
      "MediaSummaryOut.contributors",
    ),
    originalPublishedDate: decodePresence(value.originalPublishedDate, (date) =>
      decodePublicationDateOnly(date, "MediaSummaryOut.originalPublishedDate.value"),
    ),
    processingStatus: expectOneOf(
      value.processingStatus,
      PROCESSING_STATUSES,
      "MediaSummaryOut.processingStatus",
    ),
    duration: decodePresence(value.duration, decodeMediaDuration),
  };
  const expectedModality = summary.mediaKind === "podcast_episode"
    ? "Listen"
    : summary.mediaKind === "video"
      ? null
      : "Read";
  if (
    summary.duration.kind === "Present" &&
    summary.duration.value.modality !== expectedModality
  ) {
    throw new TypeError("MediaSummaryOut.duration does not match mediaKind");
  }
  return summary;
}
