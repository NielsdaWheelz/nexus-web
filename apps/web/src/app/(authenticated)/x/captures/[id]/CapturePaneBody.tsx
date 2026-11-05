"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useOutcome } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { convertReaderQuestion } from "@nexus/authored/markdown";
import { captureReaderQuote, replaceReaderQuote } from "@/lib/chat/readerIntent";
import QuotedMessageConnection from "@/components/chat/QuotedMessageConnection";
import { useRecent } from "@/lib/recent/store";
import { normalizeVisitTitleHint } from "@/lib/workspace/model";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import ReaderCitation from "@/components/ui/ReaderCitation";
import { useChangeStamp } from "@/lib/api/changes";
import { apiFetch, isApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { useAuthoredStore } from "@/lib/authored/provider";
import DocumentReaderView, { useDocumentReader, useReaderState, type Inspection, type Reader } from "@/lib/documentReader/DocumentReader";
import { locatePassage, placeSelection } from "@/lib/documentReader/annotations";
import { readerDocument } from "@/lib/documentReader/model";
import { serializeReaderDestination, type ReaderDestination } from "@/lib/documentReader/location";
import { useCompactAnnotations } from "@/lib/documentReader/chrome/CompactAnnotations";
import { useMobileChrome } from "@/lib/mobileShell/chrome";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { requirePaneRuntime, usePaneIsActive, usePaneParam, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { useAuthoredQuery } from "@/lib/notes/hooks";
import { useSourceArrival } from "@/lib/reader/sourceArrival";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { usePaneLayout } from "@/lib/panes/paneChrome";
import { MapRail, MAP_RAIL_WIDTH_PX } from "@/lib/documentReader/chrome/MapRail";
import { destinationTarget, inspectionOfLocator, targetOfLocator, targetOfResolution, useReaderVisit } from "@/app/(authenticated)/media/[id]/hostedReader";
import { PostActions, PostSaveReadFailure } from "@/app/(authenticated)/media/[id]/Embeds";
import { usePostSaveStates } from "@/lib/media/xPostSaves";
import { evidenceRootKey, factFacet } from "@/app/(authenticated)/media/[id]/evidence/model";

export default function CapturePaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("capture route requires an id");
  return <CaptureReader key={id} id={id} />;
}

function CaptureReader({ id }: { readonly id: string }) {
  const recent = useRecent();
  const runtime = requirePaneRuntime(usePaneRuntime(), "CaptureReader");
  const { ctx } = useActionRuntime();
  const store = useAuthoredStore();
  const { profile } = useReaderContext();
  const mobile = useIsMobileViewport();
  const chrome = useMobileChrome();
  const viewport = useMobileViewport();
  const active = usePaneIsActive();
  const readerRef = useRef<Reader | null>(null);
  const evidenceRoot = useRef<HTMLElement>(null);
  const arrivalRef = useRef<ReturnType<typeof useSourceArrival> | null>(null);
  const [inspection, setInspection] = useState<(Inspection & { readonly activationId: string }) | null>(null);
  const savedView = useReaderVisit(readerRef);
  const source = useMemo(() => ({
    async load(signal: AbortSignal) {
      const { data } = await apiFetch<ApiJson<"/x/captures/{capture_id}/reader", "get">>(`/api/x/captures/${id}/reader`, { signal });
      return readerDocument(data);
    },
    async refreshPdf() { throw new Error("capture has no pdf"); },
  }), [id]);
  const reader = useDocumentReader(id, useMemo(() => ({ source, progress: null, entry: { fresh: null, cold: null, view: savedView }, host: {
    scrollport: (element: HTMLElement, geometryChanged: (reason: "Occlusion" | "Layout") => void) => {
      const releaseChrome = chrome.registerReaderScrollport(element);
      const releaseViewport = viewport.registerReaderScrollport(element, geometryChanged);
      return () => { releaseChrome(); releaseViewport(); };
    },
    onIntent: (intent: { kind: "Navigate"; signal: AbortSignal | null } | { kind: "Read" }) => arrivalRef.current?.supersede({ preserveSignal: intent.kind === "Navigate" ? intent.signal : null, retireFailure: intent.kind === "Navigate" }),
    navigation: {
      href: (destination: import("@/lib/documentReader/location").ReaderDestination) => `/x/captures/${id}?${new URLSearchParams({ loc: serializeReaderDestination(destination) })}`,
      activate: (destination: import("@/lib/documentReader/location").ReaderDestination, intent: "default" | "new_pane", onDefault: () => void) => {
        if (intent === "default") { onDefault(); return "Accepted" as const; }
        const href = `/x/captures/${id}?${new URLSearchParams({ loc: serializeReaderDestination(destination) })}`;
        return runtime.activateTarget({ target: { href }, disposition: { kind: "Fork" } }).kind === "Cancelled" ? "Refused" as const : "Accepted" as const;
      },
    },
  } }), [source, savedView, id, runtime, chrome, viewport]));
  readerRef.current = reader;
  const citationStamp = useChangeStamp("Entries", "Metadata");
  useEffect(() => store.evidence_changed(() => reader.reload()), [reader, store]);
  useEffect(() => {
    if (reader.getState().document.status === "ready") reader.reload();
  }, [citationStamp, reader]);
  useEffect(() => {
    if (active && reader.getState().document.status === "ready") reader.reload();
  }, [active, reader]);
  const state = useReaderState(reader, value => value);
  const retriedSequence = useRef("0");
  const missing = state.document.status === "failed" && !state.document.retrying && isApiError(state.document.error) && state.document.error.status === 404;
  useEffect(() => {
    if (!missing) return;
    const controller = new AbortController();
    let checking = false;
    let again = false;
    const check = async () => {
      if (checking) { again = true; return; }
      checking = true;
      try {
        const { command_seq } = await store.readReplica();
        if (BigInt(command_seq) <= BigInt(retriedSequence.current)) return;
        await store.whenUploaded(command_seq, controller.signal);
        if (controller.signal.aborted) return;
        const current = reader.getState().document;
        if (current.status === "failed" && !current.retrying) {
          retriedSequence.current = command_seq;
          reader.retryLoad();
        }
      } catch {
        // A later sync status retries the wait; the source failure remains visible.
      } finally {
        checking = false;
        if (again && !controller.signal.aborted) { again = false; void check(); }
      }
    };
    const stop = store.sync_status(status => {
      if (status === "syncing" || status === "current") void check();
    });
    return () => { controller.abort(); stop(); };
  }, [missing, reader, store]);
  const doc = state.document.status === "ready" ? state.document.doc : null;
  const postSaves = usePostSaveStates(doc);
  useEffect(() => {
    if (!doc) return;
    const entry = recent.snapshot?.entries.find(value => value.target.kind === "x_capture" && value.target.capture_id === id);
    const title = normalizeVisitTitleHint(doc.title);
    if (!entry || entry.title_hint === title && entry.detail_hint === "post") return;
    recent.reconcile({ target: entry.target, expected_used_revision: entry.used_revision, replacement: { target: entry.target, href: entry.href, title_hint: title, detail_hint: "post" } });
  }, [doc, id, recent]);
  const stamp = useChangeStamp("Notes", "NoteBodies", "Chats", "Entries", "Metadata");
  const map = usePaneFreeServerValue({ key: `capture-map:${id}`, stale: stamp, load: async signal =>
    (await apiFetch<ApiJson<"/x/captures/{capture_id}/document-map", "get">>(`/api/x/captures/${id}/document-map`, { signal })).data });
  const refreshMap = useRef(map.refetch);
  refreshMap.current = map.refetch;
  useEffect(() => store.evidence_changed(() => refreshMap.current()), [store]);
  useEffect(() => {
    if (doc?.kind !== "text") return;
    const fragments = [...new Set(doc.units.flatMap(unit => unit.xPost?.owner ? [unit.xPost.owner.fragment_id] : []))];
    const stops = fragments.map(fragment => store.subscribe({ kind: "annotations", source_ref: `fragment:${fragment}`, cursor: null, limit: 100 }, () => refreshMap.current(), () => {}));
    return () => { for (const stop of stops) stop(); };
  }, [doc, store]);
  const arrival = useSourceArrival({ ready: state.restored, sourceIdentity: doc?.identity ?? null, apply: async (target, context) => {
    if (!doc || context.signal.aborted) return "Cancelled";
    if (target.kind === "resource") {
      if (context.mayFocus()) reader.focusSource();
      return "Applied";
    }
    let destination: import("@/lib/documentReader/model").ReaderTarget | null = null;
    let paint: Inspection | null = null;
    if (target.kind === "source") {
      if (target.source.location.kind === "resource") {
        if (context.mayFocus()) reader.focusSource();
        return "Applied";
      }
      const location = target.source.location;
      if (location.kind === "point") destination = destinationTarget({ source_identity: location.source_identity,
        target: { kind: "point", point: { kind: "text", unit: location.point.unit_id, offset: location.point.offset } } }, reader);
      else if (location.kind === "located") {
        const locator = location.locator;
        if (locator.type !== "x_capture_offsets" || location.source_identity !== doc.identity || doc.kind !== "text") return "Unavailable";
        const unit = doc.units.find(unit => unit.xPost?.owner?.capture_id === locator.capture_id && unit.xPost.owner.fragment_id === locator.fragment_id);
        if (!unit || locator.end_offset > unit.length || locator.text_quote_selector && Array.from(unit.text).slice(locator.start_offset, locator.end_offset).join("") !== locator.text_quote_selector.exact) return "Unavailable";
        destination = targetOfLocator(locator, doc);
        paint = inspectionOfLocator(locator, doc, location.precision);
      }
    }
    if (target.kind === "reader_destination") destination = destinationTarget(target.destination, reader);
    if (target.kind === "passage") destination = locatePassage(doc, id, target.passage, target.canonical_source_ref)?.target ?? null;
    if (target.kind === "highlight") {
      const row = (await store.query({ kind: "resource", ref: `highlight:${target.highlight_id}` })).rows[0]?.resource;
      const placed = row?.selection ? placeSelection(doc, id, row.selection) : null;
      if (placed?.kind === "placed" && placed.anchor.kind === "text") destination = { kind: "range", unit: placed.anchor.unit, start: placed.anchor.start, end: placed.anchor.end };
    }
    if (!destination) return "Unavailable";
    if (!context.restored) {
      const result = await reader.inspect({ target: destination, signal: context.signal });
      if (result.kind === "Cancelled") return "Cancelled";
      if (result.kind === "Unavailable") return "FailureHandled";
    }
    if (context.signal.aborted) return "Cancelled";
    const current = reader.getState().document;
    if (current.status !== "ready" || current.doc.identity !== doc.identity) return "Unavailable";
    if (paint) {
      setInspection({ ...paint, activationId: context.activationId });
      context.signal.addEventListener("abort", () => {
        setInspection(current => current?.activationId === context.activationId ? null : current);
      }, { once: true });
    }
    if (context.mayFocus()) reader.focusSource();
    return "Applied";
  } });
  const { say } = useOutcome();
  arrivalRef.current = arrival;
  const annotations = useCompactAnnotations(reader, id, { kind: "x_capture", label: "post" }, true, true, {
    reviewing: arrival.quoteReview !== null,
    cancelReview: arrival.finishQuoteReview,
    submit(input) {
      if (!doc || input.identity !== doc.identity) return false;
      const quote = captureReaderQuote({ doc, scope: { kind: "x_capture", capture_id: id }, anchor: input.anchor,
        capture: input.capture, annotation: input.annotation });
      if (!quote) { say({ fact: "couldn’t capture this passage." }); return false; }
      if (arrival.quoteReview) {
        if (!replaceReaderQuote(ctx.workspace(), arrival.quoteReview, quote)) { say({ fact: "the original draft is no longer open." }); return false; }
        arrival.finishQuoteReview(); return true;
      }
      const question = convertReaderQuestion(input.question);
      if (question.kind === "Unsupported") { say({ fact: "images and embeds can’t be sent from here." }); return false; }
      if (question.kind === "Text" && [...question.content].length > 20_000) { say({ fact: "this question is too long." }); return false; }
      return runtime.activateTarget({ target: { href: "/conversations/new" }, disposition: { kind: "Fork" },
        entry: { kind: "ComposeReaderQuestion", text: question.kind === "Text" ? question.content : "", selection: { kind: "Uninitialized" }, quote } }).kind !== "Cancelled";
    },
  });
  const mapEvidence = useMemo(() => {
    if (!doc || map.status !== "ready" || map.data.identity !== doc.identity) return null;
    const targets = new Map<string, Extract<ReaderDestination["target"], { kind: "range" | "point" }>>(map.data.evidence.roots.flatMap(root => {
      const target = root.resolution ? targetOfResolution(root.resolution, doc) : null;
      return target?.kind === "range" ? [[evidenceRootKey(root), target] as const] : [];
    }));
    if (doc.kind === "text") for (const occurrence of doc.citationOccurrences) {
      if (occurrence.at !== null) targets.set(occurrence.citation.edge_id, { kind: "point", point: { kind: "text", ...occurrence.at } });
    }
    return {
      markers: map.data.markers.map(marker => ({ id: marker.item_id, position: marker.position, end: marker.end_position,
        kind: marker.kind, tone: marker.tone, label: marker.label, preview: marker.preview })),
      markerTarget: (markerId: string) => {
        const target = targets.get(markerId);
        if (!target) throw new Error("capture map marker has no text location");
        return target;
      },
      onMarker: (markerId: string) => {
        const row = evidenceRoot.current?.querySelector<HTMLElement>(`[data-outline-occurrence="${CSS.escape(`capture:${id}:${markerId}`)}"]`);
        if (row) {
          row.scrollIntoView({ block: "nearest" });
          (row.querySelector<HTMLElement>("a[href]") ?? row).focus({ preventScroll: true });
          return;
        }
        const target = targets.get(markerId);
        if (target) { void reader.inspect({ target }); reader.focusSource(); }
      },
    };
  }, [doc, id, map, reader]);
  usePaneLayout(useMemo(() => ({ intrinsicWidthPx: null, rail: mobile ? null : {
    widthPx: MAP_RAIL_WIDTH_PX, body: <MapRail reader={reader} evidence={mapEvidence} />,
  } }), [mobile, reader, mapEvidence]));
  // An arrival's failure is its command's outcome: one slip, retracted when it clears.
  const arrivalFailure = arrival.failure?.title ?? null;
  useEffect(() => arrivalFailure === null ? undefined : say({ fact: arrivalFailure }), [arrivalFailure, say]);
  const footer = <>
    {annotations.list}
    {doc?.kind === "text" ? <ResourceOutlineList scope={`capture-sources:${id}`} ariaLabel="source connections">
      {[...new Set(doc.units.flatMap(unit => unit.xPost?.owner ? [unit.xPost.owner.fragment_id] : []))].map(fragment =>
        <CaptureSourceConnections key={fragment} captureId={id} fragment={fragment} />)}
    </ResourceOutlineList> : null}
    {map.status === "ready" && map.data.identity === doc?.identity && map.data.evidence.roots.length ? <section ref={evidenceRoot} aria-label="source evidence">
      <h2>evidence</h2><ResourceOutlineList scope={`capture-evidence:${id}`} ariaLabel="source evidence">
        {map.data.evidence.roots.filter(root => root.content.kind !== "Highlight" || !root.content.is_owner).map(root => {
          if (root.content.kind === "Quotation") return <li key={root.ref} tabIndex={-1} data-resource-ref={root.ref} data-outline-occurrence={`capture:${id}:${root.ref}`}>
            <QuotedMessageConnection content={root.content} />
          </li>;
          const item = root.content.kind === "SourceReference" ? null : root.content.item;
          if (!item) return null;
          const target = root.resolution ? targetOfResolution(root.resolution, doc ?? undefined) : null;
          return <ResourceOutlineRow key={evidenceRootKey(root)} item={item} incoming={null} occurrenceKey={`capture:${id}:${evidenceRootKey(root)}`}
            historical={root.direct_facts.some(fact => factFacet(fact) === "citations")}
            occurrenceLabel="source evidence" details={target ? <button type="button" onClick={() => void reader.inspect({ target, signal: new AbortController().signal })}>view in source</button> : null} />;
        })}
      </ResourceOutlineList>
    </section> : map.status === "failed" ? <button type="button" onClick={map.refetch}>retry evidence</button> : null}
  </>;
  return <>
    <DocumentReaderView reader={reader} profile={profile} isMobile={mobile} playback={null}
      decorations={annotations.decorations} inspection={inspection} onSelection={annotations.onSelection} onMarks={annotations.onMarks}
      renderCitation={citation => <ReaderCitation {...citation} />}
      renderPostActions={unit => unit.xPost ? <PostActions key={JSON.stringify([unit.id, unit.xPost.owner?.capture_id ?? null])} post={unit.xPost} hostMediaId={null} state={postSaves} /> : null}
      lane={<PostSaveReadFailure state={postSaves} />}
      end={footer} />
    {annotations.panel}
    {doc === null ? footer : null}
  </>;
}

function CaptureSourceConnections({ captureId, fragment }: { readonly captureId: string; readonly fragment: string }) {
  const ref = `fragment:${fragment}`;
  const source = useAuthoredQuery({ kind: "resource", ref });
  if (!source.data?.rows.length) return null;
  return <ResourceOutlineRow resourceRef={ref} incoming={null} occurrenceKey={`capture-source:${captureId}:${fragment}`} occurrenceLabel="source connections" />;
}
