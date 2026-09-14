import { afterEach, expect, it, vi } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY } from "./readerCapacity";

function json(value: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
}

const MEDIA = "11111111-1111-4111-8111-111111111111";
const unit = {
  fragment_id: MEDIA, fragment_idx: 0, fragment_document_start_cp: 0, fragment_length_cp: 4,
  document_word_start: 0, starts_in_word: false, epub_target: null, document_embeds: [],
  start_cp: 0, end_cp: 4, render_start_cp: 0, render_end_cp: 4,
  canonical_text: "text", word_boundaries: [0, 4], assets: [], table_contexts: [],
  render_nodes: [
    { kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] },
    { kind: "Text", parent: 0, text: "text" },
  ],
};
afterEach(() => vi.unstubAllGlobals());

it("releases the exact abandoned visit without cancelling the later visit's shared read or pin", async () => {
  const accountId = crypto.randomUUID();
  const capacity = { ...READER_CAPACITY, view: { ...READER_CAPACITY.view, maxUnits: 2 } };
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const session = createDocumentReaderSession({ mediaId: MEDIA, capacity,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, capacity.cache), capacity }),
    progress: runtime.createPort(MEDIA),
  });
  const memberBytes = new TextEncoder().encode(JSON.stringify(unit));
  const memberDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", memberBytes));
  const ref = { key: "units/0.json", bytes: memberBytes.byteLength,
    sha256: Array.from(memberDigest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
  const descriptor = { media_id: MEDIA, reader_generation: 2, reader_contract_version: 1, kind: "web_article", title: "Reader", canonical_length: 4,
    unit_count: 1, first_unit_ref: ref, contents_ref: null, table_metadata_ref: null, index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) },
  };
  const descriptorBytes = new TextEncoder().encode(JSON.stringify(descriptor));
  const descriptorDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", descriptorBytes));
  const representation = (body: Uint8Array<ArrayBuffer>, digest: Uint8Array<ArrayBuffer>) => new Response(body, { headers: {
    "Content-Type": "application/json", "Content-Length": String(body.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...digest))}:`, "X-Nexus-Reader-Generation": "2",
  } });
  let reads = 0;
  let resolveReads = 0;
  let signal: AbortSignal | null | undefined;
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return representation(descriptorBytes, descriptorDigest);
    if (path.endsWith("/offline-reader-state")) return json({ data: { accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } } });
    if (path.endsWith("/resolve")) {
      resolveReads += 1;
      return json({ data: { kind: "Unit", unit_ref: ref, ordinal: 0, previous_ref: null, next_ref: null, fragment_id: MEDIA, start_cp: 0, end_cp: 4 } });
    }
    if (path.endsWith("/units/0.json")) {
      reads += 1; signal = init?.signal;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    throw new Error(`Unexpected external request: ${path}`);
  });
  const loaded = await session.load(new AbortController().signal, { fresh: null, cold: null });
  if (!("document" in loaded) || loaded.document.kind === "Pdf") throw new Error("Text fixture did not select a publication");
  expect(reads, "initial authority load acquired an unowned view payload").toBe(0);
  expect(resolveReads, "initial authority resolved content outside its capacity owner").toBe(0);
  const address = await session.resolve(loaded.document.initial, new AbortController().signal);
  if (address.kind !== "Text" && address.kind !== "Unit") throw new Error("Text target did not resolve");
  const first = session.acquireUnit(address);
  const second = session.acquireUnit(address);
  if (first.kind !== "Acquired" || second.kind !== "Acquired") throw new Error("Independent view leases were not admitted");
  const cancelled = first.lease.promise.catch((error: unknown) => error);
  await vi.waitFor(() => expect(reads).toBe(1));
  expect(first.lease.release()).toBe(true);
  expect(signal?.aborted).toBe(false);
  expect(session.acquireUnit(address)).toEqual({ kind: "Capacity", reason: "Leases" });
  finish(representation(memberBytes, memberDigest));
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  const secondValue = await second.lease.promise;
  if (secondValue.kind !== "Unit") throw new Error("Adopted unit read lost admission");
  expect(secondValue.unit).toEqual(unit);
  second.lease.pin("Selection", true);
  expect(second.lease.pinned, "DOM retirement cannot inspect its authoritative selection pin").toBe(true);
  expect(second.lease.release()).toBe(false);
  const third = session.acquireUnit(address);
  if (third.kind !== "Acquired") throw new Error("Settled abandoned lease still occupies a view slot");
  first.lease.release();
  const thirdValue = await third.lease.promise;
  if (thirdValue.kind !== "Unit") throw new Error("Shared unit read lost admission");
  expect(thirdValue.unit).toBe(secondValue.unit);
  expect(reads).toBe(1);
  second.lease.pin("Selection", false);
  expect(second.lease.pinned).toBe(false);
  expect(second.lease.release()).toBe(true);
  expect(third.lease.release()).toBe(true);
  await expect(session.resolve({ kind: "Unit", unit_key: "units/missing.json" }, new AbortController().signal),
    "a different retained member satisfied an addressed-unit request").rejects.toMatchObject({ code: "E_INVALID_RESPONSE" });
  session.close(); runtime.close();
});

it("gives each find page its own retry owner instead of one budget for the traversal", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const session = createDocumentReaderSession({ mediaId: MEDIA, capacity: READER_CAPACITY,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
    progress: runtime.createPort(MEDIA),
  });
  const memberBytes = new TextEncoder().encode(JSON.stringify(unit));
  const memberDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", memberBytes));
  const ref = { key: "units/0.json", bytes: memberBytes.byteLength,
    sha256: Array.from(memberDigest, (byte) => byte.toString(16).padStart(2, "0")).join("") };
  const descriptorBytes = new TextEncoder().encode(JSON.stringify({ media_id: MEDIA, reader_generation: 2,
    reader_contract_version: 1, kind: "web_article", title: "Reader", canonical_length: 4, unit_count: 1,
    first_unit_ref: ref, contents_ref: null, table_metadata_ref: null,
    index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) } }));
  const descriptorDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", descriptorBytes));
  const occurrence = (start: number) => ({
    section_id: null, section_label: null, fragment_id: MEDIA, fragment_idx: 0,
    start_offset: start, end_offset: start + 2, snippet: [{ text: "te", emphasized: true }],
    locator: { kind: "web", target: { fragment_id: MEDIA },
      locations: { text_offset: start, progression: 0, total_progression: 0, position: 1 },
      text: { quote: null, quote_prefix: null, quote_suffix: null } },
  });
  // Two failed attempts on each page exhaust a single traversal budget; a
  // per-page owner admits both pages.
  const failures = { first: 2, continuation: 2 };
  let findReads = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) {
      return new Response(descriptorBytes, { headers: { "Content-Type": "application/json",
        "Content-Length": String(descriptorBytes.byteLength), "X-Nexus-Reader-Generation": "2",
        "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...descriptorDigest))}:` } });
    }
    if (path.endsWith("/offline-reader-state")) return json({ data: { accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } } });
    if (path.endsWith("/find")) {
      findReads += 1;
      const after: unknown = JSON.parse(String(init?.body)).after;
      const page = after === null ? "first" : "continuation";
      if (failures[page] > 0) { failures[page] -= 1; return new Response("Synthetic upstream failure", { status: 502 }); }
      return page === "first"
        ? json({ data: { occurrences: [occurrence(0)], next_cursor: "page-2" } })
        : json({ data: { occurrences: [occurrence(2)], next_cursor: null } });
    }
    throw new Error(`Unexpected external request: ${path}`);
  });
  try {
    await session.load(new AbortController().signal, { fresh: null, cold: null });
    const found = await session.find?.({ query: "te", match_case: false, whole_word: false, scope: { kind: "EntireResource" } },
      new AbortController().signal, {
        bytes: (result) => (result.kind === "Ready" ? result.occurrences.length * 64 : 0),
        create: (result) => ({ matches: result.kind === "Ready" ? result.occurrences.length : 0 }),
      });
    if (found?.kind !== "Acquired") throw new Error("Find traversal did not survive its per-page retries");
    expect(found.lease.result).toEqual({ matches: 2 });
    expect(findReads, "a find page reused another page's attempt budget").toBe(6);
    found.lease.release();
  } finally { session.close(); runtime.close(); }
}, 20_000);
