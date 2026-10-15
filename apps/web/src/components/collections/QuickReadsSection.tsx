"use client";

import { useEffect, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import LecternAddControl from "@/components/collections/LecternAddControl";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PaneSection from "@/components/ui/PaneSection";
import { useResource } from "@/lib/api/useResource";
import { useChangeStamp } from "@/lib/api/changes";
import { useMediaQueryRevision, useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import MediaSummaryNotice from "./MediaSummaryNotice";
import { getSuggestions, presentSuggestionItem, type Suggestions } from "@/lib/suggestions";
import { parseMediaId } from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { findPaneCollectionRowFocusTarget } from "@/lib/workspace/paneDom";
import styles from "./LecternAddControl.module.css";

export default function QuickReadsSection({ isActive }: { isActive: boolean }) {
  const paneId = usePaneRuntime()?.paneId;
  const lectern = useLectern();
  const changes = useChangeStamp("Consumption", "Entries");
  const queryRevision = useMediaQueryRevision();
  const [retained, setRetained] = useState<Suggestions | null>(null);
  const factsRevision = `${changes}:${queryRevision}`;
  const resource = useResource<{ snapshot: Suggestions; factsRevision: string }>({
    cacheKey: isActive ? `lectern:quick-reads:${factsRevision}` : null,
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
    item.target.kind === "Media" ? [item.target.media_summary] : []) ?? []);
  const rows = loaded?.items.flatMap((item) => {
    if (item.target.kind !== "Media") return [presentSuggestionItem(item)];
    const mediaSummary = summaries.resolve(item.target.media_summary);
    return mediaSummary === null ? [] : [presentSuggestionItem({ ...item,
      target: { ...item.target, media_summary: mediaSummary } })];
  }) ?? [];
  return (
    <PaneSection
      className={styles.collection}
      title="Quick reads"
      aria-label="Quick reads"
      tabIndex={-1}
    >
      <CollectionView
        returnScope="Lectern.QuickReads"
        ariaLabel="Quick reads"
        rows={rows}
        status={loaded !== null ? "ready" : resource.status === "idle" ? "loading" : resource.status}
        rowControls={Object.fromEntries(rows.filter((row) => row.id.startsWith("media:")).map((row) => [row.id,
          <LecternAddControl key={row.id} mediaId={parseMediaId(row.id.slice("media:".length))}
            title={row.title.text} returnFocus={() => findPaneCollectionRowFocusTarget(paneId, row.id)} />,
        ]))}
        notice={<>
          {lectern.resource.status === "ready" && lectern.resource.data.atCapacity ? <FeedbackNotice
            content={{ tone: "Neutral", title: "lectern is full", message: "remove an item to add another." }}
            announcement="None" /> : null}
          {resource.status === "error" && loaded !== null ? <FeedbackNotice
            content={{ tone: "Danger", title: "couldn’t refresh quick reads", message: "showing the last loaded items.", requestId: resource.error.requestId }}
            announcement="Polite" actions={[{ label: "retry", onClick: resource.retry }]} /> : null}
          <MediaSummaryNotice error={summaries.error} retry={summaries.retry} />
        </>}
        error={resource.status === "error" ? (
          <FeedbackNotice
            content={{
              tone: "Danger",
              title: "couldn’t load quick reads",
              requestId: resource.error.requestId,
            }}
            announcement="Polite"
            actions={[{ label: "retry", onClick: resource.retry }]}
          />
        ) : undefined}
        empty={<p>No quick reads.</p>}
        surface={false}
      />
    </PaneSection>
  );
}
