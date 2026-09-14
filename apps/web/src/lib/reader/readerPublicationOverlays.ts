import { HIGHLIGHT_COLORS, type HighlightColor } from "@/lib/highlights/segmenter";
import { decodePdfHighlightQuad, type PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import { decodeDocumentEmbeds, type DocumentEmbed } from "@/lib/media/documentEmbeds";
import { EDGE_KINDS, EDGE_ORIGINS, type EdgeKind, type EdgeOrigin } from "@/lib/resourceGraph/connections";
import { decodeSnakeCaseResourceActivation, type ResourceActivation } from "@/lib/resources/activation";
import { decodeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { expectArray, expectBoolean, expectCanonicalUuid, expectExactRecord, expectIsoInstant, expectNonnegativeInteger, expectNonemptyString, expectNullableString, expectOneOf, expectRecord, expectString } from "@/lib/validation";
import { READER_APPARATUS_CONFIDENCES, READER_APPARATUS_KINDS, READER_APPARATUS_RELATIONS, type ReaderApparatusConfidence, type ReaderApparatusKind, type ReaderApparatusRelation } from "./apparatusContract";
import { decodeReaderPublicationSourceRange, type ReaderPublicationSourceRange } from "./publicationContract";
import { readPublicationQuery } from "./publicationTransport";
import type { PdfHighlightPaint } from "./ReaderDecorations";
import type { ReaderMedia } from "./ReaderDocumentSource";
import type { ReaderEvidenceCounts, ReaderEvidenceFactKind } from "./documentMap";

export type { ReaderEvidenceCounts, ReaderEvidenceFactKind } from "./documentMap";

type ReaderPublicationEvidencePosition =
  | { readonly kind: "Text"; readonly range: ReaderPublicationSourceRange }
  | { readonly kind: "Pdf"; readonly page: number }
  | { readonly kind: "Document" }
  | { readonly kind: "Unavailable"; readonly reason: "Missing" | "Unanchorable" | "Stale" | "SourceUnverified" };

interface EvidenceRelatedBase {
  readonly ref: string;
  readonly label_excerpt: string;
  readonly label_codepoints: number;
  readonly excerpt: string | null;
  readonly excerpt_codepoints: number | null;
  readonly activation: ResourceActivation;
}

export type ReaderPublicationEvidenceObject = EvidenceRelatedBase & (
  | { readonly kind: "Chat"; readonly conversation_id: string; readonly message_ref: string | null }
  | { readonly kind: "Note"; readonly note_block_id: string }
  | { readonly kind: "Dossier" | "Oracle" | "Media" | "Other" }
);

interface EvidenceFactBase {
  readonly id: string;
  readonly locus_ref: string;
  readonly label_excerpt: string;
  readonly label_codepoints: number;
  readonly excerpt: string | null;
  readonly excerpt_codepoints: number | null;
  readonly position: ReaderPublicationEvidencePosition;
  readonly association_count: number;
  readonly also_reference_count: number;
}

export type ReaderPublicationEvidenceFact = EvidenceFactBase & (
  | { readonly kind: "Highlight"; readonly highlight_id: string; readonly color: HighlightColor; readonly created_at: string; readonly updated_at: string; readonly author_user_id: string; readonly is_owner: boolean }
  | { readonly kind: "SourceReference"; readonly item_id: string; readonly stable_key: string; readonly apparatus_kind: ReaderApparatusKind; readonly confidence: ReaderApparatusConfidence; readonly target_count: number }
  | { readonly kind: "GeneratedCitation"; readonly edge_id: string; readonly role: EdgeKind }
  | { readonly kind: "Link"; readonly edge_id: string; readonly role: EdgeKind; readonly origin: EdgeOrigin; readonly object: ReaderPublicationEvidenceObject }
  | { readonly kind: "Synapse"; readonly edge_id: string; readonly role: EdgeKind; readonly object: ReaderPublicationEvidenceObject }
);

export interface ReaderPublicationEvidenceFactsPage {
  readonly items: readonly ReaderPublicationEvidenceFact[];
  readonly counts: ReaderEvidenceCounts;
  readonly next_cursor: string | null;
}

type ReaderPublicationEvidenceAssociation =
  | { readonly relationship: "AuthoredIn" | "AlsoReferences"; readonly object: ReaderPublicationEvidenceObject }
  | { readonly relationship: "DirectlyAttached"; readonly edge_id: string; readonly role: EdgeKind; readonly origin: EdgeOrigin; readonly direction: "Outgoing" | "Incoming"; readonly object: ReaderPublicationEvidenceObject };

export interface ReaderPublicationEvidenceAssociationsPage {
  readonly items: readonly ReaderPublicationEvidenceAssociation[];
  readonly next_cursor: string | null;
}

type ReaderPublicationEvidenceWindow =
  | { readonly kind: "Unit"; readonly unit_key: string }
  | { readonly kind: "PdfPage"; readonly page: number }
  | { readonly kind: "Bucket"; readonly index: number; readonly bucket_count: number };

export interface ReaderPublicationEvidenceFactsRequest {
  readonly scope: "Passages" | "Document";
  readonly kinds: readonly ReaderEvidenceFactKind[];
  readonly window: ReaderPublicationEvidenceWindow | null;
  readonly after: string | null;
  readonly limit: number;
}

export interface ReaderPublicationEvidenceSeekRequest {
  readonly target: { readonly kind: "Fact"; readonly fact_id: string } | { readonly kind: "SourceReference"; readonly stable_key: string };
  readonly scope: "Passages" | "Document";
  readonly kinds: readonly ReaderEvidenceFactKind[];
  readonly limit: number;
}

export interface ReaderPublicationEvidenceAssociationsRequest {
  readonly target: { readonly kind: "Fact"; readonly fact_id: string } | { readonly kind: "Locus"; readonly locus_ref: string };
  readonly after: string | null;
  readonly limit: number;
}

function evidenceExcerpt(raw: unknown, count: unknown, name: string): { excerpt: string; count: number } {
  const excerpt = expectString(raw, name);
  const codepoints = expectNonnegativeInteger(count, `${name} codepoints`);
  let length = 0;
  for (const _point of excerpt) length += 1;
  if (length !== Math.min(codepoints, 300)) throw new TypeError(`${name} differs from its display length`);
  return { excerpt, count: codepoints };
}

function evidenceDisplay(row: Record<string, unknown>) {
  const label = evidenceExcerpt(row.label_excerpt, row.label_codepoints, "Evidence label");
  const excerpt = row.excerpt === null && row.excerpt_codepoints === null ? null : evidenceExcerpt(row.excerpt, row.excerpt_codepoints, "Evidence excerpt");
  return { label_excerpt: label.excerpt, label_codepoints: label.count, excerpt: excerpt?.excerpt ?? null, excerpt_codepoints: excerpt?.count ?? null };
}

function decodeReaderPublicationEvidencePosition(raw: unknown): ReaderPublicationEvidencePosition {
  const row = expectRecord(raw, "Evidence position");
  switch (row.kind) {
    case "Text":
      expectExactRecord(row, ["kind", "range"], "Evidence text position");
      return { kind: "Text", range: decodeReaderPublicationSourceRange(row.range) };
    case "Pdf": {
      expectExactRecord(row, ["kind", "page"], "Evidence PDF position");
      const page = expectNonnegativeInteger(row.page, "Evidence PDF page");
      if (page === 0) throw new TypeError("Evidence PDF page must be positive");
      return { kind: "Pdf", page };
    }
    case "Document":
      expectExactRecord(row, ["kind"], "Evidence document position");
      return { kind: "Document" };
    case "Unavailable":
      expectExactRecord(row, ["kind", "reason"], "Evidence unavailable position");
      return { kind: "Unavailable", reason: expectOneOf(row.reason, ["Missing", "Unanchorable", "Stale", "SourceUnverified"] as const, "Evidence unavailable reason") };
    default: throw new TypeError("Unknown evidence position");
  }
}

export function decodeReaderPublicationEvidenceObject(raw: unknown): ReaderPublicationEvidenceObject {
  const row = expectRecord(raw, "Evidence related object");
  const fields = ["kind", "ref", "label_excerpt", "label_codepoints", "excerpt", "excerpt_codepoints", "activation"];
  const ref = decodeResourceActionSubject({ ref: row.ref }, "Evidence resource").ref;
  const activation = decodeSnakeCaseResourceActivation(row.activation);
  if (activation.resourceRef !== ref) throw new TypeError("Evidence activation changed its resource");
  const base = { ...evidenceDisplay(row), ref, activation };
  switch (row.kind) {
    case "Chat":
      expectExactRecord(row, [...fields, "conversation_id", "message_ref"], "Evidence chat");
      return { ...base, kind: "Chat", conversation_id: expectCanonicalUuid(row.conversation_id, "Evidence conversation"), message_ref: expectNullableString(row.message_ref, "Evidence message") };
    case "Note":
      expectExactRecord(row, [...fields, "note_block_id"], "Evidence note");
      return { ...base, kind: "Note", note_block_id: expectCanonicalUuid(row.note_block_id, "Evidence note block") };
    case "Dossier": case "Oracle": case "Media": case "Other":
      expectExactRecord(row, fields, "Evidence object");
      return { ...base, kind: row.kind };
    default: throw new TypeError("Unknown evidence object kind");
  }
}

function decodeReaderPublicationEvidenceFact(raw: unknown): ReaderPublicationEvidenceFact {
  const row = expectRecord(raw, "Evidence fact");
  const fields = ["kind", "id", "locus_ref", "label_excerpt", "label_codepoints", "excerpt", "excerpt_codepoints", "position", "association_count", "also_reference_count"];
  const base = { ...evidenceDisplay(row), id: expectNonemptyString(row.id, "Evidence fact id"), locus_ref: decodeResourceActionSubject({ ref: row.locus_ref }, "Evidence locus").ref,
    position: decodeReaderPublicationEvidencePosition(row.position), association_count: expectNonnegativeInteger(row.association_count, "Evidence associations"), also_reference_count: expectNonnegativeInteger(row.also_reference_count, "Evidence other references") };
  switch (row.kind) {
    case "Highlight":
      expectExactRecord(row, [...fields, "highlight_id", "color", "created_at", "updated_at", "author_user_id", "is_owner"], "Evidence highlight");
      return { ...base, kind: "Highlight", highlight_id: expectCanonicalUuid(row.highlight_id, "Evidence highlight id"), color: expectOneOf(row.color, HIGHLIGHT_COLORS, "Evidence color"), created_at: expectIsoInstant(row.created_at, "Evidence creation"), updated_at: expectIsoInstant(row.updated_at, "Evidence update"), author_user_id: expectCanonicalUuid(row.author_user_id, "Evidence author"), is_owner: expectBoolean(row.is_owner, "Evidence ownership") };
    case "SourceReference":
      expectExactRecord(row, [...fields, "item_id", "stable_key", "apparatus_kind", "confidence", "target_count"], "Evidence source");
      return { ...base, kind: "SourceReference", item_id: expectCanonicalUuid(row.item_id, "Evidence source id"), stable_key: expectNonemptyString(row.stable_key, "Evidence source marker"), apparatus_kind: expectOneOf(row.apparatus_kind, READER_APPARATUS_KINDS, "Evidence source kind"), confidence: expectOneOf(row.confidence, READER_APPARATUS_CONFIDENCES, "Evidence source confidence"), target_count: expectNonnegativeInteger(row.target_count, "Evidence target count") };
    case "GeneratedCitation":
      expectExactRecord(row, [...fields, "edge_id", "role"], "Evidence citation");
      return { ...base, kind: "GeneratedCitation", edge_id: expectCanonicalUuid(row.edge_id, "Evidence edge"), role: expectOneOf(row.role, EDGE_KINDS, "Evidence role") };
    case "Link":
      expectExactRecord(row, [...fields, "edge_id", "role", "origin", "object"], "Evidence link");
      return { ...base, kind: "Link", edge_id: expectCanonicalUuid(row.edge_id, "Evidence edge"), role: expectOneOf(row.role, EDGE_KINDS, "Evidence role"), origin: expectOneOf(row.origin, EDGE_ORIGINS, "Evidence origin"), object: decodeReaderPublicationEvidenceObject(row.object) };
    case "Synapse":
      expectExactRecord(row, [...fields, "edge_id", "role", "object"], "Evidence synapse");
      return { ...base, kind: "Synapse", edge_id: expectCanonicalUuid(row.edge_id, "Evidence edge"), role: expectOneOf(row.role, EDGE_KINDS, "Evidence role"), object: decodeReaderPublicationEvidenceObject(row.object) };
    default: throw new TypeError("Unknown evidence fact kind");
  }
}

export function decodeReaderPublicationEvidenceFactsPage(raw: unknown): ReaderPublicationEvidenceFactsPage {
  const row = expectExactRecord(raw, ["items", "counts", "next_cursor"], "Evidence page");
  const counts = expectExactRecord(row.counts, ["highlights", "citations", "links", "synapses", "passages", "document"], "Evidence counts");
  const items = expectArray(row.items, decodeReaderPublicationEvidenceFact, "Evidence facts");
  const next = expectNullableString(row.next_cursor, "Evidence continuation");
  if (items.length > 100 || new Set(items.map((item) => item.id)).size !== items.length || (items.length === 0 && next !== null)) throw new TypeError("Invalid evidence page row set");
  return { items, next_cursor: next, counts: {
    highlights: expectNonnegativeInteger(counts.highlights, "Highlight count"), citations: expectNonnegativeInteger(counts.citations, "Citation count"), links: expectNonnegativeInteger(counts.links, "Link count"), synapses: expectNonnegativeInteger(counts.synapses, "Synapse count"), passages: expectNonnegativeInteger(counts.passages, "Passage count"), document: expectNonnegativeInteger(counts.document, "Document count"),
  } };
}

export function decodeReaderPublicationEvidenceAssociationsPage(raw: unknown): ReaderPublicationEvidenceAssociationsPage {
  const row = expectExactRecord(raw, ["items", "next_cursor"], "Evidence associations page");
  const items = expectArray(row.items, (rawItem): ReaderPublicationEvidenceAssociation => {
    const item = expectRecord(rawItem, "Evidence association");
    const object = decodeReaderPublicationEvidenceObject(item.object);
    if (item.relationship === "AuthoredIn" || item.relationship === "AlsoReferences") {
      expectExactRecord(item, ["relationship", "object"], "Evidence association");
      return { relationship: item.relationship, object };
    }
    expectExactRecord(item, ["relationship", "edge_id", "role", "origin", "direction", "object"], "Evidence direct association");
    return { relationship: expectOneOf(item.relationship, ["DirectlyAttached"] as const, "Evidence relationship"), object,
      edge_id: expectCanonicalUuid(item.edge_id, "Evidence association edge"), role: expectOneOf(item.role, EDGE_KINDS, "Evidence association role"), origin: expectOneOf(item.origin, EDGE_ORIGINS, "Evidence association origin"), direction: expectOneOf(item.direction, ["Outgoing", "Incoming"] as const, "Evidence association direction") };
  }, "Evidence associations");
  const next = expectNullableString(row.next_cursor, "Evidence association continuation");
  if (items.length > 100 || (items.length === 0 && next !== null)) throw new TypeError("Invalid evidence association page");
  return { items, next_cursor: next };
}

export function readReaderPublicationEvidenceFacts(descriptor: ReaderMedia, request: ReaderPublicationEvidenceFactsRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationEvidenceFactsPage> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/evidence`, body: request, signal, maxBytes,
    decode: (raw) => decodeReaderPublicationEvidenceFactsPage(expectExactRecord(raw, ["data"], "Evidence response").data) });
}

export function readReaderPublicationEvidenceSeek(descriptor: ReaderMedia, request: ReaderPublicationEvidenceSeekRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationEvidenceFactsPage> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/evidence/seek`, body: request, signal, maxBytes,
    decode: (raw) => {
      const page = decodeReaderPublicationEvidenceFactsPage(expectExactRecord(raw, ["data"], "Evidence seek response").data);
      if (request.target.kind === "Fact" ? page.items[0]?.id !== request.target.fact_id : page.items[0]?.kind !== "SourceReference") throw new TypeError("Evidence seek changed its selected fact");
      return page;
    } });
}

export function readReaderPublicationEvidenceAssociations(descriptor: ReaderMedia, request: ReaderPublicationEvidenceAssociationsRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationEvidenceAssociationsPage> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/evidence/associations`, body: request, signal, maxBytes,
    decode: (raw) => decodeReaderPublicationEvidenceAssociationsPage(expectExactRecord(raw, ["data"], "Evidence associations response").data) });
}

/** Paint facts are intentionally distinct from the authored highlight detail. */
export interface ReaderPublicationHighlightPaint {
  readonly id: string;
  readonly color: HighlightColor;
  readonly start_offset: number;
  readonly end_offset: number;
  readonly created_at: string;
  readonly author_user_id: string;
  readonly is_owner: boolean;
}

export interface ReaderPublicationEmbedsPage {
  readonly items: readonly DocumentEmbed[];
  readonly next_ordinal: number | null;
}

export interface ReaderPublicationHighlightsPage {
  readonly items: readonly ReaderPublicationHighlightPaint[];
  readonly next_cursor: string | null;
}

export interface ReaderPublicationEmbedsRequest {
  readonly unit_key: string;
  readonly after_ordinal: number | null;
}

/** Shared by every paged highlight query: unit paint and PDF page paint. */
export interface ReaderPublicationPagedHighlightsRequest {
  readonly mine_only: boolean;
  readonly after: string | null;
  readonly limit: number;
}

export interface ReaderPublicationHighlightsRequest extends ReaderPublicationPagedHighlightsRequest {
  readonly unit_key: string;
}

export interface ReaderPublicationApparatusRequest {
  readonly after: string | null;
  readonly limit: number;
}

export interface ReaderPublicationApparatusSummary {
  readonly id: string;
  readonly stable_key: string;
  readonly kind: ReaderApparatusKind;
  readonly confidence: ReaderApparatusConfidence;
  readonly label_excerpt: string | null;
  readonly label_codepoints: number | null;
  readonly label_source_id: string | null;
  readonly body_excerpt: string | null;
  readonly body_codepoints: number | null;
  readonly body_source_id: string | null;
  readonly has_targets: boolean;
  readonly source_range: ReaderPublicationSourceRange | null;
  readonly pdf_page: number | null;
}

export interface ReaderPublicationApparatusPage {
  readonly items: readonly ReaderPublicationApparatusSummary[];
  readonly next_cursor: string | null;
}

interface ReaderPublicationApparatusTarget {
  readonly edge_id: string;
  readonly relation: ReaderApparatusRelation;
  readonly confidence: ReaderApparatusConfidence;
  readonly target: ReaderPublicationApparatusSummary;
}

export interface ReaderPublicationApparatusTargetsPage {
  readonly items: readonly ReaderPublicationApparatusTarget[];
  readonly next_cursor: string | null;
}

export interface ReaderPublicationApparatusTextRequest {
  readonly field: "Body" | "Label";
  readonly offset_cp: number;
}

export interface ReaderPublicationApparatusTextPage extends ReaderPublicationApparatusTextRequest {
  readonly text: string;
  readonly total_codepoints: number;
  readonly next_offset_cp: number | null;
}

export type ReaderPublicationApparatusLocation =
  | { readonly kind: "Text"; readonly range: ReaderPublicationSourceRange }
  | { readonly kind: "Pdf"; readonly page: number; readonly quads: readonly PdfHighlightQuad[] }
  | { readonly kind: "Unavailable" };

function decodeApparatusExcerpt(raw: unknown, codepoints: unknown, sourceId: unknown, name: string): { excerpt: string | null; count: number | null; sourceId: string | null } {
  if (raw === null && codepoints === null && sourceId === null) return { excerpt: null, count: null, sourceId: null };
  const excerpt = expectString(raw, `${name} excerpt`);
  const count = expectNonnegativeInteger(codepoints, `${name} codepoints`);
  let length = 0;
  for (const _point of excerpt) length += 1;
  if (count === 0 || length !== Math.min(count, 300)) throw new TypeError(`${name} excerpt differs from its source length contract`);
  return { excerpt, count, sourceId: expectCanonicalUuid(sourceId, `${name} source`) };
}

export function decodeReaderPublicationApparatusSummary(raw: unknown): ReaderPublicationApparatusSummary {
  const row = expectExactRecord(raw, ["id", "stable_key", "kind", "confidence", "label_excerpt", "label_codepoints", "label_source_id", "body_excerpt", "body_codepoints", "body_source_id", "has_targets", "source_range", "pdf_page"], "Reader apparatus summary");
  const label = decodeApparatusExcerpt(row.label_excerpt, row.label_codepoints, row.label_source_id, "Apparatus label");
  const body = decodeApparatusExcerpt(row.body_excerpt, row.body_codepoints, row.body_source_id, "Apparatus body");
  const range = row.source_range === null ? null : decodeReaderPublicationSourceRange(row.source_range);
  const page = row.pdf_page === null ? null : expectNonnegativeInteger(row.pdf_page, "Apparatus PDF page");
  if (page === 0 || (page !== null && range !== null)) throw new TypeError("Apparatus position has incompatible coordinate kinds");
  return {
    id: expectCanonicalUuid(row.id, "Apparatus item ID"), stable_key: expectNonemptyString(row.stable_key, "Apparatus marker key"), kind: expectOneOf(row.kind, READER_APPARATUS_KINDS, "Apparatus kind"),
    confidence: expectOneOf(row.confidence, READER_APPARATUS_CONFIDENCES, "Apparatus confidence"),
    label_excerpt: label.excerpt, label_codepoints: label.count, label_source_id: label.sourceId,
    body_excerpt: body.excerpt, body_codepoints: body.count, body_source_id: body.sourceId,
    has_targets: expectBoolean(row.has_targets, "Apparatus targets"), source_range: range, pdf_page: page,
  };
}

export function decodeReaderPublicationApparatusPage(raw: unknown): ReaderPublicationApparatusPage {
  const row = expectExactRecord(raw, ["items", "next_cursor"], "Reader apparatus page");
  const items = expectArray(row.items, decodeReaderPublicationApparatusSummary, "Reader apparatus items");
  const next = expectNullableString(row.next_cursor, "Reader apparatus continuation");
  if (items.length > 100 || new Set(items.map((item) => item.id)).size !== items.length || (items.length === 0 && next !== null)) throw new TypeError("Reader apparatus page has an invalid row set");
  return { items, next_cursor: next };
}

export function decodeReaderPublicationApparatusTargetsPage(raw: unknown): ReaderPublicationApparatusTargetsPage {
  const row = expectExactRecord(raw, ["items", "next_cursor"], "Reader apparatus targets page");
  const items = expectArray(row.items, (raw) => {
    const value = expectExactRecord(raw, ["edge_id", "relation", "confidence", "target"], "Reader apparatus target");
    return { edge_id: expectCanonicalUuid(value.edge_id, "Apparatus edge ID"),
      relation: expectOneOf(value.relation, READER_APPARATUS_RELATIONS, "Apparatus relation"),
      confidence: expectOneOf(value.confidence, READER_APPARATUS_CONFIDENCES, "Apparatus edge confidence"),
      target: decodeReaderPublicationApparatusSummary(value.target) };
  }, "Reader apparatus targets");
  const next = expectNullableString(row.next_cursor, "Reader apparatus target continuation");
  if (items.length > 100 || new Set(items.map((item) => item.target.id)).size !== items.length || (items.length === 0 && next !== null)) throw new TypeError("Reader apparatus target page has an invalid row set");
  return { items, next_cursor: next };
}

export function decodeReaderPublicationApparatusTextPage(raw: unknown): ReaderPublicationApparatusTextPage {
  const row = expectExactRecord(raw, ["field", "offset_cp", "text", "total_codepoints", "next_offset_cp"], "Reader apparatus text page");
  const field = expectOneOf(row.field, ["Body", "Label"] as const, "Apparatus text field");
  const offset = expectNonnegativeInteger(row.offset_cp, "Apparatus text offset");
  const total = expectNonnegativeInteger(row.total_codepoints, "Apparatus text length");
  const text = expectString(row.text, "Apparatus text");
  const next = row.next_offset_cp === null ? null : expectNonnegativeInteger(row.next_offset_cp, "Apparatus text continuation");
  let length = 0;
  for (const _point of text) length += 1;
  const end = offset + length;
  if (end > total || (next === null ? end !== total : next !== end || end >= total || length === 0)) throw new TypeError("Apparatus text continuation changes source coordinates");
  return { field, offset_cp: offset, text, total_codepoints: total, next_offset_cp: next };
}

export function decodeReaderPublicationApparatusLocation(raw: unknown): ReaderPublicationApparatusLocation {
  const kind = expectOneOf(expectRecord(raw, "Reader apparatus location").kind, ["Text", "Pdf", "Unavailable"] as const, "Apparatus location kind");
  switch (kind) {
    case "Text": {
      const row = expectExactRecord(raw, ["kind", "range"], "Apparatus text location");
      return { kind, range: decodeReaderPublicationSourceRange(row.range) };
    }
    case "Pdf": {
      const row = expectExactRecord(raw, ["kind", "page", "quads"], "Apparatus PDF location");
      const page = expectNonnegativeInteger(row.page, "Apparatus PDF page");
      if (page === 0 || !Array.isArray(row.quads) || row.quads.length < 1 || row.quads.length > 512) throw new TypeError("Apparatus PDF geometry is incomplete");
      return { kind, page, quads: row.quads.map((raw, index) => decodePdfHighlightQuad(raw, `Apparatus quad ${index}`)) };
    }
    case "Unavailable":
      expectExactRecord(raw, ["kind"], "Unavailable apparatus location");
      return { kind };
  }
}

export function decodeReaderPublicationEmbedsPage(raw: unknown): ReaderPublicationEmbedsPage {
  const value = expectExactRecord(raw, ["items", "next_ordinal"], "Reader embed page");
  const items = decodeDocumentEmbeds(value.items, "Reader embed page.items");
  const next = value.next_ordinal === null ? null : expectNonnegativeInteger(value.next_ordinal, "Reader embed continuation");
  let previous = -1;
  const identities = new Set<string>();
  for (const item of items) {
    if (item.ordinal <= previous || identities.has(item.id)) throw new TypeError("Reader embed page repeats or reorders occurrences");
    previous = item.ordinal;
    identities.add(item.id);
  }
  if (next !== null && (items.length === 0 || next !== previous)) throw new TypeError("Reader embed continuation does not address its last occurrence");
  return { items, next_ordinal: next };
}

export function decodeReaderPublicationHighlightsPage(raw: unknown): ReaderPublicationHighlightsPage {
  const value = expectExactRecord(raw, ["items", "next_cursor"], "Reader paint page");
  const items = expectArray(value.items, (raw) => {
    const item = expectExactRecord(raw, ["id", "color", "start_offset", "end_offset", "created_at", "author_user_id", "is_owner"], "Reader highlight paint");
    const start = expectNonnegativeInteger(item.start_offset, "Highlight start");
    const end = expectNonnegativeInteger(item.end_offset, "Highlight end");
    if (end <= start) throw new TypeError("Reader highlight paint has an empty or reversed extent");
    return {
      id: expectCanonicalUuid(item.id, "Highlight ID"),
      color: expectOneOf(item.color, HIGHLIGHT_COLORS, "Highlight color"),
      start_offset: start, end_offset: end,
      created_at: expectIsoInstant(item.created_at, "Highlight creation"),
      author_user_id: expectCanonicalUuid(item.author_user_id, "Highlight author"),
      is_owner: expectBoolean(item.is_owner, "Highlight ownership"),
    };
  }, "Reader highlight paints");
  const next = expectNullableString(value.next_cursor, "Reader paint continuation");
  if (items.length > 100 || new Set(items.map((item) => item.id)).size !== items.length || (items.length === 0 && next !== null)) throw new TypeError("Invalid reader paint page row set");
  return { items, next_cursor: next };
}

/** One attempt after the session reserves read/scratch capacity; no immutable cache. */
export function readReaderPublicationEmbeds(descriptor: ReaderMedia, request: ReaderPublicationEmbedsRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationEmbedsPage> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/embeds`, body: request, signal, maxBytes,
    decode: (raw) => decodeReaderPublicationEmbedsPage(expectExactRecord(raw, ["data"], "Reader embed response").data) });
}

export function readReaderPublicationHighlights(descriptor: ReaderMedia, request: ReaderPublicationHighlightsRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationHighlightsPage> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/highlights`, body: request, signal, maxBytes,
    decode: (raw) => decodeReaderPublicationHighlightsPage(expectExactRecord(raw, ["data"], "Reader paint response").data) });
}

export function readReaderPublicationApparatus(descriptor: ReaderMedia, request: ReaderPublicationApparatusRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationApparatusPage> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/apparatus`, body: request, signal, maxBytes,
    decode: (raw) => decodeReaderPublicationApparatusPage(expectExactRecord(raw, ["data"], "Reader apparatus response").data) });
}

export function lookupReaderPublicationApparatus(descriptor: ReaderMedia, request: { readonly stable_key: string }, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationApparatusSummary> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/apparatus/lookup`, body: request, signal, maxBytes,
    decode: (raw) => {
      const item = decodeReaderPublicationApparatusSummary(expectExactRecord(raw, ["data"], "Reader apparatus lookup response").data);
      if (item.stable_key !== request.stable_key) throw new TypeError("Reader apparatus lookup does not answer its selected marker");
      return item;
    } });
}

export function readReaderPublicationApparatusTargets(descriptor: ReaderMedia, itemId: string, request: ReaderPublicationApparatusRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationApparatusTargetsPage> {
  const id = expectCanonicalUuid(itemId, "Apparatus target owner ID");
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/apparatus/${id}/targets`, body: request, signal, maxBytes,
    decode: (raw) => decodeReaderPublicationApparatusTargetsPage(expectExactRecord(raw, ["data"], "Reader apparatus targets response").data) });
}

export function readReaderPublicationApparatusText(descriptor: ReaderMedia, itemId: string, request: ReaderPublicationApparatusTextRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationApparatusTextPage> {
  const id = expectCanonicalUuid(itemId, "Apparatus text owner ID");
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/apparatus/${id}/text`, body: request, signal, maxBytes,
    decode: (raw) => {
      const page = decodeReaderPublicationApparatusTextPage(expectExactRecord(raw, ["data"], "Reader apparatus text response").data);
      if (page.field !== request.field || page.offset_cp !== request.offset_cp) throw new TypeError("Reader apparatus text does not answer its selected field and offset");
      return page;
    } });
}

export function readReaderPublicationApparatusLocation(descriptor: ReaderMedia, itemId: string, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationApparatusLocation> {
  const id = expectCanonicalUuid(itemId, "Apparatus location owner ID");
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/apparatus/${id}/location`, body: {}, signal, maxBytes,
    decode: (raw) => decodeReaderPublicationApparatusLocation(expectExactRecord(raw, ["data"], "Reader apparatus location response").data) });
}


export interface ReaderPublicationPdfHighlightsRequest extends ReaderPublicationPagedHighlightsRequest {
  readonly page_number: number;
}

export interface ReaderPublicationPdfHighlightsPage {
  readonly page_number: number;
  readonly source_sha256: string;
  readonly highlights: readonly PdfHighlightPaint[];
  readonly next_cursor: string | null;
}

function decodeReaderPublicationPdfHighlightsPage(raw: unknown): ReaderPublicationPdfHighlightsPage {
  const page = expectExactRecord(raw, ["page_number", "source_sha256", "highlights", "next_cursor"], "Reader PDF paint page");
  const pageNumber = expectNonnegativeInteger(page.page_number, "PDF paint page number");
  const digest = expectString(page.source_sha256, "PDF paint source digest");
  if (pageNumber < 1 || !/^[0-9a-f]{64}$/.test(digest)) throw new TypeError("Invalid PDF paint source");
  const seen = new Set<string>();
  const highlights = expectArray(page.highlights, (rawItem) => {
    const row = expectExactRecord(rawItem, ["id", "color", "created_at", "author_user_id", "is_owner", "quads"], "PDF highlight paint");
    const id = expectCanonicalUuid(row.id, "PDF highlight id");
    if (seen.has(id)) throw new TypeError("Duplicate PDF highlight paint");
    seen.add(id);
    const quads = expectArray(row.quads, (quad) => decodePdfHighlightQuad(quad, "PDF highlight quad"), "PDF highlight quads");
    if (quads.length < 1 || quads.length > 512) throw new TypeError("Invalid PDF highlight geometry extent");
    return { id, color: expectOneOf(row.color, HIGHLIGHT_COLORS, "PDF highlight color"),
      created_at: expectIsoInstant(row.created_at, "PDF highlight creation"),
      author_user_id: expectCanonicalUuid(row.author_user_id, "PDF highlight author"),
      is_owner: expectBoolean(row.is_owner, "PDF highlight ownership"), quads };
  }, "PDF highlight paints");
  return { page_number: pageNumber, source_sha256: digest, highlights,
    next_cursor: expectNullableString(page.next_cursor, "PDF paint continuation") };
}

export function readReaderPublicationPdfHighlights(descriptor: ReaderMedia, request: ReaderPublicationPdfHighlightsRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationPdfHighlightsPage> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/pdf-highlights`, body: request, signal, maxBytes,
    decode: (raw) => decodeReaderPublicationPdfHighlightsPage(expectExactRecord(raw, ["data"], "Reader PDF paint response").data) });
}

export interface ReaderPublicationEvidenceLocationRequest { readonly fact_id: string }
type ReaderPublicationEvidenceLocation =
  | Exclude<ReaderPublicationEvidencePosition, { readonly kind: "Pdf" }>
  | { readonly kind: "PdfPage"; readonly page: number; readonly source_sha256: string }
  | { readonly kind: "PdfGeometry"; readonly page: number; readonly source_sha256: string; readonly quads: readonly PdfHighlightQuad[] };
export interface ReaderPublicationEvidenceLocationResponse {
  readonly fact_id: string;
  readonly location: ReaderPublicationEvidenceLocation;
}

export function decodeReaderPublicationEvidenceLocation(raw: unknown): ReaderPublicationEvidenceLocationResponse {
  const response = expectExactRecord(raw, ["fact_id", "location"], "Evidence location response");
  const row = expectRecord(response.location, "Evidence location");
  const fact_id = expectNonemptyString(response.fact_id, "Evidence fact");
  if (row.kind === "PdfPage" || row.kind === "PdfGeometry") {
    expectExactRecord(row, row.kind === "PdfPage" ? ["kind", "page", "source_sha256"] : ["kind", "page", "source_sha256", "quads"], "Evidence PDF location");
    const page = expectNonnegativeInteger(row.page, "Evidence PDF page");
    const source_sha256 = expectString(row.source_sha256, "Evidence PDF source");
    if (page === 0 || !/^[0-9a-f]{64}$/.test(source_sha256)) throw new TypeError("Invalid evidence PDF source");
    if (row.kind === "PdfPage") return { fact_id, location: { kind: "PdfPage", page, source_sha256 } };
    const quads = expectArray(row.quads, (quad) => decodePdfHighlightQuad(quad, "Evidence PDF quad"), "Evidence PDF quads");
    if (!quads.length || quads.length > 512) throw new TypeError("Invalid evidence PDF geometry count");
    return { fact_id, location: { kind: "PdfGeometry", page, source_sha256, quads } };
  }
  const location = decodeReaderPublicationEvidencePosition(row);
  if (location.kind === "Pdf") throw new TypeError("Evidence PDF activation lacks source attestation");
  return { fact_id, location };
}

export function readReaderPublicationEvidenceLocation(descriptor: ReaderMedia, request: ReaderPublicationEvidenceLocationRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationEvidenceLocationResponse> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/evidence/location`, body: request, signal, maxBytes, decode: (raw) => {
    const result = decodeReaderPublicationEvidenceLocation(expectExactRecord(raw, ["data"], "Evidence location envelope").data);
    if (result.fact_id !== request.fact_id) throw new TypeError("Evidence location changed its fact");
    return result;
  } });
}

const READER_PUBLICATION_MARKER_KINDS = ["Contents", "Embed", "Highlight", "SourceReference", "GeneratedCitation", "Link", "Synapse"] as const;
export type ReaderPublicationEvidenceMarkerKind = typeof READER_PUBLICATION_MARKER_KINDS[number];
export interface ReaderPublicationEvidenceMarkerCounts {
  readonly contents: number; readonly embeds: number; readonly highlights: number;
  readonly source_references: number; readonly generated_citations: number;
  readonly links: number; readonly synapses: number;
}
export interface ReaderPublicationEvidenceOverviewRequest {
  readonly bucket_count: number; readonly kinds: readonly ReaderPublicationEvidenceMarkerKind[];
}
export interface ReaderPublicationEvidenceOverview {
  readonly bucket_count: number;
  readonly buckets: readonly { readonly index: number; readonly counts: ReaderPublicationEvidenceMarkerCounts }[];
  readonly unavailable_counts: ReaderPublicationEvidenceMarkerCounts;
}
export interface ReaderPublicationEvidenceBucketRequest extends ReaderPublicationEvidenceOverviewRequest {
  readonly index: number; readonly after: string | null; readonly limit: number;
}
export type ReaderPublicationEvidenceMarkerTarget =
  | { readonly kind: "Fact"; readonly fact_id: string }
  | { readonly kind: "Contents"; readonly section_id: string; readonly unit_key: string }
  | { readonly kind: "Embed"; readonly unit_key: string; readonly id: string; readonly occurrence_key: string; readonly ordinal: number };
export interface ReaderPublicationEvidenceMarker {
  readonly id: string; readonly kind: ReaderPublicationEvidenceMarkerKind;
  readonly item_id: string; readonly position: number; readonly target: ReaderPublicationEvidenceMarkerTarget;
}
export interface ReaderPublicationEvidenceBucketPage {
  readonly items: readonly ReaderPublicationEvidenceMarker[]; readonly next_cursor: string | null;
}

export type ReaderPublicationEvidenceGutterWindow =
  | { readonly kind: "Text"; readonly units: readonly { readonly unit_key: string; readonly ranges: readonly (readonly [number, number])[] }[] }
  | { readonly kind: "Pdf"; readonly pages: readonly { readonly page: number; readonly rect: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } }[] };
export interface ReaderPublicationEvidenceGutterRequest {
  readonly window: ReaderPublicationEvidenceGutterWindow;
  readonly kinds: readonly ReaderEvidenceFactKind[];
  readonly include_stances: boolean;
  readonly after: string | null;
  readonly limit: number;
}
export interface ReaderPublicationEvidenceGutterItem {
  readonly id: string;
  readonly fact_id: string;
  readonly kind: ReaderEvidenceFactKind | "Stance";
  readonly label_excerpt: string;
  readonly label_codepoints: number;
  readonly excerpt: string | null;
  readonly excerpt_codepoints: number | null;
  readonly location: Exclude<ReaderPublicationEvidenceLocation, { readonly kind: "Document" | "Unavailable" }>;
  readonly edge_id: string | null;
  readonly stance: "supports" | "contradicts" | null;
}
export interface ReaderPublicationEvidenceGutterPage {
  readonly items: readonly ReaderPublicationEvidenceGutterItem[];
  readonly total_count: number;
  readonly next_cursor: string | null;
}

export function decodeReaderPublicationEvidenceGutterPage(raw: unknown): ReaderPublicationEvidenceGutterPage {
  const page = expectExactRecord(raw, ["items", "total_count", "next_cursor"], "Reader gutter page");
  const seen = new Set<string>();
  const items = expectArray(page.items, (rawItem): ReaderPublicationEvidenceGutterItem => {
    const row = expectExactRecord(rawItem, ["id", "fact_id", "kind", "label_excerpt", "label_codepoints", "excerpt", "excerpt_codepoints", "location", "edge_id", "stance"], "Reader gutter item");
    const id = expectNonemptyString(row.id, "Reader gutter identity");
    const fact_id = expectNonemptyString(row.fact_id, "Reader gutter fact");
    const kind = expectOneOf(row.kind, ["Highlight", "SourceReference", "GeneratedCitation", "Link", "Synapse", "Stance"] as const, "Reader gutter kind");
    const edge_id = row.edge_id === null ? null : expectCanonicalUuid(row.edge_id, "Reader gutter edge");
    const stance = row.stance === null ? null : expectOneOf(row.stance, ["supports", "contradicts"] as const, "Reader gutter stance");
    if (kind === "Stance" ? edge_id === null || stance === null || id !== `margin:stance:${edge_id}` || !fact_id.startsWith("highlight:") : stance !== null || id !== `margin:${fact_id}` || (kind === "Synapse" ? edge_id === null || fact_id !== `synapse:${edge_id}` : edge_id !== null)) throw new TypeError("Reader gutter occurrence identity mismatch");
    if (seen.has(id)) throw new TypeError("Duplicate reader gutter occurrence");
    seen.add(id);
    const { location } = decodeReaderPublicationEvidenceLocation({ fact_id, location: row.location });
    if (location.kind === "Document" || location.kind === "Unavailable") throw new TypeError("Reader gutter requires an attested source location");
    return { id, fact_id, kind, ...evidenceDisplay(row), location, edge_id, stance };
  }, "Reader gutter items");
  const total_count = expectNonnegativeInteger(page.total_count, "Reader visible occurrence count");
  const next_cursor = expectNullableString(page.next_cursor, "Reader gutter continuation");
  if (items.length > 24 || items.length > total_count || items.length === 0 && next_cursor !== null) throw new TypeError("Invalid reader gutter page extent");
  return { items, total_count, next_cursor };
}

export function readReaderPublicationEvidenceGutter(descriptor: ReaderMedia, request: ReaderPublicationEvidenceGutterRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationEvidenceGutterPage> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/evidence/gutter`, body: request, signal, maxBytes, decode: (raw) => {
    const page = decodeReaderPublicationEvidenceGutterPage(expectExactRecord(raw, ["data"], "Reader gutter response").data);
    if (page.items.some((item) => item.kind === "Stance" ? !request.include_stances : !request.kinds.includes(item.kind))) throw new TypeError("Reader gutter changed its filters");
    return page;
  } });
}

export interface ReaderPublicationEvidenceMarkerPreviewRequest { readonly marker_id: string }
export interface ReaderPublicationEvidenceMarkerPreview {
  readonly marker_id: string;
  readonly kind: ReaderPublicationEvidenceMarkerKind;
  readonly tone: "Neutral" | "Highlight" | "Citation" | "Link" | "Synapse" | "Warning";
  readonly label_excerpt: string;
  readonly label_codepoints: number;
  readonly excerpt: string | null;
  readonly excerpt_codepoints: number | null;
}

export function decodeReaderPublicationEvidenceMarkerPreview(raw: unknown): ReaderPublicationEvidenceMarkerPreview {
  const row = expectExactRecord(raw, ["marker_id", "kind", "tone", "label_excerpt", "label_codepoints", "excerpt", "excerpt_codepoints"], "Evidence marker preview");
  const marker_id = expectNonemptyString(row.marker_id, "Evidence marker id");
  const kind = expectOneOf(row.kind, READER_PUBLICATION_MARKER_KINDS, "Evidence marker kind");
  if (!marker_id.startsWith(`marker:${kind}:`) || marker_id.length === `marker:${kind}:`.length) throw new TypeError("Evidence marker preview identity mismatch");
  const tone = expectOneOf(row.tone, ["Neutral", "Highlight", "Citation", "Link", "Synapse", "Warning"] as const, "Evidence marker tone");
  return { marker_id, kind, tone, ...evidenceDisplay(row) };
}

export function readReaderPublicationEvidenceMarkerPreview(descriptor: ReaderMedia, request: ReaderPublicationEvidenceMarkerPreviewRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationEvidenceMarkerPreview> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/evidence/overview/preview`, body: request, signal, maxBytes, decode: (raw) => {
    const result = decodeReaderPublicationEvidenceMarkerPreview(expectExactRecord(raw, ["data"], "Evidence marker preview response").data);
    if (result.marker_id !== request.marker_id) throw new TypeError("Evidence marker preview changed its target");
    return result;
  } });
}

function decodeEvidenceMarkerCounts(raw: unknown): ReaderPublicationEvidenceMarkerCounts {
  const row = expectExactRecord(raw, ["contents", "embeds", "highlights", "source_references", "generated_citations", "links", "synapses"], "Evidence marker counts");
  return { contents: expectNonnegativeInteger(row.contents, "Contents markers"), embeds: expectNonnegativeInteger(row.embeds, "Embed markers"),
    highlights: expectNonnegativeInteger(row.highlights, "Highlight markers"), source_references: expectNonnegativeInteger(row.source_references, "Source markers"),
    generated_citations: expectNonnegativeInteger(row.generated_citations, "Citation markers"), links: expectNonnegativeInteger(row.links, "Link markers"), synapses: expectNonnegativeInteger(row.synapses, "Synapse markers") };
}

export function decodeReaderPublicationEvidenceOverview(raw: unknown): ReaderPublicationEvidenceOverview {
  const row = expectExactRecord(raw, ["bucket_count", "buckets", "unavailable_counts"], "Evidence overview");
  const bucket_count = expectNonnegativeInteger(row.bucket_count, "Evidence bucket count");
  if (bucket_count < 1 || bucket_count > 512) throw new TypeError("Evidence bucket count exceeds contract");
  let previous = -1;
  const buckets = expectArray(row.buckets, (rawBucket) => {
    const bucket = expectExactRecord(rawBucket, ["index", "counts"], "Evidence bucket");
    const index = expectNonnegativeInteger(bucket.index, "Evidence bucket index");
    if (index <= previous || index >= bucket_count) throw new TypeError("Evidence buckets are out of order");
    previous = index;
    return { index, counts: decodeEvidenceMarkerCounts(bucket.counts) };
  }, "Evidence buckets");
  return { bucket_count, buckets, unavailable_counts: decodeEvidenceMarkerCounts(row.unavailable_counts) };
}

export function decodeReaderPublicationEvidenceBucketPage(raw: unknown): ReaderPublicationEvidenceBucketPage {
  const page = expectExactRecord(raw, ["items", "next_cursor"], "Evidence marker page");
  const items = expectArray(page.items, (rawItem): ReaderPublicationEvidenceMarker => {
    const item = expectExactRecord(rawItem, ["id", "kind", "item_id", "position", "target"], "Evidence marker");
    const kind = expectOneOf(item.kind, READER_PUBLICATION_MARKER_KINDS, "Evidence marker kind");
    const id = expectNonemptyString(item.id, "Evidence marker id");
    const item_id = expectNonemptyString(item.item_id, "Evidence marker item");
    if (id !== `marker:${kind}:${item_id}`) throw new TypeError("Evidence marker identity mismatch");
    if (typeof item.position !== "number" || !Number.isFinite(item.position) || item.position < 0 || item.position > 1) throw new TypeError("Invalid evidence marker position");
    const targetRow = expectRecord(item.target, "Evidence marker target");
    let target: ReaderPublicationEvidenceMarkerTarget;
    if (kind === "Contents") {
      expectExactRecord(targetRow, ["kind", "section_id", "unit_key"], "Contents marker target");
      if (targetRow.kind !== "Contents") throw new TypeError("Contents marker target changed kind");
      const section_id = expectNonemptyString(targetRow.section_id, "Contents section");
      if (item_id !== `contents:${section_id}`) throw new TypeError("Contents marker target changed identity");
      target = { kind: "Contents", section_id, unit_key: expectNonemptyString(targetRow.unit_key, "Contents unit") };
    } else if (kind === "Embed") {
      expectExactRecord(targetRow, ["kind", "unit_key", "id", "occurrence_key", "ordinal"], "Embed marker target");
      if (targetRow.kind !== "Embed") throw new TypeError("Embed marker target changed kind");
      const embedId = expectCanonicalUuid(targetRow.id, "Embed identity");
      if (item_id !== `embed:${embedId}`) throw new TypeError("Embed marker target changed identity");
      target = { kind: "Embed", unit_key: expectNonemptyString(targetRow.unit_key, "Embed unit"), id: embedId,
        occurrence_key: expectNonemptyString(targetRow.occurrence_key, "Embed occurrence"), ordinal: expectNonnegativeInteger(targetRow.ordinal, "Embed ordinal") };
    } else {
      expectExactRecord(targetRow, ["kind", "fact_id"], "Evidence fact marker target");
      if (targetRow.kind !== "Fact" || targetRow.fact_id !== item_id) throw new TypeError("Evidence marker changed its fact");
      target = { kind: "Fact", fact_id: item_id };
    }
    return { id, kind, item_id, position: item.position, target };
  }, "Evidence markers");
  if (items.length > 100 || new Set(items.map((item) => item.id)).size !== items.length) throw new TypeError("Invalid evidence marker page cardinality");
  const next_cursor = expectNullableString(page.next_cursor, "Evidence marker cursor");
  if (next_cursor !== null && items.length === 0) throw new TypeError("Empty evidence marker continuation");
  return { items, next_cursor };
}

export function readReaderPublicationEvidenceOverview(descriptor: ReaderMedia, request: ReaderPublicationEvidenceOverviewRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationEvidenceOverview> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/evidence/overview`, body: request, signal, maxBytes, decode: (raw) => {
    const result = decodeReaderPublicationEvidenceOverview(expectExactRecord(raw, ["data"], "Evidence overview response").data);
    if (result.bucket_count !== request.bucket_count) throw new TypeError("Evidence overview changed bucket boundaries");
    return result;
  } });
}

export function readReaderPublicationEvidenceBucket(descriptor: ReaderMedia, request: ReaderPublicationEvidenceBucketRequest, signal: AbortSignal, maxBytes: number): Promise<ReaderPublicationEvidenceBucketPage> {
  return readPublicationQuery({ path: `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}/evidence/overview/bucket`, body: request, signal, maxBytes, decode: (raw) => {
    const result = decodeReaderPublicationEvidenceBucketPage(expectExactRecord(raw, ["data"], "Evidence bucket response").data);
    if (result.items.some((item) => !request.kinds.includes(item.kind) || Math.min(request.bucket_count - 1, Math.floor(item.position * request.bucket_count)) !== request.index)) throw new TypeError("Evidence marker escaped its requested bucket");
    return result;
  } });
}
