import type { ResourceRowPrimary } from "@/components/ui/ResourceRow";
import type { CollectionRowView } from "@/lib/collections/types";
import { selectMediaAuthors } from "@/lib/contributors/credits";
import type { MediaSummary } from "@/lib/media/mediaSummary";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { EmphasisSegment } from "@/lib/ui/emphasis";

export interface MediaOccurrence {
  readonly id: string;
  readonly primary: Extract<ResourceRowPrimary, { kind: "link" }>;
  readonly resourceRef: CanonicalResourceRef;
  readonly selected: boolean;
  readonly searchEvidence?: readonly EmphasisSegment[];
}

/** Project one stored-media identity into any eligible collection occurrence. */
export function presentMedia(
  summary: MediaSummary,
  occurrence: MediaOccurrence,
): CollectionRowView {
  if (
    occurrence.resourceRef !==
    canonicalResourceRef({ scheme: "media", id: summary.media_id })
  ) {
    throw new Error("Media occurrence resource ref differs from media summary");
  }
  return {
    id: occurrence.id,
    kind: summary.media_kind === "podcast_episode" ? "podcast_episode" : "media",
    mediaIdentity: "Stored",
    consumption: summary.consumption,
    primary: { ...occurrence.primary, paneLabelHint: summary.title },
    title: { text: summary.title },
    contributors: selectMediaAuthors(summary.contributors),
    publicationDate: summary.original_published_date,
    context: occurrence.searchEvidence?.length
      ? { kind: "Snippet", segments: occurrence.searchEvidence }
      : null,
    activity: summary.consumption.state !== "Finished" &&
      summary.duration !== null &&
      summary.duration.estimate.remaining_minutes !== null
      ? {
          kind: "RemainingTime",
          modality: summary.duration.modality,
          minutes: summary.duration.estimate.remaining_minutes,
        }
      : null,
    exceptionalStatus: summary.processing_status === "failed"
      ? { kind: "MediaProcessing", status: "failed" }
      : null,
    resourceRef: occurrence.resourceRef,
    selected: occurrence.selected,
  };
}
