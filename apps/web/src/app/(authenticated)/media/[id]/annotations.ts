"use client";

// The media's annotations: one document-map read (marks, note markers, rail
// markers, evidence) and the highlight writes. A write paints at once from its
// acknowledgement through a pending ledger, which a map read issued after the
// write settles (created, recoloured, rebounded and deleted alike). The map is
// read while someone subscribes: a remounted subscriber reads it again.
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
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
import { structureOf, type HighlightColor, type ReaderDocument } from "@/lib/documentReader/model";
import { targetOfGroup, type Resolution } from "./hostedReader";

export type DocumentMap = Schema<"ReaderDocumentMapOut">;
export type EvidenceHighlight = Schema<"ReaderEvidenceHighlightOut">;
type Highlight = Schema<"TypedHighlightOut">;
type HighlightSummary = Pick<EvidenceHighlight, "quote" | "color" | "is_owner" | "version"> & { readonly mediaId: string };

export interface AnnotationState {
  readonly map:
    | { readonly status: "loading" }
    | { readonly status: "failed"; readonly error: unknown; readonly data: DocumentMap | null; readonly retrying: boolean }
    | { readonly status: "ready"; readonly data: DocumentMap };
  readonly decorations: Pick<Decorations, "identity" | "marks" | "noteRefs">;
  readonly markers: readonly RailMarker[];
}
export interface AnnotationStore {
  bind(doc: ReaderDocument): void;
  source<Anchor extends MarkAnchor>(anchor: Anchor): { readonly mediaId: string; readonly anchor: Anchor; readonly generation: number | null };
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

type CanonicalStore = Omit<AnnotationStore, "bind" | "source" | "prepareCreate" | "rebound"> & {
  generation(value: number): void;
  prepareCreate(anchor: DraftAnchor, color: HighlightColor, generation: number | null): WriteRequest;
  rebound(id: string, anchor: TextRange, expectedVersion: string, generation: number | null): Promise<Highlight>;
};
const canonical = new Map<string, CanonicalStore>();

/** One subscribed map per canonical media, shared by every mounted occurrence/pane. */
function canonicalStore(mediaId: string): CanonicalStore {
  const existing = canonical.get(mediaId);
  if (existing) return existing;
  let requestedGeneration: number | null = null;
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
      if (requestedGeneration !== null && Number(data.identity.slice(1)) < requestedGeneration) {
        void read();
        return;
      }
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
      if (item.kind === "Highlight" && item.highlight_id === id) return { ...item, mediaId };
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
      { quote: highlight.exact, color: highlight.color, is_owner: highlight.is_owner, version: highlight.version, mediaId });
  }

  /** The observed version is frozen by the caller, before this enters the tab's FIFO. */
  function update(id: string, body: Schema<"UpdateHighlightRequest">): Promise<Highlight> {
    return new Promise((resolve, reject) => enqueueWrite<Highlight>({
      build: () => ({ path: `/api/highlights/${id}`, method: "PATCH", body }),
      settle(reply) { acknowledge(reply); resolve(reply); },
      fail: reject,
    }));
  }

  const store: CanonicalStore = {
    generation(value) {
      if (requestedGeneration !== null && value <= requestedGeneration) return;
      const initialRead = requestedGeneration === null && reads > 0 && state.map.status === "loading";
      requestedGeneration = value;
      if (listeners.size && !initialRead && last?.identity !== `g${value}`) void read();
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) void read();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { controller.abort(); canonical.delete(mediaId); }
      };
    },
    refresh: () => void read(),
    twin,
    prepareCreate(anchor, color, generation) {
      return { path: `/api/media/${mediaId}/highlights`, method: "POST",
        body: { anchor: wireAnchor(anchor), color, expected_reader_generation: generation } };
    },
    acknowledge,
    recolor: (id, color, expectedVersion) => update(id, { color, expected_version: expectedVersion }),
    rebound: (id, anchor, expectedVersion, generation) => update(id, { expected_version: expectedVersion, expected_reader_generation: generation,
      anchor: { type: "fragment_offsets", unit_id: anchor.unit, start_offset: anchor.start, end_offset: anchor.end } }),
    async remove(id) {
      await apiFetch<void>(`/api/highlights/${id}`, { method: "DELETE" });
      publishChange("Metadata");
      settle(id, null, null);
    },
    highlight,
  };
  canonical.set(mediaId, store);
  return store;
}

/** An occurrence projection over canonical stores; body offsets never leave their source owner. */
export function createAnnotationStore(mediaId: string): AnnotationStore {
  let doc: ReaderDocument | null = null;
  const listeners = new Set<() => void>();
  const held = new Map<string, { store: CanonicalStore; unsubscribe: () => void }>();
  let state: AnnotationState = { map: { status: "loading" }, decorations: { identity: "", marks: [], noteRefs: [] }, markers: [] };

  function project() {
    const parent = held.get(mediaId)?.store.getState();
    if (!parent) return;
    if (!doc) { state = parent; for (const listener of listeners) listener(); return; }
    const structure = structureOf(doc, null);
    const marks: Mark[] = [];
    const noteRefs: NoteRef[] = [];
    const markers: RailMarker[] = [];
    const groups: DocumentMap["evidence"]["passage_groups"] = [];
    const items: DocumentMap["evidence"]["document_items"] = [];
    const counts = { citations: 0, document: 0, highlights: 0, links: 0, machine_links: 0, passages: 0 };
    let failed: Extract<AnnotationState["map"], { status: "failed" }> | null = null;
    let loading = false;
    for (const [id, binding] of held) {
      const current = binding.store.getState();
      const occurrences = doc.kind === "text" ? doc.units.filter((unit) => unit.xPost?.owner?.media_id === id) : [];
      const expected = occurrences[0]?.xPost?.owner?.generation;
      const identity = expected === undefined ? doc.identity : `g${expected}`;
      if (current.map.status === "failed") failed = current.map;
      if (current.map.status === "loading" || current.decorations.identity !== identity) { loading = true; continue; }
      const anchors = (anchor: MarkAnchor): MarkAnchor[] => anchor.kind !== "text" ? (id === mediaId ? [anchor] : [])
        : occurrences.length ? occurrences.filter((unit) => unit.xPost!.owner!.fragment_id === anchor.unit).map((unit) => ({ ...anchor, unit: unit.id }))
        : id === mediaId ? [anchor] : [];
      for (const mark of current.decorations.marks) for (const anchor of anchors(mark.anchor)) {
        marks.push({ ...mark, anchor });
        if (anchor.kind === "text") markers.push({ id: `highlight:${mark.id}`, position: structure.fraction({ kind: "text", unit: anchor.unit, offset: anchor.start }),
          end: structure.fraction({ kind: "text", unit: anchor.unit, offset: anchor.end }), tone: "Highlight", label: "highlight", preview: binding.store.highlight(mark.id)?.quote ?? null });
      }
      for (const note of current.decorations.noteRefs) for (const anchor of anchors({ ...note, kind: "text" }))
        if (anchor.kind === "text") noteRefs.push({ key: note.key, unit: anchor.unit, start: anchor.start, end: anchor.end });
      const data = current.map.data;
      if (data) {
        for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] += data.evidence.counts[key];
        items.push(...data.evidence.document_items);
        for (const group of data.evidence.passage_groups) {
          const anchor = anchorOf(group.resolution);
          const projected = anchor && anchors(anchor)[0];
          const resolution = group.resolution;
          // The evidence list holds each resource once, at its first displayed occurrence.
          groups.push(projected?.kind === "text" && resolution.kind === "Resolved" && "fragment_id" in resolution.anchor.locator
            ? { ...group, resolution: { ...resolution, anchor: { ...resolution.anchor, locator: { ...resolution.anchor.locator, fragment_id: projected.unit } } } }
            : group);
        }
        if (id === mediaId) markers.push(...(doc.kind === "pdf" ? current.markers : current.markers.filter((marker) => !marker.id.startsWith("highlight:"))));
      }
    }
    const parentData = parent.map.status === "loading" ? null : parent.map.data;
    const data = parentData && { ...parentData, identity: doc.identity, evidence: { ...parentData.evidence, counts, passage_groups: groups, document_items: items } };
    state = { map: failed ? { ...failed, data } : data && !loading ? { status: "ready", data } : { status: "loading" },
      decorations: { identity: doc.identity, marks, noteRefs }, markers };
    for (const listener of listeners) listener();
  }

  function connect() {
    const owners = new Map<string, number | null>([[mediaId, doc?.identity.startsWith("g") ? Number(doc.identity.slice(1)) : null]]);
    if (doc?.kind === "text") for (const unit of doc.units) {
      const owner = unit.xPost?.owner;
      if (owner) owners.set(owner.media_id, owner.generation);
    }
    for (const [id, binding] of held) if (!owners.has(id)) { binding.unsubscribe(); held.delete(id); }
    for (const [id, generation] of owners) {
      if (!held.has(id)) {
        const store = canonicalStore(id);
        if (generation !== null) store.generation(generation);
        const binding = { store, unsubscribe: () => {} };
        held.set(id, binding);
        binding.unsubscribe = store.subscribe(project);
      } else if (generation !== null) held.get(id)!.store.generation(generation);
    }
    project();
  }

  function source<Anchor extends MarkAnchor>(anchor: Anchor) {
    const unit = anchor.kind === "text" && doc?.kind === "text" ? doc.units.find((unit) => unit.id === anchor.unit) : null;
    const owner = unit?.xPost?.owner;
    if (unit?.xPost && !owner) throw new Error("public source has no annotation owner");
    return owner && anchor.kind === "text" ? { mediaId: owner.media_id, anchor: { ...anchor, unit: owner.fragment_id }, generation: owner.generation }
      : { mediaId, anchor, generation: doc?.identity.startsWith("g") ? Number(doc.identity.slice(1)) : null };
  }
  const storeFor = (id: string) => held.get(id)?.store ?? canonicalStore(id);
  const highlightStore = (id: string) => [...held.values()].find(({ store }) => store.highlight(id) !== null)?.store;
  return {
    bind(next) { if (doc === next) return; doc = next; if (listeners.size) connect(); },
    source,
    getState: () => {
      if (state.map.status === "failed" && (!isApiError(state.map.error) || isSameSystemApiDefect(state.map.error))) throw state.map.error;
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) connect();
      return () => { listeners.delete(listener); if (!listeners.size) { for (const binding of held.values()) binding.unsubscribe(); held.clear(); } };
    },
    refresh() { for (const binding of held.values()) binding.store.refresh(); },
    twin(anchor) { const bound = source(anchor); return storeFor(bound.mediaId).twin(bound.anchor); },
    prepareCreate(anchor, color) { const bound = source(anchor); return storeFor(bound.mediaId).prepareCreate(bound.anchor, color, bound.generation); },
    acknowledge(highlight) { storeFor(highlight.anchor.media_id).acknowledge(highlight); },
    recolor(id, color, version) { const store = highlightStore(id); if (!store) throw new Error("highlight owner is not mounted"); return store.recolor(id, color, version); },
    rebound(id, anchor, version) { const bound = source(anchor); return storeFor(bound.mediaId).rebound(id, { ...anchor, unit: bound.anchor.kind === "text" ? bound.anchor.unit : anchor.unit }, version, bound.generation); },
    remove(id) { const store = highlightStore(id); if (!store) throw new Error("highlight owner is not mounted"); return store.remove(id); },
    highlight: (id) => highlightStore(id)?.highlight(id) ?? null,
  };
}
