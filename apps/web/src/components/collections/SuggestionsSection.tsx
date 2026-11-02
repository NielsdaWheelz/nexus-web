"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import CollectionView from "@/components/collections/CollectionView";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useOutcome } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import { isApiError } from "@/lib/api/client";
import { assertNever } from "@/lib/assertNever";
import { isAbortError } from "@/lib/errors";
import { presentSuggestionItem, type SuggestionItem, type SuggestionsDestination, type SuggestionTarget } from "@/lib/suggestions";
import { useLecternCommands } from "@/lib/lectern/lectern";
import { PaneRefreshAnchor, usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";
import type { SuggestionsController } from "@/lib/useSuggestions";

/** The command owner retains uncertain work; only its receipt removes a row. A first read's or
 * first request's failure stands where the rows would; over a shown pool, failures say nothing
 * and heal. A stopped job says so above the rows, or in their place. */
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
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [retrying, setRetrying] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const outcome = useOutcome();
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

  const busyWith = (ref: string, on: boolean) => setAdding((current) => {
    const next = new Set(current);
    if (on) next.add(ref);
    else next.delete(ref);
    return next;
  });
  async function add(item: SuggestionItem) {
    busyWith(item.target.ref, true);
    try {
      if (await accept(item.target) === "Accepted" && !lectern) acknowledge(item.target.ref);
    } catch (error) {
      // Only the lectern's ensure refuses here; an unknown outcome settles `Retained` and holds there.
      const fact = `couldn’t add “${item.target.kind === "Media" ? item.target.media_summary.title : item.target.title}” to the lectern.`;
      if (isApiError(error) && error.code === "E_LIMIT") outcome.say({ fact, reason: "the lectern is full." });
      else if (isApiError(error) && error.code === "E_RESOURCE_CONFLICT") outcome.say({ fact, reason: "the lectern changed meanwhile." });
      else outcome.fail(error, fact);
    } finally {
      busyWith(item.target.ref, false);
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
        rowControls={Object.fromEntries(rows.flatMap((item) => item.target.kind === "Media" ? [] : [[item.target.ref,
          <Button key={item.target.ref} aria-label={`add ${item.target.title} to ${destination.kind === "Library" ? destination.name : "lectern"}`}
            aria-disabled={adding.has(item.target.ref) || undefined} aria-busy={adding.has(item.target.ref) || undefined}
            onClick={() => { if (!adding.has(item.target.ref)) void add(item); }}>add</Button>,
        ]]))}
      />
    </PaneSection> : null}
    </PaneRefreshAnchor>
  );
}
