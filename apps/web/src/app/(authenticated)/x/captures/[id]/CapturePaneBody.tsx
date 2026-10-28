"use client";

import { useEffect, useMemo, useRef } from "react";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { useChangeStamp } from "@/lib/api/changes";
import { apiFetch } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { useAuthoredStore } from "@/lib/authored/provider";
import DocumentReaderView, { useDocumentReader, useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import { locatePassage, placeSelection } from "@/lib/documentReader/annotations";
import { readerDocument } from "@/lib/documentReader/model";
import { serializeReaderDestination } from "@/lib/documentReader/location";
import { useCompactAnnotations } from "@/lib/documentReader/chrome/CompactAnnotations";
import { requirePaneRuntime, usePaneParam, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { useAuthoredQuery } from "@/lib/notes/hooks";
import { useSourceArrival } from "@/lib/reader/sourceArrival";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { destinationTarget, targetOfLocator, targetOfResolution, useReaderVisit } from "@/app/(authenticated)/media/[id]/hostedReader";
import { PostActions } from "@/app/(authenticated)/media/[id]/Embeds";

export default function CapturePaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("capture route requires an id");
  return <CaptureReader key={id} id={id} />;
}

function CaptureReader({ id }: { readonly id: string }) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "CaptureReader");
  const store = useAuthoredStore();
  const { profile } = useReaderContext();
  const mobile = useIsMobileViewport();
  const readerRef = useRef<Reader | null>(null);
  const arrivalRef = useRef<ReturnType<typeof useSourceArrival> | null>(null);
  const savedView = useReaderVisit(readerRef);
  const source = useMemo(() => ({
    async load(signal: AbortSignal) {
      const { data } = await apiFetch<ApiJson<"/x/captures/{capture_id}/reader", "get">>(`/api/x/captures/${id}/reader`, { signal });
      return readerDocument(data);
    },
    async refreshPdf() { throw new Error("capture has no pdf"); },
  }), [id]);
  const reader = useDocumentReader(id, useMemo(() => ({ source, progress: null, entry: { fresh: null, cold: null, view: savedView }, host: {
    scrollport: null,
    onIntent: (intent: { kind: "Navigate"; signal: AbortSignal | null } | { kind: "Read" }) => arrivalRef.current?.supersede({ preserveSignal: intent.kind === "Navigate" ? intent.signal : null, retireFailure: intent.kind === "Navigate" }),
    navigation: {
      href: (destination: import("@/lib/documentReader/location").ReaderDestination) => `/x/captures/${id}?${new URLSearchParams({ loc: serializeReaderDestination(destination) })}`,
      activate: (destination: import("@/lib/documentReader/location").ReaderDestination, intent: "default" | "new_pane", onDefault: () => void) => {
        if (intent === "default") { onDefault(); return "Accepted" as const; }
        const href = `/x/captures/${id}?${new URLSearchParams({ loc: serializeReaderDestination(destination) })}`;
        return runtime.activateTarget({ target: { href }, disposition: { kind: "Fork" } }).kind === "Cancelled" ? "Refused" as const : "Accepted" as const;
      },
    },
  } }), [source, savedView, id, runtime]));
  readerRef.current = reader;
  const state = useReaderState(reader, value => value);
  const doc = state.document.status === "ready" ? state.document.doc : null;
  const annotations = useCompactAnnotations(reader, id, { kind: "x_capture", label: "post" }, true, true);
  const stamp = useChangeStamp("Notes", "NoteBodies", "Chats", "Entries");
  const map = usePaneFreeServerValue({ key: `capture-map:${id}`, stale: stamp, load: async signal =>
    (await apiFetch<ApiJson<"/x/captures/{capture_id}/document-map", "get">>(`/api/x/captures/${id}/document-map`, { signal })).data });
  const refreshMap = useRef(map.refetch);
  refreshMap.current = map.refetch;
  useEffect(() => {
    if (doc?.kind !== "text") return;
    const fragments = [...new Set(doc.units.flatMap(unit => unit.xPost?.owner ? [unit.xPost.owner.fragment_id] : []))];
    const stops = fragments.map(fragment => store.subscribe({ kind: "annotations", source_ref: `fragment:${fragment}`, cursor: null, limit: 100 }, () => refreshMap.current(), () => {}));
    return () => { for (const stop of stops) stop(); };
  }, [doc, store]);
  const arrival = useSourceArrival({ ready: state.restored, sourceIdentity: doc?.identity ?? null, apply: async (target, context) => {
    if (!doc || context.signal.aborted) return "Cancelled";
    if (target.kind === "resource") return "Applied";
    let destination: import("@/lib/documentReader/model").ReaderTarget | null = null;
    if (target.kind === "source") {
      if (target.source.location.kind === "resource") return "Applied";
      if (target.source.location.kind !== "located") return "Unavailable";
      const locator = target.source.location.locator;
      if (locator.type !== "x_capture_offsets" || target.source.location.source_identity !== locator.capture_id) return "Unavailable";
      destination = targetOfLocator(locator, doc);
    }
    if (target.kind === "reader_destination") destination = destinationTarget(target.destination, reader);
    if (target.kind === "passage") destination = locatePassage(doc, id, target.passage, target.canonical_source_ref)?.target ?? null;
    if (target.kind === "highlight") {
      const row = (await store.query({ kind: "resource", ref: `highlight:${target.highlight_id}` })).rows[0]?.resource;
      const placed = row?.selection ? placeSelection(doc, id, row.selection) : null;
      if (placed?.kind === "placed" && placed.anchor.kind === "text") destination = { kind: "range", unit: placed.anchor.unit, start: placed.anchor.start, end: placed.anchor.end };
    }
    if (!destination) return "Unavailable";
    if (context.restored) return "Applied";
    const result = await reader.inspect({ target: destination, signal: context.signal });
    return result.kind === "Cancelled" ? "Cancelled" : result.kind === "Unavailable" ? "Unavailable" : "Applied";
  } });
  arrivalRef.current = arrival;
  return <>
    {arrival.failure ? <p role="status">{arrival.failure.title}</p> : null}
    <DocumentReaderView reader={reader} profile={profile} isMobile={mobile} playback={null}
      decorations={annotations.decorations} onSelection={annotations.onSelection} onMarks={annotations.onMarks}
      renderPostActions={unit => unit.xPost ? <PostActions post={unit.xPost} /> : null} />
    {annotations.panel}{annotations.list}
    {doc?.kind === "text" ? <ResourceOutlineList scope={`capture-sources:${id}`} ariaLabel="source connections">
      {[...new Set(doc.units.flatMap(unit => unit.xPost?.owner ? [unit.xPost.owner.fragment_id] : []))].map(fragment =>
        <CaptureSourceConnections key={fragment} captureId={id} fragment={fragment} />)}
    </ResourceOutlineList> : null}
    {map.status === "ready" && map.data.evidence.roots.length ? <section aria-label="source evidence">
      <h2>evidence</h2><ResourceOutlineList scope={`capture-evidence:${id}`} ariaLabel="source evidence">
        {map.data.evidence.roots.filter(root => root.content.kind !== "Highlight" || !root.content.is_owner).map(root => {
          const item = root.content.kind === "SourceReference" ? null : root.content.item;
          if (!item) return null;
          const target = root.resolution ? targetOfResolution(root.resolution, doc ?? undefined) : null;
          return <ResourceOutlineRow key={root.ref} item={item} incoming={null} occurrenceKey={`capture:${id}:${root.ref}`}
            occurrenceLabel="source evidence" details={target ? <button type="button" onClick={() => void reader.inspect({ target, signal: new AbortController().signal })}>view in source</button> : null} />;
        })}
      </ResourceOutlineList>
    </section> : map.status === "failed" ? <button type="button" onClick={map.refetch}>retry evidence</button> : null}
  </>;
}

function CaptureSourceConnections({ captureId, fragment }: { readonly captureId: string; readonly fragment: string }) {
  const ref = `fragment:${fragment}`;
  const source = useAuthoredQuery({ kind: "resource", ref });
  if (!source.data?.rows.length) return null;
  return <ResourceOutlineRow resourceRef={ref} incoming={null} occurrenceKey={`capture-source:${captureId}:${fragment}`} occurrenceLabel="source connections" />;
}
