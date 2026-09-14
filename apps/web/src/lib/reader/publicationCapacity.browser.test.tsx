import { useMemo } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ReaderContentBoundary from "@/components/reader/ReaderContentBoundary";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { createHostedReaderSource, selectHostedReaderPublication } from "./ReaderDocumentSource";
import { READER_CAPACITY, readerCapacityNotice } from "./readerCapacity";
import { useDocumentReaderSession } from "./useDocumentReaderSession";

const MEDIA = "11111111-1111-4111-8111-111111111111";
const runtimes: HostedReaderProgressRuntime[] = [];
const originalSendBeacon = navigator.sendBeacon;

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: originalSendBeacon });
  vi.unstubAllGlobals();
});

function json(value: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
}

/** The API's terminal oversize refusal: 422, no Retry-After, naming the limit. */
function contentTooLarge(limit: string, measured: number): Response {
  return new Response(JSON.stringify({ error: {
    code: "E_READER_CONTENT_TOO_LARGE", message: "Reader content exceeds its qualified bound",
    details: { limit, limit_value: 262_144, measured },
  } }), { status: 422, headers: { "Content-Type": "application/json" } });
}

async function member(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { bytes, hash: new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)) };
}

function representation({ bytes, hash }: { bytes: Uint8Array<ArrayBuffer>; hash: Uint8Array<ArrayBuffer> }): Response {
  return new Response(bytes, { headers: {
    "Content-Type": "application/json", "Content-Length": String(bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...hash))}:`, "X-Nexus-Reader-Generation": "2",
  } });
}

async function publicationFixture() {
  const unit = await member({
    fragment_id: MEDIA, fragment_idx: 0, fragment_document_start_cp: 0, fragment_length_cp: 5,
    document_word_start: 0, starts_in_word: false, epub_target: null, document_embeds: [],
    start_cp: 0, end_cp: 5, render_start_cp: 0, render_end_cp: 5,
    canonical_text: "first", word_boundaries: [0, 5], assets: [], table_contexts: [],
    render_nodes: [{ kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] }, { kind: "Text", parent: 0, text: "first" }],
  });
  const unitRef = { key: "units/0.json", bytes: unit.bytes.byteLength,
    sha256: Array.from(unit.hash, (value) => value.toString(16).padStart(2, "0")).join("") };
  const descriptor = await member({ media_id: MEDIA, reader_generation: 2, reader_contract_version: 1,
    kind: "web_article", title: "Reader", canonical_length: 5, unit_count: 1,
    first_unit_ref: unitRef, contents_ref: null, table_metadata_ref: null,
    index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) } });
  return { descriptor, unitRef };
}

it("answers a refused oversize member as reader capacity after exactly one request", async () => {
  const accountId = crypto.randomUUID();
  const { descriptor, unitRef } = await publicationFixture();
  let descriptorReads = 0;
  let unitReads = 0;
  let descriptorRefuses = true;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) {
      descriptorReads += 1;
      return descriptorRefuses ? contentTooLarge("descriptor_bytes", 393_216) : representation(descriptor);
    }
    if (path.endsWith("/offline-reader-state")) {
      return json({ data: { accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } } });
    }
    if (path.endsWith("/resolve")) {
      return json({ data: { kind: "Unit", unit_ref: unitRef, ordinal: 0, previous_ref: null, next_ref: null,
        fragment_id: MEDIA, start_cp: 0, end_cp: 5 } });
    }
    if (path.endsWith("/units/0.json")) { unitReads += 1; return contentTooLarge("unit_bytes", 524_288); }
    throw new Error(`Unexpected external request: ${path}`);
  });

  const cache = new ResourceCache({}, READER_CAPACITY.cache);
  const refusedDescriptor = await selectHostedReaderPublication({ mediaId: MEDIA, signal: new AbortController().signal, capacity: READER_CAPACITY, cache });
  expect(refusedDescriptor, "a permanent oversize refusal was reported as a transport failure")
    .toEqual({ kind: "Capacity", reason: "Content" });
  expect(descriptorReads, "the selection replayed a refusal the API had already decided").toBe(1);

  descriptorRefuses = false;
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  runtimes.push(runtime);
  const session = createDocumentReaderSession({ mediaId: MEDIA, capacity: READER_CAPACITY,
    source: createHostedReaderSource({ accountId, cache, capacity: READER_CAPACITY }),
    progress: runtime.createPort(MEDIA) });
  const loaded = await session.load(new AbortController().signal, { fresh: null, cold: null });
  expect("document" in loaded, "the reader could not select the publication it was about to read").toBe(true);
  const acquisition = session.acquireUnit({ unit_ref: unitRef, ordinal: 0, previous_ref: null, next_ref: null });
  if (acquisition.kind !== "Acquired") throw new Error("Reader refused the unit before reading it");
  await expect(acquisition.lease.promise).resolves.toEqual({ kind: "Capacity", reason: "Content" });
  expect(unitReads, "the reader re-requested a member the API had refused to serve").toBe(1);
  expect(session.residency.leases, "a refused member kept a content lease").toBe(0);
  expect(readerCapacityNotice("Content").retryable, "a permanent refusal offered a retry").toBe(false);
  session.close();
});

function Reader({ accountId }: { accountId: string }) {
  const session = useMemo(() => {
    const runtime = new HostedReaderProgressRuntime(accountId, () => {});
    runtimes.push(runtime);
    return createDocumentReaderSession({ mediaId: MEDIA, capacity: READER_CAPACITY,
      source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
      progress: runtime.createPort(MEDIA) });
  }, [accountId]);
  const reader = useDocumentReaderSession({ session, loadCacheKey: MEDIA,
    retireUnits: () => true, initialTargets: { fresh: null, cold: null },
    progress: {
      capability: { state: "Readable", mediaId: MEDIA, locatorKind: "web" }, isPaneActive: true,
      handleUnauthenticatedError: () => false, reportDefect: (error) => { throw error; },
      captureCurrentLocator: () => null, applyCursor: async () => "applied",
      onTerminalWriteAcknowledged: () => {}, previewLease: { isActive: () => false },
    },
  });
  const notice = reader.capacity === null ? null : readerCapacityNotice(reader.capacity.reason);
  return <section aria-label="Reader">
    <output aria-label="Refusal">{reader.capacity?.reason ?? "None"}</output>
    <output aria-label="Notice">{notice === null ? "None" : `${notice.message} retryable=${String(notice.retryable)}`}</output>
    <ReaderContentBoundary defect={reader.contentDefect ?? null} ready={reader.units.length > 0} retry={reader.retryUnit}>
      <p>{reader.units.map((item) => item.unit.canonical_text).join("")}</p>
    </ReaderContentBoundary>
  </section>;
}

it("renders a refused oversize document as a permanent capacity notice without reporting a defect", async () => {
  const accountId = crypto.randomUUID();
  const { descriptor, unitRef } = await publicationFixture();
  const reports: unknown[] = [];
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: (_url: string, body: Blob) => {
    void body.text().then((text) => reports.push(JSON.parse(text)));
    return true;
  } });
  let unitReads = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return representation(descriptor);
    if (path.endsWith("/offline-reader-state")) {
      return json({ data: { accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } } });
    }
    if (path.endsWith("/resolve")) {
      return json({ data: { kind: "Unit", unit_ref: unitRef, ordinal: 0, previous_ref: null, next_ref: null,
        fragment_id: MEDIA, start_cp: 0, end_cp: 5 } });
    }
    if (path.endsWith("/units/0.json")) { unitReads += 1; return contentTooLarge("unit_bytes", 524_288); }
    throw new Error(`Unexpected external request: ${path}`);
  });

  render(<Reader accountId={accountId} />);
  await waitFor(() => expect(screen.getByLabelText("Refusal")).toHaveTextContent("Content"), { timeout: 4000 });
  expect(screen.getByLabelText("Notice"), "the reader offered to retry a permanent refusal")
    .toHaveTextContent("This document exceeds the supported size for this reader. retryable=false");
  expect(screen.queryByText("The reader couldn’t load this part."),
    "a decided capacity answer was rendered as a read failure with a Retry control").not.toBeInTheDocument();
  expect(unitReads, "the reader replayed an oversized member read").toBe(1);
  expect(reports, "a terminal refusal was beaconed as an exhausted read budget").toEqual([]);
}, 20_000);
