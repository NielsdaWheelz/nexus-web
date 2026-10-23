"use client";

// Source and cursor ports, source-locator geometry and per-visit reader state.
// The workspace delivers arrivals; this module never watches a hash or a bus.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { publishChange } from "@/lib/api/changes";
import type { Inspection, Reader } from "@/lib/documentReader/DocumentReader";
import type { ReaderViewSnapshot } from "@/lib/documentReader/runtime";
import { readerDocument, transcriptUnitAtTime, type CursorSnapshot, type ReaderDocument, type ReaderTarget } from "@/lib/documentReader/model";
import type { ReaderProgressPort, ReaderSource } from "@/lib/documentReader/ports";
import { serializeReaderDestination, type ReaderDestination } from "@/lib/documentReader/location";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { SourceLocator } from "@/lib/resources/sourceTarget";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";

export function readerDestinationHref(mediaId: string, destination: ReaderDestination): string | null {
  return normalizeWorkspaceHref(`/media/${mediaId}?${new URLSearchParams({ loc: serializeReaderDestination(destination) })}`);
}

/** Exact publication membership; surfaces validate their loaded anchor/geometry. */
export function destinationTarget(destination: ReaderDestination, reader: Reader): ReaderTarget | null {
  const state = reader.getState();
  if (state.document.status !== "ready" || destination.source_identity !== state.document.doc.identity) return null;
  const { doc } = state.document;
  const { target } = destination;
  if (target.kind === "evidence_item") return null;
  if (target.kind === "edge") return target;
  if (target.kind === "pdf" || target.kind === "quads")
    return doc.kind === "pdf" && target.page <= (state.pdf?.pages ?? doc.pages ?? 0) ? target : null;
  if (doc.kind !== "text") return null;
  if (target.kind === "time") return doc.format === "transcript" && transcriptUnitAtTime(doc.units, target.ms) !== null ? target : null;
  const unit = doc.units.find((unit) => unit.id === (target.kind === "point" ? target.point.unit : target.unit));
  if (!unit) return null;
  if (target.kind === "point") return target.point.offset <= unit.length ? target : null;
  if (target.kind === "range") return target.end <= unit.length ? target : null;
  return target;
}

export function hostedSource(mediaId: string): ReaderSource {
  return {
    async load(signal) {
      const { data } = await apiFetch<ApiJson<"/media/{media_id}/reader", "get">>(
        `/api/media/${mediaId}/reader`,
        { signal },
      );
      return readerDocument(data);
    },
    async refreshPdf(signal) {
      const { data } = await apiFetch<ApiJson<"/media/{media_id}/file", "get">>(
        `/api/media/${mediaId}/file`,
        { signal, cache: "no-store" },
      );
      return { url: data.url, expiresAtMs: Date.parse(data.expires_at) };
    },
  };
}

/** The server cursor: compare-and-set on the revision; a refused save names the newer one. */
export function hostedProgress(mediaId: string): ReaderProgressPort {
  const path = `/api/media/${mediaId}/reader-state` as const;
  return {
    async load(signal) {
      const { data } = await apiFetch<
        ApiJson<"/media/{media_id}/reader-state", "get">
      >(path, { signal, cache: "no-store" });
      return { kind: "Canonical", snapshot: data };
    },
    async save(locator, base) {
      try {
        const { data } = await apiFetch<
          ApiJson<"/media/{media_id}/reader-state", "put">
        >(path, {
          method: "PUT",
          body: JSON.stringify({ locator, base_revision: base.revision, expected_reader_generation: base.expectedReaderGeneration, adopt_unresolved: base.adoptUnresolved }),
          keepalive: base.keepalive,
        });
        publishChange("Consumption");
        return { kind: "Canonical", snapshot: data };
      } catch (error) {
        if (isApiError(error) && error.code === "E_READER_CONTENT_CHANGED") return { kind: "ContentChanged" };
        if (!isApiError(error) || error.code !== "E_READER_STATE_CONFLICT")
          throw error;
        // justify-type-assertion: the 409's details.current is the route's own snapshot.
        const canonical = error.details?.current as CursorSnapshot;
        return { kind: "Stale", canonical };
      }
    },
    resolve() {
      throw new Error("the server cursor has no conflict view to resolve");
    },
  };
}

/** An exact resource root's own place in the document map. */
export type Resolution = NonNullable<Schema<"ReaderEvidenceRootOut">["resolution"]>;

export function targetOfLocator(
  locator: SourceLocator | Schema<"ReaderEvidenceAnchorOut">["locator"],
  doc?: ReaderDocument,
): ReaderTarget | null {
  switch (locator.type) {
    case "web_text_offsets":
    case "epub_fragment_offsets":
      return { kind: "range", unit: doc?.kind === "text"
        ? doc.units.find((unit) => unit.id === locator.fragment_id || unit.xPost?.owner?.fragment_id === locator.fragment_id)?.id ?? String(locator.fragment_id)
        : String(locator.fragment_id), start: locator.start_offset, end: locator.end_offset };
    case "pdf_page_geometry":
      return { kind: "quads", page: locator.page_number, quads: locator.quads };
    case "pdf_page":
      return { kind: "point", point: { kind: "pdf", page: locator.page_number, y: 0 } };
    case "transcript_time_range":
    case "audio_time_range":
    case "video_time_range":
      return { kind: "time", ms: locator.t_start_ms };
    default:
      return null;
  }
}

export const targetOfResolution = (resolution: Resolution) =>
  resolution.kind === "Resolved" ? targetOfLocator(resolution.anchor.locator) : null;

/** Paint the full extent, including every transcript unit in a timed interval. */
export function inspectionOfLocator(
  locator: SourceLocator,
  doc: ReaderDocument,
  precision: Inspection["precision"],
): Inspection | null {
  const target = targetOfLocator(locator, doc);
  if (!target) return null;
  const anchors: Inspection["anchors"] = target.kind === "range" && doc.kind === "text"
    ? [{ kind: "text", unit: target.unit, start: target.start, end: target.end }]
    : target.kind === "quads" && doc.kind === "pdf"
      ? [{ kind: "pdf", page: target.page, quads: target.quads }]
      : target.kind === "time" && doc.kind === "text" && "t_end_ms" in locator
        ? doc.units.filter((unit) => unit.time && unit.time.endMs > target.ms && unit.time.startMs < locator.t_end_ms)
            .map((unit) => ({ kind: "text" as const, unit: unit.id, start: 0, end: unit.length }))
        : [];
  const pages = locator.type === "pdf_page" && doc.kind === "pdf" ? [locator.page_number] : [];
  return anchors.length || pages.length ? { identity: doc.identity, anchors, pages, precision } : null;
}

const VIEW = definePaneVisitDataKey<ReaderViewSnapshot>("Reader.InspectionView");

/** Seed a remount, then retain the actual viewport and held origin as it moves. */
export function useReaderVisit(readerRef: { current: Reader | null }) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "useReaderVisit");
  const saved = usePaneVisitData(VIEW, () => readerRef.current?.captureView() ?? null);
  const write = usePaneVisitDataWriter(VIEW);
  const reader = readerRef.current;
  const previous = useRef(runtime.visitId);
  useEffect(() => {
    if (!reader) return;
    return reader.subscribe(() => {
      // Viewport notifications already carry the surface's measured placement.
      const { restored, placement, navigation } = reader.getState();
      const { mode, origin, originUnavailable } = navigation;
      if (restored && placement)
        write({ identity: placement.identity, placement, navigation: { mode, origin, originUnavailable } });
    });
  }, [reader, write]);
  useLayoutEffect(() => {
    if (previous.current === runtime.visitId) return;
    previous.current = runtime.visitId;
    // A new arrival begins at the live departure; a history return restores its visit.
    if (!saved || runtime.paneEntryDelivery?.entry.kind === "InspectSource" || !reader) return;
    const controller = new AbortController();
    void reader.restoreView(saved, controller.signal);
    return () => controller.abort();
  }, [reader, runtime.paneEntryDelivery, runtime.visitId, saved]);
  return saved;
}


const SHOW_NOTES = definePaneVisitDataKey<boolean>("Reader.ShowNotes");

/** The pane visit owns its notes disclosure across provisioning and reader remounts. */
export function useShowNotesVisit() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "useShowNotesVisit");
  const current = useRef(false);
  const saved = usePaneVisitData(SHOW_NOTES, () => current.current);
  const write = usePaneVisitDataWriter(SHOW_NOTES);
  const [open, setOpen] = useState(saved ?? false);
  current.current = open;
  useLayoutEffect(() => {
    current.current = saved ?? false;
    setOpen(saved ?? false);
  }, [runtime.visitId, saved]);
  const change = useCallback((value: boolean) => {
    current.current = value;
    setOpen(value);
    write(value);
  }, [write]);
  return { open, change };
}
