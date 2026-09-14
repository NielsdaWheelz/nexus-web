"use client";

import { useEffect, useRef, useState } from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { createRandomId } from "@/lib/createRandomId";
import type { DocumentReaderSession, ReaderDomLease, ReaderOverlayLease, ReaderViewCapacity } from "@/lib/reader/DocumentReaderSession";
import { readerCapacityNotice } from "@/lib/reader/readerCapacity";
import type { ReaderContentDefect } from "./ReaderContentBoundary";

/** The tooltip owns one excerpt; full authored text belongs to explicit detail pages. */
export default function ReaderApparatusPreview({ session, stableKey, classNames, onDefect }: {
  readonly session: DocumentReaderSession;
  readonly stableKey: string;
  readonly classNames: { readonly container: string; readonly meta: string; readonly body: string };
  readonly onDefect: (defect: ReaderContentDefect | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<{ readonly kind: "Loading" | "Ready" | "Failed" } | ReaderViewCapacity>({ kind: "Loading" });
  const { meta, body } = classNames;
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const controller = new AbortController();
    let lease: ReaderOverlayLease | null = null;
    let dom: ReaderDomLease | null = null;
    const retire = () => {
      // DOM text must stop retaining the excerpt before its payload is released.
      root.replaceChildren();
      lease?.release(); lease = null;
      dom?.release(); dom = null;
    };
    setStatus({ kind: "Loading" });
    onDefect(null);
    void (async () => {
      if (session.overlays === null) throw new Error("Hosted reader apparatus capability is unavailable");
      const result = await session.overlays({ kind: "ApparatusLookup", request: { stable_key: stableKey } }, controller.signal);
      if (result.kind === "Capacity") {
        if (!controller.signal.aborted) setStatus(result);
        return;
      }
      if (controller.signal.aborted) { result.lease.release(); return; }
      lease = result.lease;
      if (lease.result.kind !== "ApparatusLookup") throw new Error("Reader preview received another overlay");
      // Two text-bearing elements and this fixed host. No source row enters React state.
      dom = session.reserveDomNodes(5);
      if (dom === null) { retire(); setStatus({ kind: "Capacity", reason: "Dom" }); return; }
      const summary = lease.result.page;
      const heading = document.createElement("div");
      heading.className = meta;
      heading.textContent = summary.kind.replaceAll("_", " ") + (summary.confidence === "exact" ? "" : ` / ${summary.confidence}`);
      const excerpt = document.createElement("div");
      excerpt.className = body;
      excerpt.setAttribute("aria-label", "Source note excerpt");
      excerpt.textContent = summary.body_excerpt ?? summary.label_excerpt ?? "This source note has no text.";
      root.append(heading, excerpt);
      setStatus({ kind: "Ready" });
    })().catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      retire();
      setStatus({ kind: "Failed" });
      if (!isApiError(error) || isSameSystemApiDefect(error)) {
        onDefect({ key: createRandomId("apparatus-preview"), error,
          retry: () => { if (!controller.signal.aborted) setAttempt((value) => value + 1); } });
      }
    });
    return () => { controller.abort(); retire(); onDefect(null); };
  }, [attempt, body, meta, onDefect, session, stableKey]);

  const notice = status.kind === "Capacity" ? readerCapacityNotice(status.reason) : null;
  return <div aria-busy={status.kind === "Loading"}>
    <div ref={rootRef} className={classNames.container} role="group" aria-label="Source note preview" />
    {status.kind === "Loading" ? <p>Loading source note…</p> : null}
    {notice !== null ? <p>{notice.message}{notice.retryable ? " Reopen to retry." : ""}</p> : null}
    {status.kind === "Failed" ? <p>Source note could not be loaded.</p> : null}
  </div>;
}
