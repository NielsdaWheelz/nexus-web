import { afterEach, expect, it, vi } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createHostedReaderSource, type ReaderMedia } from "./ReaderDocumentSource";
import { READER_CAPACITY } from "./readerCapacity";
import { readPublicationMember } from "./publicationTransport";
import { decodeReaderPublicationUnit, type ReaderMemberRef } from "./publicationContract";

const unit = {
  table_contexts: [],
  fragment_id: "11111111-1111-4111-8111-111111111111", fragment_idx: 0,
  document_word_start: 0, starts_in_word: false, epub_target: null, document_embeds: [],
  fragment_document_start_cp: 100, fragment_length_cp: 20,
  start_cp: 10, end_cp: 14, render_start_cp: 10, render_end_cp: 14,
  render_nodes: [
    { kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] },
    { kind: "Text", parent: 0, text: "A😀 B" },
  ], canonical_text: "A😀 B",
  word_boundaries: [10, 11, 12, 13, 14],
  assets: [{ kind: "Unavailable", source_url: "https://example.invalid/image.png", reason: "NotFound" }],
};

afterEach(() => vi.unstubAllGlobals());

async function representation(body: unknown = unit) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const reference: ReaderMemberRef = {
    key: "units/0.json", bytes: bytes.byteLength,
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
  const headers = {
    "Content-Type": "application/json", "Content-Length": String(bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...digest))}:`,
    "X-Nexus-Reader-Generation": "2",
  };
  return { bytes, reference, headers };
}

it("verifies selected-generation bytes before decoding original code-point extents", async () => {
  const { bytes, reference, headers } = await representation();
  vi.stubGlobal("fetch", async () => new Response(bytes, { headers }));
  const result = await readPublicationMember({
    path: "/api/media/proof/reader-publications/2/units/0.json", signal: new AbortController().signal,
    maxBytes: reference.bytes, expected: reference, generation: 2, decode: decodeReaderPublicationUnit,
  });
  expect(result.generation).toBe(2);
  expect(result.data).toEqual(unit);
  await expect(readPublicationMember({
    path: "/api/media/proof/reader-publications/3/units/0.json", signal: new AbortController().signal,
    maxBytes: reference.bytes, expected: reference, generation: 3, decode: decodeReaderPublicationUnit,
  }), "selected content silently changed generation").rejects.toMatchObject({ code: "E_INVALID_RESPONSE" });
});

it("rejects unavailable word metadata from a hosted publication with supported Find", async () => {
  const { bytes, reference, headers } = await representation({ ...unit, word_boundaries: null });
  const source = createHostedReaderSource({ accountId: crypto.randomUUID(), cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY });
  const descriptor: ReaderMedia = { media_id: "11111111-1111-4111-8111-111111111111", reader_generation: 2,
    reader_contract_version: 1, kind: "web_article", title: "Reader", canonical_length: 120,
    source: { kind: "Publication", reader_generation: 2 }, unit_count: 1,
    first_unit_ref: reference, contents_ref: null, table_metadata_ref: null, index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) },
  };
  vi.stubGlobal("fetch", async () => new Response(bytes, { headers }));
  const result = source.acquireUnit(descriptor, reference);
  if (result.kind !== "Acquired") throw new Error("Source fixture lacked admission");
  try { await expect(result.lease.promise).rejects.toMatchObject({ code: "E_INVALID_RESPONSE" }); }
  finally { result.lease.release(); }
});

it("rejects an oversized query representation before materializing its JSON", async () => {
  const capacity = { ...READER_CAPACITY, indexBytes: 16 };
  const source = createHostedReaderSource({ accountId: crypto.randomUUID(), cache: new ResourceCache({}, capacity.cache), capacity });
  const descriptor: ReaderMedia = { media_id: "11111111-1111-4111-8111-111111111111", reader_generation: 2,
    reader_contract_version: 1, kind: "web_article", title: "Reader", canonical_length: 4,
    source: { kind: "Publication", reader_generation: 2 }, unit_count: 1,
    first_unit_ref: { key: "units/0.json", bytes: 1, sha256: "a".repeat(64) },
    contents_ref: null, table_metadata_ref: null, index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) },
  };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: { occurrences: [], next_cursor: null } }), {
    headers: { "Content-Type": "application/json", "Content-Length": "1000000" },
  }));
  await expect(source.find(descriptor, { query: "a", match_case: false, whole_word: false,
    scope: { kind: "EntireResource" }, after: null }, new AbortController().signal)).rejects.toMatchObject({ code: "E_INVALID_RESPONSE" });
});

it("shares unit and query read admission until cancelled physical reads actually settle", async () => {
  const capacity = { ...READER_CAPACITY, cache: { ...READER_CAPACITY.cache, maxReads: 1 } };
  const source = createHostedReaderSource({ accountId: crypto.randomUUID(), cache: new ResourceCache({}, capacity.cache), capacity });
  const { bytes, reference, headers } = await representation();
  const descriptor: ReaderMedia = { media_id: "11111111-1111-4111-8111-111111111111", reader_generation: 2,
    reader_contract_version: 1, kind: "web_article", title: "Reader", canonical_length: 120,
    source: { kind: "Publication", reader_generation: 2 }, unit_count: 1,
    first_unit_ref: reference, contents_ref: null, table_metadata_ref: null, index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) },
  };
  let finish: (response: Response) => void = () => { throw new Error("Physical read never started"); };
  let unitReadStarted = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/units/0.json")) {
      unitReadStarted = true;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    const body = JSON.stringify({ data: { occurrences: [], next_cursor: null } });
    return new Response(body, { headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(body).byteLength) } });
  });
  const unitRead = source.acquireUnit(descriptor, reference);
  if (unitRead.kind !== "Acquired" || source.find === null) throw new Error("Hosted source capability unavailable");
  const pending = unitRead.lease.promise.catch((error: unknown) => error);
  const query = { query: "a", match_case: false, whole_word: false, scope: { kind: "EntireResource" as const }, after: null };
  try {
    await vi.waitFor(() => expect(unitReadStarted).toBe(true));
    expect(await source.find(descriptor, query, new AbortController().signal)).toEqual({ kind: "Capacity", reason: "Reads" });
    unitRead.lease.release();
    expect(await source.find(descriptor, query, new AbortController().signal), "cancellation released physical admission before settlement").toEqual({ kind: "Capacity", reason: "Reads" });
  } finally { finish(new Response(bytes, { headers })); await pending; unitRead.lease.release(); }
  expect(await source.find(descriptor, query, new AbortController().signal)).toEqual({ occurrences: [], next_cursor: null });
});

it("rejects replaced bytes even when their advertised publication digest is retained", async () => {
  const { bytes, reference, headers } = await representation();
  const changed = bytes.slice();
  changed[changed.indexOf("A".charCodeAt(0))] = "Z".charCodeAt(0);
  vi.stubGlobal("fetch", async () => new Response(changed, { headers }));
  await expect(readPublicationMember({
    path: "/api/media/proof/reader-publications/2/units/0.json", signal: new AbortController().signal,
    maxBytes: reference.bytes, expected: reference, generation: 2, decode: decodeReaderPublicationUnit,
  }), "changed publication bytes reached the reader").rejects.toMatchObject({ code: "E_INVALID_RESPONSE", message: "Reader member digest does not match its selected publication" });
});

it("cancels excess bytes before parsing or retaining an oversized member", async () => {
  const { bytes, reference, headers } = await representation();
  let cancelled = false;
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(bytes.byteLength + 1)); },
    cancel() { cancelled = true; },
  }), { headers }));
  await expect(readPublicationMember({
    path: "/api/media/proof/reader-publications/2/units/0.json", signal: new AbortController().signal,
    maxBytes: reference.bytes, expected: reference, generation: 2, decode: decodeReaderPublicationUnit,
  })).rejects.toMatchObject({ code: "E_INVALID_RESPONSE", message: "Response exceeds its declared byte length" });
  expect(cancelled, "oversized member retained its transport producer").toBe(true);
});

it("preserves availability classification for a raw gateway failure", async () => {
  vi.stubGlobal("fetch", async () => new Response("gateway unavailable", { status: 502 }));
  await expect(readPublicationMember({
    path: "/api/media/proof/reader-publication", signal: new AbortController().signal,
    maxBytes: 1_024, decode: decodeReaderPublicationUnit,
  })).rejects.toMatchObject({ status: 502, code: "E_UPSTREAM" });
});
