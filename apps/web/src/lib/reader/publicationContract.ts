import type { RetrievalLocator } from "@/lib/api/sse/locators";
import { expectArray, expectBoolean, expectCanonicalUuid, expectExactRecord, expectInteger, expectNonemptyString, expectNonnegativeInteger, expectNullableInteger, expectNullableString, expectOneOf, expectRecord, expectString } from "@/lib/validation";
import { decodeNavigationLocation, decodeNavigationSection, type ReaderNavigationLocation, type ReaderNavigationSection, type ReaderNavigationTocNode } from "@/lib/media/readerNavigation";
import { decodeDocumentEmbedSource, type DocumentEmbedSource } from "@/lib/media/documentEmbeds";
import { canonicalCpLength } from "./textOffsets";
import { parseReaderEpubTarget, parseReaderResumeState, type EpubReaderResumeState, type ReaderResumeState } from "./types";

export interface ReaderMemberRef {
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface DescriptorIdentity {
  readonly media_id: string;
  readonly reader_generation: number;
  readonly title: string;
  readonly reader_contract_version: 1;
}

export type ReaderPublicationDescriptor = DescriptorIdentity & (
  | { readonly kind: "pdf"; readonly document_asset_ref: ReaderMemberRef; readonly page_count: number }
  | { readonly kind: "epub" | "web_article"; readonly first_unit_ref: ReaderMemberRef; readonly index_ref: ReaderMemberRef; readonly contents_ref: ReaderMemberRef | null; readonly table_metadata_ref: ReaderMemberRef | null; readonly unit_count: number; readonly canonical_length: number }
);

export type ReaderPublicationAsset =
  | { readonly kind: "Captured"; readonly member: ReaderMemberRef; readonly media_type: string; readonly package_href: string | null }
  | { readonly kind: "Unavailable"; readonly source_url: string; readonly reason: "NotFound" | "InvalidImage" };

export interface ReaderPublicationUnitIndex {
  readonly member: ReaderMemberRef;
  readonly ordinal: number;
  readonly fragment_id: string;
  readonly fragment_idx: number;
  readonly start_cp: number;
  readonly end_cp: number;
}

export interface ReaderPublicationSourceRange {
  readonly unit_key: string;
  readonly fragment_id: string;
  readonly start_cp: number;
  readonly end_cp: number;
}

interface ReaderPublicationTableContext {
  readonly table_ordinal: number;
  readonly row_count: number;
  readonly column_count: number;
  readonly caption: ReaderPublicationSourceRange | null;
  readonly cells: readonly {
    readonly row: number; readonly column: number;
    readonly row_span: number; readonly column_span: number;
    readonly continued_before: boolean; readonly continued_after: boolean;
  }[];
}

/** Sparse original table metadata; it never expands the logical slot grid. */
type ReaderPublicationTableMetadata = {
  readonly fragment_id: string;
  readonly table_ordinal: number;
} & (
  | { readonly kind: "Table"; readonly row_count: number; readonly column_count: number; readonly caption: ReaderPublicationSourceRange | null }
  | { readonly kind: "ColumnGroup"; readonly start: number; readonly end: number }
  | { readonly kind: "Cell"; readonly row: number; readonly column: number; readonly row_span: number; readonly column_span: number;
      readonly row_group: number | null; readonly header_kind: "data" | "none" | "row" | "column" | "rowgroup" | "colgroup";
      readonly empty: boolean; readonly explicit_headers: boolean; readonly range: ReaderPublicationSourceRange }
  | { readonly kind: "ExplicitHeader"; readonly row: number; readonly column: number; readonly target_row: number; readonly target_column: number }
);

export interface ReaderPublicationUnit {
  readonly document_embeds: readonly DocumentEmbedSource[];
  readonly epub_target: EpubReaderResumeState["target"] | null;
  readonly document_word_start: number;
  readonly starts_in_word: boolean;
  readonly fragment_document_start_cp: number;
  readonly fragment_length_cp: number;
  readonly fragment_id: string;
  readonly fragment_idx: number;
  readonly start_cp: number;
  readonly end_cp: number;
  readonly render_start_cp: number;
  readonly render_end_cp: number;
  readonly render_nodes: readonly ReaderRenderNode[];
  readonly canonical_text: string;
  /** Native-converted packages omit unavailable Find metadata explicitly. */
  readonly word_boundaries: readonly number[] | null;
  readonly assets: readonly ReaderPublicationAsset[];
  readonly table_contexts: readonly ReaderPublicationTableContext[];
}

export type ReaderRenderAttributeValue = string | { readonly kind: "LocalFragment"; readonly fragment_id: string; readonly fallback: string | null };

type ReaderRenderNode =
  | { readonly kind: "Element"; readonly parent: number | null; readonly namespace: "html" | "svg" | "mathml"; readonly name: string;
      readonly attributes: readonly { readonly namespace: null | "xlink" | "xml" | "xmlns"; readonly name: string; readonly value: ReaderRenderAttributeValue }[] }
  | { readonly kind: "Text" | "Comment"; readonly parent: number | null; readonly text: string };

export interface ReaderPublicationIndex {
  readonly anchors: readonly { readonly href_path: string; readonly anchor_id: string; readonly unit_key: string; readonly offset_cp: number }[];
  readonly table_metadata: readonly ReaderPublicationTableMetadata[];
  readonly units: readonly ReaderPublicationUnitIndex[];
  readonly sections: readonly (ReaderNavigationSection & { readonly unit_key: string })[];
  readonly toc: readonly (Omit<ReaderNavigationTocNode, "children"> & { readonly parent_id: string | null })[];
  readonly landmarks: readonly ReaderNavigationLocation[];
  readonly page_list: readonly ReaderNavigationLocation[];
  readonly next_ref: ReaderMemberRef | null;
}

export type ReaderPublicationResolution =
  | { readonly kind: "Incomplete"; readonly locator: ReaderResumeState; readonly next_cursor: string }
  | ({ readonly kind: "Text"; readonly locator: Extract<ReaderResumeState, { kind: "web" | "epub" }>; readonly fragment_id: string; readonly offset_cp: number; readonly local_offset_cp: number } & ReaderPublicationUnitAddress)
  | ({ readonly kind: "Unit"; readonly fragment_id: string; readonly start_cp: number; readonly end_cp: number } & ReaderPublicationUnitAddress)
  | { readonly kind: "Pdf"; readonly locator: ReaderResumeState; readonly document_asset_ref: ReaderMemberRef; readonly page: number }
  | { readonly kind: "Unresolved"; readonly locator: ReaderResumeState | null; readonly reason: "TargetMissing" | "OffsetOutOfRange" | "QuoteMissing" | "QuoteAmbiguous" };

export interface ReaderPublicationSourceRangeTarget {
  readonly kind: "SourceRange";
  readonly locator: Extract<RetrievalLocator, { type: "web_text_offsets" | "epub_fragment_offsets" }>;
}
export type ReaderPublicationSourceRangeResolution = ReaderPublicationUnitAddress & {
  readonly kind: "SourceRange";
  readonly range: ReaderPublicationSourceRange;
  readonly locator: Extract<ReaderResumeState, { kind: "web" | "epub" }>;
  readonly fragment_id: string;
};

export interface ReaderPublicationUnitAddress {
  readonly unit_ref: ReaderMemberRef;
  readonly ordinal: number;
  readonly previous_ref: ReaderMemberRef | null;
  readonly next_ref: ReaderMemberRef | null;
}

export type ReaderPublicationTarget =
  | { readonly kind: "Locator"; readonly locator: ReaderResumeState }
  | { readonly kind: "Navigation"; readonly target_id: string }
  | { readonly kind: "EpubHref"; readonly pathname: string; readonly anchor_id: string | null }
  | { readonly kind: "Unit"; readonly unit_key: string };

interface ReaderPublicationSectionSummary {
  readonly section_id: string;
  readonly label: string;
  readonly ordinal: number;
  readonly unit_key: string;
  readonly fragment_id: string;
  readonly start_offset: number;
  readonly end_offset: number | null;
  readonly href_path: string | null;
  readonly anchor_id: string | null;
}

export interface ReaderPublicationSectionContext {
  readonly current: ReaderPublicationSectionSummary | null;
  readonly previous: ReaderPublicationSectionSummary | null;
  readonly next: ReaderPublicationSectionSummary | null;
  readonly section_position: number | null;
  readonly section_count: number;
}

/** Every publication Find page is bounded by this many retained occurrences. */
export const READER_PUBLICATION_FIND_MATCH_LIMIT = 2000;

export type ReaderPublicationFindScope =
  | { readonly kind: "EntireResource" }
  | { readonly kind: "Section"; readonly section_id: string };

interface ReaderPublicationFindOccurrence {
  readonly section_id: string | null;
  readonly section_label: string | null;
  readonly fragment_id: string;
  readonly fragment_idx: number;
  readonly start_offset: number;
  readonly end_offset: number;
  readonly snippet: readonly { readonly text: string; readonly emphasized: boolean }[];
  readonly locator: ReaderResumeState;
}

export interface ReaderPublicationFindPage {
  readonly occurrences: readonly ReaderPublicationFindOccurrence[];
  readonly next_cursor: string | null;
}

function decodeReaderMemberRef(raw: unknown): ReaderMemberRef {
  const value = expectExactRecord(raw, ["key", "bytes", "sha256"], "Reader member reference");
  const sha256 = expectString(value.sha256, "Reader member digest");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError("Invalid reader member digest");
  return {
    key: expectNonemptyString(value.key, "Reader member key"),
    bytes: expectNonnegativeInteger(value.bytes, "Reader member bytes"),
    sha256,
  };
}

export function decodeReaderPublicationDescriptor(raw: unknown): ReaderPublicationDescriptor {
  const kind = expectOneOf(expectRecord(raw, "Reader descriptor").kind, ["pdf", "epub", "web_article"], "Reader format");
  const value = expectExactRecord(raw, [
    "media_id", "reader_generation", "kind", "title", "reader_contract_version",
    ...(kind === "pdf" ? ["document_asset_ref", "page_count"] : ["first_unit_ref", "index_ref", "contents_ref", "table_metadata_ref", "unit_count", "canonical_length"]),
  ], "Reader descriptor");
  const generation = expectNonnegativeInteger(value.reader_generation, "Reader generation");
  const count = expectNonnegativeInteger(kind === "pdf" ? value.page_count : value.unit_count, "Reader extent count");
  if (generation === 0 || count === 0 || value.reader_contract_version !== 1) {
    throw new TypeError("Unsupported reader descriptor");
  }
  const identity: DescriptorIdentity = {
    media_id: expectCanonicalUuid(value.media_id, "Reader media ID"), reader_generation: generation,
    title: expectString(value.title, "Reader title"), reader_contract_version: 1,
  };
  return kind === "pdf" ? {
    ...identity, kind, page_count: count, document_asset_ref: decodeReaderMemberRef(value.document_asset_ref),
  } : {
    ...identity, kind, unit_count: count,
    canonical_length: expectNonnegativeInteger(value.canonical_length, "Reader canonical length"),
    first_unit_ref: decodeReaderMemberRef(value.first_unit_ref), index_ref: decodeReaderMemberRef(value.index_ref),
    contents_ref: value.contents_ref === null ? null : decodeReaderMemberRef(value.contents_ref),
    table_metadata_ref: value.table_metadata_ref === null ? null : decodeReaderMemberRef(value.table_metadata_ref),
  };
}

function decodePublicationFragmentId(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (value.trim().length === 0 || canonicalCpLength(value) > 256) {
    throw new TypeError(`${name} must be a nonblank fragment identity of at most 256 codepoints`);
  }
  return value;
}

export function decodeReaderPublicationUnit(raw: unknown): ReaderPublicationUnit {
  const value = expectExactRecord(raw, ["document_embeds", "epub_target", "fragment_id", "fragment_idx", "document_word_start", "starts_in_word", "fragment_document_start_cp", "fragment_length_cp", "start_cp", "end_cp", "render_start_cp", "render_end_cp", "render_nodes", "canonical_text", "word_boundaries", "assets", "table_contexts"], "Reader unit");
  const start = expectNonnegativeInteger(value.start_cp, "Unit start");
  const end = expectNonnegativeInteger(value.end_cp, "Unit end");
  const fragmentLength = expectNonnegativeInteger(value.fragment_length_cp, "Unit original fragment length");
  const renderStart = expectNonnegativeInteger(value.render_start_cp, "Unit render start");
  const renderEnd = expectNonnegativeInteger(value.render_end_cp, "Unit render end");
  const canonicalText = expectString(value.canonical_text, "Unit canonical text");
  if (!(start <= renderStart && renderStart <= renderEnd && renderEnd <= end && end <= fragmentLength) || canonicalCpLength(canonicalText) !== end - start) {
    throw new TypeError("Reader unit has inconsistent canonical extents");
  }
  let offset = start;
  for (const point of canonicalText) {
    if ((offset < renderStart || offset >= renderEnd) && point.trim().length !== 0) {
      throw new TypeError("Reader unit omitted rendered canonical content");
    }
    offset += 1;
  }
  let previous = -1;
  const boundaries = value.word_boundaries === null ? null : expectArray(value.word_boundaries, (raw) => {
    const point = expectNonnegativeInteger(raw, "Unit word boundary");
    if (point < start || point > end || point <= previous) throw new TypeError("Invalid reader word boundary order");
    previous = point;
    return point;
  }, "Unit word boundaries");
  const nodes = decodeReaderRenderNodes(value.render_nodes);
  const embeds = expectArray(value.document_embeds, decodeDocumentEmbedSource, "Unit embed sources");
  const ids = new Set<string>();
  const occurrences = new Set<string>();
  let embedOrdinal = -1;
  for (const source of embeds) {
    if (ids.has(source.id) || occurrences.has(source.occurrence_key) || source.ordinal <= embedOrdinal) throw new TypeError("Reader unit repeats or reorders an embed occurrence");
    ids.add(source.id); occurrences.add(source.occurrence_key); embedOrdinal = source.ordinal;
    const start = source.canonical_start_offset; const end = source.canonical_end_offset;
    if ((start === null) !== (end === null) || (start !== null && end !== null && (start > end || end > fragmentLength))) throw new TypeError("Reader embed escapes its original fragment");
  }
  let anchors = 0;
  for (const node of nodes) {
    if (node.kind !== "Element") continue;
    for (const attribute of node.attributes) {
      if (attribute.namespace !== null || attribute.name !== "data-nexus-document-embed-id") continue;
      if (typeof attribute.value !== "string" || !occurrences.delete(attribute.value)) throw new TypeError("Reader embed anchor has no unique retained source");
      anchors += 1;
    }
  }
  if (occurrences.size !== 0 || anchors !== embeds.length) throw new TypeError("Reader embed sources do not match their retained anchors");
  return {
    document_embeds: embeds,
    epub_target: value.epub_target === null ? null : parseReaderEpubTarget(value.epub_target),
    document_word_start: expectNonnegativeInteger(value.document_word_start, "Unit document word prefix"),
    starts_in_word: expectBoolean(value.starts_in_word, "Unit word continuation"),
    fragment_document_start_cp: expectNonnegativeInteger(value.fragment_document_start_cp, "Unit fragment document start"),
    fragment_length_cp: fragmentLength,
    fragment_id: decodePublicationFragmentId(value.fragment_id, "Unit fragment"),
    fragment_idx: expectNonnegativeInteger(value.fragment_idx, "Unit fragment index"),
    start_cp: start, end_cp: end, render_start_cp: renderStart, render_end_cp: renderEnd,
    render_nodes: nodes, canonical_text: canonicalText,
    word_boundaries: boundaries,
    table_contexts: expectArray(value.table_contexts, (raw): ReaderPublicationTableContext => {
      const context = expectExactRecord(raw, ["table_ordinal", "row_count", "column_count", "caption", "cells"], "Reader table context");
      const rows = expectNonnegativeInteger(context.row_count, "Original table rows");
      const columns = expectNonnegativeInteger(context.column_count, "Original table columns");
      const coordinates = new Set<string>();
      return {
        table_ordinal: expectNonnegativeInteger(context.table_ordinal, "Original table ordinal"),
        row_count: rows, column_count: columns,
        caption: context.caption === null ? null : decodeReaderPublicationSourceRange(context.caption),
        cells: expectArray(context.cells, (raw) => {
          const cell = expectExactRecord(raw, ["row", "column", "row_span", "column_span", "continued_before", "continued_after"], "Reader table cell");
          const row = expectNonnegativeInteger(cell.row, "Original cell row");
          const column = expectNonnegativeInteger(cell.column, "Original cell column");
          const rowSpan = expectNonnegativeInteger(cell.row_span, "Original cell row span");
          const columnSpan = expectNonnegativeInteger(cell.column_span, "Original cell column span");
          if (rowSpan === 0 || columnSpan === 0 || row + rowSpan > rows || column + columnSpan > columns) throw new TypeError("Reader cell escapes its original table grid");
          const coordinate = `${row}:${column}`;
          if (coordinates.has(coordinate)) throw new TypeError("Reader table repeats an original cell");
          coordinates.add(coordinate);
          return {
            row, column, row_span: rowSpan, column_span: columnSpan,
            continued_before: expectBoolean(cell.continued_before, "Cell preceding continuation"),
            continued_after: expectBoolean(cell.continued_after, "Cell following continuation"),
          };
        }, "Reader table cells"),
      };
    }, "Reader table contexts"),
    assets: expectArray(value.assets, (raw): ReaderPublicationAsset => {
      const kind = expectOneOf(expectRecord(raw, "Unit asset").kind, ["Captured", "Unavailable"], "Unit asset kind");
      const asset = expectExactRecord(raw, kind === "Captured" ? ["kind", "member", "media_type", "package_href"] : ["kind", "source_url", "reason"], "Unit asset");
      return kind === "Captured" ? {
        kind, member: decodeReaderMemberRef(asset.member),
        media_type: expectNonemptyString(asset.media_type, "Asset media type"),
        package_href: expectNullableString(asset.package_href, "Asset package path"),
      } : {
        kind, source_url: expectNonemptyString(asset.source_url, "Unavailable asset source"),
        reason: expectOneOf(asset.reason, ["NotFound", "InvalidImage"], "Unavailable asset reason"),
      };
    }, "Unit assets"),
  };
}

function decodeReaderRenderNodes(raw: unknown): ReaderRenderNode[] {
  const elements = new Set<number>();
  const ancestors: number[] = [];
  return expectArray(raw, (raw, index): ReaderRenderNode => {
    const kind = expectOneOf(expectRecord(raw, "Reader render node").kind, ["Element", "Text", "Comment"], "Render node kind");
    const node = expectExactRecord(raw, kind === "Element"
      ? ["kind", "parent", "namespace", "name", "attributes"] : ["kind", "parent", "text"], "Reader render node");
    const parent = expectNullableInteger(node.parent, "Render node parent");
    if (parent === null) ancestors.length = 0;
    else {
      if (parent < 0 || parent >= index || !elements.has(parent)) throw new TypeError("Reader render node parent is not an earlier element");
      while (ancestors.length !== 0 && ancestors.at(-1) !== parent) ancestors.pop();
      if (ancestors.length === 0) throw new TypeError("Reader render nodes are not in contiguous preorder");
    }
    if (kind !== "Element") return {
      kind, parent, text: kind === "Text" ? expectNonemptyString(node.text, "Render node text") : expectString(node.text, "Render node text"),
    };
    elements.add(index);
    ancestors.push(index);
    const name = expectNonemptyString(node.name, "Render element name");
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) throw new TypeError("Invalid render element name");
    const elementNamespace = expectOneOf(node.namespace, ["html", "svg", "mathml"], "Render namespace");
    const attributeKeys = new Set<string>();
    return {
      kind, parent,
      namespace: elementNamespace,
      name,
      attributes: expectArray(node.attributes, (raw) => {
        const attribute = expectExactRecord(raw, ["namespace", "name", "value"], "Render attribute");
        const namespace = attribute.namespace === null ? null : expectOneOf(attribute.namespace, ["xlink", "xml", "xmlns"], "Attribute namespace");
        const name = expectNonemptyString(attribute.name, "Render attribute name");
        if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) || (namespace !== null && name.includes(":"))) throw new TypeError("Invalid render attribute name");
        const key = `${namespace}:${name}`;
        if (attributeKeys.has(key)) throw new TypeError("Reader element has duplicate attributes");
        attributeKeys.add(key);
        let value: ReaderRenderAttributeValue;
        if (typeof attribute.value === "string") value = attribute.value;
        else {
          const local = expectExactRecord(attribute.value, ["kind", "fragment_id", "fallback"], "SVG local fragment");
          if (local.kind !== "LocalFragment" || elementNamespace !== "svg" || namespace !== null || !["fill", "stroke", "clip-path"].includes(name)) {
            throw new TypeError("Typed SVG reference is not a supported paint attribute");
          }
          value = { kind: "LocalFragment", fragment_id: expectNonemptyString(local.fragment_id, "SVG fragment ID"), fallback: expectNullableString(local.fallback, "SVG paint fallback") };
        }
        return { namespace, name, value };
      }, "Render attributes"),
    };
  }, "Reader render nodes");
}

export function decodeReaderPublicationSourceRange(raw: unknown): ReaderPublicationSourceRange {
  const value = expectExactRecord(raw, ["unit_key", "fragment_id", "start_cp", "end_cp"], "Reader source range");
  const start = expectNonnegativeInteger(value.start_cp, "Reader source range start");
  const end = expectNonnegativeInteger(value.end_cp, "Reader source range end");
  if (end < start) throw new TypeError("Reader source range is reversed");
  return { unit_key: expectNonemptyString(value.unit_key, "Reader source range unit"),
    fragment_id: decodePublicationFragmentId(value.fragment_id, "Reader source range fragment"), start_cp: start, end_cp: end };
}

function decodeTableCoordinate(raw: unknown, name: string): number {
  const value = expectNonnegativeInteger(raw, name);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  return value;
}

function decodeReaderTableMetadata(raw: unknown): ReaderPublicationTableMetadata {
  const kind = expectOneOf(expectRecord(raw, "Reader table metadata").kind, ["Table", "ColumnGroup", "Cell", "ExplicitHeader"], "Table metadata kind");
  const fields = kind === "Table" ? ["row_count", "column_count", "caption"]
    : kind === "ColumnGroup" ? ["start", "end"]
    : kind === "Cell" ? ["row", "column", "row_span", "column_span", "row_group", "header_kind", "empty", "explicit_headers", "range"]
    : ["row", "column", "target_row", "target_column"];
  const value = expectExactRecord(raw, ["kind", "fragment_id", "table_ordinal", ...fields], "Reader table metadata");
  const identity = { fragment_id: decodePublicationFragmentId(value.fragment_id, "Table source fragment"),
    table_ordinal: decodeTableCoordinate(value.table_ordinal, "Source table ordinal") };
  switch (kind) {
    case "Table": return { ...identity, kind,
      row_count: decodeTableCoordinate(value.row_count, "Source table rows"), column_count: decodeTableCoordinate(value.column_count, "Source table columns"),
      caption: value.caption === null ? null : decodeReaderPublicationSourceRange(value.caption) };
    case "ColumnGroup": return { ...identity, kind,
      start: decodeTableCoordinate(value.start, "Source column group start"), end: decodeTableCoordinate(value.end, "Source column group end") };
    case "Cell": {
      const rowSpan = decodeTableCoordinate(value.row_span, "Source cell row span");
      const columnSpan = decodeTableCoordinate(value.column_span, "Source cell column span");
      if (rowSpan === 0 || columnSpan === 0 || columnSpan > 1000) throw new TypeError("Invalid source table cell span");
      return { ...identity, kind,
        row: decodeTableCoordinate(value.row, "Source cell row"), column: decodeTableCoordinate(value.column, "Source cell column"),
        row_span: rowSpan, column_span: columnSpan, row_group: value.row_group === null ? null : decodeTableCoordinate(value.row_group, "Source row group"),
        header_kind: expectOneOf(value.header_kind, ["data", "none", "row", "column", "rowgroup", "colgroup"], "Source header kind"),
        empty: expectBoolean(value.empty, "Empty source cell"), explicit_headers: expectBoolean(value.explicit_headers, "Explicit source headers"),
        range: decodeReaderPublicationSourceRange(value.range) };
    }
    case "ExplicitHeader": return { ...identity, kind,
      row: decodeTableCoordinate(value.row, "Header owner row"), column: decodeTableCoordinate(value.column, "Header owner column"),
      target_row: decodeTableCoordinate(value.target_row, "Header target row"), target_column: decodeTableCoordinate(value.target_column, "Header target column") };
  }
}

export function decodeReaderPublicationIndex(raw: unknown): ReaderPublicationIndex {
  const value = expectExactRecord(raw, ["units", "sections", "toc", "landmarks", "page_list", "table_metadata", "anchors", "next_ref"], "Reader index");
  let previousOrdinal = -1;
  const page: ReaderPublicationIndex = {
    anchors: expectArray(value.anchors, (raw) => {
      const anchor = expectExactRecord(raw, ["href_path", "anchor_id", "unit_key", "offset_cp"], "Reader source anchor");
      return { href_path: expectNonemptyString(anchor.href_path, "Anchor href"), anchor_id: expectNonemptyString(anchor.anchor_id, "Anchor ID"),
        unit_key: expectNonemptyString(anchor.unit_key, "Anchor unit"), offset_cp: expectNonnegativeInteger(anchor.offset_cp, "Anchor canonical offset") };
    }, "Reader source anchors"),
    table_metadata: expectArray(value.table_metadata, decodeReaderTableMetadata, "Reader table metadata"),
    units: expectArray(value.units, (raw): ReaderPublicationUnitIndex => {
      const unit = expectExactRecord(raw, ["member", "ordinal", "fragment_id", "fragment_idx", "start_cp", "end_cp"], "Indexed unit");
      const ordinal = expectNonnegativeInteger(unit.ordinal, "Unit ordinal");
      const start = expectNonnegativeInteger(unit.start_cp, "Indexed unit start");
      const end = expectNonnegativeInteger(unit.end_cp, "Indexed unit end");
      if (ordinal <= previousOrdinal || end < start) throw new TypeError("Reader index units must preserve reading order");
      previousOrdinal = ordinal;
      return {
        member: decodeReaderMemberRef(unit.member), ordinal,
        fragment_id: decodePublicationFragmentId(unit.fragment_id, "Indexed fragment"),
        fragment_idx: expectNonnegativeInteger(unit.fragment_idx, "Indexed fragment index"),
        start_cp: start, end_cp: end,
      };
    }, "Reader index units"),
    sections: expectArray(value.sections, (raw) => {
      const { unit_key, ...fields } = expectRecord(raw, "Reader index section");
      const section = decodeNavigationSection(fields, "Reader index section");
      return { ...section, fragment_id: decodePublicationFragmentId(section.fragment_id, "Section fragment"),
        unit_key: expectNonemptyString(unit_key, "Section addressed unit") };
    }, "Reader index sections"),
    toc: expectArray(value.toc, (raw) => {
      const entry = expectExactRecord(raw, ["id", "parent_id", "label", "ordinal", "href", "fragment_idx", "level", "depth", "section_id"], "Reader index TOC entry");
      return {
        id: expectString(entry.id, "TOC ID"), parent_id: expectNullableString(entry.parent_id, "TOC parent ID"),
        label: expectString(entry.label, "TOC label"), ordinal: expectInteger(entry.ordinal, "TOC ordinal"),
        href: expectNullableString(entry.href, "TOC href"), fragment_idx: expectNullableInteger(entry.fragment_idx, "TOC fragment index"),
        level: expectNullableInteger(entry.level, "TOC level"), depth: expectNullableInteger(entry.depth, "TOC depth"),
        section_id: expectNullableString(entry.section_id, "TOC section ID"),
      };
    }, "Reader index TOC"),
    landmarks: expectArray(value.landmarks, (raw) => decodeNavigationLocation(raw, "Reader landmark"), "Reader landmarks"),
    page_list: expectArray(value.page_list, (raw) => decodeNavigationLocation(raw, "Reader page-list entry"), "Reader page list"),
    next_ref: value.next_ref === null ? null : decodeReaderMemberRef(value.next_ref),
  };
  if (page.table_metadata.length !== 0 && [page.units, page.sections, page.toc, page.landmarks, page.page_list, page.anchors].some((rows) => rows.length !== 0)) {
    throw new TypeError("Reader table metadata shares the navigation index chain");
  }
  return page;
}

export function decodeReaderPublicationResolution(raw: unknown): ReaderPublicationResolution | ReaderPublicationSourceRangeResolution {
  const kind = expectOneOf(expectRecord(raw, "Reader resolution").kind, ["Text", "Unit", "Pdf", "Unresolved", "Incomplete", "SourceRange"], "Resolution kind");
  const value = expectExactRecord(raw, ["kind", ...(kind === "Unit" ? ["start_cp", "end_cp"] : ["locator"]), ...(kind === "Text" || kind === "Unit" || kind === "SourceRange" ? ["unit_ref", "ordinal", "previous_ref", "next_ref", "fragment_id", ...(kind === "Text" ? ["offset_cp", "local_offset_cp"] : kind === "SourceRange" ? ["range"] : [])] : kind === "Pdf" ? ["document_asset_ref", "page"] : kind === "Incomplete" ? ["next_cursor"] : ["reason"])], "Reader resolution");
  if (kind === "Unit") {
    const start = expectNonnegativeInteger(value.start_cp, "Resolved unit start");
    const end = expectNonnegativeInteger(value.end_cp, "Resolved unit end");
    if (end < start) throw new TypeError("Invalid resolved unit extent");
    return { kind, ...decodeUnitAddress(value), fragment_id: decodePublicationFragmentId(value.fragment_id, "Resolved fragment"), start_cp: start, end_cp: end };
  }
  const locator = parseReaderResumeState(value.locator);
  if (kind === "Unresolved") {
    const reason = expectOneOf(value.reason, ["TargetMissing", "OffsetOutOfRange", "QuoteMissing", "QuoteAmbiguous"], "Unresolved reason");
    if (locator === null && value.locator !== null) throw new TypeError("Invalid unresolved reader locator");
    return { kind, locator, reason };
  }
  if (locator === null) throw new TypeError("Invalid resolved reader locator");
  switch (kind) {
    case "SourceRange": {
      const address = decodeUnitAddress(value);
      const range = decodeReaderPublicationSourceRange(value.range);
      const fragmentId = decodePublicationFragmentId(value.fragment_id, "Resolved source fragment");
      if (range.unit_key !== address.unit_ref.key || range.fragment_id !== fragmentId ||
          (locator.kind !== "web" && locator.kind !== "epub") || locator.locations.text_offset !== range.start_cp ||
          (locator.kind === "web" && locator.target.fragment_id !== fragmentId)) {
        throw new TypeError("Resolved source range lost its original locator or member");
      }
      return { kind, ...address, range, locator, fragment_id: fragmentId };
    }
    case "Incomplete": return {
      kind, locator, next_cursor: expectNonemptyString(value.next_cursor, "Reader resolve continuation"),
    };
    case "Text": {
      if (locator.kind !== "web" && locator.kind !== "epub") throw new TypeError("Text resolution has a nontext locator");
      return {
      kind, locator, ...decodeUnitAddress(value),
      fragment_id: decodePublicationFragmentId(value.fragment_id, "Resolved fragment"),
      offset_cp: expectNonnegativeInteger(value.offset_cp, "Resolved offset"),
      local_offset_cp: expectNonnegativeInteger(value.local_offset_cp, "Resolved local offset"),
      };
    }
    case "Pdf": {
      const page = expectNonnegativeInteger(value.page, "Resolved PDF page");
      if (page === 0) throw new TypeError("Resolved PDF page must be positive");
      return { kind, locator, document_asset_ref: decodeReaderMemberRef(value.document_asset_ref), page };
    }
  }
}

function decodeUnitAddress(value: Record<string, unknown>): ReaderPublicationUnitAddress {
  return {
    unit_ref: decodeReaderMemberRef(value.unit_ref),
    ordinal: expectNonnegativeInteger(value.ordinal, "Resolved ordinal"),
    previous_ref: value.previous_ref === null ? null : decodeReaderMemberRef(value.previous_ref),
    next_ref: value.next_ref === null ? null : decodeReaderMemberRef(value.next_ref),
  };
}

export function decodeReaderPublicationFindPage(raw: unknown): ReaderPublicationFindPage {
  const value = expectExactRecord(raw, ["occurrences", "next_cursor"], "Reader find page");
  return {
    next_cursor: expectNullableString(value.next_cursor, "Reader find continuation"),
    occurrences: expectArray(value.occurrences, (raw) => {
      const hit = expectExactRecord(raw, ["section_id", "section_label", "fragment_id", "fragment_idx", "start_offset", "end_offset", "snippet", "locator"], "Reader find occurrence");
      const start = expectNonnegativeInteger(hit.start_offset, "Find match start");
      const end = expectNonnegativeInteger(hit.end_offset, "Find match end");
      if (end <= start) throw new TypeError("Reader find match must cover canonical text");
      const locator = parseReaderResumeState(hit.locator);
      if (locator === null || (locator.kind !== "web" && locator.kind !== "epub") || locator.locations.text_offset !== start ||
          (locator.kind === "web" && locator.target.fragment_id !== hit.fragment_id) ||
          (locator.kind === "epub" && locator.target.section_id !== hit.section_id)) {
        throw new TypeError("Reader find locator does not address its canonical occurrence");
      }
      return {
        locator, section_id: expectNullableString(hit.section_id, "Find section ID"),
        section_label: expectNullableString(hit.section_label, "Find section label"),
        fragment_id: decodePublicationFragmentId(hit.fragment_id, "Find fragment ID"),
        fragment_idx: expectNonnegativeInteger(hit.fragment_idx, "Find fragment index"),
        start_offset: start, end_offset: end,
        snippet: expectArray(hit.snippet, (raw) => {
          const part = expectExactRecord(raw, ["text", "emphasized"], "Find snippet part");
          return { text: expectString(part.text, "Snippet text"), emphasized: expectBoolean(part.emphasized, "Snippet emphasis") };
        }, "Find snippet"),
      };
    }, "Reader find occurrences"),
  };
}

export function decodeReaderPublicationSectionContext(raw: unknown): ReaderPublicationSectionContext {
  const value = expectExactRecord(raw, ["current", "previous", "next", "section_position", "section_count"], "Reader section context");
  const section = (raw: unknown): ReaderPublicationSectionSummary | null => {
    if (raw === null) return null;
    const value = expectExactRecord(raw, ["section_id", "label", "ordinal", "unit_key", "fragment_id", "start_offset", "end_offset", "href_path", "anchor_id"], "Reader section summary");
    const start = expectNonnegativeInteger(value.start_offset, "Section start");
    const end = value.end_offset === null ? null : expectNonnegativeInteger(value.end_offset, "Section end");
    if (end !== null && end < start) throw new TypeError("Reader section has reversed canonical offsets");
    return { section_id: expectNonemptyString(value.section_id, "Section ID"), label: expectString(value.label, "Section label"),
      ordinal: expectNonnegativeInteger(value.ordinal, "Section ordinal"), unit_key: expectNonemptyString(value.unit_key, "Section unit"),
      fragment_id: decodePublicationFragmentId(value.fragment_id, "Section fragment"), start_offset: start, end_offset: end,
      href_path: expectNullableString(value.href_path, "Section href"), anchor_id: expectNullableString(value.anchor_id, "Section anchor") };
  };
  const current = section(value.current); const previous = section(value.previous); const next = section(value.next);
  const position = value.section_position === null ? null : expectNonnegativeInteger(value.section_position, "Section position");
  const count = expectNonnegativeInteger(value.section_count, "Section count");
  if ((current === null) !== (position === null) || (position !== null && (position < 1 || position > count)) ||
      (current === null && (previous !== null || next !== null))) throw new TypeError("Reader section context has inconsistent source position");
  return { current, previous, next, section_position: position, section_count: count };
}
