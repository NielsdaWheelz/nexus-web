"use client";

import { useCallback, useEffect, useState } from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import type { DocumentReaderSession, ReaderDomLease, ReaderIndexLease, ReaderViewCapacity } from "./DocumentReaderSession";
import type { ReaderMemberRef, ReaderPublicationIndex } from "./publicationContract";

type ContentsState =
  | { readonly kind: "Idle" | "Loading" }
  | { readonly kind: "Ready"; readonly page: ReaderPublicationIndex; readonly released: boolean; retain(): () => void }
  | ReaderViewCapacity
  | { readonly kind: "Failed"; readonly error: unknown };

/** One visible contents page owns one payload lease and its bounded row DOM. */
export function useReaderContents({ session, first, enabled }: {
  readonly session: DocumentReaderSession;
  readonly first: ReaderMemberRef | null;
  readonly enabled: boolean;
}) {
  // The trail is the member refs this reader has paged through. Index pages are
  // forward-linked, so backward traversal needs the refs it already visited; only
  // the visible page holds payload or DOM, so the trail costs no lease.
  const [trail, setTrail] = useState<{ session: DocumentReaderSession; refs: readonly ReaderMemberRef[] }>({ session, refs: [] });
  const visited = trail.session === session ? trail.refs : [];
  const reference = visited.at(-1) ?? first;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    session: DocumentReaderSession; reference: ReaderMemberRef; attempt: number; state: ContentsState;
  } | null>(null);
  const state: ContentsState = !enabled || reference === null ? { kind: "Idle" }
    : result?.session === session && result.reference === reference && result.attempt === attempt
      ? result.state.kind === "Ready" && result.state.released ? { kind: "Loading" } : result.state : { kind: "Loading" };
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!enabled || reference === null) return;
    const abort = new AbortController();
    let lease: ReaderIndexLease | null = null;
    let dom: ReaderDomLease | null = null;
    let withdrawPage: (() => void) | null = null;
    const publish = (state: ContentsState) => setResult({ session, reference, attempt, state });
    void session.readIndex(reference, abort.signal).then((value) => {
      if ("kind" in value) {
        if (!abort.signal.aborted) publish(value);
        return;
      }
      lease = value;
      if (abort.signal.aborted) { lease.release(); return; }
      const page = lease.page;
      if (page.units.length !== 0 || page.landmarks.length !== 0 || page.page_list.length !== 0 || page.table_metadata.length !== 0 || page.anchors.length !== 0 ||
          (page.toc.length !== 0 && page.sections.length !== 0) || page.toc.length + page.sections.length === 0) {
        throw new Error("Reader contents page mixes display and lookup records");
      }
      // The shared leaf uses at most four nodes per row plus its fixed chrome.
      dom = session.reserveDomNodes(16 + 4 * (page.toc.length + page.sections.length));
      if (dom === null) { lease.release(); publish({ kind: "Capacity", reason: "Dom" }); return; }
      let retainedPage: ReaderPublicationIndex | null = page;
      let consumers = 1;
      const release = () => {
        consumers -= 1;
        if (consumers !== 0) return;
        retainedPage = null;
        lease?.release(); lease = null;
        dom?.release(); dom = null;
      };
      withdrawPage = release;
      publish({ kind: "Ready", get page() {
        if (retainedPage === null) throw new Error("Contents page has retired");
        return retainedPage;
      }, get released() { return consumers === 0; }, retain() {
        if (consumers === 0) throw new Error("Contents page has retired");
        consumers += 1;
        let current = true;
        return () => { if (current) { current = false; release(); } };
      } });
    }).catch((error: unknown) => {
      lease?.release(); dom?.release();
      if (!abort.signal.aborted && !isAbortError(error)) publish({ kind: "Failed", error });
    });
    return () => {
      abort.abort();
      setResult((current) => current?.session === session && current.reference === reference && current.attempt === attempt ? null : current);
      if (withdrawPage !== null) { withdrawPage(); withdrawPage = null; }
      else { lease?.release(); dom?.release(); }
    };
  }, [enabled, reference, attempt, session]);

  return {
    state, retry,
    isFirst: reference?.key === first?.key,
    hasPrevious: visited.length > 0,
    first: () => setTrail({ session, refs: [] }),
    previous: () => setTrail({ session, refs: visited.slice(0, -1) }),
    next: () => {
      if (state.kind === "Ready" && !state.released && state.page.next_ref !== null) setTrail({ session, refs: [...visited, state.page.next_ref] });
    },
    defect: state.kind === "Failed" && (!isApiError(state.error) || isSameSystemApiDefect(state.error))
      ? { key: `contents:${reference?.key}:${attempt}`, error: state.error, retry } : null,
  };
}

export type ReaderContents = ReturnType<typeof useReaderContents>;
