"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import CollectionView from "@/components/collections/CollectionView";
import { Fact, Failed } from "@/components/feedback/Fact";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import { assertNever } from "@/lib/assertNever";
import { isAbortError } from "@/lib/errors";
import { presentSuggestionItem, type SuggestionItem, type SuggestionsDestination, type SuggestionTarget } from "@/lib/suggestions";
import { useLecternCommands } from "@/lib/lectern/lectern";
import { PaneRefreshAnchor, usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";
import type { SuggestionsController } from "@/lib/useSuggestions";

/** A suggested podcast is the one row with a control: `add` opens its subscribe dialog, whose
 * acceptance acknowledges the row. Media rows carry their own commands, and a lectern receipt for
 * one acknowledges it. Only named libraries suggest podcasts. A first read's or first request's
 * failure stands where the rows would; over a shown pool, failures say nothing and heal. A stopped
 * job says so above the rows, or in their place. */
export default function SuggestionsSection({ destination, suggestions, subscribe, returnScope }: {
  destination: SuggestionsDestination;
  suggestions: SuggestionsController;
  subscribe?: (target: Extract<SuggestionTarget, { kind: "Podcast" }>) => void;
  returnScope: string;
}) {
  const lectern = destination.kind === "Lectern";
  const { receipts } = useLecternCommands();
  const previousReceipts = useRef<typeof receipts>(new Map());
  const [retrying, setRetrying] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  usePaneReturnDescendantReady({ rootRef, ready: suggestions.state !== null || suggestions.readFailure !== null || suggestions.withdrawn });
  const sectionId = `suggestions-${useId().replaceAll(":", "")}`;
  const summaries = useMediaSummaries(suggestions.rows.flatMap((item) =>
    item.target.kind === "Media" ? [item.target.media_summary] : []));
  const publishedRows = suggestions.rows;
  const rows = useMemo(() => publishedRows.flatMap<SuggestionItem>((item) => {
    if (item.target.kind !== "Media") return [item];
    const summary = summaries.resolve(item.target.media_summary);
    return summary === null ? [] : [{ ...item, target: { ...item.target, media_summary: summary } }];
  }), [publishedRows, summaries]);
  const presentedRows = useMemo(() => rows.map(presentSuggestionItem), [rows]);
  const { acknowledge } = suggestions;
  useEffect(() => {
    if (lectern) {
      for (const [mediaId, receipt] of receipts) {
        if (receipt.intentKind === "Ensure" && receipt.present &&
            previousReceipts.current.get(mediaId)?.order_revision !== receipt.order_revision)
          acknowledge(`media:${mediaId}`);
      }
    }
    previousReceipts.current = receipts;
  }, [lectern, receipts, acknowledge]);

  let needsRepair = false;
  const work = suggestions.state?.work;
  if (work != null) {
    switch (work) {
      case "Queued": case "Running": case "Recovering": break;
      case "Suspended": needsRepair = true; break;
      default: assertNever(work);
    }
  }
  const coldFailure = suggestions.adopted === null ? suggestions.readFailure?.error ?? null : null;
  const admissionFailure = suggestions.adopted === null && coldFailure === null && !needsRepair ? suggestions.admissionError?.error ?? null : null;
  const waiting = suggestions.adopted === null && coldFailure === null && admissionFailure === null && !needsRepair;

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try {
      await suggestions.retry();
    } catch (error) {
      if (!isAbortError(error)) setDefect({ error });
    } finally {
      setRetrying(false);
    }
  }

  const sectionVisible = !suggestions.withdrawn && suggestions.state?.capability !== "NotApplicable";
  // Section visibility and its facts can move the eye-line independently of rows.
  const noticeGeometry = useMemo(() => sectionVisible ? { visible: sectionVisible, waiting, needsRepair, coldFailure, admissionFailure } : null,
  [sectionVisible, waiting, needsRepair, coldFailure, admissionFailure]);
  const repair = needsRepair ? <Fact line={{ fact: "suggestions stopped updating.", reason: "the job that finds them needs a repair." }} /> : null;
  if (defect) throw defect.error;
  const title = lectern ? "suggestions" : "suggested for this library";
  const ariaLabel = lectern ? "suggestions" : `suggestions for ${destination.name}`;
  return (
    <PaneRefreshAnchor identity={`${returnScope}:notices`} value={noticeGeometry} ready={!sectionVisible || !waiting}>
    {sectionVisible ? <PaneSection
      ref={rootRef}
      id={sectionId}
      aria-label={ariaLabel}
      tabIndex={-1}
      title={title}
    >
      <CollectionView geometry="UniformIndex"
        returnScope={returnScope}
        rows={presentedRows}
        status={waiting ? "loading" : "ready"}
        ariaLabel={ariaLabel}
        surface={false}
        notice={rows.length > 0 ? repair : null}
        empty={coldFailure !== null ? <Failed error={coldFailure} noun="suggestions" retry={{ run: () => void retry(), busy: retrying || suggestions.reconciling }} />
          : admissionFailure !== null ? <Failed error={admissionFailure} noun="suggestions" retry={{ run: suggestions.retryAdmission, busy: suggestions.admitting }} />
            : repair ?? (suggestions.adopted !== null ? <Fact line={{ fact: "no suggestions right now." }} /> : undefined)}
        rowControls={subscribe === undefined || destination.kind !== "Library" ? undefined : Object.fromEntries(rows.flatMap(({ target }) => target.kind !== "Podcast" ? [] : [[target.ref,
          <Button key={target.ref} aria-label={`add ${target.title} to ${destination.name}`} onClick={() => subscribe(target)}>add</Button>,
        ]]))}
      />
    </PaneSection> : null}
    </PaneRefreshAnchor>
  );
}
