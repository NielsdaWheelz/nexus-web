import { afterEach, expect, it, vi } from "vitest";
import { ResourceCache, publicationPayloadBytes } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY } from "./readerCapacity";

afterEach(() => vi.unstubAllGlobals());

it("owns one bounded find result lease and distinguishes the 2001st match from a full 2000-match result", async () => {
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const session = createDocumentReaderSession({ mediaId, capacity: READER_CAPACITY,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
    progress: runtime.createPort(mediaId),
  });
  const descriptor = new TextEncoder().encode(JSON.stringify({ media_id: mediaId, reader_generation: 2,
    reader_contract_version: 1, kind: "web_article", title: "Reader", canonical_length: 5000,
    unit_count: 1, first_unit_ref: { key: "units/0.json", bytes: 1, sha256: "a".repeat(64) },
    contents_ref: null, table_metadata_ref: null, index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) },
  }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", descriptor));
  const json = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
  };
  let matchCount = 2001;
  const pages: (string | null)[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return new Response(descriptor, { headers: {
      "Content-Type": "application/json", "Content-Length": String(descriptor.byteLength),
      "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...digest))}:`, "X-Nexus-Reader-Generation": "2",
    } });
    if (path.endsWith("/offline-reader-state")) return json({ data: { accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } } });
    if (path.endsWith("/resolve")) return json({ data: { kind: "Unit", unit_ref: { key: "units/0.json", bytes: 1, sha256: "a".repeat(64) }, ordinal: 0,
      previous_ref: null, next_ref: null, fragment_id: mediaId, start_cp: 0, end_cp: 5000 } });
    if (path.endsWith("/find")) {
      const after = (JSON.parse(String(init?.body)).after ?? null) as string | null;
      pages.push(after);
      const start = after === null ? 0 : Number(after);
      const end = Math.min(start + 400, matchCount);
      return json({ data: { occurrences: Array.from({ length: end - start }, (_, offset) => ({
        section_id: null, section_label: null, fragment_id: mediaId, fragment_idx: 0,
        start_offset: (start + offset) * 2, end_offset: (start + offset) * 2 + 1,
        snippet: [{ text: "a", emphasized: true }],
        locator: { kind: "web", target: { fragment_id: mediaId },
          locations: { text_offset: (start + offset) * 2, progression: null, total_progression: null, position: null },
          text: { quote: null, quote_prefix: null, quote_suffix: null } },
      })), next_cursor: end < matchCount ? String(end) : null } });
    }
    throw new Error(`Unexpected external request: ${path}`);
  });
  try {
    const signal = new AbortController().signal;
    await session.load(signal, { fresh: null, cold: null });
    const query = { query: "a", match_case: false, whole_word: false, scope: { kind: "EntireResource" as const } };
    if (session.find === null) throw new Error("Hosted reader lost its Find capability");
    const overflow = await session.find(query, signal, { bytes: publicationPayloadBytes, create: (value) => value });
    expect(overflow).toMatchObject({ kind: "Acquired", lease: { result: { kind: "TooManyMatches", threshold: 2000 } } });
    if (overflow.kind !== "Acquired") throw new Error("Find did not acquire its bounded result lease");
    overflow.lease.release();
    expect(pages).toEqual([null, "400", "800", "1200", "1600", "2000"]);
    matchCount = 2000;
    const complete = await session.find(query, signal, { bytes: publicationPayloadBytes, create: (value) => value });
    if (complete.kind !== "Acquired") throw new Error("Find unexpectedly exhausted its released payload budget");
    expect(complete.lease.result).toMatchObject({ kind: "Ready" });
    if (complete.lease.result.kind !== "Ready") throw new Error("Exactly 2000 matches were treated as overflow");
    expect(complete.lease.result.occurrences).toHaveLength(2000);
    expect(complete.lease.result.occurrences[1999].locator).toMatchObject({
      kind: "web", target: { fragment_id: mediaId }, locations: { text_offset: 3998 },
    });
    complete.lease.release();
  } finally { session.close(); runtime.close(); }
});
