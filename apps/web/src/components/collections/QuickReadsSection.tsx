"use client";

import { useRef, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import LecternAddControl from "@/components/collections/LecternAddControl";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PaneSection from "@/components/ui/PaneSection";
import { apiTransportFeedback } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { lecternFull, useLectern } from "@/lib/lectern/lectern";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { getQuickReads, presentSuggestionItem, type QuickReads } from "@/lib/suggestions";
import { findPaneCollectionRowFocusTarget } from "@/lib/workspace/paneDom";
import { definePaneVisitDataKey, usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./LecternAddControl.module.css";

const VISIT = definePaneVisitDataKey<Visit<QuickReads>>("Suggestions.QuickReads");

/** The direct quick-read query keeps the normal read and inspected-add owners. */
export default function QuickReadsSection({ isActive }: { isActive: boolean }) {
  const paneId = usePaneRuntime()?.paneId;
  const full = lecternFull(useLectern());
  const [seen, setSeen] = useState(isActive);
  if (isActive && !seen) setSeen(true);
  const refresh = useRefreshStamp(isActive, null);
  const read = useServerValue({
    key: seen ? "/lectern/quick-reads" : null,
    stale: String(refresh),
    visit: VISIT,
    load: getQuickReads,
  });
  const loaded = read.status === "ready" ? read.data : null;
  const failure = read.status === "loading" ? null : read.error;
  const summaries = useMediaSummaries(loaded?.items.flatMap((item) =>
    item.target.kind === "Media" ? [item.target.media_summary] : []) ?? []);
  const rows = loaded?.items.flatMap((item) => {
    if (item.target.kind !== "Media") return [presentSuggestionItem(item)];
    const mediaSummary = summaries.resolve(item.target.media_summary);
    return mediaSummary === null ? [] : [presentSuggestionItem({ ...item,
      target: { ...item.target, media_summary: mediaSummary } })];
  }) ?? [];
  const rootRef = useRef<HTMLElement>(null);
  usePaneReturnDescendantReady({ rootRef, ready: read.status !== "loading" });
  const failureTitle = loaded === null ? "couldn’t load quick reads" : "couldn’t refresh quick reads";
  const failureNotice = failure === null ? null : <FeedbackNotice
    content={apiTransportFeedback(failure, failureTitle) ?? {
      tone: "Danger", title: failureTitle, requestId: failure.requestId,
    }}
    announcement="Polite" actions={[{ label: "retry", onClick: read.refetch }]} />;
  return (
    <PaneSection ref={rootRef} className={styles.collection} title="Quick reads" aria-label="Quick reads" tabIndex={-1}>
      <CollectionView
        returnScope="Lectern.QuickReads" ariaLabel="Quick reads" rows={rows}
        status={read.status === "failed" ? "error" : read.status}
        rowControls={Object.fromEntries(rows.filter((row) => row.id.startsWith("media:")).map((row) => [row.id,
          <LecternAddControl key={row.id} mediaId={row.id.slice("media:".length)}
            title={row.title.text} returnFocus={() => findPaneCollectionRowFocusTarget(paneId, row.id)} />,
        ]))}
        notice={<>
          {full ? <FeedbackNotice content={{ tone: "Neutral", title: "lectern is full", message: "remove an item to add another." }} announcement="None" /> : null}
          {loaded !== null ? failureNotice : null}
          <MediaSummaryNotice error={summaries.error} retry={summaries.retry} />
        </>}
        error={failureNotice}
        empty={<p>No quick reads.</p>}
        surface={false}
      />
    </PaneSection>
  );
}
