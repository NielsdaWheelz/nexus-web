"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import type { DocumentReaderSession, ReaderSectionContextLease, ReaderViewCapacity } from "@/lib/reader/DocumentReaderSession";
import { readerCapacityNotice } from "@/lib/reader/readerCapacity";
import type { ReaderResumeState } from "@/lib/reader/types";
import Button from "@/components/ui/Button";
import PaneToolbar from "@/components/ui/PaneToolbar";
import ReaderContentBoundary from "./ReaderContentBoundary";

type Point = Extract<ReaderResumeState, { kind: "epub" }>;
type State = { kind: "Loading" } | { kind: "Ready"; lease: ReaderSectionContextLease } | ReaderViewCapacity | { kind: "Failed"; error: unknown };

/** Three authored section summaries replace the whole-document section select. */
export default function PublicationSectionControls({ session, point, onNavigate, onContents }: {
  readonly session: DocumentReaderSession;
  readonly point: Point | null;
  readonly onNavigate: (sectionId: string) => void;
  readonly onContents: (() => void) | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ session: DocumentReaderSession; point: Point; attempt: number; state: State } | null>(null);
  const state: State = result?.session === session && result.point === point && result.attempt === attempt
    ? result.state : { kind: "Loading" };
  const retry = () => setAttempt((value) => value + 1);
  useEffect(() => {
    if (point === null) return;
    const abort = new AbortController();
    let lease: ReaderSectionContextLease | null = null;
    const publish = (state: State) => setResult({ session, point, attempt, state });
    void (async () => {
      if (session.sectionContext === null) throw new Error("Hosted chapter controls require retained section context");
      return session.sectionContext(point, abort.signal);
    })().then((value) => {
      if (value.kind !== "Acquired") { if (!abort.signal.aborted) publish(value); return; }
      lease = value.lease;
      if (abort.signal.aborted) { lease.release(); return; }
      publish({ kind: "Ready", lease });
    }).catch((error: unknown) => {
      lease?.release();
      if (!abort.signal.aborted && !isAbortError(error)) publish({ kind: "Failed", error });
    });
    return () => {
      abort.abort();
      setResult((current) => current?.session === session && current.point === point && current.attempt === attempt ? null : current);
      lease?.release();
    };
  }, [session, point, attempt]);
  const notice = state.kind === "Capacity" ? readerCapacityNotice(state.reason) : null;
  const lease = state.kind === "Ready" && !state.lease.released ? state.lease : null;
  const context = lease?.context;
  const previousSectionId = context?.previous?.section_id ?? null;
  const nextSectionId = context?.next?.section_id ?? null;
  const defect = state.kind === "Failed" && (!isApiError(state.error) || isSameSystemApiDefect(state.error))
    ? { key: `chapter-context:${attempt}`, error: state.error, retry } : null;
  return <ReaderContentBoundary defect={defect} ready={lease !== null} retry={retry}>
    <PaneToolbar variant="Instrument" controls={<>
      <Button variant="ghost" size="sm" iconOnly aria-label="Previous section" disabled={previousSectionId === null}
        onClick={() => { if (lease !== null && !lease.released && previousSectionId !== null) onNavigate(previousSectionId); }}><ChevronLeft size={16} aria-hidden="true" /></Button>
      <span aria-live="polite" aria-busy={state.kind === "Loading"} aria-label={context?.section_position != null ? `Section ${context.section_position} of ${context.section_count}` : undefined}>
        {context?.section_position != null ? `${context.section_position} / ${context.section_count}` : state.kind === "Loading" ? "Loading sections…" : null}
      </span>
      <Button variant="ghost" size="sm" iconOnly aria-label="Next section" disabled={nextSectionId === null}
        onClick={() => { if (lease !== null && !lease.released && nextSectionId !== null) onNavigate(nextSectionId); }}><ChevronRight size={16} aria-hidden="true" /></Button>
      {onContents === null ? null : <Button variant="ghost" size="sm" onClick={onContents}>Contents</Button>}
      {notice !== null ? <span role="status">{notice.message}</span> : null}
      {state.kind === "Failed" && defect === null ? <span role="alert">Section controls could not load.</span> : null}
      {(notice !== null && notice.retryable) || (state.kind === "Failed" && defect === null) ? <Button variant="ghost" size="sm" onClick={retry}>Retry sections</Button> : null}
    </>} />
  </ReaderContentBoundary>;
}
