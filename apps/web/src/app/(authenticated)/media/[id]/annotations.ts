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
import { targetOfResolution, type Resolution } from "./hostedReader";
import { markerFacet, rootCounts, rootExtent, rootItem, type EvidenceRoot } from "./evidence/model";

type WireDocumentMap = Schema<"ReaderDocumentMapOut">;
export type DocumentMap = Omit<WireDocumentMap, "evidence"> & {
  readonly evidence: Omit<WireDocumentMap["evidence"], "roots"> & { readonly roots: EvidenceRoot[] };
};
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
  const target = targetOfResolution(resolution);
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
    for (const root of data?.evidence.roots ?? []) {
      const anchor = root.resolution && anchorOf(root.resolution);
      const item = root.content;
      if (anchor) {
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
      const { data: wire } = await apiFetch<
        ApiJson<"/media/{media_id}/document-map", "get">
      >(`/api/media/${mediaId}/document-map`, { signal });
      const data: DocumentMap = { ...wire, evidence: { ...wire.evidence,
        roots: wire.evidence.roots.map((root) => ({ ...root,
          source: { media_id: wire.media_id, identity: wire.identity, apparatus_source: wire.evidence.apparatus_source },
        })),
      } };
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
    for (const { content } of last.evidence.roots)
      if (content.kind === "Highlight" && content.highlight_id === id) return { ...content, mediaId };
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
    const roots = new Map<string, EvidenceRoot>();
    const placementRanks = new Map<string, number>();
    let failed: Extract<AnnotationState["map"], { status: "failed" }> | null = null;
    let loading = false;
    let partial = false;
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
      for (const mark of current.decorations.marks) for (const anchor of anchors(mark.anchor)) marks.push({ ...mark, anchor });
      for (const note of current.decorations.noteRefs) for (const anchor of anchors({ ...note, kind: "text" }))
        if (anchor.kind === "text") noteRefs.push({ key: note.key, unit: anchor.unit, start: anchor.start, end: anchor.end });
      const data = current.map.data;
      if (!data) continue;
      partial ||= data.status === "partial";
      for (const canonicalRoot of data.evidence.roots) {
        let resolution = canonicalRoot.resolution;
        if (resolution?.kind === "Resolved") {
          const locator = resolution.anchor.locator;
          if ("fragment_id" in locator) {
            const unit = doc.kind === "text" ? doc.units.find((unit) =>
              (id === mediaId && unit.id === locator.fragment_id) ||
              (unit.xPost?.owner?.media_id === id && unit.xPost.owner.fragment_id === locator.fragment_id)) : null;
            resolution = unit && "end_offset" in locator && locator.end_offset <= unit.length
              ? { ...resolution, anchor: { ...resolution.anchor, locator: { ...locator, fragment_id: unit.id } } }
              : { kind: "Unavailable", reason: "Unanchorable" };
          } else if (id !== mediaId) resolution = { kind: "Unavailable", reason: "Unanchorable" };
          if (!rootExtent(resolution, doc)) resolution = { kind: "Unavailable", reason: "Unanchorable" };
        }
        const incoming = { ...canonicalRoot, resolution };
        const rank = resolution?.kind === "Resolved" ? canonicalRoot.content.kind === "Resource" ? 2 : 3 : resolution ? 1 : 0;
        const previous = roots.get(incoming.ref);
        if (!previous) { roots.set(incoming.ref, incoming); placementRanks.set(incoming.ref, rank); continue; }
        const native = previous.content.kind === "Resource" && incoming.content.kind !== "Resource" ? incoming : previous;
        const facts = new Map([...previous.direct_facts, ...incoming.direct_facts].map((fact) => [fact.edge_id, fact]));
        roots.set(incoming.ref, { ...native,
          resolution: rank > placementRanks.get(incoming.ref)! ? resolution : previous.resolution,
          direct_facts: [...facts.values()].sort((a, b) => a.edge_id < b.edge_id ? -1 : a.edge_id > b.edge_id ? 1 : 0),
        });
        placementRanks.set(incoming.ref, Math.max(rank, placementRanks.get(incoming.ref)!));
      }
      if (id === mediaId) markers.push(...current.markers.filter((marker) => marker.id.startsWith("embed:")));
    }
    const position = (root: EvidenceRoot, end = false): number | null => {
      const extent = rootExtent(root.resolution, doc!);
      return extent ? structure.fraction(end ? extent.end : extent.start) : null;
    };
    const orderedRoots = [...roots.values()].sort((a, b) => {
      const at = position(a), bt = position(b);
      if (at !== null || bt !== null) return at === null ? 1 : bt === null ? -1 : at - bt || a.ref.localeCompare(b.ref);
      if ((a.resolution === null) !== (b.resolution === null)) return a.resolution === null ? -1 : 1;
      return rootItem(a).label.localeCompare(rootItem(b).label) || a.ref.localeCompare(b.ref);
    });
    for (const root of orderedRoots) {
      const at = position(root);
      if (at === null) continue;
      const item = rootItem(root), body = item.preview.body;
      const facet = markerFacet(root);
      markers.push({ id: root.ref, position: at, end: position(root, true),
        tone: facet === "highlights" ? "Highlight" : facet === "citations" ? "Citation" : facet === "links" ? "Link" : "MachineLink",
        label: item.label, preview: body.kind === "passage" ? body.exact.text : body.kind === "prose" ? body.excerpt.text : null,
      });
    }
    const parentData = parent.map.status === "loading" ? null : parent.map.data;
    const data: DocumentMap | null = parentData && { ...parentData, identity: doc.identity, status: partial ? "partial" : orderedRoots.length || parentData.embeds.length ? "ready" : "empty", evidence: { ...parentData.evidence, counts: rootCounts(orderedRoots), roots: orderedRoots } };
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
