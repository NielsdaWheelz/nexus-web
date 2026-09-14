"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { createRandomId } from "@/lib/createRandomId";
import type { DocumentReaderSession, ReaderDomLease, ReaderOverlayLease, ReaderOverlayRequest, ReaderViewCapacity } from "@/lib/reader/DocumentReaderSession";
import { readerCapacityNotice } from "@/lib/reader/readerCapacity";
import type { ReaderPublicationEvidenceFact, ReaderPublicationEvidenceObject, ReaderPublicationEvidenceFactsRequest, ReaderPublicationEvidenceAssociationsRequest, ReaderPublicationEvidenceSeekRequest } from "@/lib/reader/readerPublicationOverlays";
import type { EvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import type { ReaderContentDefect } from "../ReaderContentBoundary";
import styles from "./EvidencePaneSurface.module.css";

type Scope = ReaderPublicationEvidenceFactsRequest["scope"];
type Page =
  | { readonly kind: "Facts"; readonly scope: Scope; readonly after: string | null }
  | { readonly kind: "Seek"; readonly scope: Scope; readonly target: ReaderPublicationEvidenceSeekRequest["target"] }
  | { readonly kind: "Associations"; readonly scope: Scope; readonly target: ReaderPublicationEvidenceAssociationsRequest["target"]; readonly after: string | null };
export type PublicationEvidenceSelection =
  | { readonly kind: "Highlight"; readonly highlightId: string }
  | { readonly kind: "SourceReference"; readonly stableKey: string }
  | { readonly kind: "LinkNote"; readonly edgeId: string }
  | { readonly kind: "Object"; readonly ref: string };
interface EvidenceHover { readonly factId: string; readonly highlightId: string | null; readonly stableKey: string | null }

/** One explicit fact/disclosure page. Editors belong to the parent and survive page replacement. */
export default function PublicationEvidence({ session, filters, refreshToken, activeItemId, activeSourceKey, followGeneration,
  selectedDetail, onSelect, onActivateObject, onLocate, onHover, onRemoveEdge, onDismissSynapse, onDefect }: {
  readonly session: DocumentReaderSession;
  readonly filters: EvidenceFilters;
  readonly refreshToken: number;
  readonly activeItemId: string | null;
  readonly activeSourceKey: string | null;
  readonly followGeneration: number;
  readonly selectedDetail: ReactNode;
  readonly onSelect: (selection: PublicationEvidenceSelection) => void;
  readonly onActivateObject: (object: ReaderPublicationEvidenceObject, disposition: WorkspaceTargetDisposition) => void;
  readonly onLocate: (factId: string, signal: AbortSignal) => Promise<{ readonly kind: "Located" | "Unavailable" } | ReaderViewCapacity>;
  readonly onHover: (value: EvidenceHover | null) => void;
  readonly onRemoveEdge: (edgeId: string, role: "context" | "supports" | "contradicts") => Promise<void>;
  readonly onDismissSynapse: (edgeId: string) => Promise<void>;
  readonly onDefect: (defect: ReaderContentDefect | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [pageIntent, setPageIntent] = useState<{ filter: EvidenceFilters["filter"]; value: Page }>({ filter: filters.filter, value: { kind: "Facts", scope: "Passages", after: null } });
  const page = useMemo<Page>(() => pageIntent.filter === filters.filter ? pageIntent.value : { kind: "Facts", scope: pageIntent.value.scope, after: null }, [pageIntent, filters.filter]);
  const setPage = useCallback((value: Page) => setPageIntent({ filter: filters.filter, value }), [filters.filter]);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<{ readonly kind: "Loading" | "Ready" | "Failed" } | ReaderViewCapacity>({ kind: "Loading" });
  const [actionStatus, setActionStatus] = useState<{ readonly kind: "Idle" | "Loading" | "Unavailable" | "Failed" } | ReaderViewCapacity>({ kind: "Idle" });
  const [next, setNext] = useState<string | null>(null);
  const [counts, setCounts] = useState({ highlights: 0, citations: 0, links: 0, synapses: 0, passages: 0, document: 0 });
  const [focusedSourceFact, setFocusedSourceFact] = useState<string | null>(null);
  const [followPaused, setFollowPaused] = useState(false);
  const callbacks = useRef({ onSelect, onActivateObject, onLocate, onHover, onRemoveEdge, onDismissSynapse, onDefect, filter: filters.filter });
  callbacks.current = { onSelect, onActivateObject, onLocate, onHover, onRemoveEdge, onDismissSynapse, onDefect, filter: filters.filter };
  const kinds = useMemo<ReaderPublicationEvidenceFactsRequest["kinds"]>(() => [
    ...(filters.filter.highlight ? ["Highlight" as const] : []),
    ...(filters.filter.citation ? ["SourceReference" as const, "GeneratedCitation" as const] : []),
    ...(filters.filter.link ? ["Link" as const] : []),
    ...(filters.filter.synapse ? ["Synapse" as const] : []),
  ], [filters.filter.highlight, filters.filter.citation, filters.filter.link, filters.filter.synapse]);
  useEffect(() => {
    if (activeItemId === null && activeSourceKey === null || followGeneration === 0) return;
    setFollowPaused(false);
    setPageIntent({ filter: callbacks.current.filter, value: { kind: "Seek", scope: "Passages", target: activeSourceKey === null ? { kind: "Fact", fact_id: activeItemId! } : { kind: "SourceReference", stable_key: activeSourceKey } } });
  }, [activeItemId, activeSourceKey, followGeneration]);
  useEffect(() => {
    const root = host.current;
    if (root === null) return;
    for (const row of root.querySelectorAll<HTMLElement>("[data-evidence-item-id]")) {
      if (row.dataset.evidenceItemId === (activeSourceKey === null ? activeItemId : focusedSourceFact)) {
        row.dataset.active = "true";
        if (!followPaused) row.scrollIntoView({ block: "nearest" });
      } else delete row.dataset.active;
    }
  }, [activeItemId, activeSourceKey, focusedSourceFact, followPaused, status]);
  useEffect(() => {
    const root = host.current;
    if (root === null) return;
    const controller = new AbortController();
    let lease: ReaderOverlayLease | null = null;
    let dom: ReaderDomLease | null = null;
    let actionPending = false;
    const retire = () => { root.replaceChildren(); lease?.release(); lease = null; dom?.release(); dom = null; };
    const fail = (error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) callbacks.current.onDefect({
        key: createRandomId("evidence"), error,
        retry: () => { if (!controller.signal.aborted) setAttempt((value) => value + 1); },
      });
    };
    const action = async (run: () => Promise<void | { readonly kind: "Located" | "Unavailable" } | ReaderViewCapacity>) => {
      if (controller.signal.aborted || actionPending) return;
      actionPending = true; setActionStatus({ kind: "Loading" });
      try {
        const result = await run();
        if (!controller.signal.aborted) {
          setActionStatus(result === undefined || result.kind === "Located" ? { kind: "Idle" }
            : result.kind === "Capacity" ? result : { kind: "Unavailable" });
        }
      } catch (error) { if (!controller.signal.aborted && !isAbortError(error)) { setActionStatus({ kind: "Failed" }); fail(error); } }
      finally { actionPending = false; }
    };
    const text = (parent: HTMLElement, tag: "p" | "span", value: string, className: string) => {
      const node = document.createElement(tag); node.className = className; node.textContent = value; parent.append(node);
    };
    const button = (parent: HTMLElement, label: string, run: (event: MouseEvent) => void) => {
      const node = document.createElement("button"); node.type = "button"; node.className = styles.objectButton; node.textContent = label;
      node.onclick = (event) => { if (!controller.signal.aborted) run(event); }; parent.append(node);
    };
    const object = (parent: HTMLElement, value: ReaderPublicationEvidenceObject) => {
      text(parent, "p", value.label_excerpt, styles.itemLabel);
      if (value.excerpt !== null) text(parent, "p", value.excerpt, styles.itemExcerpt);
      button(parent, `Open ${value.kind === "Chat" ? "chat" : value.kind === "Note" ? "note" : "resource"}`, (event) => {
        const intent = workspaceTargetClickIntent(event);
        callbacks.current.onActivateObject(value, intent.disposition);
      });
      const ref = value.ref;
      button(parent, "Resource actions", () => callbacks.current.onSelect({ kind: "Object", ref }));
    };
    const removeEdge = (parent: HTMLElement, edgeId: string, role: string) => {
      if (role !== "context" && role !== "supports" && role !== "contradicts") return;
      button(parent, "Remove connection", () => { void action(() => callbacks.current.onRemoveEdge(edgeId, role)); });
    };
    const fact = (item: ReaderPublicationEvidenceFact) => {
      const row = document.createElement("article"); row.className = styles.item; row.dataset.evidenceItemId = item.id; row.dataset.kind = item.kind;
      const factId = item.id;
      const hover = { factId, highlightId: item.kind === "Highlight" ? item.highlight_id : null, stableKey: item.kind === "SourceReference" ? item.stable_key : null };
      row.onmouseenter = () => callbacks.current.onHover(hover);
      row.addEventListener("focusin", () => callbacks.current.onHover(hover));
      row.onmouseleave = () => callbacks.current.onHover(null);
      row.addEventListener("focusout", (event) => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) callbacks.current.onHover(null); });
      text(row, "span", item.kind === "SourceReference" ? "Source reference" : item.kind === "GeneratedCitation" ? "Generated citation" : item.kind, styles.kindLabel);
      text(row, "p", item.label_excerpt, styles.itemLabel);
      if (item.excerpt !== null) text(row, "p", item.excerpt, styles.itemExcerpt);
      if (item.kind === "SourceReference" && item.confidence !== "exact") text(row, "p", item.confidence, styles.kindLabel);
      if (item.position.kind === "Text" || item.position.kind === "Pdf") button(row, "Locate passage", () => { void action(() => callbacks.current.onLocate(factId, controller.signal)); });
      else if (item.position.kind === "Unavailable") text(row, "p", item.position.reason === "SourceUnverified" ? "Source position is unverified. Edit highlight bounds to attach it to this copy." : "Source position unavailable.", styles.unavailableReason);
      if (item.kind === "Highlight") {
        const highlightId = item.highlight_id; button(row, "Highlight details", () => callbacks.current.onSelect({ kind: "Highlight", highlightId }));
      } else if (item.kind === "SourceReference") {
        const stableKey = item.stable_key; button(row, "Source note details", () => callbacks.current.onSelect({ kind: "SourceReference", stableKey }));
      } else if (item.kind === "Link" || item.kind === "Synapse") {
        object(row, item.object);
        const edgeId = item.edge_id;
        if (item.kind === "Synapse") button(row, "Dismiss suggestion", () => { void action(() => callbacks.current.onDismissSynapse(edgeId)); });
        else if (item.origin === "user") {
          removeEdge(row, edgeId, item.role);
          if (item.role === "context") button(row, "Edit link note", () => callbacks.current.onSelect({ kind: "LinkNote", edgeId }));
        }
      }
      if (item.association_count > 0) button(row, `Relationships (${item.association_count})`, () => setPage({ kind: "Associations", scope: page.scope, target: { kind: "Fact", fact_id: factId }, after: null }));
      if (item.also_reference_count > 0) {
        const locusRef = item.locus_ref;
        button(row, `Also references (${item.also_reference_count})`, () => setPage({ kind: "Associations", scope: page.scope, target: { kind: "Locus", locus_ref: locusRef }, after: null }));
      }
      root.append(row);
    };
    setStatus({ kind: "Loading" }); setActionStatus({ kind: "Idle" }); setNext(null); callbacks.current.onDefect(null);
    void (async () => {
      if (session.overlays === null) throw new Error("Hosted evidence capability is unavailable");
      const query: ReaderOverlayRequest = page.kind === "Facts"
        ? { kind: "EvidenceFacts", request: { scope: page.scope, kinds, window: null, after: page.after, limit: 100 } }
        : page.kind === "Seek" ? { kind: "EvidenceSeek", request: { scope: page.scope, kinds, target: page.target, limit: 100 } }
        : { kind: "EvidenceAssociations", request: { target: page.target, after: page.after, limit: 100 } };
      const result = await session.overlays(query, controller.signal);
      if (result.kind === "Capacity") { if (!controller.signal.aborted) setStatus(result); return; }
      if (controller.signal.aborted) { result.lease.release(); return; }
      lease = result.lease;
      const value = lease.result;
      if (value.kind !== "EvidenceFacts" && value.kind !== "EvidenceSeek" && value.kind !== "EvidenceAssociations") throw new Error("Evidence page received another query result");
      // Each fact has at most 14 element/text pairs; 40 nodes also cover relationship chrome.
      dom = session.reserveDomNodes(40 + value.page.items.length * 40);
      if (dom === null) { retire(); setStatus({ kind: "Capacity", reason: "Dom" }); return; }
      if (value.kind === "EvidenceFacts" || value.kind === "EvidenceSeek") {
        if (page.kind === "Seek" && page.target.kind === "SourceReference") setFocusedSourceFact(value.page.items[0]?.id ?? null);
        const { highlights, citations, links, synapses, passages, document } = value.page.counts;
        setCounts({ highlights, citations, links, synapses, passages, document });
        for (const item of value.page.items) fact(item);
      } else if (value.kind === "EvidenceAssociations") {
        for (const item of value.page.items) {
          const row = document.createElement("article"); row.className = styles.item;
          text(row, "span", item.relationship === "AuthoredIn" ? "Authored in" : item.relationship === "DirectlyAttached" ? "Directly attached" : "Also references", styles.relationshipKind);
          object(row, item.object);
          if (item.relationship === "DirectlyAttached" && item.origin === "user") removeEdge(row, item.edge_id, item.role);
          root.append(row);
        }
      }
      // A relationships page is addressed by fact or locus: neither the scope
      // tabs nor the kind filters reach it, so it must not blame them.
      if (value.page.items.length === 0) text(root, "p", page.kind === "Associations"
        ? "This item has no relationships." : "No evidence matches this scope and these filters.", styles.filteredEmpty);
      setNext(value.page.next_cursor); setStatus({ kind: "Ready" });
    })().catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      retire(); setStatus({ kind: "Failed" }); fail(error);
    });
    return () => { controller.abort(); callbacks.current.onHover(null); retire(); };
  }, [session, page, kinds, refreshToken, attempt, setPage]);
  const notice = status.kind === "Capacity" ? readerCapacityNotice(status.reason) : null;
  const actionNotice = actionStatus.kind === "Capacity" ? readerCapacityNotice(actionStatus.reason) : null;
  const first = () => setPage({ kind: "Facts", scope: page.scope, after: null });
  return <section className={styles.root} aria-label="Evidence">
    <header className={styles.header}>
      <h2 className={styles.title}>Evidence</h2>
      <div role="group" aria-label="Evidence scope">
        {(["Passages", "Document"] as const).map((scope) => <button key={scope} type="button" aria-pressed={scope === page.scope}
          onClick={() => setPage({ kind: "Facts", scope, after: null })}>{scope} ({scope === "Passages" ? counts.passages : counts.document})</button>)}
      </div>
      <div className={styles.filters} aria-label="Evidence filters">
        {(["highlight", "citation", "link", "synapse"] as const).map((kind) => <button key={kind} type="button" aria-pressed={filters.filter[kind]}
          onClick={() => filters.toggleFilter(kind)}>{kind === "highlight" ? `Highlights (${counts.highlights})` : kind === "citation" ? `Citations (${counts.citations})` : kind === "link" ? `Links (${counts.links})` : `Synapses (${counts.synapses})`}</button>)}
      </div>
      {followPaused && activeItemId !== null ? <button type="button" onClick={() => { setFollowPaused(false); setPage({ kind: "Seek", scope: "Passages", target: activeSourceKey === null ? { kind: "Fact", fact_id: activeItemId } : { kind: "SourceReference", stable_key: activeSourceKey } }); }}>Follow current passage</button> : null}
      {page.kind === "Associations" ? <button type="button" onClick={first}>Back to evidence</button> : null}
      {status.kind === "Loading" ? <p role="status">Loading evidence…</p> : null}
      {notice !== null || status.kind === "Failed" ? <p role="status">{notice?.message ?? "Evidence could not be loaded."}
        {notice === null || notice.retryable ? <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry evidence</button> : null}</p> : null}
      {actionStatus.kind !== "Idle" ? <p role="status">{actionStatus.kind === "Loading" ? "Opening evidence…" : actionNotice?.message ?? (actionStatus.kind === "Unavailable" ? "Source position unavailable." : "Evidence action failed.")}</p> : null}
      {status.kind === "Ready" ? <div role="group" aria-label="Evidence pages"><button type="button" onClick={first}>First page</button>
        {next !== null ? <button type="button" onClick={() => setPage(page.kind === "Associations" ? { ...page, after: next } : { kind: "Facts", scope: page.scope, after: next })}>Next page</button> : null}</div> : null}
    </header>
    {selectedDetail}
    <div ref={host} className={styles.list} aria-busy={status.kind === "Loading"} onPointerDown={() => setFollowPaused(true)}
      onKeyDown={(event) => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) setFollowPaused(true); }} />
  </section>;
}
