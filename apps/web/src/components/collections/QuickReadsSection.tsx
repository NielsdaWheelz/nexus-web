"use client";

import { useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PaneSection from "@/components/ui/PaneSection";
import { apiTransportFeedback } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { useQuickReadsEntryRead } from "@/lib/panes/suggestionEntryReads";
import { lecternFull, useLectern } from "@/lib/lectern/lectern";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { presentSuggestionItem, type QuickReads } from "@/lib/suggestions";
import { definePaneVisitDataKey, usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";

const VISIT = definePaneVisitDataKey<Visit<QuickReads>>("Suggestions.QuickReads");

/** The direct quick-read query keeps the normal read and inspected-add owners. */
export default function QuickReadsSection() {
  const full = lecternFull(useLectern());
  const descriptor = useQuickReadsEntryRead();
  // justify-defect: the lectern entry owns this section's exact read descriptor.
  if (descriptor === null) throw new Error("quick reads without lectern entry");
  const read = useServerValue({ ...descriptor, visit: VISIT });
  const loaded = read.status === "ready" ? read.data : null;
  const failure = read.status === "loading" ? null : read.error;
  // Quick reads are media only (the server's direct read).
  const items = loaded?.items.flatMap((item) => item.target.kind === "Media" ? [item.target] : []) ?? [];
  const summaries = useMediaSummaries(items.map((target) => target.media_summary));
  const rows = items.flatMap((target) => {
    const mediaSummary = summaries.resolve(target.media_summary);
    return mediaSummary === null ? [] : [presentSuggestionItem({ target: { ...target, media_summary: mediaSummary } })];
  });
  const rootRef = useRef<HTMLElement>(null);
  usePaneReturnDescendantReady({ rootRef, ready: read.status !== "loading" });
  const failureTitle = loaded === null ? "couldn’t load quick reads" : "couldn’t refresh quick reads";
  const failureNotice = failure === null ? null : <FeedbackNotice
    content={apiTransportFeedback(failure, failureTitle) ?? {
      tone: "Danger", title: failureTitle, requestId: failure.requestId,
    }}
    announcement={loaded === null ? "Polite" : "None"} actions={[{ label: "try again", onClick: read.refetch }]} />;
  return (
    <PaneSection ref={rootRef} title="Quick reads" aria-label="Quick reads" tabIndex={-1}>
      <CollectionView geometry="UniformIndex"
        returnScope="Lectern.QuickReads" ariaLabel="Quick reads" rows={rows}
        status={read.status === "failed" ? "error" : read.status}
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
