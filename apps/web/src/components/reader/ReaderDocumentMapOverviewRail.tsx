"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useId, type CSSProperties } from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { createRandomId } from "@/lib/createRandomId";
import type { DocumentReaderSession, ReaderOverlayLease, ReaderDomLease, ReaderViewCapacity } from "@/lib/reader/DocumentReaderSession";
import { readerCapacityNotice } from "@/lib/reader/readerCapacity";
import type { ReaderPublicationEvidenceMarker, ReaderPublicationEvidenceMarkerCounts, ReaderPublicationEvidenceMarkerKind, ReaderPublicationEvidenceMarkerPreview } from "@/lib/reader/readerPublicationOverlays";
import type { EvidenceFilterState } from "@/lib/reader/useEvidenceFilters";
import type { ReaderDocumentOverviewRange } from "@/lib/reader/readerDocumentPosition";
import type { ReaderContentDefect } from "./ReaderContentBoundary";
import { cx } from "@/lib/ui/cx";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import styles from "./ReaderDocumentMapOverviewRail.module.css";

const MARKER_TARGET_SIZE_PX = 24;
const RAIL_WIDTH_PX = 28;
const KINDS: readonly ReaderPublicationEvidenceMarkerKind[] = ["Contents", "Embed", "Highlight", "SourceReference", "GeneratedCitation", "Link", "Synapse"];
type VineStyle = CSSProperties & { "--vine-reach": string };

/** Finite overview bins; one explicitly opened member page owns its source rows and DOM. */
export default function ReaderDocumentMapOverviewRail({ session, refreshToken, visibleRange, onActivateMarker, onDefect, resourceId, marginFilters, onHasMarginFacts }: {
  readonly marginFilters: EvidenceFilterState;
  readonly onHasMarginFacts: (present: boolean | null) => void;
  readonly session: DocumentReaderSession;
  readonly refreshToken: number;
  readonly visibleRange: ReaderDocumentOverviewRange;
  readonly onActivateMarker: (marker: ReaderPublicationEvidenceMarker, signal: AbortSignal) => Promise<{ readonly kind: "Located" | "Unavailable" } | ReaderViewCapacity>;
  readonly onDefect: (defect: ReaderContentDefect | null) => void;
  readonly resourceId: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewId = useId();
  const listId = useId();
  const [trackHeight, setTrackHeight] = useState(0);
  const [bucket, setBucket] = useState<{ index: number; after: string | null } | null>(null);
  /* Focus follows the reader's own opening or page turn; a reload the reader
     did not ask for (a mutation refresh, a resize) must leave the caret alone. */
  const bucketRef = useRef<{ index: number; after: string | null } | null>(null);
  const focusFirstDestination = useRef(false);
  bucketRef.current = bucket;
  const [next, setNext] = useState<string | null>(null);
  const [overviewAttempt, setOverviewAttempt] = useState(0);
  const [pageAttempt, setPageAttempt] = useState(0);
  const [overviewStatus, setOverviewStatus] = useState<{ readonly kind: "Loading" | "Ready" | "Failed" } | ReaderViewCapacity>({ kind: "Loading" });
  const [pageStatus, setPageStatus] = useState<{ readonly kind: "Loading" | "Ready" | "Failed" } | ReaderViewCapacity>({ kind: "Loading" });
  const [actionStatus, setActionStatus] = useState<{ readonly kind: "Idle" | "Loading" | "Unavailable" | "Failed" } | ReaderViewCapacity>({ kind: "Idle" });
  const [unavailable, setUnavailable] = useState(0);
  const [positionedFacts, setPositionedFacts] = useState<{ highlight: number; citation: number; link: number; synapse: number } | null>(null);
  useEffect(() => {
    if (positionedFacts === null) { onHasMarginFacts(null); return; }
    const present = Object.entries(positionedFacts).some(([kind, count]) => count > 0 && marginFilters[kind as keyof EvidenceFilterState]);
    // Link-only mode can still show highlight stances. The overview does not
    // count those associations, so absence is unknown in that one case.
    onHasMarginFacts(present ? true : marginFilters.link && positionedFacts.highlight > 0 ? null : false);
  }, [positionedFacts, marginFilters, onHasMarginFacts]);
  const callbacks = useRef({ onActivateMarker, onDefect });
  callbacks.current = { onActivateMarker, onDefect };
  const [storedFurthest, setStoredFurthest] = useState(0);
  const [wornStrokes, setWornStrokes] = useState<WornStroke[]>([]);
  /* The dwell clock reads the reading position off refs so that scrolling —
     which already re-renders this component through `visibleRange` — costs
     nothing extra, and so the interval never captures a stale range. */
  const positionRef = useRef(visibleRange.start);
  const reachRef = useRef(visibleRange.end);
  positionRef.current = visibleRange.start;
  reachRef.current = visibleRange.end;

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const measure = () => {
      const nextHeight = track.getBoundingClientRect().height;
      setTrackHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(track);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  /* The wear-marks are local by construction: no request, no cookie, no
     server, and nothing here is ever surfaced as a number. Loading on mount
     rather than during render keeps first paint identical on both sides of
     hydration — the vine starts at this sitting's reach and lengthens to the
     remembered one a frame later. */
  useEffect(() => {
    if (resourceId === undefined) return;

    const store = readMarginalia(resourceId);
    setStoredFurthest(store.furthest);
    setWornStrokes(toWornStrokes(store.worn));

    let lastBucket = -1;
    let ticks = 0;
    let changed = false;
    const timer = window.setInterval(() => {
      /* A backgrounded tab is not a reader: an unattended sitting wears no
         groove, and the tick it spanned is not one a position survived. */
      if (document.visibilityState !== "visible") {
        lastBucket = -1;
        return;
      }

      const reach = clampUnit(reachRef.current);
      if (reach > store.furthest) {
        store.furthest = reach;
        changed = true;
      }
      const bucket = wornBucket(positionRef.current);
      /* Credit only a position that survived a whole tick, so scrolling past a
         page leaves no groove and stopping to read one does. */
      if (bucket === lastBucket) {
        const seconds = Math.min(
          (store.worn[bucket] ?? 0) + WORN_TICK_MS / 1000,
          WORN_BUCKET_CAP_SECONDS,
        );
        if (seconds !== store.worn[bucket]) {
          store.worn[bucket] = seconds;
          changed = true;
        }
      }
      lastBucket = bucket;
      /* Storage is synchronous: a tick that recorded nothing — a capped bucket,
         a reader who has not moved — must not reach it at all. */
      if (changed) {
        persistMarginalia(resourceId, store);
        changed = false;
      }

      ticks += 1;
      if (ticks % WORN_REFRESH_TICKS === 0) {
        setWornStrokes((current) => {
          const next = toWornStrokes(store.worn);
          return sameWornStrokes(current, next) ? current : next;
        });
      }
    }, WORN_TICK_MS);

    return () => {
      window.clearInterval(timer);
      const reach = clampUnit(reachRef.current);
      if (reach > store.furthest) {
        store.furthest = reach;
        changed = true;
      }
      if (changed) persistMarginalia(resourceId, store);
    };
  }, [resourceId]);

  const hasTrackHeight = trackHeight > 0;
  const bucketCount = Math.min(512, Math.max(1, Math.floor(trackHeight / MARKER_TARGET_SIZE_PX)));
  const vineD = useMemo(() => vinePath(trackHeight), [trackHeight]);
  const vineReach = Math.max(storedFurthest, clampUnit(visibleRange.end));
  const budY = clampUnit(visibleRange.start) * trackHeight;
  useEffect(() => {
    const root = buttonsRef.current;
    if (root === null || !hasTrackHeight) return;
    const controller = new AbortController();
    let lease: ReaderOverlayLease | null = null;
    let dom: ReaderDomLease | null = null;
    const retire = () => { root.replaceChildren(); lease?.release(); lease = null; dom?.release(); dom = null; };
    setOverviewStatus({ kind: "Loading" }); setBucket(null); setPositionedFacts(null); callbacks.current.onDefect(null);
    void (async () => {
      if (session.overlays === null) throw new Error("Hosted overview capability is unavailable");
      const result = await session.overlays({ kind: "EvidenceOverview", request: { bucket_count: bucketCount, kinds: KINDS } }, controller.signal);
      if (result.kind === "Capacity") { if (!controller.signal.aborted) setOverviewStatus(result); return; }
      if (controller.signal.aborted) { result.lease.release(); return; }
      lease = result.lease;
      if (lease.result.kind !== "EvidenceOverview") throw new Error("Overview received another query result");
      dom = session.reserveDomNodes(24 + lease.result.page.buckets.length * 4);
      if (dom === null) { retire(); setOverviewStatus({ kind: "Capacity", reason: "Dom" }); return; }
      const missing = Object.values(lease.result.page.unavailable_counts).reduce((sum, value) => sum + value, 0);
      setUnavailable(missing);
      // The old plaque depends on locatable, filtered margin facts. Unavailable
      // facts were excluded by buildMarginItems, as were Contents and Embeds.
      const positioned = { highlight: 0, citation: 0, link: 0, synapse: 0 };
      for (const { counts } of lease.result.page.buckets) {
        positioned.highlight += counts.highlights; positioned.citation += counts.source_references + counts.generated_citations;
        positioned.link += counts.links; positioned.synapse += counts.synapses;
      }
      setPositionedFacts(positioned);
      for (const entry of lease.result.page.buckets) {
        const count = Object.values(entry.counts).reduce((sum, value) => sum + value, 0);
        if (count === 0) continue;
        const index = entry.index;
        const position = (index + 0.5) / bucketCount;
        const slot = document.createElement("div"); slot.className = styles.markerSlot;
        slot.style.setProperty("--position", `${position * 100}%`);
        const button = document.createElement("button"); button.type = "button"; button.className = styles.markerButton;
        button.dataset.bucket = String(index); button.tabIndex = root.childElementCount === 0 ? 0 : -1;
        button.setAttribute("aria-label", bucketAccessibleName(entry.counts, count, position));
        button.setAttribute("aria-expanded", "false");
        const label = document.createElement("span"); label.className = styles.clusterCount; label.setAttribute("aria-hidden", "true"); label.textContent = String(count);
        button.append(label); slot.append(button); root.append(slot);
        button.onclick = () => {
          const opening = bucketRef.current?.index !== index;
          focusFirstDestination.current = opening;
          setBucket(opening ? { index, after: null } : null);
        };
        button.onfocus = () => {
          for (const other of root.querySelectorAll<HTMLButtonElement>("button")) other.tabIndex = other === button ? 0 : -1;
        };
        button.onkeydown = (event) => {
          const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
          const nextIndex = nextRovingIndexForKey({ key: event.key, currentIndex: buttons.indexOf(button), itemCount: buttons.length, orientation: "vertical" });
          if (nextIndex === null) return;
          event.preventDefault(); buttons[nextIndex]?.focus();
        };
      }
      setOverviewStatus({ kind: "Ready" });
    })().catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      retire(); setOverviewStatus({ kind: "Failed" });
      if (!isApiError(error) || isSameSystemApiDefect(error)) callbacks.current.onDefect({ key: createRandomId("overview"), error,
        retry: () => { if (!controller.signal.aborted) setOverviewAttempt((value) => value + 1); } });
    });
    return () => { controller.abort(); retire(); };
  }, [session, refreshToken, bucketCount, overviewAttempt, hasTrackHeight]);
  useEffect(() => {
    for (const button of buttonsRef.current?.querySelectorAll<HTMLButtonElement>("button[data-bucket]") ?? []) {
      const expanded = Number(button.dataset.bucket) === bucket?.index;
      button.setAttribute("aria-expanded", String(expanded));
      if (expanded) button.setAttribute("aria-controls", listId);
      else button.removeAttribute("aria-controls");
    }
  }, [bucket, listId]);
  useEffect(() => {
    const root = listRef.current;
    if (root === null || bucket === null) return;
    const controller = new AbortController();
    let lease: ReaderOverlayLease | null = null;
    let dom: ReaderDomLease | null = null;
    let pendingAction = false;
    const previewRoot = previewRef.current;
    let previewController: AbortController | null = null;
    let previewMarkerId: string | null = null;
    let previewLease: ReaderOverlayLease | null = null;
    let previewDom: ReaderDomLease | null = null;
    const retirePreview = () => {
      previewController?.abort(); previewController = null; previewMarkerId = null;
      previewRoot?.replaceChildren(); previewLease?.release(); previewLease = null; previewDom?.release(); previewDom = null;
      for (const button of root.querySelectorAll("[aria-describedby]")) button.removeAttribute("aria-describedby");
    };
    const release = () => { lease?.release(); lease = null; dom?.release(); dom = null; };
    const retire = () => { root.replaceChildren(); if (!pendingAction) release(); };
    const fail = (error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) callbacks.current.onDefect({ key: createRandomId("overview-members"), error,
        retry: () => { if (!controller.signal.aborted) setPageAttempt((value) => value + 1); } });
    };
    const showPreview = (markerId: string) => {
      if (previewMarkerId === markerId) return;
      retirePreview();
      if (previewRoot === null || controller.signal.aborted) return;
      const request = new AbortController(); previewController = request; previewMarkerId = markerId;
      previewRoot.textContent = "Loading destination…";
      void (async () => {
        if (session.overlays === null) throw new Error("Hosted overview capability is unavailable");
        const result = await session.overlays({ kind: "EvidenceMarkerPreview", request: { marker_id: markerId } }, request.signal);
        if (result.kind === "Capacity") { if (previewController === request) previewRoot.textContent = readerCapacityNotice(result.reason).message; return; }
        if (previewController !== request || request.signal.aborted) { result.lease.release(); return; }
        previewLease = result.lease;
        if (previewLease.result.kind !== "EvidenceMarkerPreview") throw new Error("Overview preview received another query result");
        previewDom = session.reserveDomNodes(10);
        if (previewDom === null) { retirePreview(); previewRoot.textContent = readerCapacityNotice("Dom").message; return; }
        const value = previewLease.result.page;
        const label = document.createElement("strong"); label.textContent = value.tone === "Warning" ? `Source uncertain: ${value.label_excerpt}` : value.label_excerpt;
        const excerpt = document.createElement("p"); excerpt.textContent = value.excerpt ?? "";
        previewRoot.replaceChildren(markerGlyph(value.kind, value.tone), label, excerpt);
      })().catch((error: unknown) => {
        if (previewController !== request || request.signal.aborted || isAbortError(error)) return;
        retirePreview(); previewRoot.textContent = "Destination preview could not be loaded."; fail(error);
      });
    };
    setPageStatus({ kind: "Loading" }); setNext(null); setActionStatus({ kind: "Idle" });
    void (async () => {
      if (session.overlays === null) throw new Error("Hosted overview capability is unavailable");
      const result = await session.overlays({ kind: "EvidenceBucket", request: { bucket_count: bucketCount, kinds: KINDS, index: bucket.index, after: bucket.after, limit: 24 } }, controller.signal);
      if (result.kind === "Capacity") { if (!controller.signal.aborted) setPageStatus(result); return; }
      if (controller.signal.aborted) { result.lease.release(); return; }
      lease = result.lease;
      if (lease.result.kind !== "EvidenceBucket") throw new Error("Overview members received another query result");
      dom = session.reserveDomNodes(16 + lease.result.page.items.length * 8);
      if (dom === null) { retire(); setPageStatus({ kind: "Capacity", reason: "Dom" }); return; }
      for (const marker of lease.result.page.items) {
        const item = document.createElement("li");
        const button = document.createElement("button"); button.type = "button";
        const label = `${marker.kind === "SourceReference" || marker.kind === "GeneratedCitation" ? "Citation" : marker.kind}, ${Math.round(marker.position * 100)}% through document`;
        button.append(markerGlyph(marker.kind, marker.kind === "SourceReference" || marker.kind === "GeneratedCitation" ? "Citation" : marker.kind === "Contents" || marker.kind === "Embed" ? "Neutral" : marker.kind), document.createTextNode(label));
        const markerId = marker.id;
        button.onmouseenter = button.onfocus = () => { showPreview(markerId); button.setAttribute("aria-describedby", previewId); };
        button.onmouseleave = () => { if (document.activeElement !== button) retirePreview(); };
        button.onblur = retirePreview;
        button.onclick = () => {
          if (pendingAction || controller.signal.aborted) return;
          pendingAction = true; setActionStatus({ kind: "Loading" });
          void callbacks.current.onActivateMarker(marker, controller.signal).then((result) => {
            if (controller.signal.aborted) return;
            if (result.kind === "Located") setBucket(null);
            else setActionStatus(result.kind === "Capacity" ? result : { kind: "Unavailable" });
          }).catch((error: unknown) => { if (!controller.signal.aborted && !isAbortError(error)) { setActionStatus({ kind: "Failed" }); fail(error); } })
            .finally(() => { pendingAction = false; if (controller.signal.aborted) release(); });
        };
        item.append(button); root.append(item);
      }
      setNext(lease.result.page.next_cursor); setPageStatus({ kind: "Ready" });
      if (focusFirstDestination.current) {
        focusFirstDestination.current = false;
        root.querySelector<HTMLButtonElement>("button")?.focus();
      }
    })().catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      retire(); setPageStatus({ kind: "Failed" }); fail(error);
    });
    return () => { controller.abort(); retirePreview(); retire(); };
  }, [session, refreshToken, bucketCount, bucket, pageAttempt, previewId]);
  const overviewNotice = overviewStatus.kind === "Capacity" ? readerCapacityNotice(overviewStatus.reason) : null;
  const pageNotice = pageStatus.kind === "Capacity" ? readerCapacityNotice(pageStatus.reason) : null;
  const actionNotice = actionStatus.kind === "Capacity" ? readerCapacityNotice(actionStatus.reason) : null;
  const closeBucket = () => {
    if (bucket !== null) buttonsRef.current?.querySelector<HTMLButtonElement>(`button[data-bucket="${bucket.index}"]`)?.focus();
    setBucket(null);
  };
  return <div className={styles.rail} data-testid="reader-document-map-overview-rail" role="region" aria-label="Document Map overview">
    <div ref={trackRef} className={styles.track} role="toolbar" aria-orientation="vertical" aria-label="Document Map destinations">
        {trackHeight > 0 ? (
          <svg
            className={styles.marginalia}
            viewBox={`0 0 ${RAIL_WIDTH_PX} ${trackHeight}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {wornStrokes.map((stroke) => (
              <path
                key={stroke.level}
                className={cx(styles.worn, wornLevelClass(stroke.level))}
                d={vineD}
                pathLength={WORN_BUCKETS}
                style={{ strokeDasharray: stroke.dashArray }}
              />
            ))}
            <path
              className={styles.vine}
              d={vineD}
              pathLength={1}
              style={{ "--vine-reach": vineReach.toFixed(3) } as VineStyle}
            />
            <circle
              className={styles.budRing}
              cx={vineX(budY)}
              cy={budY}
              r={5}
            />
            <circle className={styles.bud} cx={vineX(budY)} cy={budY} r={2.4} />
          </svg>
        ) : null}

        <div
          className={styles.band}
          data-testid="reader-document-map-band"
          aria-hidden="true"
          style={{
            top: `${visibleRange.start * 100}%`,
            height: `${(visibleRange.end - visibleRange.start) * 100}%`,
          }}
        />

        <div ref={buttonsRef} aria-busy={overviewStatus.kind === "Loading"} />
        {overviewStatus.kind === "Loading" ? <span role="status">Loading overview…</span> : null}
        {overviewNotice !== null ? <span role="status">{overviewNotice.message}</span> : null}
        {(overviewNotice !== null && overviewNotice.retryable) || overviewStatus.kind === "Failed" ? <button type="button" onClick={() => setOverviewAttempt((value) => value + 1)}>Retry overview</button> : null}
        {unavailable > 0 ? <span role="status">{unavailable === 1 ? "1 destination has" : `${unavailable} destinations have`} no source position.</span> : null}
        {bucket !== null ? <div className={cx(styles.destinationList, positionPlacementClass((bucket.index + 0.5) / bucketCount))}
          style={{ "--position": `${((bucket.index + 0.5) / bucketCount) * 100}%` } as CSSProperties}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeBucket(); } }}>
          <button type="button" onClick={closeBucket}>Close destinations</button>
          <div ref={previewRef} id={previewId} role="tooltip" />
          <ul ref={listRef} id={listId} aria-label="Destinations in this part" aria-busy={pageStatus.kind === "Loading"} />
          {pageStatus.kind === "Loading" ? <p role="status">Loading destinations…</p> : null}
          {pageNotice !== null ? <p role="status">{pageNotice.message}</p> : null}
          {(pageNotice !== null && pageNotice.retryable) || pageStatus.kind === "Failed" ? <button type="button" onClick={() => setPageAttempt((value) => value + 1)}>Retry destinations</button> : null}
          {actionStatus.kind !== "Idle" ? <p role="status">{actionStatus.kind === "Loading" ? "Opening destination…" : actionNotice?.message ?? "Destination is unavailable."}</p> : null}
          <button type="button" onClick={() => { focusFirstDestination.current = true; setBucket({ index: bucket.index, after: null }); }}>First destinations</button>
          {next !== null ? <button type="button" onClick={() => { focusFirstDestination.current = true; setBucket({ index: bucket.index, after: next }); }}>Next destinations</button> : null}
        </div> : null}
    </div>
  </div>;
}

/* === Living marginalia (final-direction §10, wildcard 1) ===
   One drawing that is at once the progress bar, the wear-mark and the
   highlight map. Two sines of incommensurate wavelength, exactly the language
   of the `--elvish-vine` tile: asymmetric S-curves that never resolve into a
   sine, an amplitude that keeps the stroke clear of the 24px marker buttons.
   Closed-form so the bud can sit on the curve without ever measuring the DOM. */
const VINE_CENTER_X = RAIL_WIDTH_PX / 2;
const VINE_AMPLITUDE_A = 3.4;
const VINE_WAVELENGTH_A = 96;
const VINE_AMPLITUDE_B = 1.8;
const VINE_WAVELENGTH_B = 158;
const VINE_PHASE_B = 1.1;
const VINE_SAMPLE_PX = 16;

function vineX(y: number): number {
  return (
    VINE_CENTER_X +
    VINE_AMPLITUDE_A * Math.sin((2 * Math.PI * y) / VINE_WAVELENGTH_A) +
    VINE_AMPLITUDE_B *
      Math.sin((2 * Math.PI * y) / VINE_WAVELENGTH_B + VINE_PHASE_B)
  );
}

function vineSlope(y: number): number {
  return (
    ((2 * Math.PI * VINE_AMPLITUDE_A) / VINE_WAVELENGTH_A) *
      Math.cos((2 * Math.PI * y) / VINE_WAVELENGTH_A) +
    ((2 * Math.PI * VINE_AMPLITUDE_B) / VINE_WAVELENGTH_B) *
      Math.cos((2 * Math.PI * y) / VINE_WAVELENGTH_B + VINE_PHASE_B)
  );
}

/* Hermite-to-Bézier per sample interval: the analytic tangent at both ends is
   what keeps a 16px step from reading as a polyline. */
function vinePath(height: number): string {
  if (height <= 0) return "";

  const steps = Math.max(2, Math.round(height / VINE_SAMPLE_PX));
  const step = height / steps;
  let path = `M${vineX(0).toFixed(2)} 0`;
  for (let index = 0; index < steps; index += 1) {
    const startY = index * step;
    const endY = startY + step;
    const startControlX = vineX(startY) + (vineSlope(startY) * step) / 3;
    const endControlX = vineX(endY) - (vineSlope(endY) * step) / 3;
    path += `C${startControlX.toFixed(2)} ${(startY + step / 3).toFixed(2)} ${endControlX.toFixed(2)} ${(endY - step / 3).toFixed(2)} ${vineX(endY).toFixed(2)} ${endY.toFixed(2)}`;
  }
  return path;
}

const MARGINALIA_STORAGE_PREFIX = "nx-solar:";
const WORN_BUCKETS = 96;
const WORN_TICK_MS = 5000;
const WORN_REFRESH_TICKS = 6;
const WORN_BUCKET_CAP_SECONDS = 600;
const WORN_LEVEL_SECONDS = [15, 60, 240];

interface MarginaliaStore {
  furthest: number;
  worn: number[];
}

/* Half-open, in bucket indices. */
interface WornRun {
  start: number;
  end: number;
}

interface WornStroke {
  level: number;
  dashArray: string;
}

function emptyMarginalia(): MarginaliaStore {
  return { furthest: 0, worn: new Array<number>(WORN_BUCKETS).fill(0) };
}

function readMarginalia(resourceId: string): MarginaliaStore {
  const store = emptyMarginalia();
  try {
    const raw = window.localStorage.getItem(
      `${MARGINALIA_STORAGE_PREFIX}${resourceId}`,
    );
    if (raw === null) return store;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return store;

    const { furthest, worn } = parsed as Partial<MarginaliaStore>;
    if (typeof furthest === "number" && Number.isFinite(furthest)) {
      store.furthest = clampUnit(furthest);
    }
    if (Array.isArray(worn)) {
      for (let index = 0; index < WORN_BUCKETS; index += 1) {
        const seconds = worn[index];
        store.worn[index] =
          typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds, WORN_BUCKET_CAP_SECONDS)
            : 0;
      }
    }
    return store;
  } catch {
    return store;
  }
}

function writeMarginalia(resourceId: string, store: MarginaliaStore): void {
  try {
    window.localStorage.setItem(
      `${MARGINALIA_STORAGE_PREFIX}${resourceId}`,
      JSON.stringify(store),
    );
  } catch {
    // A blocked or full store costs the reader nothing but this drawing.
  }
}

/* Two panes can hold one document open, each with its own copy of the store, so
   writing a copy whole would drop whatever the other pane recorded since this
   one loaded. Re-read, take the larger of every field — furthest and each
   bucket only ever grow — and keep the merge in this copy, so the other pane's
   wear shows up in the next refresh instead of being overwritten by the next
   tick. */
function persistMarginalia(resourceId: string, store: MarginaliaStore): void {
  const stored = readMarginalia(resourceId);
  store.furthest = Math.max(store.furthest, stored.furthest);
  for (let index = 0; index < WORN_BUCKETS; index += 1) {
    store.worn[index] = Math.max(
      store.worn[index] ?? 0,
      stored.worn[index] ?? 0,
    );
  }
  writeMarginalia(resourceId, store);
}

function wornBucket(position: number): number {
  return Math.min(
    WORN_BUCKETS - 1,
    Math.max(0, Math.floor(clampUnit(position) * WORN_BUCKETS)),
  );
}

function wornLevel(seconds: number): number {
  let level = 0;
  for (const threshold of WORN_LEVEL_SECONDS) {
    if (seconds >= threshold) level += 1;
  }
  return level;
}

/* Quantising to three authored strengths puts the groove's opacity in the
   stylesheet where `--ornament` can reach it, and collecting every run of a
   strength into that strength's own dash pattern puts the whole drawing in
   three elements whatever the reading looks like — not the 96 a bucket-per-run
   emitter reaches when no two neighbours agree. */
function toWornStrokes(worn: number[]): WornStroke[] {
  const runsByLevel = new Map<number, WornRun[]>();
  let index = 0;
  while (index < WORN_BUCKETS) {
    const level = wornLevel(worn[index] ?? 0);
    let end = index + 1;
    while (end < WORN_BUCKETS && wornLevel(worn[end] ?? 0) === level) end += 1;
    if (level > 0) {
      const runs = runsByLevel.get(level) ?? [];
      runs.push({ start: index, end });
      runsByLevel.set(level, runs);
    }
    index = end;
  }

  return [...runsByLevel].map(([level, runs]) => ({
    level,
    dashArray: wornDashArray(runs),
  }));
}

/* The path is measured in buckets — `pathLength={WORN_BUCKETS}` — so the dash
   cycle is a list of whole buckets and one element can expose several stretches
   of the same curve exactly: a zero-length dash, then gap-and-run per stretch,
   then a trailing gap of a whole path length so the cycle never repeats. Runs
   arrive in ascending order, which is what lets each gap be the plain distance
   from the previous run's end. */
function wornDashArray(runs: WornRun[]): string {
  const parts = ["0"];
  let cursor = 0;
  for (const run of runs) {
    parts.push(String(run.start - cursor), String(run.end - run.start));
    cursor = run.end;
  }
  parts.push(String(WORN_BUCKETS));
  return parts.join(" ");
}

/* The refresh runs on a clock, not on a change, and a reader who stopped moving
   recomputes the same three strokes forever. Returning the current array keeps
   React from re-rendering the rail in every room. */
function sameWornStrokes(current: WornStroke[], next: WornStroke[]): boolean {
  return (
    current.length === next.length &&
    current.every(
      (stroke, index) =>
        stroke.level === next[index]!.level &&
        stroke.dashArray === next[index]!.dashArray,
    )
  );
}

function wornLevelClass(level: number): string {
  if (level >= 3) return styles.wornDeep;
  if (level === 2) return styles.wornMid;
  return styles.wornFaint;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* A bucket of one is named by its destination: the kind is already in hand from
   the overview counts, so the reader need not open the list to learn what it is. */
function bucketAccessibleName(counts: ReaderPublicationEvidenceMarkerCounts, count: number, position: number): string {
  const percent = Math.round(position * 100);
  if (count !== 1) return `${count} destinations near ${percent}% through document`;
  const kind = counts.contents === 1 ? "Contents" : counts.embeds === 1 ? "Embed" : counts.highlights === 1 ? "Highlight"
    : counts.source_references === 1 || counts.generated_citations === 1 ? "Citation" : counts.links === 1 ? "Link" : "Synapse";
  return `${kind} near ${percent}% through document`;
}

function positionPlacementClass(position: number): string | false {
  if (position < 0.25) return styles.placeAtStart;
  if (position > 0.75) return styles.placeAtEnd;
  return false;
}

function markerGlyph(kind: ReaderPublicationEvidenceMarkerKind, tone: ReaderPublicationEvidenceMarkerPreview["tone"]): HTMLSpanElement {
  const shape = kind === "Contents" ? styles.markerContents : kind === "Embed" ? styles.markerEmbed
    : kind === "Highlight" ? styles.markerHighlight : kind === "SourceReference" || kind === "GeneratedCitation" ? styles.markerCitation : styles.markerConnection;
  const color = tone === "Highlight" ? "var(--highlight-yellow)" : tone === "Citation" ? "var(--highlight-purple)"
    : tone === "Link" ? "var(--highlight-blue)" : tone === "Synapse" ? "var(--highlight-green)"
    : tone === "Warning" ? "var(--highlight-pink)" : "var(--edge-strong)";
  const glyph = document.createElement("span");
  glyph.className = cx(styles.markerGlyph, shape, tone === "Warning" && styles.markerWarning);
  glyph.style.setProperty("--marker-color", color);
  glyph.setAttribute("aria-hidden", "true");
  return glyph;
}
