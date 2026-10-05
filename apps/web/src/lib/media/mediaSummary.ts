import { absent, present, type Presence } from "@/lib/api/presence";
import type { Schema } from "@/lib/api/wire";
import type { ContributorCredit } from "@/lib/contributors/types";
import { decodePublicationDateOnly, type PublicationDate } from "@/lib/dates/publicationDate";
import type { MediaKind } from "@/lib/media/kind";
import {
  readingTimeEstimateFromWire,
  type ReadingTimeEstimate,
} from "@/lib/media/readingTime";
import type { MediaProcessingStatus } from "@/lib/status/mediaProcessing";

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

function mediaDurationFromWire(duration: Schema<"MediaDurationOut">): MediaDuration {
  return {
    modality: duration.modality,
    estimate: readingTimeEstimateFromWire(duration.estimate),
  };
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
