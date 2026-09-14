"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createInlineMachineText } from "@/components/ui/MachineText";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { createRandomId } from "@/lib/createRandomId";
import type { DocumentReaderSession, ReaderDomLease, ReaderViewCapacity } from "@/lib/reader/DocumentReaderSession";
import type { ReaderPublicationEvidenceGutterPage, ReaderPublicationEvidenceGutterRequest } from "@/lib/reader/readerPublicationOverlays";
import { readerCapacityNotice } from "@/lib/reader/readerCapacity";
import type { EvidenceFilterState } from "@/lib/reader/useEvidenceFilters";
import { readTextGutterWindow, readPdfGutterWindow, publicationGutterTop, type PublicationGutterTextPart } from "@/lib/reader/publicationGutter";
import { stackAnchoredRows } from "@/lib/reader/marginItems";
import { elvishInscriptions } from "@/lib/theme/elvishInscriptions";
import { findScrollParent } from "./useAnchoredReaderProjection";
import type { ReaderContentDefect } from "./ReaderContentBoundary";
import styles from "./MarginRail.module.css";

const MEASURE_DELAY_MS = 75;
const CHAPTER_OPENER = elvishInscriptions.elenSila;

/** One current visible-source page. The source snapshot and rows never enter React state. */
export default function MarginRail({ session, contentRef, layoutKey, readTextParts, isPdf, isMobile, filters,
  refreshToken, hasMarginFacts, onOpenSidecar, onActivateItem, onDismissSynapse, onDefect }: {
  readonly session: DocumentReaderSession;
  readonly contentRef: RefObject<HTMLElement | null>;
  readonly layoutKey: unknown;
  readonly readTextParts: () => Iterable<PublicationGutterTextPart>;
  readonly isPdf: boolean;
  readonly isMobile: boolean;
  readonly filters: EvidenceFilterState;
  readonly refreshToken: number;
  readonly hasMarginFacts: boolean | null;
  readonly onOpenSidecar: () => void;
  readonly onActivateItem: (factId: string, signal: AbortSignal) => Promise<{ readonly kind: "Located" | "Unavailable" } | ReaderViewCapacity>;
  readonly onDismissSynapse: (edgeId: string) => Promise<void>;
  readonly onDefect: (defect: ReaderContentDefect | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [after, setAfter] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [status, setStatus] = useState<{ readonly kind: "Loading" | "Ready" | "Failed" } | ReaderViewCapacity>({ kind: "Loading" });
  const [actionStatus, setActionStatus] = useState<{ readonly kind: "Idle" | "Loading" | "Unavailable" | "Failed" } | ReaderViewCapacity>({ kind: "Idle" });
  const callbacks = useRef({ readTextParts, onActivateItem, onDismissSynapse, onDefect });
  callbacks.current = { readTextParts, onActivateItem, onDismissSynapse, onDefect };
  const kinds = useMemo<ReaderPublicationEvidenceGutterRequest["kinds"]>(() => [
    ...(filters.highlight ? ["Highlight" as const] : []), ...(filters.citation ? ["SourceReference" as const, "GeneratedCitation" as const] : []),
    ...(filters.link ? ["Link" as const] : []), ...(filters.synapse ? ["Synapse" as const] : []),
  ], [filters.highlight, filters.citation, filters.link, filters.synapse]);

  useEffect(() => {
    if (isMobile || contentRef.current === null) { setWide(false); return; }
    const viewport = findScrollParent(contentRef.current);
    const measure = () => {
      const threshold = probe.current?.getBoundingClientRect().width ?? 0;
      setWide(threshold > 0 && viewport.clientWidth >= threshold);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(viewport);
    return () => observer.disconnect();
  }, [contentRef, isMobile, layoutKey]);

  useEffect(() => {
    if (!wide || host.current === null || contentRef.current === null) return;
    let observed: { content: HTMLElement; viewport: HTMLElement } | null = {
      content: contentRef.current, viewport: findScrollParent(contentRef.current),
    };
    let current: AbortController | null = null;
    let timer: number | null = null;
    let withdraw: (() => void) | null = null;
    const retire = () => {
      current?.abort(); current = null;
      withdraw?.(); withdraw = null;
    };
    const fail = (error: unknown, request: AbortController) => {
      if (request.signal.aborted || isAbortError(error)) return;
      setStatus({ kind: "Failed" });
      if (!isApiError(error) || isSameSystemApiDefect(error)) callbacks.current.onDefect({ key: createRandomId("reader-gutter"), error,
        retry: () => { if (current === request) setAttempt((value) => value + 1); } });
    };
    const load = (cursor: string | null) => {
      retire();
      if (observed === null || host.current === null || contentRef.current === null) return;
      let presentation: { host: HTMLElement; content: HTMLElement; viewport: HTMLElement } | null = {
        host: host.current, content: contentRef.current, viewport: findScrollParent(contentRef.current),
      };
      const request = new AbortController(); current = request;
      let lease: { readonly page: ReaderPublicationEvidenceGutterPage; release(): void } | null = null;
      let dom: ReaderDomLease | null = null;
      let pendingAction = false;
      const release = () => { lease?.release(); lease = null; dom?.release(); dom = null; };
      withdraw = () => {
        presentation?.host.replaceChildren(); presentation = null;
        if (!pendingAction) release();
      };
      setStatus({ kind: "Loading" }); setNext(null); setRemaining(0); setActionStatus({ kind: "Idle" }); callbacks.current.onDefect(null);
      void (async () => {
        if (session.gutter === null) throw new Error("Hosted gutter capability is unavailable");
        const result = await session.gutter({ kinds, include_stances: filters.link, after: cursor, limit: 24,
          readWindow: (maxBytes) => {
            const view = presentation;
            if (view === null) throw new DOMException("Margin source retired", "AbortError");
            return isPdf ? readPdfGutterWindow(view.content, view.viewport.getBoundingClientRect(), maxBytes)
              : readTextGutterWindow(callbacks.current.readTextParts(), view.viewport.getBoundingClientRect(), maxBytes);
          },
        }, request.signal);
        if (result.kind === "Capacity") { if (!request.signal.aborted) setStatus(result); return; }
        if (request.signal.aborted || presentation === null || presentation.host !== host.current || presentation.content !== contentRef.current) { result.lease.release(); return; }
        lease = result.lease;
        dom = session.reserveDomNodes(32 + CHAPTER_OPENER.paths.length + lease.page.items.length * 14);
        if (dom === null) { release(); setStatus({ kind: "Capacity", reason: "Dom" }); return; }
        const { host: root, content, viewport } = presentation;
        const rect = viewport.getBoundingClientRect();
        const baseline = root.getBoundingClientRect().top;
        const positions: { id: string; desiredTop: number }[] = [];
        const heights = new Map<string, number>();
        const act = (action: () => Promise<{ readonly kind: "Located" | "Unavailable" } | ReaderViewCapacity | void>) => {
          if (pendingAction || request.signal.aborted) return;
          pendingAction = true; setActionStatus({ kind: "Loading" });
          void action().then((outcome) => {
            if (!request.signal.aborted) {
              setActionStatus(outcome === undefined || outcome.kind === "Located" ? { kind: "Idle" }
                : outcome.kind === "Capacity" ? outcome : { kind: "Unavailable" });
            }
          }).catch((error: unknown) => { if (!request.signal.aborted && !isAbortError(error)) { setActionStatus({ kind: "Failed" }); fail(error, request); } })
            .finally(() => { pendingAction = false; if (request.signal.aborted) release(); });
        };
        for (const item of lease.page.items) {
          const top = publicationGutterTop(item, callbacks.current.readTextParts(), content, rect);
          if (top === null) continue;
          const row = document.createElement("div"); row.className = styles.item; row.dataset.gutterId = item.id;
          const button = document.createElement("button"); button.type = "button";
          const factId = item.fact_id;
          button.onclick = () => act(() => callbacks.current.onActivateItem(factId, request.signal));
          if (item.kind === "Stance") {
            button.className = styles.stance; button.textContent = item.stance === "supports" ? "✓" : "~";
            button.setAttribute("aria-label", item.stance === "supports" ? "Conceded" : "Doubted");
          } else {
            button.className = styles.itemActivation;
            const kicker = document.createElement("span"); kicker.className = styles.kicker;
            kicker.textContent = item.kind === "GeneratedCitation" || item.kind === "SourceReference" ? "Citation" : item.kind;
            button.append(kicker);
            if (item.kind === "Synapse") {
              const machine = createInlineMachineText(item.excerpt ?? item.label_excerpt, { label: item.kind });
              machine.classList.add(styles.synapseText); button.append(machine); row.classList.add(styles.synapse);
            } else {
              const label = document.createElement("span"); label.className = styles.itemLabel; label.textContent = item.label_excerpt; button.append(label);
              if (item.excerpt !== null) { const excerpt = document.createElement("span"); excerpt.className = styles.itemExcerpt; excerpt.textContent = item.excerpt; button.append(excerpt); }
            }
          }
          row.append(button);
          if (item.kind === "Synapse" && item.edge_id !== null) {
            const edgeId = item.edge_id;
            const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.className = styles.dismiss;
            dismiss.setAttribute("aria-label", "Dismiss Synapse connection"); dismiss.textContent = "×";
            dismiss.onclick = () => act(() => callbacks.current.onDismissSynapse(edgeId)); row.append(dismiss);
          }
          root.append(row); positions.push({ id: item.id, desiredTop: top - baseline });
          heights.set(item.id, Math.ceil(row.getBoundingClientRect().height));
        }
        const { alignedRows } = stackAnchoredRows(positions, { rowHeights: heights, rowHeight: 72, gap: 6, containerHeight: root.clientHeight });
        for (const row of root.querySelectorAll<HTMLElement>("[data-gutter-id]")) {
          const position = alignedRows.find((entry) => entry.id === row.dataset.gutterId);
          if (position === undefined) row.remove(); else row.style.transform = `translateY(${position.top}px)`;
        }
        setRemaining(Math.max(0, lease.page.total_count - alignedRows.length)); setNext(lease.page.next_cursor); setStatus({ kind: "Ready" });
      })().catch((error: unknown) => { if (current === request) { presentation?.host.replaceChildren(); presentation = null; release(); fail(error, request); } });
    };
    const measure = () => {
      if (observed === null) return;
      retire(); setStatus({ kind: "Loading" });
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; if (after !== null) setAfter(null); else load(null); }, MEASURE_DELAY_MS);
    };
    load(after);
    observed.viewport.addEventListener("scroll", measure, { passive: true });
    observed.content.addEventListener("load", measure, true);
    let width = observed.viewport.clientWidth;
    let height = observed.viewport.clientHeight;
    let contentWidth = observed.content.clientWidth;
    let contentHeight = observed.content.clientHeight;
    const observer = new ResizeObserver(() => {
      if (observed === null) return;
      if (width === observed.viewport.clientWidth && height === observed.viewport.clientHeight &&
          contentWidth === observed.content.clientWidth && contentHeight === observed.content.clientHeight) return;
      width = observed.viewport.clientWidth; height = observed.viewport.clientHeight;
      contentWidth = observed.content.clientWidth; contentHeight = observed.content.clientHeight;
      measure();
    });
    observer.observe(observed.viewport); observer.observe(observed.content);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
      observed?.viewport.removeEventListener("scroll", measure); observed?.content.removeEventListener("load", measure, true);
      observed = null; retire();
    };
  }, [session, contentRef, wide, isPdf, kinds, filters.link, refreshToken, layoutKey, after, attempt]);

  const notice = status.kind === "Capacity" ? readerCapacityNotice(status.reason) : null;
  const actionNotice = actionStatus.kind === "Capacity" ? readerCapacityNotice(actionStatus.reason) : null;
  const measuringProbe = <div ref={probe} aria-hidden="true" className={styles.probe} style={{ width: "calc(var(--reader-measure) + var(--reader-margin-width))" }} />;
  if (isMobile || !wide) return measuringProbe;
  return <aside className={styles.rail} aria-label="Margin">
    {measuringProbe}
    {hasMarginFacts === false ? <svg className={styles.plaque} viewBox={CHAPTER_OPENER.viewBox} aria-hidden="true" focusable="false">
      {CHAPTER_OPENER.paths.map((path, index) => <path key={index} d={path} />)}
    </svg> : null}
    <div ref={host} className={styles.container} />
    <div className={styles.overflowFoot}>
      {status.kind === "Loading" ? <span role="status">Loading margin…</span> : null}
      {notice !== null || status.kind === "Failed" ? <span role="status">{notice?.message ?? "Margin could not be loaded."}
        {notice === null || notice.retryable ? <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry margin</button> : null}</span> : null}
      {actionStatus.kind !== "Idle" ? <span role="status">{actionStatus.kind === "Loading" ? "Opening passage…" : actionNotice?.message ?? (actionStatus.kind === "Unavailable" ? "Passage is unavailable." : "Passage could not be opened.")}</span> : null}
      {remaining > 0 ? <button type="button" onClick={onOpenSidecar}>+{remaining} more</button> : null}
      {after !== null ? <button type="button" onClick={() => setAfter(null)}>First margin page</button> : null}
      {next !== null ? <button type="button" onClick={() => setAfter(next)}>Next margin page</button> : null}
    </div>
  </aside>;
}
