import { absent, present } from "@/lib/api/presence";
import type { ResourceRowPrimary } from "@/components/ui/ResourceActivation";
import type { CollectionRowView } from "@/lib/collections/types";
import { selectMediaAuthors } from "@/lib/contributors/formatting";
import type { MediaSummary } from "@/lib/media/mediaSummary";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { EmphasisSegment } from "@/lib/ui/emphasis";

export interface MediaOccurrence {
  readonly id: string;
  readonly primary: Extract<ResourceRowPrimary, { kind: "link" }>;
  readonly actionSubject: ResourceActionSubject;
  readonly selected: boolean;
  readonly searchEvidence?: readonly EmphasisSegment[];
}

/** Project one stored-media identity into any eligible collection occurrence. */
export function presentMedia(
  summary: MediaSummary,
  occurrence: MediaOccurrence,
): CollectionRowView {
  if (
    occurrence.actionSubject.ref !==
    canonicalResourceRef({ scheme: "media", id: summary.mediaId })
  ) {
    throw new Error("Media occurrence action subject differs from media summary");
  }
  return {
    id: occurrence.id,
    kind: summary.mediaKind === "podcast_episode" ? "podcast_episode" : "media",
    mediaIdentity: "Stored",
    consumption: summary.consumption,
    primary: { ...occurrence.primary, paneLabelHint: summary.title },
    title: { text: summary.title },
    contributors: selectMediaAuthors(summary.contributors),
    publicationDate: summary.originalPublishedDate,
    context: occurrence.searchEvidence?.length
      ? present({ kind: "Snippet", segments: occurrence.searchEvidence })
      : absent(),
    activity: summary.consumption.state !== "Finished" &&
      summary.duration.kind === "Present" &&
      summary.duration.value.estimate.remainingMinutes.kind === "Present"
      ? present({
          kind: "RemainingTime",
          modality: summary.duration.value.modality,
          minutes: summary.duration.value.estimate.remainingMinutes.value,
        })
      : absent(),
    exceptionalStatus: summary.processingStatus === "failed"
      ? present({ kind: "MediaProcessing", status: "failed" })
      : absent(),
    actionSubject: occurrence.actionSubject,
    selected: occurrence.selected,
  };
}
