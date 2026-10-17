"use client";

// Source and cursor ports, source-locator geometry and per-visit reader state.
// The workspace delivers arrivals; this module never watches a hash or a bus.
import { useEffect, useLayoutEffect, useRef } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { publishChange } from "@/lib/api/changes";
import type { Inspection, Reader } from "@/lib/documentReader/DocumentReader";
import type { ReaderViewSnapshot } from "@/lib/documentReader/runtime";
import { readerDocument, type CursorSnapshot, type ReaderDocument, type ReaderTarget } from "@/lib/documentReader/model";
import type { ReaderProgressPort, ReaderSource } from "@/lib/documentReader/ports";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { SourceLocator } from "@/lib/resources/sourceTarget";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";

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
          body: JSON.stringify({ locator, base_revision: base.revision }),
          keepalive: base.keepalive,
        });
        publishChange("Consumption");
        return { kind: "Canonical", snapshot: data };
      } catch (error) {
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

/** A passage group's place in the document map. */
export type Resolution = Schema<"ReaderEvidencePassageGroupOut">["resolution"];

export function targetOfLocator(
  locator: SourceLocator | Schema<"ReaderEvidenceAnchorOut">["locator"],
): ReaderTarget | null {
  switch (locator.type) {
    case "web_text_offsets":
    case "epub_fragment_offsets":
      return { kind: "range", unit: String(locator.fragment_id), start: locator.start_offset, end: locator.end_offset };
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

export const targetOfGroup = (resolution: Resolution) =>
  resolution.kind === "Resolved" ? targetOfLocator(resolution.anchor.locator) : null;

/** Paint the full extent, including every transcript unit in a timed interval. */
export function inspectionOfLocator(
  locator: SourceLocator,
  doc: ReaderDocument,
  precision: Inspection["precision"],
): Inspection | null {
  const target = targetOfLocator(locator);
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
      const view = reader.captureView();
      if (view) write(view);
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
