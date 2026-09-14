import { expect, it } from "vitest";
import { decodeReaderPublicationUnit } from "./publicationContract";

const element = (parent: number | null, name: string) => ({ kind: "Element", parent, namespace: "html", name, attributes: [] });
const text = (parent: number | null, value: string) => ({ kind: "Text", parent, text: value });
const unit = (nodes: readonly unknown[]) => ({
  fragment_id: "11111111-1111-4111-8111-111111111111", fragment_idx: 0,
  document_word_start: 0, starts_in_word: false, epub_target: null, document_embeds: [],
  fragment_document_start_cp: 0, fragment_length_cp: 2,
  start_cp: 0, end_cp: 2, render_start_cp: 0, render_end_cp: 2,
  render_nodes: nodes, canonical_text: "ab", word_boundaries: [0, 2], assets: [], table_contexts: [],
});

it("rejects render records the producer's DOM-name and text grammar cannot emit", () => {
  for (const invalid of [
    { ...element(null, "svg:path"), namespace: "svg" },
    text(null, ""),
    { ...element(null, "p"), attributes: [{ namespace: "xml", name: "xml:lang", value: "en" }] },
  ]) expect(() => decodeReaderPublicationUnit(unit([invalid]))).toThrow();
});

it("accepts an explicit ordered tree and rejects parent reuse after its subtree has closed", () => {
  const nodes = [element(null, "p"), text(0, "a"), element(null, "p"), text(2, "b")];
  expect(decodeReaderPublicationUnit(unit(nodes)).render_nodes).toEqual(nodes);
  expect(() => decodeReaderPublicationUnit(unit([
    ...nodes, text(0, "late child"),
  ]))).toThrow("Reader render nodes are not in contiguous preorder");
  expect(() => decodeReaderPublicationUnit(unit([
    element(null, "p"), text(0, "a"), text(1, "b"),
  ]))).toThrow("Reader render node parent is not an earlier element");
});

it("accepts source-parsed SVG paint references only on their declared element and attribute", () => {
  const paint = { namespace: null, name: "fill", value: { kind: "LocalFragment", fragment_id: "gradient", fallback: "currentColor" } };
  const svg = { ...element(null, "rect"), namespace: "svg", attributes: [paint] };
  expect(decodeReaderPublicationUnit(unit([svg])).render_nodes).toEqual([svg]);
  expect(() => decodeReaderPublicationUnit(unit([{ ...svg, namespace: "html" }]))).toThrow();
  expect(() => decodeReaderPublicationUnit(unit([{ ...svg, attributes: [{ ...paint, name: "href" }] }]))).toThrow();
});

it("retains an existing epub target on a unit entered without a navigation-page read", () => {
  const target = { section_id: "retained-opening", href_path: "Text/chapter.xhtml", anchor_id: null };
  expect(decodeReaderPublicationUnit({ ...unit([element(null, "p"), text(0, "ab")]), epub_target: target }).epub_target).toEqual(target);
});

it("preserves explicit unavailable word metadata for converted packages without inventing an empty index", () => {
  const source = unit([element(null, "p"), text(0, "ab")]);
  expect(decodeReaderPublicationUnit({ ...source, word_boundaries: null }).word_boundaries).toBeNull();
});

it("preserves bounded opaque fragment identities from supported local packages", () => {
  const source = unit([element(null, "p"), text(0, "ab")]);
  expect(decodeReaderPublicationUnit({ ...source, fragment_id: "legacy-fragment" }).fragment_id).toBe("legacy-fragment");
  expect(decodeReaderPublicationUnit({ ...source, fragment_id: "𐐀".repeat(256) }).fragment_id).toBe("𐐀".repeat(256));
  for (const fragment_id of [" ", "𐐀".repeat(257)]) expect(() => decodeReaderPublicationUnit({ ...source, fragment_id })).toThrow();
});

it("binds each retained embed to exactly one authored anchor without freezing current display authority", () => {
  const source = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ordinal: 0, occurrence_key: "embed-one", provider: "youtube",
    embed_kind: "video", source_shape: "iframe", source_url: "https://example.test/authored", canonical_source_url: null,
    provider_target_ref: null, title: "Authored title", authored_text: null, placeholder_text: "ab",
    canonical_start_offset: 0, canonical_end_offset: 2,
    target: { kind: "materialized", media_id: "22222222-2222-4222-8222-222222222222" },
  };
  const anchor = { ...element(null, "p"), attributes: [{ namespace: null, name: "data-nexus-document-embed-id", value: "embed-one" }] };
  const valid = { ...unit([anchor, text(0, "ab")]), document_embeds: [source] };
  expect(decodeReaderPublicationUnit(valid).document_embeds).toEqual([source]);
  expect(() => decodeReaderPublicationUnit({ ...valid, document_embeds: [] })).toThrow("Reader embed anchor");
  expect(() => decodeReaderPublicationUnit({ ...valid, document_embeds: [source, source] })).toThrow("repeats or reorders");
  expect(() => decodeReaderPublicationUnit({ ...valid, document_embeds: [{ ...source, canonical_end_offset: 3 }] })).toThrow("original fragment");
  expect(() => decodeReaderPublicationUnit({ ...valid, document_embeds: [{ ...source, display: { allowed: true } }] })).toThrow();
});

it("preserves empty caption-only grids and rejects repeated original cell coordinates", () => {
  const cell = { row: 0, column: 0, row_span: 1, column_span: 1, continued_before: false, continued_after: false };
  const table = { table_ordinal: 0, row_count: 1, column_count: 1, caption: null, cells: [cell] };
  const source = unit([element(null, "table"), element(0, "tbody"), element(1, "tr"), element(2, "td"), text(3, "ab")]);
  expect(decodeReaderPublicationUnit({ ...source, table_contexts: [table] }).table_contexts).toEqual([table]);
  const empty = { ...table, row_count: 0, column_count: 0, cells: [] };
  expect(decodeReaderPublicationUnit({ ...source, table_contexts: [empty] }).table_contexts).toEqual([empty]);
  expect(() => decodeReaderPublicationUnit({ ...source, table_contexts: [{ ...table, cells: [cell, cell] }] })).toThrow();
});
