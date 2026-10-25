"use client";

import { installedApp } from "@/lib/native/admission";
import { useEffect, useId, useRef, useState } from "react";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import { isApiError, isStaleBuild } from "@/lib/api/client";
import { modeledApiError } from "@/lib/api/serverState";
import { assertNever } from "@/lib/assertNever";
import { isAbortError } from "@/lib/errors";
import { presentSuggestionItem, type SuggestionItem, type SuggestionsDestination, type SuggestionTarget } from "@/lib/suggestions";
import { useLecternCommands } from "@/lib/lectern/lectern";
import { usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";
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
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const announced = useRef(new Set<string>());
  const rootRef = useRef<HTMLElement>(null);
  usePaneReturnDescendantReady({ rootRef, ready: suggestions.state !== null || suggestions.readFailure !== null || suggestions.withdrawn });
  const sectionId = `suggestions-${useId().replaceAll(":", "")}`;
  const summaries = useMediaSummaries(suggestions.rows.flatMap((item) =>
    item.target.kind === "Media" ? [item.target.media_summary] : []));
  const rows = suggestions.rows.flatMap<SuggestionItem>((item) => {
    if (item.target.kind !== "Media") return [item];
    const summary = summaries.resolve(item.target.media_summary);
    return summary === null ? [] : [{ ...item, target: { ...item.target, media_summary: summary } }];
  });
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
  useEffect(() => {
    const firstCompletion = suggestions.initialCompleted && !announced.current.has("first-completion");
    if (suggestions.initialCompleted) announced.current.add("first-completion");
    if (!suggestions.active || retrying) return;
    const event = notice ? { key: `add-error:${notice.text}`, text: notice.text }
      : readFailure && suggestions.readFailure?.owner !== "Pane"
        ? { key: `read-error:${readFailureText}:${readFailureError?.message}`, text: readFailureText }
      : suggestions.admissionError ? { key: `admission-error:${suggestions.admissionError.error.message}`, text: "couldn’t request suggestions." }
      : firstCompletion ? { key: "first-completion", text: rows.length ? "suggestions are ready." : "no suggestions right now." } : null;
    if (event === null || (event.key !== "first-completion" && announced.current.has(event.key))) return;
    announced.current.add(event.key);
    setAnnouncement(event.text);
  }, [suggestions.active, suggestions.readFailure, suggestions.admissionError, suggestions.initialCompleted, readFailure, readFailureText, readFailureError, rows.length, notice, retrying]);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setAnnouncement(suggestions.readFailure?.intention === "Initial" ? "loading suggestions…" : "refreshing suggestions…");
    try {
      const outcome = await suggestions.retry();
      switch (outcome) {
        case "Refreshed": setAnnouncement("suggestions refreshed."); break;
        case "Finding": setAnnouncement("finding suggestions…"); break;
        case "Repair": setAnnouncement("suggestions need repair."); break;
        case "Failed": setAnnouncement(readFailureText); break;
        case "NotApplicable": setAnnouncement(null); break;
        default: assertNever(outcome);
      }
    } catch (error) {
      if (isAbortError(error)) setAnnouncement(null);
      else setDefect({ error });
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

  if (defect) throw defect.error;
  if (suggestions.withdrawn || suggestions.state?.capability === "NotApplicable") return null;
  const title = lectern ? "suggestions" : "suggested for this library";
  const ariaLabel = lectern ? "suggestions" : `suggestions for ${destination.name}`;
  return (
    <PaneSection
      ref={rootRef}
      id={sectionId}
      aria-label={ariaLabel}
      tabIndex={-1}
      title={title}
    >
      <span className="sr-only" aria-live={suggestions.active ? "polite" : "off"} aria-atomic="true">{announcement}</span>
      <CollectionView
        returnScope={returnScope}
        rows={rows.map(presentSuggestionItem)}
        status={waiting ? "loading" : "ready"}
        ariaLabel={ariaLabel}
        surface={false}
        anchorKey={rows.map((item) => item.target.ref).join(",")}
        notice={<>
          {needsRepair ? <FeedbackNotice content={{ tone: "Warning", title: "suggestions need repair." }} announcement="None" /> : null}
          {atCapacity ? <FeedbackStatus content={{ tone: "Neutral", title: "lectern is full. remove an item to add another." }} announcement="None" /> : null}
          {readFailure ? <FeedbackNotice
            content={{ tone: "Danger", title: readFailureText, requestId: isApiError(readFailureError) ? readFailureError.requestId : undefined }}
            announcement="None" actions={[{ label: "retry", onClick: () => void retry(), busy: retrying || suggestions.reconciling }]} /> : null}
          {suggestions.admissionError ? <FeedbackNotice
            content={{ tone: "Danger", title: "couldn’t request suggestions.", requestId: suggestions.admissionError.error.requestId }}
            announcement="None" actions={[{ label: "retry", onClick: suggestions.retryAdmission, busy: suggestions.admitting }]} /> : null}
          {notice ? <FeedbackNotice content={{ tone: "Danger", title: notice.text, requestId: notice.requestId }} announcement="None" /> : null}
          <MediaSummaryNotice error={summaries.error} retry={summaries.retry} busy={summaries.retrying} />
        </>}
        empty={suggestions.adopted !== null ? <FeedbackStatus content={{ tone: "Neutral", title: "no suggestions right now." }} announcement="None" /> : undefined}
        rowControls={Object.fromEntries(rows.flatMap((item) => item.target.kind === "Media" ? [] : [[item.target.ref,
          <Button key={item.target.ref} aria-label={`add ${item.target.title} to ${destination.kind === "Library" ? destination.name : "lectern"}`}
            aria-disabled={adding.has(item.target.ref) || undefined} aria-busy={adding.has(item.target.ref) || undefined}
            onClick={() => { if (!adding.has(item.target.ref)) void add(item); }}>add</Button>,
        ]]))}
      />
    </PaneSection>
  );
}
