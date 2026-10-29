"use client";

import { installedApp } from "@/lib/native/admission";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice, FeedbackFailure, useFeedbackOccurrence, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import { isApiError, isStaleBuild } from "@/lib/api/client";
import { modeledApiError } from "@/lib/api/serverState";
import { assertNever } from "@/lib/assertNever";
import { isAbortError } from "@/lib/errors";
import { presentSuggestionItem, type SuggestionItem, type SuggestionsDestination, type SuggestionTarget } from "@/lib/suggestions";
import { useLecternCommands } from "@/lib/lectern/lectern";
import { PaneRefreshAnchor, usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";
import type { SuggestionsController } from "@/lib/useSuggestions";

/** The command owner retains uncertain work; only its receipt removes a row. */
export type SuggestionAccept = (target: SuggestionTarget) => Promise<"Accepted" | "Retained">;

export default function SuggestionsSection({ destination, suggestions, accept, returnScope }: {
  destination: SuggestionsDestination;
  suggestions: SuggestionsController;
  accept: SuggestionAccept;
  returnScope: string;
}) {
  const lectern = destination.kind === "Lectern";
  const { receipts } = useLecternCommands();
  const previousReceipts = useRef<typeof receipts>(new Map());
  const atCapacity = lectern && suggestions.state?.capability === "LecternFull";
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<{ text: string; requestId?: string } | null>(null);
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
  const readFailure = suggestions.readFailure !== null || suggestions.observationInterrupted;
  const readFailureText = suggestions.readFailure?.intention === "Initial"
    ? "couldn’t load suggestions." : "couldn’t refresh suggestions.";
  const readFailureError = suggestions.readFailure?.error ?? suggestions.observationError;
  const waiting = suggestions.adopted === null && !readFailure && suggestions.admissionError === null && !needsRepair;
  const readOccurrence = useFeedbackOccurrence(readFailure, returnScope);
  const admissionOccurrence = useFeedbackOccurrence(suggestions.admissionError !== null, returnScope);
  const addOccurrence = useFeedbackOccurrence(notice !== null, returnScope);

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

  const busyWith = (ref: string, on: boolean) => setAdding((current) => {
    const next = new Set(current);
    if (on) next.add(ref);
    else next.delete(ref);
    return next;
  });
  async function add(item: SuggestionItem) {
    busyWith(item.target.ref, true);
    setNotice(null);
    try {
      if (await accept(item.target) === "Accepted" && !lectern) acknowledge(item.target.ref);
    } catch (error) {
      const modeled = modeledApiError(error, setDefect);
      if (modeled !== null && isStaleBuild(modeled) && !installedApp) setDefect({ error });
      else if (modeled !== null)
        setNotice({ text: lectern ? "lectern change not confirmed" : "library change not confirmed", requestId: modeled.requestId });
    } finally {
      busyWith(item.target.ref, false);
    }
  }

  const sectionVisible = !suggestions.withdrawn && suggestions.state?.capability !== "NotApplicable";
  // Section visibility and notices can move the eye-line independently of rows.
  const noticeGeometry = useMemo(() => sectionVisible ? { visible: sectionVisible, waiting, needsRepair, atCapacity, readFailure, readFailureText, readFailureError,
    admissionError: suggestions.admissionError, notice, summaryError: summaries.error } : null,
  [sectionVisible, waiting, needsRepair, atCapacity, readFailure, readFailureText, readFailureError, suggestions.admissionError, notice, summaries.error]);
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
        notice={<>
          {needsRepair ? <FeedbackNotice content={{ tone: "Warning", title: "suggestions need repair." }} announcement="None" /> : null}
          {atCapacity ? <FeedbackStatus content={{ tone: "Neutral", title: "lectern is full. remove an item to add another." }} announcement="None" /> : null}
          {readFailure ? <FeedbackFailure scope="Local" occurrence={readOccurrence}
            content={{ tone: "Danger", title: readFailureText, requestId: isApiError(readFailureError) ? readFailureError.requestId : undefined }}
            announcement="Polite" actions={[{ label: "retry", onClick: () => void retry(), busy: retrying || suggestions.reconciling }]} /> : null}
          {suggestions.admissionError ? <FeedbackFailure scope="Local" occurrence={admissionOccurrence}
            content={{ tone: "Danger", title: "couldn’t request suggestions.", requestId: suggestions.admissionError.error.requestId }}
            announcement="Polite" actions={[{ label: "retry", onClick: suggestions.retryAdmission, busy: suggestions.admitting }]} /> : null}
          {notice ? <FeedbackFailure scope="Local" occurrence={addOccurrence} content={{ tone: "Danger", title: notice.text, requestId: notice.requestId }} announcement="Polite" /> : null}
          <MediaSummaryNotice error={summaries.error} retry={summaries.retry} busy={summaries.retrying} />
        </>}
        empty={suggestions.adopted !== null ? <FeedbackStatus content={{ tone: "Neutral", title: "no suggestions right now." }} announcement="None" /> : undefined}
        rowControls={Object.fromEntries(rows.flatMap((item) => item.target.kind === "Media" ? [] : [[item.target.ref,
          <Button reserveIcon busyKey={item.target.ref} key={item.target.ref} aria-label={`add ${item.target.title} to ${destination.kind === "Library" ? destination.name : "lectern"}`}
            aria-disabled={adding.has(item.target.ref) || undefined} aria-busy={adding.has(item.target.ref) || undefined}
            onClick={() => { if (!adding.has(item.target.ref)) void add(item); }}>add</Button>,
        ]]))}
      />
    </PaneSection> : null}
    </PaneRefreshAnchor>
  );
}
