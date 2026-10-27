"use client";

// Reader annotations over the local authored store. A highlight is an independent
// authored resource; its attached notes are its linked notes in endpoint order, read
// for a whole source at once. This
// module maps them onto one mounted publication and turns reader selections into
// exact local commands. Every host (workspace, shelf, saved episode) uses it.
//
// Placement never rewrites writing: the same publication or an exact quote at the
// saved offsets places a mark; otherwise a unique literal occurrence places a derived
// mark; otherwise the annotation stays unlocated beside its literal quote. A host
// without source text still lists every annotation with editable notes.
import { createNoteIntent, type Intent } from "@nexus/authored/commands";
import type { NoteBody } from "@nexus/authored/body";
import { normalizeQuote, passageId, passageKey } from "@nexus/authored/identity";
import type { AuthoredStore, HighlightColor, LinkState, Locator, PassageState, QueryResult, SelectionCapture } from "@nexus/authored/types";
import type { LocalCommit, WritingRuntime } from "@/lib/notes/runtime";
import { prepareLink } from "@/lib/resourceGraph/links";
import { ScopeQuoteScanner, normalizeScopeText } from "@nexus/authored/scope";
import type { DraftAnchor, Inspection, Mark, MarkAnchor } from "./DocumentReader";
import type { ReaderDocument, ReaderTarget, TextDocument, TextUnit } from "./model";

const CONTEXT = 64;
const PAGE = 100;
const WHITE = /[\p{White_Space}\u001c-\u001f]/u;

export interface AttachedNote {
  readonly ref: string;
  readonly linkId: string;
  readonly position: string;
}
export type Placement =
  | { readonly kind: "placed"; readonly anchor: MarkAnchor }
  | { readonly kind: "unlocated" }
  | { readonly kind: "unavailable" };
export interface ReaderAnnotation {
  /** The highlight uuid; marks and reader events carry it. */
  readonly id: string;
  readonly ref: string;
  readonly sourceRef: string;
  readonly color: HighlightColor;
  readonly selection: SelectionCapture;
  readonly placement: Placement;
  readonly notes: readonly AttachedNote[];
}
export interface AnnotationsState {
  readonly status: "loading" | "ready" | "failed";
  readonly error: unknown;
  /** Placed in document order, then unlocated; each id once. */
  readonly annotations: readonly ReaderAnnotation[];
  /** Topmost first: the narrower of two overlapping marks paints and hits first. */
  readonly marks: readonly Mark[];
}
/** The literal label and kind captured into the source stub with a new highlight. */
export interface SourceLabel {
  readonly kind: string;
  readonly label: string;
}

const highlightRef = (id: string) => `highlight:${id}`;
const mediaRef = (id: string) => `media:${id}`;
const chars = (text: string) => [...text];

/** The canonical owner of a mounted unit's offsets, or null for a public source unit. */
function ownerOf(doc: TextDocument, mediaId: string, unit: TextUnit): { mediaId: string; generation: number | null; fragment: string } | null {
  if (unit.xPost) return unit.xPost.owner ? { mediaId: unit.xPost.owner.media_id, generation: unit.xPost.owner.generation, fragment: unit.xPost.owner.fragment_id } : null;
  if (doc.part) return { mediaId: doc.part.mediaId, generation: doc.part.generation, fragment: unit.id };
  return { mediaId, generation: doc.generation, fragment: unit.id };
}

/** Every source whose highlights may paint on this publication. */
export function annotationSources(doc: ReaderDocument | null, mediaId: string): string[] {
  if (doc?.kind !== "text") return [mediaRef(mediaId)];
  const owners = new Set<string>();
  for (const unit of doc.units) {
    const owner = ownerOf(doc, mediaId, unit);
    if (owner) owners.add(mediaRef(owner.mediaId));
  }
  return owners.size ? [...owners] : [mediaRef(doc.part?.mediaId ?? mediaId)];
}

/** A text selection's passage identity, exactly as the server's `text_quote` derives it:
 * NFC, every whitespace run one space, the normalized quote and the nearest 64 normalized
 * scalars each side, stripped of spaces only (python `strip` keeps U+FEFF; JS `trim` does
 * not). Raw code point offsets enter NFC space through their own normalized prefixes. */
export interface PassageKey { readonly normalized_exact: string; readonly prefix: string; readonly suffix: string }
const strip = (text: string) => text.replace(/^ +| +$/gu, "");
function collapse(text: string): { normalized: string[]; boundaries: number[] } {
  const nfc = chars(text.normalize("NFC"));
  const normalized: string[] = [];
  const boundaries = [0];
  for (let i = 0; i < nfc.length;) {
    let j = i + 1;
    if (WHITE.test(nfc[i]!)) { while (j < nfc.length && WHITE.test(nfc[j]!)) j++; normalized.push(" "); }
    else normalized.push(nfc[i]!);
    boundaries.push(j);
    i = j;
  }
  return { normalized, boundaries };
}
function passageOf(text: string, start: number, end: number): PassageKey | null {
  const raw = chars(text);
  const exact = strip(collapse(raw.slice(start, end).join("")).normalized.join(""));
  // whitespace alone has no passage identity; the highlight still keeps its literal capture.
  if (!exact) return null;
  const { normalized, boundaries } = collapse(text);
  const nfcStart = chars(raw.slice(0, start).join("").normalize("NFC")).length;
  const nfcEnd = chars(raw.slice(0, end).join("").normalize("NFC")).length;
  let from = boundaries.findIndex(boundary => boundary >= nfcStart);
  let to = boundaries.findLastIndex(boundary => boundary <= nfcEnd);
  while (from < to && normalized[from] === " ") from++;
  while (to > from && normalized[to - 1] === " ") to--;
  return { normalized_exact: exact, prefix: strip(normalized.slice(Math.max(0, from - CONTEXT), from).join("")),
    suffix: strip(normalized.slice(to, to + CONTEXT).join("")) };
}

export interface Capture {
  readonly sourceRef: string;
  /** passage_ref is bound when the command commits, through the permanent passage binding. */
  readonly selection: SelectionCapture;
  /** The passage owner is the text whose context keyed it: a part keys its own slice. */
  readonly passage: (PassageKey & { readonly source_ref: string }) | null;
}

/** The exact local capture of one reader selection; null when this source grants no annotation. */
export function captureSelection(doc: ReaderDocument, mediaId: string, anchor: DraftAnchor): Capture | null {
  if (anchor.kind === "pdf") {
    // the shared pdf canonicalization admits at most 512 quads and a 2000-code-point quote.
    if (doc.kind !== "pdf" || doc.generation === null || anchor.quads.length > 512 || chars(anchor.exact).length > 2000) return null;
    const locator: Locator = { type: "pdf_page_geometry", media_id: mediaId, page_number: anchor.page, quads: anchor.quads.map(quad => ({ ...quad })),
      exact: anchor.exact, prefix: null, suffix: null, text_quote_selector: { exact: anchor.exact, prefix: null, suffix: null }, projection: null };
    // a geometric pdf selection has no textual passage anchor.
    return { sourceRef: mediaRef(mediaId), passage: null, selection: { publication: { kind: "reader", generation: doc.generation }, locator,
      quote_exact: anchor.exact, prefix: null, suffix: null, passage_ref: null } };
  }
  if (doc.kind !== "text") return null;
  const unit = doc.units.find(candidate => candidate.id === anchor.unit);
  const owner = unit && ownerOf(doc, mediaId, unit);
  if (!unit || !owner) return null;
  const text = chars(unit.text);
  if (anchor.start < 0 || anchor.end > text.length || anchor.end <= anchor.start) return null;
  const exact = text.slice(anchor.start, anchor.end).join("");
  const prefix = text.slice(Math.max(0, anchor.start - CONTEXT), anchor.start).join("");
  const suffix = text.slice(anchor.end, anchor.end + CONTEXT).join("");
  const offsets = { media_id: owner.mediaId, fragment_id: owner.fragment, start_offset: anchor.start + unit.sourceStartOffset,
    end_offset: anchor.end + unit.sourceStartOffset, media_kind: null, text_quote_selector: { exact, prefix, suffix } };
  const locator: Locator = doc.format === "epub" ? { type: "epub_fragment_offsets", section_id: null, ...offsets } : { type: "web_text_offsets", ...offsets };
  const passage = passageOf(unit.text, anchor.start, anchor.end);
  return { sourceRef: mediaRef(owner.mediaId), passage: passage && { ...passage, source_ref: doc.part ? mediaRef(mediaId) : mediaRef(owner.mediaId) },
    selection: { publication: owner.generation === null ? null : { kind: "reader", generation: owner.generation },
      locator, quote_exact: exact, prefix, suffix, passage_ref: null } };
}

/** Units whose offsets this source owns, keyed by canonical fragment. */
export function sourceUnits(doc: TextDocument, mediaId: string, source: string): { unit: TextUnit; generation: number | null; fragment: string }[] {
  return doc.units.flatMap(unit => {
    const owner = ownerOf(doc, mediaId, unit);
    return owner && owner.mediaId === source ? [{ unit, generation: owner.generation, fragment: owner.fragment }] : [];
  });
}

/** Where a saved selection paints on this publication; null when it belongs elsewhere. */
export function placeSelection(doc: ReaderDocument, mediaId: string, selection: SelectionCapture): Placement | null {
  const { locator, publication } = selection;
  if (locator.type === "pdf_page_geometry") {
    if (doc.kind !== "pdf" || locator.media_id !== mediaId) return null;
    return publication?.kind === "reader" && doc.generation !== null && publication.generation === doc.generation
      ? { kind: "placed", anchor: { kind: "pdf", page: locator.page_number, quads: locator.quads } } : { kind: "unlocated" };
  }
  if (doc.kind !== "text" || !("media_id" in locator)) return null;
  const units = sourceUnits(doc, mediaId, locator.media_id);
  if ("fragment_id" in locator) {
    const mounted = units.find(entry => entry.fragment === locator.fragment_id);
    if (mounted) {
      const text = chars(mounted.unit.text);
      const start = locator.start_offset - mounted.unit.sourceStartOffset;
      const end = locator.end_offset - mounted.unit.sourceStartOffset;
      const same = publication?.kind === "reader" && publication.generation === mounted.generation;
      // a part mounts a slice of its source fragment; offsets outside it belong to another part.
      if (doc.part && (start < 0 || end > text.length)) return null;
      if (start >= 0 && end <= text.length && start < end && (same || text.slice(start, end).join("") === selection.quote_exact))
        return { kind: "placed", anchor: { kind: "text", unit: mounted.unit.id, start, end } };
    } else if (doc.part || locator.media_id !== mediaId) return null;
  }
  // Relocation reads only the whole owning publication; parts and threads show their own slice.
  if (doc.part || locator.media_id !== mediaId || !selection.quote_exact) return { kind: "unlocated" };
  const found: MarkAnchor[] = [];
  const prefix = normalizeQuote(selection.prefix ?? ""), suffix = normalizeQuote(selection.suffix ?? "");
  for (const { unit } of units) {
    for (let at = unit.text.indexOf(selection.quote_exact); at >= 0; at = unit.text.indexOf(selection.quote_exact, at + 1)) {
      const start = chars(unit.text.slice(0, at)).length, end = start + chars(selection.quote_exact).length;
      found.push({ kind: "text", unit: unit.id, start, end });
    }
  }
  const fits = (anchor: Extract<MarkAnchor, { kind: "text" }>) => {
    const text = chars(doc.units.find(unit => unit.id === anchor.unit)!.text);
    const before = normalizeQuote(text.slice(Math.max(0, anchor.start - CONTEXT), anchor.start).join(""));
    const after = normalizeQuote(text.slice(anchor.end, anchor.end + CONTEXT).join(""));
    // saved context must overlap real text; an empty edge never vouches for a candidate.
    return (!prefix || before !== "" && (prefix.endsWith(before) || before.endsWith(prefix))) &&
      (!suffix || after !== "" && (suffix.startsWith(after) || after.startsWith(suffix)));
  };
  const unique = found.length === 1 ? found : found.filter(anchor => anchor.kind === "text" && fits(anchor));
  return unique.length === 1 ? { kind: "placed", anchor: unique[0]! } : { kind: "unlocated" };
}

/** A saved passage uses only this mounted source. Capture hints stay immutable;
 * missing or changed provenance needs one normalized quote in its owned units. */
export function locatePassage(doc: ReaderDocument, mediaId: string, passage: PassageState, canonicalSourceRef: string | null): {
  target: ReaderTarget; inspection: Inspection;
} | null {
  const ownReading = passage.source_ref === mediaRef(mediaId);
  const { locator, publication, quote_exact } = passage.capture.value;
  const source = locator && "media_id" in locator ? mediaRef(locator.media_id) : canonicalSourceRef ?? passage.source_ref;
  if (!ownReading && !annotationSources(doc, mediaId).includes(source)) return null;
  const capturedGeneration = locator?.type === "pdf_page_geometry" && doc.kind === "pdf" ? doc.generation
    : locator && "fragment_id" in locator && doc.kind === "text"
      ? sourceUnits(doc, mediaId, locator.media_id).find(entry => entry.fragment === locator.fragment_id)?.generation ?? null : null;
  if (publication?.kind === "reader" && capturedGeneration !== null && publication.generation === capturedGeneration &&
      locator && (locator.type === "web_text_offsets" || locator.type === "epub_fragment_offsets" || locator.type === "pdf_page_geometry")) {
    const placed = placeSelection(doc, mediaId, { locator, publication, quote_exact,
      prefix: passage.prefix, suffix: passage.suffix, passage_ref: `passage_anchor:${passage.anchor_id}` });
    if (placed?.kind === "placed") {
      const anchor = placed.anchor;
      return { target: anchor.kind === "text" ? { kind: "range", unit: anchor.unit, start: anchor.start, end: anchor.end }
        : { kind: "quads", page: anchor.page, quads: anchor.quads },
        inspection: { identity: doc.identity, anchors: [anchor], pages: [], precision: "exact" } };
    }
  }
  if (doc.kind !== "text") return null;
  const units = doc.units.filter(unit => {
    const owner = ownerOf(doc, mediaId, unit);
    return owner !== null && (ownReading && source === passage.source_ref || mediaRef(owner.mediaId) === source);
  });
  const scanner = new ScopeQuoteScanner(passage.normalized_exact, passage.prefix, passage.suffix);
  for (const unit of units) {
    const normalized = normalizeScopeText(unit.text);
    scanner.add({ fragment_id: unit.id, start_offset: 0, normalized_text: normalized.normalized_text,
      normalized_start_offset: 0, edits: normalized.edits, start_cut: unit.sourceStartOffset > 0, end_cut: doc.part !== null });
    if (scanner.ambiguous) return null;
  }
  const match = scanner.result;
  if (!match) return null;
  const unit = units.find(unit => unit.id === match.fragment_id)!;
  if (normalizeQuote(chars(unit.text).slice(match.start_offset, match.end_offset).join("")) !== passage.normalized_exact) return null;
  const anchor = { kind: "text" as const, unit: unit.id, start: match.start_offset, end: match.end_offset };
  return { target: { kind: "range", unit: anchor.unit, start: anchor.start, end: anchor.end },
    inspection: { identity: doc.identity, anchors: [anchor], pages: [], precision: "exact" } };
}

interface Loaded {
  readonly ref: string;
  readonly sourceRef: string;
  readonly color: HighlightColor;
  readonly selection: SelectionCapture;
  readonly notes: readonly AttachedNote[];
}

async function readAll(store: AuthoredStore, query: (cursor: string | null) => Parameters<AuthoredStore["query"]>[0]): Promise<QueryResult["rows"]> {
  const rows: QueryResult["rows"] = [];
  for (let cursor: string | null = null; ;) {
    const page: QueryResult = await store.query(query(cursor));
    rows.push(...page.rows);
    if (page.next_cursor === null) return rows;
    cursor = page.next_cursor;
  }
}

const endpointPosition = (link: LinkState, ref: string) => (link.endpoint_a === ref ? link.position_a : link.position_b)?.value ?? "";

/** One account's annotations for one reader occurrence; re-reads whenever local state commits. */
export function createReaderAnnotations(store: AuthoredStore, mediaId: string) {
  let doc: ReaderDocument | null = null;
  let bound = false;
  let sources: string[] = [];
  let loaded: readonly Loaded[] = [];
  let state: AnnotationsState = { status: "loading", error: null, annotations: [], marks: [] };
  const listeners = new Set<() => void>();
  let triggers: (() => void)[] = [];
  let reading: Promise<void> | null = null;
  let again = false;
  let generation = 0;

  function project() {
    const annotations: ReaderAnnotation[] = [];
    for (const entry of loaded) {
      const placement = doc === null ? { kind: "unavailable" as const } : placeSelection(doc, mediaId, entry.selection);
      if (placement) annotations.push({ id: entry.ref.slice("highlight:".length), ...entry, placement });
    }
    const order = (annotation: ReaderAnnotation): [number, number, number] => {
      if (annotation.placement.kind !== "placed") return [Infinity, 0, 0];
      const anchor = annotation.placement.anchor;
      if (anchor.kind === "pdf") return [anchor.page, Math.min(...anchor.quads.map(quad => quad.y1)), Math.min(...anchor.quads.map(quad => quad.x1))];
      const index = doc?.kind === "text" ? doc.units.findIndex(unit => unit.id === anchor.unit) : 0;
      return [index, anchor.start, anchor.end];
    };
    annotations.sort((a, b) => {
      const x = order(a), y = order(b);
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
    });
    const size = (anchor: MarkAnchor) => anchor.kind === "text" ? anchor.end - anchor.start
      : anchor.quads.reduce((sum, quad) => sum + Math.abs((quad.x2 - quad.x1) * (quad.y3 - quad.y1)), 0);
    const marks = annotations.flatMap(annotation => annotation.placement.kind === "placed"
      ? [{ id: annotation.id, color: annotation.color, anchor: annotation.placement.anchor }] : [])
      .sort((a, b) => size(a.anchor) - size(b.anchor) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    state = { ...state, annotations, marks };
    for (const listener of listeners) listener();
  }

  async function read(current: number) {
    const next: Loaded[] = [];
    for (const source of sources) {
      const [highlights, attached] = await Promise.all([
        readAll(store, cursor => ({ kind: "annotations", source_ref: source, cursor, limit: PAGE })),
        readAll(store, cursor => ({ kind: "annotation_notes", source_ref: source, cursor, limit: PAGE })),
      ]);
      // attached notes arrive ordered by highlight, then that highlight's endpoint position.
      const notes = new Map<string, AttachedNote[]>();
      for (const { resource: note, link } of attached) {
        if (!link) continue;
        const highlight = link.endpoint_a === note.ref ? link.endpoint_b : link.endpoint_a;
        notes.set(highlight, [...notes.get(highlight) ?? [], { ref: note.ref, linkId: link.link_id, position: endpointPosition(link, highlight) }]);
      }
      for (const { resource } of highlights) {
        if (resource.kind !== "highlight" || resource.selection === null || resource.color === null) continue;
        next.push({ ref: resource.ref, sourceRef: source, color: resource.color, selection: resource.selection, notes: notes.get(resource.ref) ?? [] });
      }
    }
    if (current !== generation) return;
    loaded = next;
    state = { ...state, status: "ready", error: null };
    project();
  }

  function refresh() {
    if (reading) { again = true; return; }
    const current = generation;
    reading = read(current).catch(error => {
      if (current !== generation) return;
      state = { ...state, status: "failed", error };
      for (const listener of listeners) listener();
    }).finally(() => {
      reading = null;
      if (again && listeners.size) { again = false; refresh(); }
    });
  }

  function connect() {
    for (const stop of triggers) stop();
    generation++;
    again = false;
    triggers = sources.map(source => store.subscribe({ kind: "annotations", source_ref: source, cursor: null, limit: 1 }, refresh));
    refresh();
  }

  return {
    /** null: the source text is unavailable on this device; annotations still list. */
    bind(next: ReaderDocument | null) {
      if (bound && next === doc) return;
      bound = true;
      doc = next;
      // losing the text keeps the sources it named (a part's source, a thread's owners).
      const wanted = next === null && sources.length ? sources : annotationSources(doc, mediaId);
      if (wanted.join() === sources.join()) { project(); return; }
      sources = wanted;
      if (listeners.size) connect();
    },
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1 && bound) connect();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        for (const stop of triggers) stop();
        triggers = [];
        generation++;
      };
    },
    retry: refresh,
    annotation: (id: string) => state.annotations.find(annotation => annotation.id === id) ?? null,
  };
}
export type ReaderAnnotations = ReturnType<typeof createReaderAnnotations>;

/** The selection bound to its passage: a known semantic binding wins; an unseen key mints its one id. */
async function boundCapture(store: AuthoredStore, accountId: string, capture: Capture): Promise<{ selection: SelectionCapture; intents: Intent[] }> {
  if (!capture.passage) return { selection: capture.selection, intents: [] };
  const { normalized_exact, prefix, suffix, source_ref } = capture.passage;
  const bound = await store.query({ kind: "binding", key: { kind: "passage", source_ref, normalized_exact, prefix, suffix } });
  const anchor = bound.binding_id ?? passageId(accountId, source_ref, await passageKey(normalized_exact, prefix, suffix));
  const selection = { ...capture.selection, passage_ref: `passage_anchor:${anchor}` };
  return { selection, intents: [{ kind: "capture_passage", anchor_id: anchor, source_ref, normalized_exact, prefix, suffix,
    capture: { quote_exact: selection.quote_exact, publication: selection.publication, locator: selection.locator } }] };
}

/** An independent note appended after the highlight's notes, with its first link. */
async function noteIntents(runtime: WritingRuntime, highlight: string, body: NoteBody): Promise<Intent[]> {
  const ref = `note_block:${crypto.randomUUID()}`;
  const initializer = createNoteIntent(ref, body);
  const link = await prepareLink(runtime, { source_ref: highlight, target_ref: ref, source_label: null, target_label: null, after: null });
  return [initializer, ...link.intents];
}

/** Commits one new highlight, its passage, its source stub and an optional first note atomically. */
export async function createHighlight(runtime: WritingRuntime, input: {
  /** Minted by the caller so a retried local commit keeps the same highlight. */
  readonly id: string;
  readonly capture: Capture;
  readonly color: HighlightColor;
  /** The literal label this host knows for the capture's source, if any. */
  readonly source: SourceLabel | null;
  readonly note: NoteBody | null;
}): Promise<LocalCommit> {
  const store = await runtime.store;
  const { account_id } = await store.readReplica();
  const ref = highlightRef(input.id);
  const { sourceRef } = input.capture;
  const passage = await boundCapture(store, account_id, input.capture);
  const intents: Intent[] = [...passage.intents];
  // a known label refreshes the stub; an unknown source keeps its stub, or gets its ref as a truthful label.
  const known = input.source !== null || (await store.query({ kind: "resource", ref: sourceRef })).rows.length > 0;
  if (input.source || !known) intents.push({ kind: "capture_source", source_ref: sourceRef,
    capture: { kind: input.source?.kind ?? "media", label: input.source?.label ?? sourceRef, publication: passage.selection.publication } });
  intents.push({ kind: "create_highlight", ref, source_ref: sourceRef, selection: passage.selection, color: input.color });
  if (input.note) intents.push(...await noteIntents(runtime, ref, input.note));
  return runtime.run({ kind: "batch", intents });
}

/** A new independent note after the highlight's current notes. */
export async function attachNote(runtime: WritingRuntime, annotation: ReaderAnnotation, body: NoteBody): Promise<LocalCommit> {
  return runtime.run({ kind: "batch", intents: await noteIntents(runtime, annotation.ref, body) });
}

export function recolorHighlight(runtime: WritingRuntime, annotation: ReaderAnnotation, color: HighlightColor): Promise<LocalCommit> {
  return runtime.run({ kind: "update_highlight", ref: annotation.ref, selection: null, color });
}

/** Publication, extent, quote, context and passage move together; identity, colour and notes stay. */
export async function resizeHighlight(runtime: WritingRuntime, annotation: ReaderAnnotation, capture: Capture): Promise<LocalCommit> {
  if (capture.sourceRef !== annotation.sourceRef) throw new Error("a highlight keeps its source");
  const store = await runtime.store;
  const passage = await boundCapture(store, (await store.readReplica()).account_id, capture);
  return runtime.run({ kind: "batch", intents: [...passage.intents, { kind: "update_highlight", ref: annotation.ref, selection: passage.selection, color: null }] });
}
