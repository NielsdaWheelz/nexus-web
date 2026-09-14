import { useMemo, useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import ReaderContentBoundary from "@/components/reader/ReaderContentBoundary";
import { PaneRouteErrorBoundary } from "@/components/workspace/PaneRouteErrorBoundary";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { READER_CAPACITY } from "./readerCapacity";
import { useDocumentReaderSession } from "./useDocumentReaderSession";

function json(value: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
}

const MEDIA = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const runtimes: HostedReaderProgressRuntime[] = [];
const originalSendBeacon = navigator.sendBeacon;
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: originalSendBeacon });
  vi.unstubAllGlobals();
});

function Reader({ mediaId, accountId }: { mediaId: string; accountId: string }) {
  const session = useMemo(() => {
    const runtime = new HostedReaderProgressRuntime(accountId, () => {});
    runtimes.push(runtime);
    return createDocumentReaderSession({ mediaId, capacity: READER_CAPACITY,
      source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
      progress: runtime.createPort(mediaId),
    });
  }, [mediaId, accountId]);
  const [draft, setDraft] = useState("");
  const reader = useDocumentReaderSession({ session, loadCacheKey: mediaId,
    retireUnits: () => true, initialTargets: { fresh: null, cold: null },
    progress: {
      capability: { state: "Readable", mediaId, locatorKind: "web" }, isPaneActive: true,
      handleUnauthenticatedError: () => false, reportDefect: (error) => { throw error; },
      captureCurrentLocator: () => null, applyCursor: async () => "applied",
      onTerminalWriteAcknowledged: () => {}, previewLease: { isActive: () => false },
    },
  });
  return <section aria-label={mediaId === MEDIA ? "Reader" : "Other reader"}>
    <input aria-label="Note draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    <ReaderContentBoundary defect={reader.contentDefect ?? null} ready={reader.units.length > 0} retry={reader.retryUnit}>
      <div data-testid="content">{reader.units.map((item) => <p key={item.address.unit_ref.key}>{item.unit.canonical_text}</p>)}</div>
    </ReaderContentBoundary>
    <button onClick={() => reader.loadNeighbor("Next")}>Next part</button>
    <button onClick={() => reader.navigate({ kind: "Unit", unit_key: "units/0.json" })}>Start part</button>
  </section>;
}

it("contains exhausted authority and neighbor reads while preserving drafts, the other reader, and the selected publication on retry", async () => {
  const accountId = crypto.randomUUID();
  const encoded = await Promise.all(["first", "second"].map(async (text, ordinal) => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      fragment_id: MEDIA, fragment_idx: 0, fragment_document_start_cp: 0, fragment_length_cp: 11,
      document_word_start: ordinal, starts_in_word: false, epub_target: null, document_embeds: [],
      start_cp: ordinal === 0 ? 0 : 5, end_cp: ordinal === 0 ? 5 : 11,
      render_start_cp: ordinal === 0 ? 0 : 5, render_end_cp: ordinal === 0 ? 5 : 11,
      canonical_text: text, word_boundaries: [ordinal === 0 ? 0 : 5, ordinal === 0 ? 5 : 11], assets: [], table_contexts: [],
      render_nodes: [{ kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] }, { kind: "Text", parent: 0, text }],
    }));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { bytes, hash, ref: { key: `units/${ordinal}.json`, bytes: bytes.byteLength,
      sha256: Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("") } };
  }));
  const first = encoded[0]!; const second = encoded[1]!;
  const descriptors = new Map(await Promise.all([MEDIA, OTHER].map(async (mediaId) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ media_id: mediaId, reader_generation: 2,
      reader_contract_version: 1, kind: "web_article", title: "Reader", canonical_length: 11,
      unit_count: 2, first_unit_ref: first.ref, contents_ref: null, table_metadata_ref: null, index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) },
    }));
    return [mediaId, { bytes, hash: new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)) }] as const;
  })));
  const representation = ({ bytes, hash }: { bytes: Uint8Array<ArrayBuffer>; hash: Uint8Array<ArrayBuffer> }) => new Response(bytes, { headers: {
    "Content-Type": "application/json", "Content-Length": String(bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...hash))}:`, "X-Nexus-Reader-Generation": "2",
  } });
  let authorityFails = true; let neighborFails = true; let holdNeighbor = false;
  let finishNeighbor: ((response: Response) => void) | null = null;
  let descriptorReads = 0; let authorityFailures = 0; let neighborFailures = 0;
  const reports: unknown[] = [];
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: (_url: string, body: Blob) => {
    void body.text().then((text) => reports.push(JSON.parse(text)));
    return true;
  } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const mediaId = path.includes(MEDIA) ? MEDIA : OTHER;
    if (path.endsWith("/reader-publication")) {
      if (mediaId === MEDIA) descriptorReads += 1;
      return representation(descriptors.get(mediaId)!);
    }
    if (path.endsWith("/offline-reader-state")) {
      if (mediaId === MEDIA && authorityFails) { authorityFailures += 1; return new Response("gateway down", { status: 502 }); }
      return json({ data: { accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } } });
    }
    if (path.endsWith("/resolve")) {
      const key = JSON.parse(String(init?.body)).target.unit_key;
      const next = key === second.ref.key;
      return json({ data: { kind: "Unit", unit_ref: next ? second.ref : first.ref,
        ordinal: next ? 1 : 0, previous_ref: next ? first.ref : null, next_ref: next ? null : second.ref,
        fragment_id: MEDIA, start_cp: next ? 5 : 0, end_cp: next ? 11 : 5,
      } });
    }
    if (path.endsWith("/units/0.json")) return representation(first);
    if (path.endsWith("/units/1.json")) {
      if (neighborFails) { neighborFailures += 1; return new Response("gateway down", { status: 502 }); }
      if (holdNeighbor) return new Promise<Response>((resolve) => { finishNeighbor = resolve; });
      return representation(second);
    }
    throw new Error(`Unexpected external request: ${path}`);
  });
  render(<>
    <PaneRouteErrorBoundary paneId="reader" visitId="reader" resetKey="reader" slotMinWidth="0" isActive={false}>
      <Reader mediaId={MEDIA} accountId={accountId} />
    </PaneRouteErrorBoundary>
    <Reader mediaId={OTHER} accountId={accountId} />
  </>);
  const pane = within(screen.getByRole("region", { name: "Reader" }));
  const other = within(screen.getByRole("region", { name: "Other reader" }));
  const draft = pane.getByRole("textbox", { name: "Note draft" });
  await userEvent.fill(draft, "unfinished note");
  const otherText = await other.findByText("first");
  expect(await pane.findByText("The reader couldn’t load this part.", {}, { timeout: 4000 })).toBeVisible();
  expect(draft).toHaveValue("unfinished note");
  expect(authorityFailures).toBe(3);
  authorityFails = false;
  await userEvent.click(pane.getByRole("button", { name: "Retry reader" }));
  const firstText = await pane.findByText("first");
  expect(descriptorReads, "retry selected a different publication").toBe(1);
  await userEvent.click(pane.getByRole("button", { name: "Next part" }));
  expect(await pane.findByText("The reader couldn’t load this part.", {}, { timeout: 4000 })).toBeVisible();
  expect(neighborFailures).toBe(3);
  expect(firstText.isConnected, "refresh exhaustion detached admitted content").toBe(true);
  neighborFails = false;
  holdNeighbor = true;
  await userEvent.click(pane.getByRole("button", { name: "Retry reader" }));
  await waitFor(() => expect(finishNeighbor).not.toBeNull());
  await userEvent.click(pane.getByRole("button", { name: "Start part" }));
  holdNeighbor = false;
  finishNeighbor!(new Response("obsolete gateway failure", { status: 502 }));
  await userEvent.click(pane.getByRole("button", { name: "Next part" }));
  expect(await pane.findByText("second")).toBeVisible();
  expect(pane.queryByText("The reader couldn’t load this part.")).not.toBeInTheDocument();
  expect(pane.getByRole("textbox", { name: "Note draft" })).toBe(draft);
  expect(draft).toHaveValue("unfinished note");
  expect(other.getByText("first")).toBe(otherText);
  await waitFor(() => expect(reports).toHaveLength(2));
  expect(reports).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "ReaderContent", error_code: "E_RETRY_EXHAUSTED" })]));
}, 20_000);
