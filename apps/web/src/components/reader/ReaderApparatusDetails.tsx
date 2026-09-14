"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import type { DocumentReaderSession, ReaderDomLease, ReaderOverlayLease, ReaderOverlayRequest, ReaderViewCapacity } from "@/lib/reader/DocumentReaderSession";
import { readerCapacityNotice } from "@/lib/reader/readerCapacity";
import type { ReaderContentDefect } from "./ReaderContentBoundary";
import styles from "./ReaderApparatusDetails.module.css";

type Page = Extract<ReaderOverlayRequest, { kind: "ApparatusLookup" | "ApparatusTargets" | "ApparatusText" }>;
export type ReaderApparatusLocationResult = { readonly kind: "Located" | "Unavailable" } | ReaderViewCapacity;

/** One selected note page; parents key the owner by the selected source key. */
export default function ReaderApparatusDetails({ session, stableKey, locateOnOpen, renderActions, onBack, onLocate, onDefect }: {
  readonly session: DocumentReaderSession;
  readonly stableKey: string;
  readonly locateOnOpen: boolean;
  readonly renderActions: (subject: ResourceActionSubject) => ReactNode;
  readonly onBack: () => void;
  readonly onLocate: (itemId: string, key: string, signal: AbortSignal) => Promise<ReaderApparatusLocationResult>;
  readonly onDefect: (defect: ReaderContentDefect | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const initialLocationCompleted = useRef(false);
  const [request, setRequest] = useState<Page>({ kind: "ApparatusLookup", request: { stable_key: stableKey } });
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState<{ request: Page; subject: ResourceActionSubject } | null>(null);
  const [status, setStatus] = useState<{ readonly kind: "Loading" | "Ready" | "Failed" } | ReaderViewCapacity>({ kind: "Loading" });
  const [locationStatus, setLocationStatus] = useState<{ readonly kind: "Idle" | "Loading" | "Unavailable" | "Failed" } | ReaderViewCapacity>({ kind: "Idle" });
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const controller = new AbortController();
    let lease: ReaderOverlayLease | null = null;
    let dom: ReaderDomLease | null = null;
    let locating = false;
    const retire = () => {
      root.replaceChildren();
      lease?.release(); lease = null;
      dom?.release(); dom = null;
    };
    const fail = (error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) {
        onDefect({ key: createRandomId("apparatus-detail"), error,
          retry: () => { if (!controller.signal.aborted) setAttempt((value) => value + 1); } });
      }
    };
    const locate = async (itemId: string, key: string) => {
      if (controller.signal.aborted || locating) return;
      locating = true;
      setLocationStatus({ kind: "Loading" });
      try {
        const result = await onLocate(itemId, key, controller.signal);
        if (!controller.signal.aborted) {
          setLocationStatus(result.kind === "Located" ? { kind: "Idle" }
            : result.kind === "Capacity" ? result : { kind: "Unavailable" });
        }
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) { setLocationStatus({ kind: "Failed" }); fail(error); }
      } finally {
        if (!controller.signal.aborted) initialLocationCompleted.current = true;
        locating = false;
      }
    };
    const button = (parent: HTMLElement, label: string, action: () => void) => {
      const node = document.createElement("button");
      node.type = "button";
      node.textContent = label;
      node.onclick = () => { if (!controller.signal.aborted) action(); };
      parent.append(node);
    };
    const text = (parent: HTMLElement, tag: "h3" | "p", value: string) => {
      const node = document.createElement(tag);
      node.textContent = value;
      parent.append(node);
    };
    setStatus({ kind: "Loading" }); setLocationStatus({ kind: "Idle" }); onDefect(null);
    void (async () => {
      if (session.overlays === null) throw new Error("Hosted reader apparatus capability is unavailable");
      const value = await session.overlays(request, controller.signal);
      if (value.kind === "Capacity") { if (!controller.signal.aborted) setStatus(value); return; }
      if (controller.signal.aborted) { value.lease.release(); return; }
      lease = value.lease;
      const result = lease.result;
      if (result.kind !== request.kind) throw new Error("Source note detail received another page");
      // Fixed controls plus at most one heading, excerpt and button per target.
      dom = session.reserveDomNodes(24 + (result.kind === "ApparatusTargets" ? result.page.items.length * 8 : 0));
      if (dom === null) { retire(); setStatus({ kind: "Capacity", reason: "Dom" }); return; }
      if (result.kind === "ApparatusLookup") {
        const item = result.page;
        const itemId = item.id;
        const key = item.stable_key;
        text(root, "h3", item.label_excerpt ?? item.kind.replaceAll("_", " "));
        if (item.body_excerpt !== null) text(root, "p", item.body_excerpt);
        if (item.label_source_id !== null) {
          const labelOwner = item.label_source_id;
          button(root, "Read full label", () => setRequest({ kind: "ApparatusText", itemId: labelOwner, request: { field: "Label", offset_cp: 0 } }));
        }
        if (item.body_source_id !== null) {
          const bodyOwner = item.body_source_id;
          button(root, "Read full note", () => setRequest({ kind: "ApparatusText", itemId: bodyOwner, request: { field: "Body", offset_cp: 0 } }));
        }
        if (item.has_targets) button(root, "Source targets", () => setRequest({ kind: "ApparatusTargets", itemId, request: { after: null, limit: 100 } }));
        if (item.source_range !== null || item.pdf_page !== null) button(root, "Locate source note", () => { void locate(itemId, key); });
        else text(root, "p", "Source position unavailable.");
        if (locateOnOpen && !initialLocationCompleted.current && key === stableKey) void locate(itemId, key);
      } else if (result.kind === "ApparatusText" && request.kind === "ApparatusText") {
        text(root, "h3", result.page.field === "Body" ? "Source note" : "Source label");
        text(root, "p", result.page.text);
        const next = result.page.next_offset_cp;
        if (next !== null) button(root, "Next text page", () => setRequest({ ...request, request: { ...request.request, offset_cp: next } }));
        if (result.page.offset_cp > 0) button(root, "Beginning of text", () => setRequest({ ...request, request: { ...request.request, offset_cp: 0 } }));
      } else if (result.kind === "ApparatusTargets" && request.kind === "ApparatusTargets") {
        text(root, "h3", "Source targets");
        const list = document.createElement("ul"); root.append(list);
        for (const { target } of result.page.items) {
          const row = document.createElement("li"); list.append(row);
          const key = target.stable_key;
          button(row, target.label_excerpt ?? target.kind.replaceAll("_", " "), () => setRequest({ kind: "ApparatusLookup", request: { stable_key: key } }));
          if (target.body_excerpt !== null) text(row, "p", target.body_excerpt);
        }
        const next = result.page.next_cursor;
        if (next !== null) button(root, "More source targets", () => setRequest({ ...request, request: { ...request.request, after: next } }));
        if (request.request.after !== null) button(root, "First source targets", () => setRequest({ ...request, request: { ...request.request, after: null } }));
      } else throw new Error("Source note detail received an unrelated result");
      if (request.kind !== "ApparatusLookup" || request.request.stable_key !== stableKey) {
        button(root, "Back to source note", () => setRequest({ kind: "ApparatusLookup", request: { stable_key: stableKey } }));
      }
      const itemId = result.kind === "ApparatusLookup" ? result.page.id
        : request.kind === "ApparatusLookup" ? null : request.itemId;
      if (itemId === null) throw new Error("Source note page has no resource identity");
      setResource({ request, subject: { ref: canonicalResourceRef({ scheme: "reader_apparatus_item", id: itemId }) } });
      setStatus({ kind: "Ready" });
    })().catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      retire(); setStatus({ kind: "Failed" }); fail(error);
    });
    return () => { controller.abort(); retire(); onDefect(null); };
  }, [attempt, locateOnOpen, onDefect, onLocate, request, session, stableKey]);

  const notice = status.kind === "Capacity" ? readerCapacityNotice(status.reason) : null;
  const locationNotice = locationStatus.kind === "Capacity" ? readerCapacityNotice(locationStatus.reason) : null;
  return <section className={styles.detail} aria-label="Source note details" aria-busy={status.kind === "Loading"}>
    <button type="button" onClick={onBack}>Back to evidence</button>
    {status.kind === "Ready" && resource?.request === request ? renderActions(resource.subject) : null}
    <div ref={rootRef} className={styles.page} />
    {status.kind === "Loading" ? <p>Loading source note…</p> : null}
    {notice !== null ? <p role="status">{notice.message}</p> : null}
    {status.kind === "Failed" ? <p role="alert">Source note could not be loaded.</p> : null}
    {(notice !== null && notice.retryable) || status.kind === "Failed" ? <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry source note</button> : null}
    {locationStatus.kind === "Loading" ? <p role="status">Opening source position…</p> : null}
    {locationNotice !== null ? <p role="status">{locationNotice.message}</p> : null}
    {locationStatus.kind === "Unavailable" ? <p role="status">Source position is unavailable in this copy.</p> : null}
    {locationStatus.kind === "Failed" ? <p role="alert">Source position could not be opened.</p> : null}
  </section>;
}
