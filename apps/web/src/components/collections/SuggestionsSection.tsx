"use client";

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
  const [adopting, setAdopting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; requestId?: string } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef(new Set<string>());
  const rootRef = useRef<HTMLElement>(null);
  usePaneReturnDescendantReady({ rootRef, ready: suggestions.state !== null || suggestions.readError !== null || suggestions.withdrawn });
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

  const work = suggestions.state?.work;
  let preparing = false;
  let needsRepair = false;
  if (work != null) {
    switch (work) {
      case "Queued": case "Running": case "Recovering": preparing = true; break;
      case "Suspended": needsRepair = true; break;
      default: assertNever(work);
    }
  }
  const readFailure = suggestions.readError !== null || suggestions.observationInterrupted;
  const readFailureText = suggestions.adopted === null && suggestions.readError !== null
    ? "couldn’t load suggestions." : "couldn’t check for new suggestions.";
  const readFailureError = suggestions.readError ?? suggestions.observationError;
  const waiting = suggestions.adopted === null && !readFailure && suggestions.admissionError === null && !needsRepair;
  const progress = waiting ? suggestions.state === null ? "loading suggestions…" : "finding suggestions…"
    : preparing ? suggestions.adopted === null ? "finding suggestions…" : "updating suggestions…" : null;
  const firstCompletion = suggestions.adopted !== null;
  const availableId = suggestions.staged?.id ?? null;
  useEffect(() => {
    if (!suggestions.active) return;
    const event = notice ? { key: `add-error:${notice.text}`, text: notice.text }
      : readFailure ? { key: `read-error:${readFailureText}:${readFailureError?.message}`, text: readFailureText }
      : suggestions.admissionError ? { key: `admission-error:${suggestions.admissionError.error.message}`, text: "couldn’t request suggestions." }
      : needsRepair ? { key: "repair", text: "suggestions need repair." }
      : availableId ? { key: `available:${availableId}`, text: "new suggestions are ready." }
      : firstCompletion ? { key: "first-completion", text: rows.length ? "suggestions are ready." : "no suggestions right now." } : null;
    if (event === null || announced.current.has(event.key)) return;
    announced.current.add(event.key);
    setAnnouncement(event.text);
  }, [suggestions.active, suggestions.admissionError, readFailure, readFailureText, readFailureError, needsRepair, availableId, firstCompletion, rows.length, notice]);

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
      if (modeled !== null && isStaleBuild(modeled)) setDefect({ error });
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
      onPointerDownCapture={suggestions.interact}
      onKeyDownCapture={suggestions.interact}
      onFocusCapture={suggestions.interact}
      actions={suggestions.staged !== null || adopting ? (
        <Button aria-disabled={adopting || undefined} aria-busy={adopting || undefined}
          onClick={async (event) => {
            if (adopting) return;
            const button = event.currentTarget;
            setAdopting(true);
            const adopted = await suggestions.adopt();
            if (adopted) {
              setAnnouncement("showing new suggestions.");
              // The button stays mounted while awaiting adoption, so this checks
              // its current focus ownership, not focus captured before a request.
              if (document.activeElement === button) document.getElementById(sectionId)?.focus({ preventScroll: true });
            }
            setAdopting(false);
          }}>
          show new suggestions
        </Button>
      ) : undefined}
    >
      <span className="sr-only" aria-live={suggestions.active ? "polite" : "off"} aria-atomic="true">{announcement}</span>
      <CollectionView
        returnScope={returnScope}
        rows={rows.map(presentSuggestionItem)}
        status={waiting ? "loading" : "ready"}
        ariaLabel={ariaLabel}
        surface={false}
        rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: rows.map((item) => item.target.ref).join(",") }}
        notice={<>
          {progress ? <FeedbackStatus content={{ tone: "Neutral", title: progress }} announcement="None" /> : null}
          {suggestions.staged !== null ? <FeedbackStatus content={{ tone: "Neutral", title: "new suggestions are ready." }} announcement="None" /> : null}
          {needsRepair ? <FeedbackNotice content={{ tone: "Warning", title: "suggestions need repair." }} announcement="None" /> : null}
          {atCapacity ? <FeedbackStatus content={{ tone: "Neutral", title: "lectern is full. remove an item to add another." }} announcement="None" /> : null}
          {readFailure ? <FeedbackNotice
            content={{ tone: "Danger", title: readFailureText, requestId: isApiError(readFailureError) ? readFailureError.requestId : undefined }}
            announcement="None" actions={[{ label: "retry", onClick: suggestions.reconcile, busy: suggestions.reconciling }]} /> : null}
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
