import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { HostedReaderProgressProvider } from "./HostedReaderProgressProvider";
import { ReaderIntentStore } from "./readerIntentStore";
import type { ReaderCursorSnapshot } from "./readerProgress";
import { readerResumeStatesEqual, type ReaderResumeState } from "./types";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const source = { kind: "Publication", reader_generation: 1 } as const;
const locator = (page: number): ReaderResumeState => ({ kind: "pdf", page, page_progression: null, zoom: null, position: null });
const positioned = (revision: number, page: number): ReaderCursorSnapshot => ({ state: "Positioned", source, revision, locator: locator(page) });
const empty = { state: "Empty", revision: 0 } as const;
afterEach(() => vi.unstubAllGlobals());

/** Browser site-data clearing removes the durable row under a live writer. */
async function evictReaderStorage(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("nexus-reader-pending");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

it("keeps live captured intent out of orphan replay and advances the baseline before a new capture", async () => {
  const accountId = crypto.randomUUID();
  let recovered!: () => void;
  const recoveryComplete = new Promise<void>((resolve) => { recovered = resolve; });
  const runtime = new HostedReaderProgressRuntime(accountId, () => recovered());
  const port = runtime.createPort(MEDIA_ID);
  const release = port.attach();
  port.bindSource(MEDIA_ID, source);
  let cursor: ReaderCursorSnapshot = empty;
  const writes: { baseRevision: number; locator: ReaderResumeState }[] = [];
  let firstStarted!: () => void;
  const firstWrite = new Promise<void>((resolve) => { firstStarted = resolve; });
  let completeFirst!: () => void;
  const heldWrite = new Promise<void>((resolve) => { completeFirst = resolve; });
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("X-Nexus-Expected-Account-Id")).toBe(accountId);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: number; locator: ReaderResumeState };
      writes.push(body);
      if (writes.length === 1) { firstStarted(); await heldWrite; }
      cursor = positioned(writes.length, writes.length + 1);
    }
    return Response.json({ data: { accountId, readerGeneration: 1, cursor } });
  });
  await port.load(MEDIA_ID);
  await port.capture(MEDIA_ID, locator(2));
  runtime.recover();
  await recoveryComplete;
  expect(writes).toHaveLength(0);
  const delivery = port.flush(MEDIA_ID);
  await firstWrite;
  await port.capture(MEDIA_ID, locator(3));
  completeFirst();
  expect(await delivery).toEqual({ kind: "Canonical", snapshot: positioned(2, 3) });
  await port.capture(MEDIA_ID, locator(4));
  await port.flush(MEDIA_ID);
  expect(writes.map((write) => write.baseRevision), "a capture resurrected an already acknowledged baseline").toEqual([0, 1, 2]);
  expect(writes.map((write) => write.locator)).toEqual([locator(2), locator(3), locator(4)]);
  expect(await runtime.store.next(accountId)).toBeNull();
  release();
  runtime.close();
});

it("reconciles a lost acknowledgment before showing a conflict or sending a duplicate mutation", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const port = runtime.createPort(MEDIA_ID);
  port.bindSource(MEDIA_ID, source);
  let cursor: ReaderCursorSnapshot = empty;
  let writes = 0;
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      writes += 1;
      cursor = positioned(1, 2);
      throw new TypeError("Connection ended after commit");
    }
    return Response.json({ data: { accountId, readerGeneration: 1, cursor } });
  });
  await port.load(MEDIA_ID);
  await port.capture(MEDIA_ID, locator(2));
  expect((await port.flush(MEDIA_ID)).kind).toBe("DurablyPending");
  expect(await port.load(MEDIA_ID)).toEqual({ kind: "Canonical", snapshot: positioned(1, 2) });
  expect(writes, "lost acknowledgment replayed an already committed mutation").toBe(1);
  expect(await runtime.store.next(accountId)).toBeNull();
  runtime.close();
});

it("reconciles another browser window's acknowledgment before capturing subsequent movement", async () => {
  const accountId = crypto.randomUUID();
  const owner = new HostedReaderProgressRuntime(accountId, () => {});
  const recovery = new HostedReaderProgressRuntime(accountId, () => {});
  const port = owner.createPort(MEDIA_ID);
  const release = port.attach();
  port.bindSource(MEDIA_ID, source);
  let cursor: ReaderCursorSnapshot = empty;
  const writes: number[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: number; locator: ReaderResumeState };
      writes.push(body.baseRevision);
      cursor = { state: "Positioned", source, revision: cursor.revision + 1, locator: body.locator };
    }
    return Response.json({ data: { accountId, readerGeneration: 1, cursor } });
  });
  await port.load(MEDIA_ID);
  await port.capture(MEDIA_ID, locator(2));
  const row = await recovery.store.next(accountId);
  if (row === null) throw new Error("Missing captured intent");
  await recovery.deliver(MEDIA_ID, row.writerId);
  expect(await port.flush(MEDIA_ID), "foreign acknowledgment left the active writer on a stale baseline")
    .toEqual({ kind: "Canonical", snapshot: positioned(1, 2) });
  await port.capture(MEDIA_ID, locator(3));
  expect(await port.flush(MEDIA_ID)).toEqual({ kind: "Canonical", snapshot: positioned(2, 3) });
  expect(writes).toEqual([0, 1]);
  release();
  owner.close();
  recovery.close();
});

it("never acknowledges the same locator with unknown source provenance", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const row = await runtime.store.capture({ accountId, writerId: crypto.randomUUID(), mediaId: MEDIA_ID,
    sequence: 1, source, locator: locator(2), baseline: empty });
  vi.stubGlobal("fetch", async () => Response.json({ data: {
    accountId, readerGeneration: 1,
    cursor: { ...positioned(1, 2), source: { kind: "Unresolved" } },
  } }));
  const result = await runtime.deliver(MEDIA_ID, row.writerId);
  expect(result.kind, "locator-only equality acknowledged unknown provenance").toBe("Conflict");
  expect((await runtime.store.next(accountId))?.desired.locator).toEqual(locator(2));
  runtime.close();
});

it("a delayed authority read cannot regress an acknowledged writer's next revision", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const port = runtime.createPort(MEDIA_ID);
  port.bindSource(MEDIA_ID, source);
  let cursor: ReaderCursorSnapshot = empty;
  let reads = 0;
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  const writes: number[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: number; locator: ReaderResumeState };
      writes.push(body.baseRevision);
      cursor = { state: "Positioned", source, revision: cursor.revision + 1, locator: body.locator };
    } else if (++reads === 2) {
      readStarted();
      await heldRead;
      return Response.json({ data: { accountId, readerGeneration: 1, cursor: empty } });
    }
    return Response.json({ data: { accountId, readerGeneration: 1, cursor } });
  });
  await port.load(MEDIA_ID);
  const oldRead = port.load(MEDIA_ID);
  await started;
  await port.capture(MEDIA_ID, locator(2));
  await port.flush(MEDIA_ID);
  releaseRead();
  await oldRead;
  await port.capture(MEDIA_ID, locator(3));
  expect(await port.flush(MEDIA_ID), "stale read regressed an acknowledged writer baseline")
    .toEqual({ kind: "Canonical", snapshot: positioned(2, 3) });
  expect(writes).toEqual([0, 1]);
  runtime.close();
});

it("accepts completion by another browser context and retains intents through reconciliation outages", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  vi.stubGlobal("fetch", async () => Response.json({ data: { accountId, readerGeneration: 1, cursor: positioned(1, 2) } }));
  expect(await runtime.deliver(MEDIA_ID, crypto.randomUUID()),
    "a writer with no stored intent was handed an acknowledgment of unrelated canonical state")
    .toEqual({ kind: "Absent", authority: { source, cursor: positioned(1, 2) } });
  const row = await runtime.store.capture({ accountId, writerId: crypto.randomUUID(), mediaId: MEDIA_ID,
    sequence: 1, source, locator: locator(3), baseline: positioned(1, 2) });
  let attempts = 0;
  vi.stubGlobal("fetch", async () => { attempts += 1; return new Response(null, { status: 503 }); });
  expect((await runtime.deliver(MEDIA_ID, row.writerId)).kind).toBe("DurablyPending");
  expect(attempts).toBe(3);
  expect((await runtime.store.next(accountId))?.desired.locator).toEqual(locator(3));
  runtime.close();
});

it("finishes a started capture after account teardown without dispatching it under a later account", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const port = runtime.createPort(MEDIA_ID);
  port.bindSource(MEDIA_ID, source);
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests += 1;
    return Response.json({ data: { accountId, readerGeneration: 1, cursor: empty } });
  });
  await port.load(MEDIA_ID);
  const captured = port.capture(MEDIA_ID, locator(2));
  runtime.close();
  expect((await captured).kind).toBe("DurablyPending");
  await expect(port.flush(MEDIA_ID)).rejects.toThrow("account lifetime ended");
  expect(requests).toBe(1);
  expect((await runtime.store.next(accountId))?.desired.locator).toEqual(locator(2));
});

it("a storage failure never claims that movement is durably pending or dispatches it", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const port = runtime.createPort(MEDIA_ID);
  port.bindSource(MEDIA_ID, source);
  let writes = 0;
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") writes += 1;
    return Response.json({ data: { accountId, readerGeneration: 1, cursor: empty } });
  });
  await port.load(MEDIA_ID);
  // A browser storage transition closes the existing connection, then denies
  // reopening. No pending work exists before this test-owned database removal.
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("nexus-reader-pending");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  const availableStorage = indexedDB;
  vi.stubGlobal("indexedDB", {
    open() { throw new DOMException("Storage is unavailable", "SecurityError"); },
  });
  await expect(port.capture(MEDIA_ID, locator(2))).rejects.toThrow("Storage is unavailable");
  vi.stubGlobal("indexedDB", availableStorage);
  await expect(port.flush(MEDIA_ID)).rejects.toThrow("Storage is unavailable");
  expect(await runtime.store.next(accountId)).toBeNull();
  expect(writes).toBe(0);
  runtime.close();
});

it("recovers independent writers and applies a visible conflict choice to its exact orphan", async () => {
  const accountId = crypto.randomUUID();
  const otherMediaId = "22222222-2222-4222-8222-222222222222";
  const store = new ReaderIntentStore();
  const conflict = await store.capture({ accountId, writerId: "00000000-0000-4000-8000-000000000001",
    mediaId: MEDIA_ID, sequence: 1, source, locator: locator(2), baseline: empty });
  const independent = await store.capture({ accountId, writerId: "00000000-0000-4000-8000-000000000002",
    mediaId: otherMediaId, sequence: 1, source, locator: locator(4), baseline: empty });
  const cursors = new Map<string, ReaderCursorSnapshot>([[MEDIA_ID, positioned(1, 7)], [otherMediaId, empty]]);
  const writes: { mediaId: string; baseRevision: number }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const mediaId = new URL(String(input), location.origin).pathname.split("/")[3]!;
    let cursor = cursors.get(mediaId);
    if (cursor === undefined) throw new Error("Unexpected media request");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: number; locator: ReaderResumeState };
      writes.push({ mediaId, baseRevision: body.baseRevision });
      cursor = { state: "Positioned", source, revision: cursor.revision + 1, locator: body.locator };
      cursors.set(mediaId, cursor);
    }
    return Response.json({ data: { accountId, readerGeneration: 1, cursor } });
  });
  const metrics = { primaryMinWidthPx: 684, primaryDefaultWidthPx: 684 };
  const view = render(<FeedbackProvider><PaneReturnMementoProvider><WorkspaceStoreProvider workspacePrimaryMetrics={metrics}
    initialState={createDefaultWorkspaceState("/libraries", metrics)}>
    <HostedReaderProgressProvider accountId={accountId}><p>Unrelated pane remains available</p></HostedReaderProgressProvider>
  </WorkspaceStoreProvider></PaneReturnMementoProvider></FeedbackProvider>);
  expect(await screen.findByText("Two reading views saved different positions.")).toBeVisible();
  expect(await store.get(accountId, independent.writerId)).toBeNull();
  expect((await store.get(accountId, conflict.writerId))?.desired.locator).toEqual(locator(2));
  await userEvent.click(screen.getByRole("button", { name: "Keep this saved position" }));
  await waitFor(async () => expect(await store.get(accountId, conflict.writerId)).toBeNull());
  expect(cursors.get(MEDIA_ID)).toEqual(positioned(2, 2));
  expect(cursors.get(otherMediaId)).toEqual(positioned(1, 4));
  expect(writes).toEqual([{ mediaId: otherMediaId, baseRevision: 0 }, { mediaId: MEDIA_ID, baseRevision: 1 }]);
  expect(screen.getByText("Unrelated pane remains available")).toBeVisible();
  view.unmount();
});

it("classifies an absent row against canonical state instead of acknowledging what this writer never sent", async () => {
  const accountId = crypto.randomUUID();
  const owner = new HostedReaderProgressRuntime(accountId, () => {});
  const foreign = new HostedReaderProgressRuntime(accountId, () => {});
  const port = owner.createPort(MEDIA_ID);
  const release = port.attach();
  port.bindSource(MEDIA_ID, source);
  let cursor: ReaderCursorSnapshot = empty;
  let reads = 0;
  const writes: ReaderResumeState[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { locator: ReaderResumeState };
      writes.push(body.locator);
      cursor = { state: "Positioned", source, revision: cursor.revision + 1, locator: body.locator };
    } else reads += 1;
    return Response.json({ data: { accountId, readerGeneration: 1, cursor } });
  });
  await port.load(MEDIA_ID);
  await port.capture(MEDIA_ID, locator(2));
  const row = await foreign.store.next(accountId);
  if (row === null) throw new Error("Missing captured intent");
  await foreign.deliver(MEDIA_ID, row.writerId);
  expect(await owner.store.next(accountId), "the foreign delivery left the row in place").toBeNull();
  // Another device moves on before this writer drains its now-absent row.
  cursor = positioned(2, 9);
  const before = reads;
  expect(await port.flush(MEDIA_ID), "an absent row acknowledged a position this writer never submitted")
    .toEqual({ kind: "Conflict", canonical: positioned(2, 9), source, device: locator(2) });
  expect(reads - before, "the absent row was reclassified repeatedly").toBe(1);
  expect(writes).toEqual([locator(2)]);
  release();
  owner.close();
  foreign.close();
});

it("replays an evicted attempt against its unchanged base", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const port = runtime.createPort(MEDIA_ID);
  const release = port.attach();
  port.bindSource(MEDIA_ID, source);
  let cursor: ReaderCursorSnapshot = empty;
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: number; locator: ReaderResumeState };
      writes.push(body);
      cursor = { state: "Positioned", source, revision: cursor.revision + 1, locator: body.locator };
    }
    return Response.json({ data: { accountId, readerGeneration: 1, cursor } });
  });
  await port.load(MEDIA_ID);
  await port.capture(MEDIA_ID, locator(2));
  await evictReaderStorage();
  expect(await runtime.store.next(accountId), "the eviction left the durable row in place").toBeNull();
  expect(await port.flush(MEDIA_ID), "an evicted attempt was dropped or acknowledged as canonical")
    .toEqual({ kind: "Canonical", snapshot: positioned(1, 2) });
  expect(writes).toEqual([{ expectedReaderGeneration: 1, baseRevision: 0, locator: locator(2) }]);
  expect(await runtime.store.next(accountId)).toBeNull();
  release();
  runtime.close();
});

it("absorbs a duplicate delivery that lost the revision cas", async () => {
  const accountId = crypto.randomUUID();
  const owner = new HostedReaderProgressRuntime(accountId, () => {});
  const duplicate = new HostedReaderProgressRuntime(accountId, () => {});
  const port = owner.createPort(MEDIA_ID);
  const release = port.attach();
  port.bindSource(MEDIA_ID, source);
  let cursor: ReaderCursorSnapshot = empty;
  let reads = 0;
  let writes = 0;
  let conflicts = 0;
  let duplicateRead!: () => void;
  const secondRead = new Promise<void>((resolve) => { duplicateRead = resolve; });
  let releaseDuplicate!: () => void;
  const heldRead = new Promise<void>((resolve) => { releaseDuplicate = resolve; });
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: number; locator: ReaderResumeState };
      writes += 1;
      if (body.baseRevision !== cursor.revision) {
        conflicts += 1;
        return Response.json({ error: { code: "E_READER_STATE_CONFLICT", message: "Stale reader revision", details: { current: cursor } } }, { status: 409 });
      }
      cursor = { state: "Positioned", source, revision: cursor.revision + 1, locator: body.locator };
      return Response.json({ data: { accountId, readerGeneration: 1, cursor } });
    }
    // Both contexts read the same pre-write state; only one write can win.
    const observed = cursor;
    if (++reads === 2) { duplicateRead(); await heldRead; }
    return Response.json({ data: { accountId, readerGeneration: 1, cursor: observed } });
  });
  await port.load(MEDIA_ID);
  await port.capture(MEDIA_ID, locator(2));
  const row = await duplicate.store.next(accountId);
  if (row === null) throw new Error("Missing captured intent");
  const other = duplicate.deliver(MEDIA_ID, row.writerId);
  await secondRead;
  expect(await port.flush(MEDIA_ID)).toEqual({ kind: "Canonical", snapshot: positioned(1, 2) });
  releaseDuplicate();
  expect(await other, "a duplicate delivery of one frozen attempt raised a false conflict")
    .toEqual({ kind: "Canonical", snapshot: positioned(1, 2) });
  expect([writes, conflicts]).toEqual([2, 1]);
  expect(await owner.store.next(accountId)).toBeNull();
  release();
  owner.close();
  duplicate.close();
});

it("dispatches an unchanged position so a read-only visit still records engagement", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const port = runtime.createPort(MEDIA_ID);
  const release = port.attach();
  port.bindSource(MEDIA_ID, source);
  let cursor: ReaderCursorSnapshot = positioned(1, 2);
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: number; locator: ReaderResumeState };
      writes.push(body);
      // The cursor service keeps the revision for an equal locator and still
      // records engagement; a different locator advances the revision.
      if (cursor.state !== "Positioned" || !readerResumeStatesEqual(cursor.locator, body.locator)) {
        cursor = { state: "Positioned", source, revision: cursor.revision + 1, locator: body.locator };
      }
    }
    return Response.json({ data: { accountId, readerGeneration: 1, cursor } });
  });
  await port.load(MEDIA_ID);
  await port.capture(MEDIA_ID, locator(2));
  expect(await port.flush(MEDIA_ID)).toEqual({ kind: "Canonical", snapshot: positioned(1, 2) });
  expect(writes, "an unchanged position never reached the engagement owner")
    .toEqual([{ expectedReaderGeneration: 1, baseRevision: 1, locator: locator(2) }]);
  expect(await runtime.store.next(accountId)).toBeNull();
  release();
  runtime.close();
});
