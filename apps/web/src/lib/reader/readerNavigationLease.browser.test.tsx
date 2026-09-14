import { afterEach, expect, it, vi } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY } from "./readerCapacity";
import { prepareReaderUnit } from "./publicationDom";

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

it("keeps the newer navigation and its prepared source charged through older completion and session close", async () => {
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
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return representation(descriptorBytes, descriptorDigest);
    if (path.endsWith("/offline-reader-state")) return json({ data: { accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } } });
    if (path.endsWith("/resolve")) {
      resolveReads += 1;
      return json({ data: { kind: "Unit", unit_ref: ref, ordinal: 0, previous_ref: null, next_ref: null, fragment_id: MEDIA, start_cp: 0, end_cp: 4 } });
    }
    if (path.endsWith("/units/0.json")) {
      reads += 1;
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
  const before = session.residency;
  const acquired = session.acquireUnit(address);
  if (acquired.kind !== "Acquired") throw new Error("Navigation source did not fit");
  await vi.waitFor(() => expect(reads).toBe(1));
  finish(representation(memberBytes, memberDigest));
  const source = await acquired.lease.promise;
  if (source.kind !== "Unit") throw new Error("Navigation source was refused");
  const prepared = prepareReaderUnit({ session, unit: source.unit, unitKey: ref.key, highlights: [], headingLevelOffset: 0 });
  if (prepared.kind !== "Ready") throw new Error("Navigation DOM did not fit");
  document.body.append(prepared.value.root);
  const oldCompletion = acquired.lease.holdNavigation();
  const currentCompletion = acquired.lease.holdNavigation();
  try {
    await Promise.resolve().finally(oldCompletion);
    expect(acquired.lease.release(), "older completion released the newer navigation source").toBe(false);
    expect(prepared.value.root).toBeVisible();
    expect(prepared.value.root).toHaveTextContent("text");
    const held = session.residency;
    expect(held.payloadBytes).toBeGreaterThan(before.payloadBytes);
    expect(held.domNodes).toBeGreaterThan(before.domNodes);
    session.close();
    expect(session.residency, "session close forgot a live navigation source").toEqual(held);
    oldCompletion();
    expect(acquired.lease.release(), "repeated older cleanup retired the current navigation").toBe(false);
    expect(prepared.value.root).toBeVisible();
    prepared.value.release();
    currentCompletion();
    expect(acquired.lease.released).toBe(true);
    expect(session.residency, "navigation retirement did not restore its prior occupancy").toEqual(before);
  } finally {
    prepared.value.release(); currentCompletion(); oldCompletion(); session.close(); runtime.close();
  }
});
