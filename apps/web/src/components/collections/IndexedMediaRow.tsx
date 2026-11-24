"use client";

import { useLayoutEffect, useRef } from "react";
import Button from "@/components/ui/Button";
import CollectionRow from "@/components/collections/CollectionRow";
import type { CollectionViewRowRenderProps } from "@/components/collections/CollectionView";
import { presentMedia } from "@/lib/collections/presenters/media";
import { useMediaSummaryIds } from "@/lib/media/MediaSummaryProvider";
import type { MediaSummary } from "@/lib/media/mediaSummary";
import { usePaneScrollMotion } from "@/lib/workspace/paneReturnMemento";

/** A complete index supplies identity and title. Only mounted rows retain live summaries. */
export default function IndexedMediaRow({ mediaId, saved, containingPodcastId, occurrenceActions, className, onAnimationEnd, ...props }: CollectionViewRowRenderProps & {
  readonly mediaId: string;
  readonly saved?: MediaSummary;
  readonly containingPodcastId?: string;
  readonly occurrenceActions?: Parameters<typeof CollectionRow>[0]["occurrenceActions"];
  readonly className?: Parameters<typeof CollectionRow>[0]["className"];
  readonly onAnimationEnd?: Parameters<typeof CollectionRow>[0]["onAnimationEnd"];
}) {
  const motion = usePaneScrollMotion();
  const admitted = useRef(false);
  useLayoutEffect(() => { if (motion === "still") admitted.current = true; }, [motion]);
  // The index alone can paint every slot during travel. Demand a new body at
  // the landing; a row with an admitted body keeps it while it remains mounted.
  const summaries = useMediaSummaryIds(saved === undefined && (motion === "still" || admitted.current) ? [mediaId] : []);
  const summary = saved ?? summaries.resolve(mediaId);
  const { row } = props;
  const unavailable = summary === null && !summaries.pending(mediaId) && summaries.error === null;
  const resolved = unavailable
    ? { ...row, resourceRef: null, primary: { kind: "static" as const }, title: { text: "item unavailable" } }
    : summary === null || row.resourceRef === null || row.primary.kind !== "link" ? row
    : { ...presentMedia(summary, { id: row.id, resourceRef: row.resourceRef, primary: row.primary, selected: row.selected }), title: row.title };
  return <CollectionRow {...props} row={resolved} containingPodcastId={containingPodcastId} occurrenceActions={occurrenceActions}
    primaryControl={summaries.error !== null && summary === null
      ? <Button aria-label={`retry details for ${row.title.text}`} disabled={summaries.retrying} onClick={summaries.retry}>retry details</Button>
      : props.primaryControl}
    rowActionsAvailable={props.rowActionsAvailable && !unavailable} className={className} onAnimationEnd={onAnimationEnd} />;
}
