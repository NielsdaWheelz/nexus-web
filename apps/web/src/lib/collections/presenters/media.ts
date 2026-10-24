import type { ResourceRowPrimary } from "@/components/ui/ResourceRow";
import type { CollectionRowView } from "@/lib/collections/types";
import { selectMediaAuthors } from "@/lib/contributors/credits";
import type { PlayerDescriptor } from "@/lib/player/playerRuntime";
import type { MediaSummary } from "@/lib/media/mediaSummary";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { EmphasisSegment } from "@/lib/ui/emphasis";

export interface MediaOccurrence {
  readonly id: string;
  readonly primary: Extract<ResourceRowPrimary, { kind: "link" }>;
  readonly resourceRef: CanonicalResourceRef;
  readonly selected: boolean;
  readonly knownDescriptor?: PlayerDescriptor | null;
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
    resourceActions: { kind: "Media", subject: { kind: "Stored", summary }, knownDescriptor: occurrence.knownDescriptor ?? null },
    primary: { ...occurrence.primary, paneLabelHint: summary.title },
    title: { text: summary.title },
    contributors: selectMediaAuthors(summary.contributors),
    publicationDate: summary.original_published_date,
    context: occurrence.searchEvidence?.length
      ? { kind: "Snippet", segments: occurrence.searchEvidence }
      : null,
    activity: null,
    exceptionalStatus: null,
    resourceRef: occurrence.resourceRef,
    selected: occurrence.selected,
  };
}
