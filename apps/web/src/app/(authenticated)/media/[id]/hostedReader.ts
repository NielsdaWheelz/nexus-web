"use client";

// The hosted reader's ports (the media's one reader read, its revisioned
// cursor) and its deep links: the hash, a pending chat pulse and the cold
// query are read once and consumed with one replace; later pulses and hash
// pushes become reader jumps.
import { useEffect, useMemo, useRef } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { RetrievalLocator } from "@/lib/resourceGraph/citations";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { publishConsumptionProjectionChange } from "@/lib/consumption/projectionRevision";
import type { Reader, ReaderEntry } from "@/lib/documentReader/DocumentReader";
import type { TextRange } from "@/lib/documentReader/DocumentReader";
import {
  readerDocument,
  type CursorSnapshot,
  type ReaderTarget,
} from "@/lib/documentReader/model";
import type { ReaderProgressPort, ReaderSource } from "@/lib/documentReader/ports";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import {
  consumePendingReaderPulse,
  useReaderPulseHighlight,
  type ReaderPulseTarget,
} from "@/lib/reader/pulseEvent";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

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
      return { url: data.url, headers: {}, expiresAtMs: Date.parse(data.expires_at) };
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
        publishConsumptionProjectionChange();
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

/** A server-resolved deep link: what it names inside this media. */
export type TargetRef = {
  readonly kind: "highlight" | "evidence" | "passage" | "apparatus";
  readonly id: string;
};

/** Where a deep link lands, and what the reader shows when it arrives. */
export interface Arrival {
  readonly target: ReaderTarget;
  readonly focused: string | null;
  readonly evidence: TextRange | null;
  readonly pulse: TextRange | null;
}

export async function resolveTargetRef(
  mediaId: string,
  ref: TargetRef,
  signal?: AbortSignal,
): Promise<Arrival | null> {
  let data: ApiJson<"/media/{media_id}/reader-targets/{kind}/{target_id}", "get">["data"];
  try {
    ({ data } = await apiFetch<
      ApiJson<"/media/{media_id}/reader-targets/{kind}/{target_id}", "get">
    >(`/api/media/${mediaId}/reader-targets/${ref.kind}/${ref.id}`, { signal }));
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null;
    throw error;
  }
  const range: TextRange | null =
    data.kind === "Text"
      ? { kind: "text", unit: data.unit_id, start: data.start_offset, end: data.end_offset }
      : null;
  const target: ReaderTarget =
    data.kind === "Text"
      ? { kind: "range", unit: data.unit_id, start: data.start_offset, end: data.end_offset }
      : data.kind === "Time"
        ? { kind: "time", ms: data.start_ms }
        : data.quads.length
          ? { kind: "quads", page: data.page_number, quads: data.quads }
          : { kind: "point", point: { kind: "pdf", page: data.page_number, y: 0 } };
  return {
    target,
    focused: ref.kind === "highlight" ? ref.id : null,
    evidence: ref.kind === "evidence" ? range : null,
    pulse: ref.kind === "passage" ? range : null,
  };
}

/** A passage group's place in the document map. */
export type Resolution = Schema<"ReaderEvidencePassageGroupOut">["resolution"];

/** The one locator → reader target map: chat pulses, evidence jumps and paint extents. */
function targetOfLocator(
  locator: RetrievalLocator | Schema<"ReaderEvidenceAnchorOut">["locator"],
): ReaderTarget | null {
  switch (locator.type) {
    case "web_text_offsets":
    case "epub_fragment_offsets":
      return {
        kind: "range",
        unit: String(locator.fragment_id),
        start: locator.start_offset,
        end: locator.end_offset,
      };
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

/** Where a resolved passage group is, as a reader target. */
export const targetOfGroup = (resolution: Resolution) =>
  resolution.kind === "Resolved" ? targetOfLocator(resolution.anchor.locator) : null;

function arrivalOfPulse(mediaId: string, pulse: ReaderPulseTarget) {
  const ref: TargetRef | null = pulse.evidenceSpanId
    ? { kind: "evidence", id: pulse.evidenceSpanId }
    : pulse.highlightId
      ? { kind: "highlight", id: pulse.highlightId }
      : null;
  if (ref) return resolveTargetRef(mediaId, ref);
  const target = targetOfLocator(pulse.locator);
  const range: TextRange | null =
    target?.kind === "range" ? { ...target, kind: "text" } : null;
  return Promise.resolve(
    target && { target, focused: null, evidence: null, pulse: range },
  );
}

/** A one-shot hash target: `#highlight-|#evidence-|#passage-|#fragment-<id>` or `#text-<id>:<s>:<e>`. */
function arrivalOfHash(mediaId: string, hash: string) {
  const ref = new RegExp(`^#(highlight|evidence|passage)-(${UUID})$`).exec(hash);
  if (ref) {
    const kind = ref[1] as TargetRef["kind"];
    return resolveTargetRef(mediaId, { kind, id: ref[2] });
  }
  const text = new RegExp(`^#(?:fragment|text)-(${UUID})(?::(\\d+):(\\d+))?$`).exec(hash);
  if (!text) return null;
  const [, unit, start = "0", end = start] = text;
  const target: ReaderTarget =
    Number(end) > Number(start)
      ? { kind: "range", unit, start: Number(start), end: Number(end) }
      : { kind: "point", point: { kind: "text", unit, offset: Number(start) } };
  return Promise.resolve({ target, focused: null, evidence: null, pulse: null });
}

/**
 * The reader's entry, read once per media from the pane url (hash, `?fragment`,
 * `?apparatus`) and a pending pulse, then removed from the url with one replace.
 * `arrival` settles with what the entry shows once there.
 */
export function useReaderEntry(mediaId: string): {
  readonly entry: ReaderEntry;
  readonly arrival: Promise<Arrival | null> | null;
  readonly apparatusKey: string | null;
} {
  const runtime = requirePaneRuntime(usePaneRuntime(), "useReaderEntry");
  const read = useMemo(() => {
    const query = new URLSearchParams(runtime.searchParams);
    const pulse = consumePendingReaderPulse(mediaId);
    const apparatus = query.get("apparatus_id");
    const fragment = query.get("fragment");
    const arrival =
      arrivalOfHash(mediaId, runtime.hash) ??
      (apparatus && new RegExp(`^${UUID}$`).test(apparatus)
        ? resolveTargetRef(mediaId, { kind: "apparatus", id: apparatus })
        : pulse
          ? arrivalOfPulse(mediaId, pulse)
          : null);
    const consumed = Boolean(runtime.hash) || ["fragment", "loc", "apparatus", "apparatus_id"].some((key) => query.has(key));
    for (const key of ["fragment", "loc", "apparatus", "apparatus_id"]) query.delete(key);
    return {
      entry: {
        fresh: arrival && arrival.then((settled) => settled?.target ?? null, () => null),
        cold: fragment
          ? { kind: "point" as const, point: { kind: "text" as const, unit: fragment, offset: 0 } }
          : null,
      },
      arrival: arrival?.catch(() => null) ?? null,
      apparatusKey: runtime.searchParams.get("apparatus"),
      replace: consumed ? `${runtime.pathname}${query.size ? `?${query}` : ""}` : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: read once per media
  }, [mediaId]);
  const { replace } = runtime.router;
  useEffect(() => {
    if (read.replace !== null) replace(read.replace);
  }, [read, replace]);
  return read;
}

/**
 * Later deep links into the open reader: chat pulses (a jump, or a flash in
 * place) and same-pane hash pushes. Each becomes a reader jump; `onArrive`
 * hears what it shows and whether it moved the reader there.
 */
export function useLiveReaderTargets(
  mediaId: string,
  reader: Reader,
  onArrive: (arrival: Arrival, moved: boolean) => void,
): void {
  const runtime = requirePaneRuntime(usePaneRuntime(), "useLiveReaderTargets");
  const arriveRef = useRef(onArrive);
  arriveRef.current = onArrive;
  /** The entry read the mount's hash; a later push (the same link again too) differs from the hash before it. */
  const previousHash = useRef(runtime.hash);
  /** A target already on screen (a mark's own menu activating its highlight) is no jump. */
  const shown = (target: ReaderTarget) => {
    const { document: ready, viewport } = reader.getState();
    if (ready.status !== "ready" || !viewport) return false;
    const [from, to] =
      target.kind === "range"
        ? [target, { ...target, start: target.end }].map((t) =>
            ready.structure.fraction({ kind: "text", unit: t.unit, offset: t.start }),
          )
        : target.kind === "quads"
          ? [target.page - 1, target.page].map((p) => p / ready.structure.length)
          : [Infinity, Infinity];
    return from <= viewport.end && to >= viewport.start;
  };
  const land = async (arrival: Promise<Arrival | null> | null, move: boolean) => {
    const settled = await arrival?.catch(() => null);
    if (!settled) return;
    if (move && !shown(settled.target)) {
      const outcome = await reader.inspect(settled.target);
      if (outcome.kind !== "Arrived" && outcome.kind !== "Unchanged") return;
    }
    arriveRef.current(settled, move);
  };
  useReaderPulseHighlight((pulse) => {
    if (pulse.mediaId !== mediaId) return;
    consumePendingReaderPulse(mediaId, pulse);
    void land(
      arrivalOfPulse(mediaId, pulse),
      pulse.focusBehavior === "scroll_into_view",
    );
  });
  const { hash, pathname, searchParams } = runtime;
  const { replace } = runtime.router;
  useEffect(() => {
    const previous = previousHash.current;
    previousHash.current = hash;
    if (!hash || hash === previous) return;
    void land(arrivalOfHash(mediaId, hash), true);
    replace(`${pathname}${searchParams.size ? `?${searchParams}` : ""}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: one jump per pushed hash
  }, [hash]);
}
