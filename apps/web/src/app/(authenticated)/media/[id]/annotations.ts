"use client";

// The media's annotations: one document-map read (marks, note markers, rail
// markers, evidence) and the highlight writes. A write paints at once from its
// acknowledgement through a pending ledger, which a map read issued after the
// write settles (created, recoloured, rebounded and deleted alike). The map is
// read while someone subscribes: a remounted subscriber reads it again.
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { enqueueWrite, type WriteRequest } from "@/lib/notes/writes";
import type { RailMarker } from "@/lib/documentReader/chrome/MapRail";
import type {
  Decorations,
  DraftAnchor,
  Mark,
  MarkAnchor,
  NoteRef,
  TextRange,
} from "@/lib/documentReader/DocumentReader";
import type { HighlightColor } from "@/lib/documentReader/model";
import { targetOfGroup, type Resolution } from "./hostedReader";

export type DocumentMap = Schema<"ReaderDocumentMapOut">;
export type EvidenceHighlight = Schema<"ReaderEvidenceHighlightOut">;
type Highlight = Schema<"TypedHighlightOut">;
type HighlightSummary = Pick<EvidenceHighlight, "quote" | "color" | "is_owner" | "version">;

export interface AnnotationState {
  readonly map:
    | { readonly status: "loading" }
    | { readonly status: "failed"; readonly error: unknown; readonly data: DocumentMap | null; readonly retrying: boolean }
    | { readonly status: "ready"; readonly data: DocumentMap };
  readonly decorations: Pick<Decorations, "identity" | "marks" | "noteRefs">;
  readonly markers: readonly RailMarker[];
}
export interface AnnotationStore {
  getState(): AnnotationState;
  subscribe(listener: () => void): () => void;
  refresh(): void;
  /** The viewer's own highlight of exactly this extent (library-mates' marks paint too). */
  twin(anchor: MarkAnchor): string | null;
  prepareCreate(anchor: DraftAnchor, color: HighlightColor): WriteRequest;
  acknowledge(highlight: Highlight): void;
  recolor(id: string, color: HighlightColor, expectedVersion: string): Promise<Highlight>;
  rebound(id: string, anchor: TextRange, expectedVersion: string): Promise<Highlight>;
  remove(id: string): Promise<void>;
  highlight(id: string): HighlightSummary | null;
}

/** The painted extent of a resolved passage: a text range or page quads. */
function anchorOf(resolution: Resolution): MarkAnchor | null {
  const target = targetOfGroup(resolution);
  if (target?.kind === "range") return { kind: "text", unit: target.unit, start: target.start, end: target.end };
  return target?.kind === "quads" ? { kind: "pdf", page: target.page, quads: target.quads } : null;
}

function anchorOfHighlight(highlight: Highlight): MarkAnchor | null {
  const { anchor } = highlight;
  if (anchor.type === "pdf_page_geometry")
    return { kind: "pdf", page: anchor.page_number, quads: anchor.quads };
  return anchor.fragment_id === null || anchor.start_offset === null || anchor.end_offset === null
    ? null
    : { kind: "text", unit: anchor.fragment_id, start: anchor.start_offset, end: anchor.end_offset };
}

/** The wire anchor of a draft: a unit span, or page quads and their text. */
function wireAnchor(anchor: DraftAnchor) {
  return anchor.kind === "text"
    ? { kind: "text" as const, unit_id: anchor.unit, start_offset: anchor.start, end_offset: anchor.end }
    : { kind: "pdf" as const, page_number: anchor.page, quads: [...anchor.quads], exact: anchor.exact };
}

/** The same painted extent (a draft's `exact` aside). */
const sameAnchor = (a: MarkAnchor, b: MarkAnchor) =>
  JSON.stringify({ ...a, exact: undefined }) === JSON.stringify({ ...b, exact: undefined });

export function createAnnotationStore(mediaId: string): AnnotationStore {
  const listeners = new Set<() => void>();
  let state: AnnotationState = {
    map: { status: "loading" },
    decorations: { identity: "", marks: [], noteRefs: [] },
    markers: [],
  };
  /** Writes not yet read back: `after` is the first map read that reflects them. */
  const ledger = new Map<string, { readonly after: number; readonly mark: Mark | null; readonly highlight: HighlightSummary | null }>();
  /** The last map read: a failed read keeps it painted. */
  let last: DocumentMap | null = null;
  let reads = 0;
  let controller = new AbortController();

  function project(data: DocumentMap | null) {
    const marks = new Map<string, Mark & { readonly order: string }>();
    const noteRefs: NoteRef[] = [];
    for (const group of data?.evidence.passage_groups ?? []) {
      const anchor = anchorOf(group.resolution);
      for (const item of anchor ? group.items : []) {
        if (item.kind === "Highlight") {
          marks.set(item.highlight_id, {
            id: item.highlight_id,
            color: item.color,
            anchor: anchor!,
            order: `${item.created_at} ${item.highlight_id}`,
          });
        }
        if (item.kind === "SourceReference" && anchor!.kind === "text") {
          const { unit, start, end } = anchor!;
          noteRefs.push({ key: item.stable_key, unit, start, end });
        }
      }
    }
    for (const [id, entry] of ledger) {
      if (entry.mark) marks.set(id, { ...entry.mark, order: `~ ${id}` });
      else marks.delete(id);
    }
    // Topmost first: the most recent highlight paints over older ones.
    const ordered = [...marks.values()].sort((a, b) =>
      a.order === b.order ? 0 : a.order < b.order ? 1 : -1,
    );
    state = {
      ...state,
      decorations: {
        identity: data?.identity ?? state.decorations.identity,
        marks: ordered.map(({ order: _order, ...mark }) => mark),
        noteRefs,
      },
      markers: (data?.markers ?? []).map((marker) => ({
          id: marker.item_id,
          position: marker.position,
          end: marker.end_position,
          tone: marker.tone,
          label: marker.label,
          preview: marker.preview,
      })),
    };
    for (const listener of listeners) listener();
  }

  async function read() {
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const seq = (reads += 1);
    if (state.map.status === "failed") {
      state = { ...state, map: { ...state.map, retrying: true } };
      project(last);
    }
    try {
      const { data } = await apiFetch<
        ApiJson<"/media/{media_id}/document-map", "get">
      >(`/api/media/${mediaId}/document-map`, { signal });
      if (signal.aborted) return;
      for (const [id, entry] of ledger) if (entry.after <= seq) ledger.delete(id);
      last = data;
      state = { ...state, map: { status: "ready", data } };
      project(data);
    } catch (error) {
      if (signal.aborted || handleUnauthenticatedApiError(error)) return;
      state = { ...state, map: { status: "failed", error, data: last, retrying: false } };
      project(last);
    }
  }

  /** Records a write, paints it, and reads the map back. */
  function settle(id: string, mark: Mark | null, highlight: HighlightSummary | null) {
    ledger.set(id, { after: reads + 1, mark, highlight });
    project(last);
    void read();
  }

  function highlight(id: string): HighlightSummary | null {
    const pending = ledger.get(id);
    if (pending) return pending.highlight;
    if (last === null) return null;
    const { evidence } = last;
    for (const item of [
      ...evidence.passage_groups.flatMap((group) => group.items),
      ...evidence.document_items,
    ])
      if (item.kind === "Highlight" && item.highlight_id === id) return item;
    return null;
  }
  const twin = (anchor: MarkAnchor) =>
    state.decorations.marks.find(
      (mark) =>
        sameAnchor(mark.anchor, anchor) &&
        highlight(mark.id)?.is_owner === true,
    )?.id ?? null;

  function acknowledge(highlight: Highlight) {
    const painted = anchorOfHighlight(highlight);
    settle(highlight.id, painted && { id: highlight.id, color: highlight.color, anchor: painted },
      { quote: highlight.exact, color: highlight.color, is_owner: highlight.is_owner, version: highlight.version });
  }

  /** The observed version is frozen by the caller, before this enters the tab's FIFO. */
  function update(id: string, body: Schema<"UpdateHighlightRequest">): Promise<Highlight> {
    return new Promise((resolve, reject) => enqueueWrite<Highlight>({
      build: () => ({ path: `/api/highlights/${id}`, method: "PATCH", body }),
      settle(reply) { acknowledge(reply); resolve(reply); },
      fail: reject,
    }));
  }

  return {
    getState: () => {
      if (state.map.status === "failed" && (!isApiError(state.map.error) || isSameSystemApiDefect(state.map.error))) throw state.map.error;
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) void read();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) controller.abort();
      };
    },
    refresh: () => void read(),
    twin,
    prepareCreate(anchor, color) {
      return { path: `/api/media/${mediaId}/highlights`, method: "POST",
        body: { anchor: wireAnchor(anchor), color } };
    },
    acknowledge,
    recolor: (id, color, expectedVersion) => update(id, { color, expected_version: expectedVersion }),
    rebound: (id, anchor, expectedVersion) => update(id, { expected_version: expectedVersion,
      anchor: { type: "fragment_offsets", unit_id: anchor.unit, start_offset: anchor.start, end_offset: anchor.end } }),
    async remove(id) {
      await apiFetch<void>(`/api/highlights/${id}`, { method: "DELETE" });
      settle(id, null, null);
    },
    highlight,
  };
}
