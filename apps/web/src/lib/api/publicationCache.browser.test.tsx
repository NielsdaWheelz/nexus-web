import { afterEach, expect, it, vi } from "vitest";
import { ResourceCache, type PublicationUnitLease } from "./resourceCache";
import { readPublicationMember } from "@/lib/reader/publicationTransport";
import { decodeReaderPublicationUnit, type ReaderMemberRef } from "@/lib/reader/publicationContract";

const unit = {
  table_contexts: [],
  fragment_id: "11111111-1111-4111-8111-111111111111", fragment_idx: 0,
  document_word_start: 0, starts_in_word: false, epub_target: null, document_embeds: [],
  fragment_document_start_cp: 0, fragment_length_cp: 4,
  start_cp: 0, end_cp: 4, render_start_cp: 0, render_end_cp: 4,
  render_nodes: [
    { kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] },
    { kind: "Text", parent: 0, text: "A😀 B" },
  ], canonical_text: "A😀 B", word_boundaries: [0, 1, 2, 3, 4], assets: [],
};
afterEach(() => vi.unstubAllGlobals());

async function representation() {
  const bytes = new TextEncoder().encode(JSON.stringify(unit));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const reference: ReaderMemberRef = {
    key: "units/0.json", bytes: bytes.byteLength,
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
  return {
    reference,
    response: (generation: number) => new Response(bytes, { headers: {
      "Content-Type": "application/json", "Content-Length": String(bytes.byteLength),
      "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...digest))}:`,
      "X-Nexus-Reader-Generation": String(generation),
    } }),
  };
}

function acquire(cache: ResourceCache, reference: ReaderMemberRef, generation = 2) {
  return cache.acquirePublicationUnit({
    accountId: "account-a", mediaId: unit.fragment_id, generation, reference,
    read: async (signal) => (await readPublicationMember({
      path: `/api/media/${unit.fragment_id}/reader-publications/${generation}/units/0.json`,
      signal, maxBytes: reference.bytes, expected: reference, generation, decode: decodeReaderPublicationUnit,
    })).data,
  });
}

function lease(result: ReturnType<typeof acquire>): PublicationUnitLease {
  if (result.kind !== "Acquired") throw new Error(`Reader acquisition failed: ${result.reason}`);
  return result.lease;
}

it("shares immutable data while one of two independent views releases its lease", async () => {
  const { reference, response } = await representation();
  const cache = new ResourceCache({}, { maxPayloadBytes: reference.bytes * 22, maxReads: 1, reservedViewReads: 1 });
  let reads = 0;
  let readSignal: AbortSignal | null | undefined;
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", (_path: RequestInfo | URL, init?: RequestInit) => {
    reads += 1;
    readSignal = init?.signal;
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  const first = lease(acquire(cache, reference));
  const second = lease(acquire(cache, reference));
  const firstRead = first.promise;
  await vi.waitFor(() => expect(reads).toBe(1));
  first.release();
  expect(readSignal?.aborted, "closing one pane cancelled the other pane's read").toBe(false);
  finish(response(2));
  expect(await firstRead).toBe(await second.promise);
  expect(await second.promise).toEqual({ kind: "Unit", unit });
  expect(() => acquire(cache, { ...reference, sha256: "0".repeat(64) })).toThrow("Immutable reader member changed its representation");
  second.release();
  const retained = lease(acquire(cache, reference));
  expect(await retained.promise).toEqual({ kind: "Unit", unit });
  expect(reads).toBe(1);
  retained.release();
});

it("retains read admission until an abandoned transport actually settles", async () => {
  const { reference, response } = await representation();
  const cache = new ResourceCache({}, { maxPayloadBytes: reference.bytes * 22, maxReads: 1, reservedViewReads: 1 });
  let finish!: (response: Response) => void;
  let started!: () => void;
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal("fetch", async () => {
    started();
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  const abandoned = lease(acquire(cache, reference));
  const failed = abandoned.promise.catch((error: unknown) => error);
  await readStarted;
  abandoned.release();
  expect(acquire(cache, reference, 3), "adoption/release freed a still-running read slot").toEqual({ kind: "Capacity", reason: "Reads" });
  finish(response(2));
  expect(await failed).toMatchObject({ name: "AbortError" });
  vi.stubGlobal("fetch", async () => response(3));
  const replacement = lease(acquire(cache, reference, 3));
  expect(await replacement.promise).toEqual({ kind: "Unit", unit });
  replacement.release();
});

it("keeps pinned content charged and evicts it only after its last view releases", async () => {
  const { reference, response } = await representation();
  const cache = new ResourceCache({}, { maxPayloadBytes: reference.bytes * 11, maxReads: 2, reservedViewReads: 1 });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => response(String(input).includes("/3/") ? 3 : 2));
  const pinned = lease(acquire(cache, reference));
  expect(await pinned.promise).toEqual({ kind: "Unit", unit });
  expect(acquire(cache, reference, 3), "pinned content disappeared from the payload budget").toEqual({ kind: "Capacity", reason: "Payload" });
  pinned.release();
  const next = lease(acquire(cache, reference, 3));
  expect(await next.promise).toEqual({ kind: "Unit", unit });
  next.release();
});

it("keeps one read admitted across its retry schedule instead of reporting capacity", async () => {
  const { reference, response } = await representation();
  const cache = new ResourceCache({}, { maxPayloadBytes: reference.bytes * 22, maxReads: 1, reservedViewReads: 1 });
  let attempts = 0;
  vi.stubGlobal("fetch", async () => {
    attempts += 1;
    return attempts === 1
      ? new Response("upstream unavailable", { status: 503, headers: { "Retry-After": "1" } })
      : response(2);
  });
  const retrying = lease(acquire(cache, reference));
  await vi.waitFor(() => expect(attempts).toBe(1));
  expect(acquire(cache, reference, 3), "retry backoff released a slot the read still owed work")
    .toEqual({ kind: "Capacity", reason: "Reads" });
  expect(await retrying.promise, "a lost slot answered a retried upstream failure with capacity").toEqual({ kind: "Unit", unit });
  expect(attempts, "the retry schedule did not resume after its backoff").toBe(2);
  retrying.release();
});

it("keeps retained content when a read is refused before it starts", async () => {
  const { reference, response } = await representation();
  const cache = new ResourceCache({}, { maxPayloadBytes: reference.bytes * 11, maxReads: 1, reservedViewReads: 1 });
  let reads = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    reads += 1;
    return response(String(input).includes("/3/") ? 3 : 2);
  });
  const retained = lease(acquire(cache, reference));
  expect(await retained.promise).toEqual({ kind: "Unit", unit });
  retained.release();
  const viewRead = cache.acquireRead();
  if (viewRead.kind !== "Acquired") throw new Error("The reader pool refused a free read");
  expect(acquire(cache, reference, 3), "a full pool refused for the wrong reason").toEqual({ kind: "Capacity", reason: "Reads" });
  viewRead.release();
  const reused = lease(acquire(cache, reference));
  expect(await reused.promise).toEqual({ kind: "Unit", unit });
  expect(reads, "a refused read evicted content it never replaced").toBe(1);
  reused.release();
});

it("invalidates account lookups while retaining active view and physical read accounting", async () => {
  const { reference, response } = await representation();
  const cache = new ResourceCache({}, { maxPayloadBytes: reference.bytes * 11, maxReads: 1, reservedViewReads: 1 });
  let reads = 0;
  vi.stubGlobal("fetch", async () => { reads += 1; return response(2); });
  const active = lease(acquire(cache, reference));
  expect(await active.promise).toEqual({ kind: "Unit", unit });
  cache.clear();
  expect(acquire(cache, reference), "account invalidation stopped charging a still-mounted view").toEqual({ kind: "Capacity", reason: "Payload" });
  active.release();
  const fresh = lease(acquire(cache, reference));
  expect(await fresh.promise).toEqual({ kind: "Unit", unit });
  expect(reads, "old account lookup survived invalidation").toBe(2);
  fresh.release();
  cache.clear();

  let finish!: (response: Response) => void;
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal("fetch", async () => { started(); return new Promise<Response>((resolve) => { finish = resolve; }); });
  const abandoned = lease(acquire(cache, reference));
  const stopped = abandoned.promise.catch((error: unknown) => error);
  await start;
  cache.clear();
  expect(cache.acquireRead(), "account invalidation released unsettled physical work").toEqual({ kind: "Capacity", reason: "Reads" });
  finish(response(2));
  expect(await stopped).toMatchObject({ name: "AbortError" });
  abandoned.release();
  const available = cache.acquireRead();
  expect(available.kind).toBe("Acquired");
  if (available.kind === "Acquired") available.release();
});
