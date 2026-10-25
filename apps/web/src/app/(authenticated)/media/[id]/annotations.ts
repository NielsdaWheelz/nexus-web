"use client";

// The media's annotations: one document-map read (marks, note markers, rail
// markers, evidence) and the highlight writes. A write paints at once from its
// acknowledgement through a pending ledger, which a map read issued after the
// write settles (created, recoloured, rebounded and deleted alike). The map is
// read while someone subscribes: a remounted subscriber reads it again.
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { admitWriting, type WritingAck, type WritingIntent } from "@/lib/notes/writes";
import { adoptText, readText, setGone } from "@/lib/notes/texts";
import { parseBody } from "@/lib/notes/noteBody";
import { fetchNote } from "@/lib/notes/api";
import { readSharedValue } from "@/lib/api/serverState";
import { watchWritingResource, type WritingWatch } from "@/lib/api/writingReceive";
import { captureResourceOutlineRead, isResourceOutlineReadCurrent } from "@/lib/resourceGraph/useResourceOutline";
import type { RailMarker } from "@/lib/documentReader/chrome/MapRail";
import { sameAnchor } from "@/lib/documentReader/anchors";
import type {
  Decorations,
  DraftAnchor,
  Mark,
  MarkAnchor,
  NoteRef,
  TextRange,
} from "@/lib/documentReader/DocumentReader";
import { structureOf, localPoint, sourcePoint, type HighlightColor, type ReaderDocument } from "@/lib/documentReader/model";
import { targetOfResolution, type Resolution } from "./hostedReader";
import { markerFacet, rootCounts, rootExtent, rootItem, type EvidenceRoot } from "./evidence/model";

type WireDocumentMap = Schema<"ReaderDocumentMapOut">;
export interface ReaderRootRead {
  readonly endpoint: string;
  readonly generation: number;
  readonly complete: boolean;
  readonly edgeIds: ReadonlySet<string>;
}
export type DocumentMap = Omit<WireDocumentMap, "evidence"> & {
  readonly root_reads: readonly ReaderRootRead[];
  readonly evidence: Omit<WireDocumentMap["evidence"], "roots"> & { readonly roots: EvidenceRoot[] };
};
export type EvidenceHighlight = Schema<"ReaderEvidenceHighlightOut">;
type Highlight = Schema<"WritingHighlight">;
type HighlightSummary = Pick<EvidenceHighlight, "quote" | "color" | "is_owner" | "version"> & { readonly mediaId: string };

export interface AnnotationState {
  readonly map:
    | { readonly status: "loading"; readonly data: DocumentMap | null }
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
  prepareCreate(input: { anchor: DraftAnchor; color: HighlightColor; id: string; initialNote: Schema<"InitialHighlightNote"> | null }): Extract<WritingIntent, { kind: "passage" }>;
  acknowledge(ack: WritingAck): void;
  recolor(id: string, color: HighlightColor, expectedVersion: string): Promise<WritingAck>;
  rebound(id: string, anchor: TextRange, expectedVersion: string): Promise<WritingAck>;
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

type CanonicalStore = Omit<AnnotationStore, "bind" | "source" | "prepareCreate" | "rebound"> & {
  generation(value: number): void;
  rebound(id: string, anchor: TextRange, expectedVersion: string, generation: number | null): Promise<WritingAck>;
};
const canonical = new Map<string, CanonicalStore>();

/** One subscribed map per canonical media, shared by every mounted occurrence/pane. */
function canonicalStore(mediaId: string, accountId: string): CanonicalStore {
  const key = `${accountId}:${mediaId}`;
  const existing = canonical.get(key);
  if (existing) return existing;
  let requestedGeneration: number | null = null;
  const listeners = new Set<() => void>();
  let state: AnnotationState = {
    map: { status: "loading", data: null },
    decorations: { identity: "", marks: [], noteRefs: [] },
    markers: [],
  };
  /** Writes not yet read back: `after` is the first map read that reflects them. */
  const ledger = new Map<string, { readonly after: number; readonly mark: Mark | null; readonly highlight: HighlightSummary | null }>();
  /** The last map read: a failed read keeps it painted. */
  let last: DocumentMap | null = null;
  let reads = 0;
  let controller = new AbortController();
  let mediaWatch: WritingWatch | null = null;
  const noteWatches = new Map<string, { watch: WritingWatch; controller: AbortController | null }>();

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
    const generation = captureResourceOutlineRead();
    const watchedGeneration = mediaWatch?.capture();
    const noteGenerations = new Map([...noteWatches].map(([ref, held]) => [ref, held.watch.capture()]));
    if (state.map.status === "failed") {
      state = { ...state, map: { ...state.map, retrying: true } };
      project(last);
    }
    try {
      const { data: wire } = await apiFetch<
        ApiJson<"/media/{media_id}/document-map", "get">
      >(`/api/media/${mediaId}/document-map`, { signal });
      const data: DocumentMap = { ...wire,
        root_reads: [{ endpoint: `media:${wire.media_id}`, generation, complete: wire.status !== "partial",
          edgeIds: new Set(wire.evidence.roots.flatMap((root) => root.direct_facts.map((fact) => fact.edge_id))) }],
        evidence: { ...wire.evidence,
        roots: wire.evidence.roots.map((root) => ({ ...root,
          source: { media_id: wire.media_id, identity: wire.identity, apparatus_source: wire.evidence.apparatus_source },
        })),
      } };
      if (signal.aborted) return;
      if (!isResourceOutlineReadCurrent(`media:${mediaId}`, generation)) { void read(); return; }
      if (requestedGeneration !== null && Number(data.identity.slice(1)) < requestedGeneration) {
        void read();
        return;
      }
      if (watchedGeneration !== undefined && !mediaWatch?.adopt({ annotations_version: wire.annotations_version }, watchedGeneration)) return;
      for (const [id, entry] of ledger) if (entry.after <= seq) ledger.delete(id);
      watchNotes(data, noteGenerations);
      last = data;
      state = { ...state, map: { status: "ready", data } };
      project(data);
    } catch (error) {
      if (signal.aborted || handleUnauthenticatedApiError(error)) return;
      state = { ...state, map: { status: "failed", error, data: last, retrying: false } };
      project(last);
    }
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

  function acknowledge(ack: WritingAck) {
    for (const highlight of ack.highlights) {
      if (highlight.anchor.media_id !== mediaId) continue;
      const painted = anchorOfHighlight(highlight);
      ledger.set(highlight.id, { after: reads + 1,
        mark: painted && { id: highlight.id, color: highlight.color, anchor: painted },
        highlight: { quote: highlight.exact, color: highlight.color, is_owner: highlight.author_user_id === accountId, version: highlight.version, mediaId } });
    }
    for (const ref of ack.deleted_refs) if (ref.startsWith("highlight:"))
      ledger.set(ref.slice("highlight:".length), { after: reads + 1, mark: null, highlight: null });
    project(last);
    // the receive owner invalidates membership and previews once after settlement.
  }

  function receiveNote(ref: string, incoming: Pick<Schema<"WritingNote">, "body_pm_json" | "body_text" | "body_version">) {
    const current = readText(ref)?.acked;
    const body = current && typeof current.value !== "string" && current.version > incoming.body_version
      ? { ...current.value, body_version: current.version } : incoming;
    adoptText(ref, parseBody(body.body_pm_json), body.body_version);
    if (!last) return;
    last = { ...last, evidence: { ...last.evidence, roots: last.evidence.roots.map(root => {
      const content = root.content;
      if (content.kind === "SourceReference" || content.item.preview.annotation?.note_ref !== ref) return root;
      return { ...root, content: { ...content, item: { ...content.item, preview: { ...content.item.preview,
        annotation: { ...content.item.preview.annotation, body_pm_json: body.body_pm_json, body_text: body.body_text, body_version: body.body_version },
      } } } };
    }) } };
    state = { ...state, map: { ...state.map, data: last } };
    project(last);
  }

  function watchNotes(data: DocumentMap, generations: ReadonlyMap<string, number>) {
    const notes = new Map<string, Schema<"ResourceAnnotationOut">>();
    for (const root of data.evidence.roots) {
      const annotation = rootItem(root).preview.annotation;
      if (annotation) notes.set(annotation.note_ref, annotation);
    }
    for (const [ref, held] of noteWatches) if (!notes.has(ref)) {
      held.watch.stop(); held.controller?.abort(); noteWatches.delete(ref);
    }
    for (const [ref, note] of notes) {
      if (readText(ref)?.gone) continue;
      let generation = generations.get(ref);
      let held = noteWatches.get(ref);
      if (!held) {
        const binding: { watch: WritingWatch; controller: AbortController | null } = {
          controller: null,
          watch: watchWritingResource({ accountId, ref, lanes: ["body_version"], acknowledge(ack) {
            const note = ack.notes.find(note => `note_block:${note.id}` === ref);
            if (!note) return {};
            receiveNote(ref, note);
            return { body_version: readText(ref)?.acked?.version ?? note.body_version };
          }, invalidate(state) {
            if (noteWatches.get(ref) !== binding) return;
            binding.controller?.abort();
            const generation = binding.watch.capture();
            if (state === "unavailable") { retire(generation); return; }
            binding.controller = new AbortController();
            const signal = binding.controller.signal;
            const noteId = ref.slice("note_block:".length);
            void readSharedValue({ accountId, key: `/notes/blocks/${encodeURIComponent(noteId)}`,
              load: readSignal => fetchNote(noteId, readSignal), signal, revalidate: true,
            }).then(body => {
              if (signal.aborted || noteWatches.get(ref) !== binding ||
                !binding.watch.adopt({ body_version: body.body_version }, generation)) return;
              receiveNote(ref, body);
            }).catch(error => {
              if (signal.aborted || isAbortError(error) || noteWatches.get(ref) !== binding ||
                binding.watch.capture() !== generation) return;
              if (isApiError(error) && !isSameSystemApiDefect(error) && error.status === 404) retire(generation);
              else binding.watch.fail(error, generation);
            });
          } }),
        };
        function retire(generation: number) {
          if (noteWatches.get(ref) !== binding || binding.watch.capture() !== generation) return;
          noteWatches.delete(ref);
          binding.controller?.abort();
          binding.watch.stop();
          setGone(ref);
        }
        held = binding; noteWatches.set(ref, held);
        generation = held.watch.capture();
      }
      const current = readText(ref)?.acked;
      if (current && typeof current.value !== "string" && current.version > note.body_version) {
        Object.assign(note, { body_pm_json: current.value.body_pm_json, body_text: current.value.body_text, body_version: current.version });
      }
      if (generation !== undefined && held.watch.adopt({ body_version: note.body_version }, generation)) adoptText(ref, parseBody(note.body_pm_json), note.body_version);
    }
  }

  /** admission freezes the exact observed version; delivery never belongs to a pane. */
  async function update(id: string, request: Schema<"UpdateHighlightRequest">): Promise<WritingAck> {
    const admitted = admitWriting({ kind: "highlight_update", highlight_id: id, request }, []);
    const ack = await admitted.settled;
    acknowledge(ack);
    return ack;
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
      if (listeners.size === 1) {
        mediaWatch = watchWritingResource({ accountId, ref: `media:${mediaId}`, lanes: ["annotations_version"], invalidate() { void read(); } });
        void read();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          controller.abort(); mediaWatch?.stop(); mediaWatch = null;
          for (const held of noteWatches.values()) { held.watch.stop(); held.controller?.abort(); }
          noteWatches.clear(); canonical.delete(key);
        }
      };
    },
    refresh: () => void read(),
    twin,
    acknowledge,
    recolor: (id, color, expectedVersion) => update(id, { color, expected_version: expectedVersion }),
    rebound: (id, anchor, expectedVersion, generation) => update(id, { expected_version: expectedVersion, expected_reader_generation: generation,
      anchor: { type: "fragment_offsets", reading_media_id: mediaId, unit_id: anchor.unit, start_offset: anchor.start, end_offset: anchor.end } }),
    async remove(id) {
      const admitted = admitWriting({ kind: "highlight_delete", highlight_id: id }, []);
        acknowledge(await admitted.settled);
    },
    highlight,
  };
  canonical.set(key, store);
  return store;
}

/** An occurrence projection over canonical stores; body offsets never leave their source owner. */
export function createAnnotationStore(mediaId: string, accountId: string): AnnotationStore {
  let doc: ReaderDocument | null = null;
  const listeners = new Set<() => void>();
  const held = new Map<string, { store: CanonicalStore; unsubscribe: () => void }>();
  let state: AnnotationState = { map: { status: "loading", data: null }, decorations: { identity: "", marks: [], noteRefs: [] }, markers: [] };

  function project() {
    const parent = held.get(mediaId)?.store.getState();
    if (!parent) return;
    if (!doc) { state = parent; for (const listener of listeners) listener(); return; }
    const projectedDocument = doc;
    const structure = structureOf(doc, null);
    const marks: Mark[] = [];
    const noteRefs: NoteRef[] = [];
    const markers: RailMarker[] = [];
    const roots = new Map<string, EvidenceRoot>();
    const rootReads: ReaderRootRead[] = [];
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
        : id === mediaId ? (() => {
          const start=localPoint(projectedDocument,{unit:anchor.unit,offset:anchor.start});
          const end=localPoint(projectedDocument,{unit:anchor.unit,offset:anchor.end});
          return start && end ? [{...anchor,unit:start.unit,start:start.offset,end:end.offset}] : [];
        })() : [];
      for (const mark of current.decorations.marks) for (const anchor of anchors(mark.anchor)) marks.push({ ...mark, anchor });
      for (const note of current.decorations.noteRefs) for (const anchor of anchors({ ...note, kind: "text" }))
        if (anchor.kind === "text") noteRefs.push({ key: note.key, unit: anchor.unit, start: anchor.start, end: anchor.end });
      const data = current.map.data;
      if (!data) continue;
      rootReads.push(...data.root_reads);
      partial ||= data.status === "partial";
      for (const canonicalRoot of data.evidence.roots) {
        let resolution = canonicalRoot.resolution;
        if (resolution?.kind === "Resolved") {
          const locator = resolution.anchor.locator;
          if ("fragment_id" in locator) {
            const unit = doc.kind === "text" ? doc.units.find((unit) =>
              (id === mediaId && unit.id === locator.fragment_id) ||
              (unit.xPost?.owner?.media_id === id && unit.xPost.owner.fragment_id === locator.fragment_id)) : null;
            resolution = unit && "end_offset" in locator && localPoint(doc,{unit:unit.id,offset:locator.end_offset}) !== null
              ? { ...resolution, anchor: { ...resolution.anchor, locator: { ...locator, fragment_id: unit.id } } }
              : { kind: "Unavailable", reason: "Unanchorable" };
          } else if (id !== mediaId) resolution = { kind: "Unavailable", reason: "Unanchorable" };
          if (!rootExtent(resolution, doc)) resolution = { kind: "Unavailable", reason: "Unanchorable" };
        }
        const incoming = { ...canonicalRoot, resolution };
        const rank = resolution?.kind === "Resolved" ? canonicalRoot.content.kind === "Resource" ? 2 : 3 : resolution ? 1 : 0;
        const previous = roots.get(incoming.ref);
        if (!previous) { roots.set(incoming.ref, incoming); placementRanks.set(incoming.ref, rank); continue; }
        // Content, continuation and placement keep the same canonical source owner.
        const preferred = previous.content.kind === "Resource" && incoming.content.kind !== "Resource" ? incoming
          : previous.content.kind !== "Resource" && incoming.content.kind === "Resource" ? previous
          : rank > placementRanks.get(incoming.ref)! ? incoming : previous;
        const facts = new Map([...previous.direct_facts, ...incoming.direct_facts].map((fact) => [fact.edge_id, fact]));
        roots.set(incoming.ref, { ...preferred, direct_facts: [...facts.values()] });
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
      return 0;
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
    const data: DocumentMap | null = parentData && { ...parentData, root_reads: rootReads, identity: doc.identity, status: partial ? "partial" : orderedRoots.length || parentData.embeds.length ? "ready" : "empty", evidence: { ...parentData.evidence, counts: rootCounts(orderedRoots), roots: orderedRoots } };
    state = { map: failed ? { ...failed, data } : data && !loading ? { status: "ready", data } : { status: "loading", data: state.map.data ?? data },
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
        const store = canonicalStore(id, accountId);
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
    if (!owner && anchor.kind === "text" && doc) {
      const start=sourcePoint(doc,{unit:anchor.unit,offset:anchor.start});
      const end=sourcePoint(doc,{unit:anchor.unit,offset:anchor.end});
      if (!start || !end) throw new Error("selection is outside its reading scope");
      return {mediaId,anchor:{...anchor,unit:start.unit,start:start.offset,end:end.offset},generation:doc.identity.startsWith("g")?Number(doc.identity.slice(1)):null};
    }
    return owner && anchor.kind === "text" ? { mediaId: owner.media_id, anchor: { ...anchor, unit: owner.fragment_id }, generation: owner.generation }
      : { mediaId, anchor, generation: doc?.identity.startsWith("g") ? Number(doc.identity.slice(1)) : null };
  }
  const storeFor = (id: string) => held.get(id)?.store ?? canonicalStore(id, accountId);
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
    prepareCreate({ anchor, color, id, initialNote }) {
      const bound = source(anchor);
      if (bound.generation === null && !(doc?.kind === "text" && doc.format === "transcript"))
        throw new Error("the passage has no captured source generation");
      return { kind: "passage", media_id: bound.mediaId, request: {
        id, anchor: wireAnchor(bound.anchor), color,
        expected_reader_generation: bound.generation, initial_note: initialNote,
      } };
    },
    acknowledge(ack) {
      const owners = new Set(ack.highlights.map(highlight => highlight.anchor.media_id));
      for (const id of owners) storeFor(id).acknowledge(ack);
      held.get(mediaId)?.store.acknowledge(ack);
    },
    recolor(id, color, version) { const store = highlightStore(id); if (!store) throw new Error("highlight owner is not mounted"); return store.recolor(id, color, version); },
    rebound(id, anchor, version) { const bound = source(anchor); return storeFor(bound.mediaId).rebound(id, bound.anchor, version, bound.generation); },
    remove(id) { const store = highlightStore(id); if (!store) throw new Error("highlight owner is not mounted"); return store.remove(id); },
    highlight: (id) => highlightStore(id)?.highlight(id) ?? null,
  };
}
