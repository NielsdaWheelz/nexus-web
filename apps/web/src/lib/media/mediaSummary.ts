import { absent, present, decodePresence, type Presence } from "@/lib/api/presence";
import type { Schema } from "@/lib/api/wire";
import { decodeContributorCredit } from "@/lib/contributors/credit";
import type { ContributorCredit } from "@/lib/contributors/types";
import { decodePublicationDateOnly, type PublicationDate } from "@/lib/dates/publicationDate";
import { MEDIA_KINDS, type MediaKind } from "@/lib/media/kind";
import {
  parseReadingTimeEstimateWire,
  readingTimeEstimateFromWire,
  type ReadingTimeEstimate,
} from "@/lib/media/readingTime";
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

function parseMediaDurationWire(raw: unknown): Schema<"MediaDurationOut"> {
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
    estimate: parseReadingTimeEstimateWire(duration.estimate),
  };
}

function mediaDurationFromWire(duration: Schema<"MediaDurationOut">): MediaDuration {
  return {
    modality: duration.modality,
    estimate: readingTimeEstimateFromWire(duration.estimate),
  };
}

export function decodeMediaDuration(raw: unknown): MediaDuration {
  return mediaDurationFromWire(parseMediaDurationWire(raw));
}

export function mediaSummaryFromWire(value: Schema<"MediaSummaryOut">): MediaSummary {
  const summary: MediaSummary = {
    ...value,
    originalPublishedDate: value.originalPublishedDate.kind === "Present"
      ? present(decodePublicationDateOnly(
          value.originalPublishedDate.value,
          "MediaSummaryOut.originalPublishedDate.value",
        ))
      : absent(),
    duration: value.duration.kind === "Present"
      ? present(mediaDurationFromWire(value.duration.value))
      : absent(),
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
  return mediaSummaryFromWire({
    mediaId: expectCanonicalUuid(value.mediaId, "MediaSummaryOut.mediaId"),
    mediaKind: expectOneOf(value.mediaKind, MEDIA_KINDS, "MediaSummaryOut.mediaKind"),
    title: expectString(value.title, "MediaSummaryOut.title"),
    contributors: expectArray(
      value.contributors,
      (credit, index) => decodeContributorCredit(credit, index, "MediaSummaryOut.contributors"),
      "MediaSummaryOut.contributors",
    ),
    originalPublishedDate: decodePresence(value.originalPublishedDate, (date) =>
      expectString(date, "MediaSummaryOut.originalPublishedDate.value"),
    ),
    processingStatus: expectOneOf(
      value.processingStatus,
      PROCESSING_STATUSES,
      "MediaSummaryOut.processingStatus",
    ),
    duration: decodePresence(value.duration, parseMediaDurationWire),
  });
}
