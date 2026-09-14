import { expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY } from "./readerCapacity";

it("retains a shared source for its live reader and collects it after the last lease and cache retire", async () => {
  const accountId = crypto.randomUUID();
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const fragmentId = "22222222-2222-4222-8222-222222222222";
  async function member(key: string, value: unknown) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { bytes, digest, ref: { key, bytes: bytes.byteLength,
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") } };
  }
  const source = await member("units/0.json", {
    fragment_id: fragmentId, fragment_idx: 0, fragment_document_start_cp: 0, fragment_length_cp: 4,
    document_word_start: 0, starts_in_word: false, epub_target: null, document_embeds: [],
    start_cp: 0, end_cp: 4, render_start_cp: 0, render_end_cp: 4,
    canonical_text: "A😀 B", word_boundaries: [0, 1, 2, 3, 4], assets: [], table_contexts: [],
    render_nodes: [{ kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] },
      { kind: "Text", parent: 0, text: "A😀 B" }],
  });
  const descriptor = await member("descriptor.json", {
    media_id: mediaId, reader_generation: 7, reader_contract_version: 1, title: "Shared source", kind: "web_article",
    first_unit_ref: source.ref, contents_ref: null, table_metadata_ref: null,
    index_ref: { key: "index/0.json", bytes: 1, sha256: "0".repeat(64) }, unit_count: 1, canonical_length: 4,
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
    if (path === `/api/media/${mediaId}/offline-reader-state`) {
      return Response.json({ data: { accountId, readerGeneration: 7, cursor: { state: "Empty", revision: 0 } } });
    }
    const value = path === `/api/media/${mediaId}/reader-publication` ? descriptor
      : path === `/api/media/${mediaId}/reader-publications/7/units/0.json` ? source : null;
    if (value === null) throw new Error(`Source retirement escaped its selected member: ${path}`);
    return new Response(value.bytes, { headers: {
      "Content-Type": "application/json", "Content-Length": String(value.bytes.byteLength),
      "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...value.digest))}:`, "X-Nexus-Reader-Generation": "7",
    } });
  });
  const cache = new ResourceCache({}, READER_CAPACITY.cache);
  const progress = new HostedReaderProgressRuntime(accountId, () => {});
  const readers = [0, 1].map(() => createDocumentReaderSession({ mediaId, capacity: READER_CAPACITY,
    source: createHostedReaderSource({ accountId, cache, capacity: READER_CAPACITY }), progress: progress.createPort(mediaId) }));
  try {
    await Promise.all(readers.map((reader) => reader.load(new AbortController().signal, { fresh: null, cold: null })));
    const before = readers.map((reader) => reader.residency);
    const leases = readers.map((reader) => {
      const result = reader.acquireUnit({ unit_ref: source.ref, ordinal: 0, previous_ref: null, next_ref: null });
      if (result.kind !== "Acquired") throw new Error("Shared source could not be admitted");
      return result.lease;
    });
    const results = await Promise.all(leases.map((lease) => lease.promise));
    const first = results[0]; const second = results[1];
    if (first.kind === "Capacity" || second.kind === "Capacity") throw new Error("Shared source was not available");
    expect(first.unit === second.unit, "independent views did not share the exact immutable member").toBe(true);
    const retired = new WeakRef(first.unit);
    expect(retired.deref()?.canonical_text).toBe("A😀 B");
    expect(readers[0].residency.payloadBytes).toBeGreaterThan(before[0].payloadBytes);
    expect(leases[0].release()).toBe(true);
    cache.clear();
    await cdp().send("HeapProfiler.collectGarbage");
    expect(retired.deref()?.canonical_text, "clearing the cache retired a still-owned source").toBe("A😀 B");
    expect(second.unit.canonical_text).toBe("A😀 B");
    expect(readers[0].residency).toEqual(before[0]);
    expect(readers[1].residency.payloadBytes).toBeGreaterThan(before[1].payloadBytes);
    expect(leases[1].release()).toBe(true);
    expect(readers[1].residency).toEqual(before[1]);
    await cdp().send("HeapProfiler.collectGarbage");
    expect(retired.deref(), "released reader handles retained a source after its payload charge retired").toBeUndefined();
    // The retired handles deliberately remain reachable through this assertion.
    expect(leases.every((lease) => lease.released)).toBe(true);
    expect(() => first.unit).toThrow("Reader unit source has retired");
    expect(() => second.unit).toThrow("Reader unit source has retired");
  } finally { for (const reader of readers) reader.close(); progress.close(); cache.clear(); vi.unstubAllGlobals(); }
});
