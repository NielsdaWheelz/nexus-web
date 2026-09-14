import { afterEach, expect, it, vi } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY } from "./readerCapacity";

afterEach(() => vi.unstubAllGlobals());

it("retains bounded paint independently of a retired unit, bounds each pool alone, and rejects another source extent", async () => {
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const accountId = crypto.randomUUID();
  const capacity = { ...READER_CAPACITY, view: { ...READER_CAPACITY.view, maxUnits: 2, maxQueryLeases: 2 } };
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const session = createDocumentReaderSession({ mediaId, capacity,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, capacity.cache), capacity }), progress: runtime.createPort(mediaId) });
  const encode = async (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { bytes, hash };
  };
  const member = await encode({ fragment_id: mediaId, fragment_idx: 0, fragment_document_start_cp: 0,
    fragment_length_cp: 4, document_word_start: 0, starts_in_word: false, epub_target: null, document_embeds: [],
    start_cp: 0, end_cp: 4, render_start_cp: 0, render_end_cp: 4, canonical_text: "text",
    word_boundaries: [0, 4], assets: [], table_contexts: [], render_nodes: [{ kind: "Text", parent: null, text: "text" }] });
  const reference = { key: "units/0.json", bytes: member.bytes.byteLength,
    sha256: Array.from(member.hash, (value) => value.toString(16).padStart(2, "0")).join("") };
  const descriptor = await encode({ media_id: mediaId, reader_generation: 2, reader_contract_version: 1,
    kind: "web_article", title: "Selected source", canonical_length: 4, unit_count: 1, first_unit_ref: reference,
    contents_ref: null, table_metadata_ref: null, index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) } });
  const representation = (value: typeof member) => new Response(value.bytes, { headers: {
    "Content-Type": "application/json", "Content-Length": String(value.bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...value.hash))}:`, "X-Nexus-Reader-Generation": "2",
  } });
  const json = (data: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data }));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
  };
  const paint = (start: number, end: number, next: string | null = null) => json({ items: [{ id: crypto.randomUUID(), color: "yellow", start_offset: start, end_offset: end,
    created_at: "2026-09-13T00:00:00Z", author_user_id: accountId, is_owner: true }], next_cursor: next });
  const heldResponse: { finish: ((value: Response) => void) | null } = { finish: null };
  let holdPaint = true;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return representation(descriptor);
    if (path.endsWith("/offline-reader-state")) return json({ accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } });
    if (path.endsWith("/units/0.json")) return representation(member);
    if (path.endsWith("/reader-publications/2/highlights")) {
      const query = JSON.parse(String(init?.body));
      expect(query).toEqual({ unit_key: reference.key, mine_only: false, after: query.after, limit: 100 });
      if (query.after === "second") return paint(2, 3);
      expect(query.after).toBeNull();
      if (!holdPaint) return paint(0, 1);
      return new Promise<Response>((resolve) => { heldResponse.finish = resolve; });
    }
    throw new Error(`Overlay escaped its selected generation: ${path}`);
  });
  try {
    const signal = new AbortController().signal;
    await session.load(signal, { fresh: null, cold: null });
    const address = { unit_ref: reference, ordinal: 0, previous_ref: null, next_ref: null };
    const first = session.acquireUnit(address);
    if (first.kind !== "Acquired" || session.overlays === null) throw new Error("Hosted overlay prerequisites were unavailable");
    const loaded = await first.lease.promise;
    if (loaded.kind !== "Unit") throw new Error("Selected source was not admitted");
    const pending = session.overlays({ kind: "Highlights", unit: { ...loaded, lease: first.lease }, mine_only: false }, signal);
    await vi.waitFor(() => expect(heldResponse.finish).not.toBeNull());
    expect(first.lease.release(), "overlay validation pinned retired content").toBe(true);
    heldResponse.finish!(paint(0, 1, "second"));
    const complete = await pending;
    if (complete.kind !== "Acquired") throw new Error("Retired source projection lost its admitted overlay");
    expect(complete.lease.result).toMatchObject({ kind: "Highlights", items: [{ start_offset: 0, end_offset: 1 }, { start_offset: 2, end_offset: 3 }] });
    const next = session.acquireUnit(address);
    if (next.kind !== "Acquired") throw new Error("Retired source still occupies a content lease");
    const nextUnit = await next.lease.promise;
    if (nextUnit.kind !== "Unit") throw new Error("Reopened source was not admitted");
    // Decoration leases and content residency answer to separate bounds: two
    // paint pages fill the query pool without denying the reader a third unit
    // of text, and the unit pool refuses only when the text itself is resident.
    holdPaint = false;
    const second = await session.overlays({ kind: "Highlights", unit: { ...nextUnit, lease: next.lease }, mine_only: false }, signal);
    if (second.kind !== "Acquired") throw new Error("Second paint page lost its query admission");
    expect(await session.overlays({ kind: "Highlights", unit: { ...nextUnit, lease: next.lease }, mine_only: false }, signal),
      "query pool admitted a paint page past its bound").toEqual({ kind: "Capacity", reason: "Leases" });
    const third = session.acquireUnit(address);
    if (third.kind !== "Acquired") throw new Error("A full query pool denied the reader its next unit of text");
    if ((await third.lease.promise).kind !== "Unit") throw new Error("Third source was not admitted");
    expect(session.acquireUnit(address), "content residency admitted a unit past its bound").toEqual({ kind: "Capacity", reason: "Leases" });
    third.lease.release();
    second.lease.release();
    complete.lease.release();
    holdPaint = true;
    heldResponse.finish = null;
    const escaped = session.overlays({ kind: "Highlights", unit: { ...nextUnit, lease: next.lease }, mine_only: false }, signal);
    await vi.waitFor(() => expect(heldResponse.finish).not.toBeNull());
    const rejected = expect(escaped, "paint escaped its selected unit").rejects.toThrow("escaped its retained unit");
    heldResponse.finish!(paint(0, 40));
    await rejected;
    next.lease.release();
  } finally { heldResponse.finish?.(paint(0, 3)); session.close(); runtime.close(); }
});
