"use client";

import { useEffect, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PaneSection from "@/components/ui/PaneSection";
import { useResource } from "@/lib/api/useResource";
import { useConsumptionProjectionRevision } from "@/lib/consumption/projectionRevision";
import { useLibraryPlacementRevision } from "@/lib/libraries/placementRevision";
import { useMediaQueryRevision, useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import MediaSummaryNotice from "./MediaSummaryNotice";
import { getSuggestions, presentSuggestionItem, type Suggestions } from "@/lib/suggestions";

export default function QuickReadsSection({ isActive }: { isActive: boolean }) {
  const consumption = useConsumptionProjectionRevision();
  const placement = useLibraryPlacementRevision();
  const queryRevision = useMediaQueryRevision();
  const [retained, setRetained] = useState<Suggestions | null>(null);
  const factsRevision = [consumption.revision, placement.revision, queryRevision].join(":");
  const resource = useResource<{ snapshot: Suggestions; factsRevision: string }>({
    cacheKey: isActive || retained !== null ? `lectern:quick-reads:${factsRevision}` : null,
    load: async (signal) => ({ snapshot: await getSuggestions("/api/lectern/quick-reads", signal), factsRevision }),
  });
  useEffect(() => {
    if (resource.status === "ready" && resource.data.factsRevision === factsRevision) {
      setRetained(resource.data.snapshot);
    }
  }, [resource, factsRevision]);
  const loaded = resource.status === "ready" && resource.data.factsRevision === factsRevision
    ? resource.data.snapshot : retained;
  const summaries = useMediaSummaries(loaded?.items.flatMap((item) =>
    item.target.kind === "Media" ? [item.target.mediaSummary] : []) ?? []);
  const rows = loaded?.items.flatMap((item) => {
    if (item.target.kind !== "Media") return [presentSuggestionItem(item)];
    const mediaSummary = summaries.resolve(item.target.mediaSummary);
    return mediaSummary.kind === "Absent" ? [] : [presentSuggestionItem({ ...item,
      target: { ...item.target, mediaSummary: mediaSummary.value } })];
  }) ?? [];
  return (
    <PaneSection
      title="Quick reads"
      aria-label="Quick reads"
      tabIndex={-1}
    >
      <CollectionView
        returnScope="Lectern.QuickReads"
        ariaLabel="Quick reads"
        rows={rows}
        status={loaded !== null ? "ready" : resource.status === "idle" ? "loading" : resource.status}
        notice={<MediaSummaryNotice error={resource.status === "error" && loaded !== null
          ? resource.error : summaries.error} retry={() => {
          if (summaries.error !== null) summaries.retry();
          if (resource.status === "error") resource.retry();
        }} />}
        error={resource.status === "error" ? (
          <FeedbackNotice
            content={{
              tone: "Danger",
              title: "Couldn’t load quick reads.",
              requestId: resource.error.requestId,
            }}
            announcement="Polite"
            actions={[{ label: "Retry", onClick: resource.retry }]}
          />
        ) : undefined}
        empty={<p>No quick reads.</p>}
        surface={false}
      />
    </PaneSection>
  );
}
