import { expect, it } from "vitest";
import { decodeReaderPublicationEvidenceMarkerPreview } from "./readerPublicationOverlays";
import { decodeReaderPublicationEvidenceGutterPage } from "./readerPublicationOverlays";
import { decodeReaderPublicationEvidenceLocation, decodeReaderPublicationEvidenceOverview, decodeReaderPublicationEvidenceBucketPage, decodeReaderPublicationEvidenceAssociationsPage, decodeReaderPublicationEvidenceFactsPage, decodeReaderPublicationEvidenceObject } from "./readerPublicationOverlays";
import { decodeReaderPublicationApparatusLocation, decodeReaderPublicationApparatusPage, decodeReaderPublicationApparatusSummary, decodeReaderPublicationApparatusTargetsPage, decodeReaderPublicationApparatusTextPage, decodeReaderPublicationEmbedsPage, decodeReaderPublicationHighlightsPage } from "./readerPublicationOverlays";

const identity = {
  id: "11111111-1111-4111-8111-111111111111", color: "yellow",
  created_at: "2026-09-13T12:00:00Z", author_user_id: "22222222-2222-4222-8222-222222222222", is_owner: true,
};

it("decodes a focused marker preview without pretending the excerpt is complete", () => {
  const preview = { marker_id: `marker:Embed:embed:${identity.id}`, kind: "Embed", tone: "Warning",
    label_excerpt: "unavailable source", label_codepoints: 18, excerpt: "🧠".repeat(300), excerpt_codepoints: 900000 };
  expect(decodeReaderPublicationEvidenceMarkerPreview(preview)).toEqual(preview);
  for (const bad of [
    { ...preview, kind: "Contents" }, { ...preview, excerpt_codepoints: 299 },
    { ...preview, excerpt_codepoints: null }, { ...preview, body_pm_json: {} },
  ]) expect(() => decodeReaderPublicationEvidenceMarkerPreview(bad)).toThrow();
});

it("keeps gutter occurrence counts and precise source geometry separate from facts", () => {
  const row = { id: `margin:stance:${identity.id}`, fact_id: `highlight:${identity.author_user_id}`, kind: "Stance",
    label_excerpt: "Conceded", label_codepoints: 8, excerpt: null, excerpt_codepoints: null,
    location: { kind: "PdfGeometry", page: 2, source_sha256: "a".repeat(64), quads: [{ x1: 1, y1: 2, x2: 3, y2: 2, x3: 3, y3: 4, x4: 1, y4: 4 }] },
    edge_id: identity.id, stance: "supports" };
  const page = { items: [row], total_count: 57, next_cursor: "complete-visible-count" };
  expect(decodeReaderPublicationEvidenceGutterPage(page)).toEqual(page);
  for (const bad of [
    { ...row, id: `margin:${row.fact_id}` }, { ...row, stance: null },
    { ...row, location: { kind: "Unavailable", reason: "SourceUnverified" } },
    { ...row, location: { ...row.location, source_sha256: null } },
  ]) expect(() => decodeReaderPublicationEvidenceGutterPage({ ...page, items: [bad] })).toThrow();
  expect(() => decodeReaderPublicationEvidenceGutterPage({ ...page, items: [row, row] })).toThrow();
});

it("keeps paged evidence summaries separate from authored detail and legacy pdf attestation", () => {
  const item = { kind: "Highlight", id: `highlight:${identity.id}`, locus_ref: `highlight:${identity.id}`,
    label_excerpt: "🧠é", label_codepoints: 2, excerpt: "🧠é", excerpt_codepoints: 2,
    position: { kind: "Unavailable", reason: "SourceUnverified" }, association_count: 2, also_reference_count: 0,
    highlight_id: identity.id, color: identity.color, created_at: identity.created_at, updated_at: identity.created_at,
    author_user_id: identity.author_user_id, is_owner: true };
  const counts = { highlights: 8, citations: 12, links: 6, synapses: 1, passages: 25, document: 2 };
  const page = { items: [item], counts, next_cursor: "exact-live-page" };
  expect(decodeReaderPublicationEvidenceFactsPage(page)).toEqual(page);
  for (const bad of [
    { ...item, exact: "authored text belongs to detail" },
    { ...item, excerpt_codepoints: 3 },
    { ...item, position: { kind: "Unavailable", reason: "pretend_current" } },
  ]) expect(() => decodeReaderPublicationEvidenceFactsPage({ ...page, items: [bad] })).toThrow();
  expect(() => decodeReaderPublicationEvidenceFactsPage({ ...page, items: [item, item] })).toThrow();
});

it("decodes live evidence actions without reconstructing a note body or changing its resource", () => {
  const ref = `note_block:${identity.id}`;
  const raw = { kind: "Note", ref, note_block_id: identity.id,
    label_excerpt: "🧠é".repeat(150), label_codepoints: 900000,
    excerpt: "🧠é".repeat(150), excerpt_codepoints: 900000,
    activation: { resource_ref: ref, kind: "route", href: `/notes/${identity.id}`, unresolved_reason: null } };
  const note = decodeReaderPublicationEvidenceObject(raw);
  expect(note.ref).toBe(ref);
  expect(note.excerpt_codepoints).toBe(900000);
  expect(note.activation.resourceRef).toBe(ref);
  expect(() => decodeReaderPublicationEvidenceObject({ ...raw, body_pm_json: {} })).toThrow();
  expect(() => decodeReaderPublicationEvidenceObject({ ...raw, activation: { ...raw.activation, resource_ref: `note_block:${identity.author_user_id}` } })).toThrow();
  const association = { relationship: "DirectlyAttached", edge_id: identity.id, role: "context", origin: "user", direction: "Outgoing", object: raw };
  const page = decodeReaderPublicationEvidenceAssociationsPage({ items: [association], next_cursor: null });
  expect(page.items[0]?.object).toEqual(note);
  expect(() => decodeReaderPublicationEvidenceAssociationsPage({ items: [{ ...association, direction: "storage-left" }], next_cursor: null })).toThrow();
});

it("keeps paint offsets in original fragment coordinates and rejects authored detail at this boundary", () => {
  const paint = { ...identity, start_offset: 10001, end_offset: 10012 };
  expect(decodeReaderPublicationHighlightsPage({ items: [paint], next_cursor: "selected-source-cursor" })).toEqual({ items: [paint], next_cursor: "selected-source-cursor" });
  for (const malformed of [
    { ...paint, end_offset: 10001 }, { ...paint, start_offset: -1 },
    { ...paint, color: "unknown" }, { ...paint, created_at: "yesterday" },
    { ...paint, exact: "whole authored quote" },
  ]) expect(() => decodeReaderPublicationHighlightsPage({ items: [malformed], next_cursor: null })).toThrow();
  const paints = (count: number) => Array.from({ length: count }, (_item, index) => ({ ...paint, id: `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` }));
  expect(decodeReaderPublicationHighlightsPage({ items: paints(100), next_cursor: null }).items).toHaveLength(100);
  expect(() => decodeReaderPublicationHighlightsPage({ items: paints(101), next_cursor: null })).toThrow();
  expect(() => decodeReaderPublicationHighlightsPage({ items: [paint, paint], next_cursor: null })).toThrow();
  expect(() => decodeReaderPublicationHighlightsPage({ items: [], next_cursor: "selected-source-cursor" })).toThrow();
});

it("rejects an embed continuation without a declared occurrence and preserves explicit completion", () => {
  expect(decodeReaderPublicationEmbedsPage({ items: [], next_ordinal: null })).toEqual({ items: [], next_ordinal: null });
  expect(() => decodeReaderPublicationEmbedsPage({ items: [], next_ordinal: 0 })).toThrow();
  expect(() => decodeReaderPublicationEmbedsPage({ items: [], next_ordinal: null, cached_permissions: [] })).toThrow();
});

it("keeps apparatus excerpt provenance separate from its owning reference and exact authored text", () => {
  const targetId = "22222222-2222-4222-8222-222222222222";
  const item = { id: identity.id, stable_key: "epub:marker:original-key", kind: "footnote_ref", confidence: "exact",
    label_excerpt: "note", label_codepoints: 4, label_source_id: targetId,
    body_excerpt: "🧠é", body_codepoints: 2, body_source_id: targetId,
    has_targets: true, source_range: null, pdf_page: 2 };
  expect(decodeReaderPublicationApparatusSummary(item)).toEqual(item);
  expect(decodeReaderPublicationApparatusPage({ items: [item], next_cursor: "source-bound" })).toEqual({ items: [item], next_cursor: "source-bound" });
  for (const invalid of [
    { ...item, body_source_id: null }, { ...item, body_codepoints: 3 },
    { ...item, body_text: "complete authored text" }, { ...item, pdf_page: 0 },
    { ...item, kind: "guessed_kind" },
  ]) expect(() => decodeReaderPublicationApparatusSummary(invalid)).toThrow();
  expect(() => decodeReaderPublicationApparatusPage({ items: [item, item], next_cursor: null })).toThrow();
  const edge = { edge_id: "33333333-3333-4333-8333-333333333333", relation: "points_to_note", confidence: "strong", target: { ...item, id: targetId, has_targets: false } };
  expect(decodeReaderPublicationApparatusTargetsPage({ items: [edge], next_cursor: null })).toEqual({ items: [edge], next_cursor: null });
  expect(() => decodeReaderPublicationApparatusTargetsPage({ items: [edge, edge], next_cursor: null })).toThrow();
});

it("counts apparatus text continuation in Unicode codepoints and preserves complete PDF quads", () => {
  const page = { field: "Body", offset_cp: 42, text: "🧠é", total_codepoints: 50, next_offset_cp: 44 };
  expect(decodeReaderPublicationApparatusTextPage(page)).toEqual(page);
  expect(() => decodeReaderPublicationApparatusTextPage({ ...page, next_offset_cp: 45 })).toThrow();
  expect(() => decodeReaderPublicationApparatusTextPage({ ...page, next_offset_cp: null })).toThrow();
  expect(decodeReaderPublicationApparatusTextPage({ ...page, total_codepoints: 44, next_offset_cp: null })).toEqual({ ...page, total_codepoints: 44, next_offset_cp: null });
  const quad = { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.2, x3: 0.1, y3: 0.4, x4: 0.3, y4: 0.4 };
  const location = { kind: "Pdf", page: 2, quads: [quad] };
  expect(decodeReaderPublicationApparatusLocation(location)).toEqual(location);
  expect(() => decodeReaderPublicationApparatusLocation({ ...location, quads: [quad, { ...quad, x1: Infinity }] })).toThrow();
  expect(() => decodeReaderPublicationApparatusLocation({ ...location, exact: "unbounded quote" })).toThrow();
  expect(decodeReaderPublicationApparatusLocation({ kind: "Unavailable" })).toEqual({ kind: "Unavailable" });
});

it("keeps precise PDF activation distinct from page navigation and unverified source", () => {
  const quad = { x1: 1, y1: 2, x2: 3, y2: 2, x3: 3, y3: 4, x4: 1, y4: 4 };
  const fact_id = `highlight:${identity.id}`;
  const source_sha256 = "a".repeat(64);
  const response = { fact_id, location: { kind: "PdfGeometry", page: 2, source_sha256, quads: [quad] } };
  expect(decodeReaderPublicationEvidenceLocation(response)).toEqual(response);
  expect(decodeReaderPublicationEvidenceLocation({ fact_id, location: { kind: "PdfPage", page: 2, source_sha256 } }).location.kind).toBe("PdfPage");
  for (const location of [
    { kind: "Pdf", page: 2 }, { ...response.location, source_sha256: null },
    { ...response.location, quads: [] }, { kind: "PdfPage", page: 2, source_sha256, quads: [quad] },
  ]) expect(() => decodeReaderPublicationEvidenceLocation({ fact_id, location })).toThrow();
});

it("keeps complete seven-kind overview counts and exact bucket activation identities", () => {
  const counts = { contents: 3, embeds: 2, highlights: 10, source_references: 5, generated_citations: 4, links: 6, synapses: 1 };
  const overview = { bucket_count: 4, buckets: [{ index: 0, counts }, { index: 3, counts }], unavailable_counts: { ...counts, embeds: 19 } };
  expect(decodeReaderPublicationEvidenceOverview(overview)).toEqual(overview);
  expect(() => decodeReaderPublicationEvidenceOverview({ ...overview, buckets: [overview.buckets[1], overview.buckets[0]] })).toThrow();
  expect(() => decodeReaderPublicationEvidenceOverview({ ...overview, unavailable_counts: { ...counts, guessed: 0 } })).toThrow();
  const marker = { id: `marker:Embed:embed:${identity.id}`, kind: "Embed", item_id: `embed:${identity.id}`, position: 1,
    target: { kind: "Embed", id: identity.id, unit_key: "units/last.json", occurrence_key: "retained-original", ordinal: 3 } };
  expect(decodeReaderPublicationEvidenceBucketPage({ items: [marker], next_cursor: "last-bucket-continuation" }).items).toEqual([marker]);
  for (const bad of [
    { ...marker, position: Infinity }, { ...marker, id: "invented" },
    { ...marker, target: { ...marker.target, id: identity.author_user_id } },
    { ...marker, label: "not actually loaded" },
  ]) expect(() => decodeReaderPublicationEvidenceBucketPage({ items: [bad], next_cursor: null })).toThrow();
});
