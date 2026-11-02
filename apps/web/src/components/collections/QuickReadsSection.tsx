"use client";

import { useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { Fact, Failed } from "@/components/feedback/Fact";
import PaneSection from "@/components/ui/PaneSection";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { useQuickReadsEntryRead } from "@/lib/panes/suggestionEntryReads";
import { lecternFull, useLectern } from "@/lib/lectern/lectern";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { presentSuggestionItem, type QuickReads } from "@/lib/suggestions";
import { definePaneVisitDataKey, usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";

const VISIT = definePaneVisitDataKey<Visit<QuickReads>>("Suggestions.QuickReads");

/** The direct quick-read query keeps the normal read and inspected-add owners. It is the lectern
 * pane's one home for the lectern being full. */
export default function QuickReadsSection() {
  const full = lecternFull(useLectern());
  const descriptor = useQuickReadsEntryRead();
  // justify-defect: the lectern entry owns this section's exact read descriptor.
  if (descriptor === null) throw new Error("quick reads without lectern entry");
  const read = useServerValue({ ...descriptor, visit: VISIT });
  const loaded = read.status === "ready" ? read.data : null;
  // Quick reads are media only (the server's direct read).
  const items = loaded?.items.flatMap((item) => item.target.kind === "Media" ? [item.target] : []) ?? [];
  const summaries = useMediaSummaries(items.map((target) => target.media_summary));
  const rows = items.flatMap((target) => {
    const mediaSummary = summaries.resolve(target.media_summary);
    return mediaSummary === null ? [] : [presentSuggestionItem({ target: { ...target, media_summary: mediaSummary } })];
  });
  const rootRef = useRef<HTMLElement>(null);
  usePaneReturnDescendantReady({ rootRef, ready: read.status !== "loading" });
  return (
    <PaneSection ref={rootRef} title="Quick reads" aria-label="Quick reads" tabIndex={-1}>
      <CollectionView geometry="UniformIndex"
        returnScope="Lectern.QuickReads" ariaLabel="Quick reads" rows={rows}
        status={read.status === "failed" ? "error" : read.status}
        notice={full ? <Fact line={{ fact: "the lectern is full." }} /> : null}
        error={read.status === "failed" ? <Failed error={read.error} noun="quick reads" retry={{ run: read.refetch, busy: read.retrying }} /> : null}
        empty={<Fact line={{ fact: "no quick reads." }} />}
        surface={false}
      />
    </PaneSection>
  );
}
