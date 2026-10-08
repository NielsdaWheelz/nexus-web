"use client";

// The media's annotations: one document-map read (marks, note markers, rail
// markers, evidence) and the highlight writes. A write paints at once from its
// acknowledgement through a pending ledger, which a map read issued after the
// write settles (created, recoloured, rebounded and deleted alike). The map is
// read while someone subscribes: a remounted subscriber reads it again.
import { apiFetch, apiCommand204, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ApiJson, Schema } from "@/lib/api/wire";
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

export interface AnnotationState {
  readonly map:
    | { readonly status: "loading" }
    | { readonly status: "failed"; readonly error: unknown; readonly data: DocumentMap | null }
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
  /** `existing`: the viewer already highlighted the exact span; nothing was written. */
  create(
    anchor: DraftAnchor,
    color: HighlightColor,
  ): Promise<{ readonly id: string; readonly existing: boolean }>;
  recolor(id: string, color: HighlightColor): Promise<void>;
  rebound(id: string, anchor: TextRange): Promise<void>;
  remove(id: string): Promise<void>;
  highlight(id: string): EvidenceHighlight | null;
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
  const ledger = new Map<string, { readonly after: number; readonly mark: Mark | null }>();
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
        if (item.kind === "Highlight")
          marks.set(item.highlight_id, {
            id: item.highlight_id,
            color: item.color,
            anchor: anchor!,
            order: `${item.created_at} ${item.highlight_id}`,
          });
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
          end: marker.end_position.kind === "Present" ? marker.end_position.value : null,
          tone: marker.tone,
          label: marker.label,
          preview: marker.preview.kind === "Present" ? marker.preview.value : null,
      })),
    };
    for (const listener of listeners) listener();
  }

  async function read() {
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const seq = (reads += 1);
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
      state = { ...state, map: { status: "failed", error, data: last } };
      project(last);
    }
  }

  /** Records a write, paints it, and reads the map back. */
  function settle(id: string, mark: Mark | null) {
    ledger.set(id, { after: reads + 1, mark });
    project(last);
    void read();
  }

  function highlight(id: string): EvidenceHighlight | null {
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
        (ledger.has(mark.id) || highlight(mark.id)?.is_owner === true),
    )?.id ?? null;

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
    async create(anchor, color) {
      const same = twin(anchor);
      if (same) return { id: same, existing: true };
      const { data } = await apiFetch<
        ApiJson<"/media/{media_id}/highlights", "post">
      >(`/api/media/${mediaId}/highlights`, {
        method: "POST",
        body: JSON.stringify({ anchor: wireAnchor(anchor), color }),
      });
      const painted = anchorOfHighlight(data);
      settle(data.id, painted && { id: data.id, color: data.color, anchor: painted });
      return { id: data.id, existing: false };
    },
    async recolor(id, color) {
      const { data } = await apiFetch<ApiJson<"/highlights/{highlight_id}", "patch">>(
        `/api/highlights/${id}`,
        { method: "PATCH", body: JSON.stringify({ color }) },
      );
      const painted = anchorOfHighlight(data);
      settle(id, painted && { id, color: data.color, anchor: painted });
    },
    async rebound(id, anchor) {
      const { data } = await apiFetch<ApiJson<"/highlights/{highlight_id}", "patch">>(
        `/api/highlights/${id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            anchor: { type: "fragment_offsets", start_offset: anchor.start, end_offset: anchor.end },
          }),
        },
      );
      const painted = anchorOfHighlight(data);
      settle(id, painted && { id, color: data.color, anchor: painted });
    },
    async remove(id) {
      await apiCommand204(`/api/highlights/${id}`, { method: "DELETE" });
      settle(id, null);
    },
    highlight,
  };
}
