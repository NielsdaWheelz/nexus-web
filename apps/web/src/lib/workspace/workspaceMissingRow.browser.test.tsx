import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSessionWriter } from "./sessionSync";
import { WorkspaceSessionStore } from "./sessionStore";
import { createDefaultWorkspaceState, createPaneVisit, type WorkspaceState } from "./schema";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("a recovered missing row cannot acknowledge navigation captured during its read", async () => {
  // Keep the real IndexedDB event ordering; this proof explicitly drives delivery.
  const scheduleDelivery = () => () => {};
  const accountId = crypto.randomUUID();
  const seed = createDefaultWorkspaceState("/libraries", { primaryMinWidthPx: 684, primaryDefaultWidthPx: 684 });
  const paneId = seed.activePrimaryPaneId;
  const first: WorkspaceState = { ...seed, primaryPanesById: { ...seed.primaryPanesById,
    [paneId]: { ...seed.primaryPanesById[paneId], currentVisit: createPaneVisit("/notes") } } };
  const latest: WorkspaceState = { ...first, primaryPanesById: { ...first.primaryPanesById,
    [paneId]: { ...first.primaryPanesById[paneId], currentVisit: createPaneVisit("/lectern") } } };
  const writes: WorkspaceState[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body: { state: WorkspaceState } = JSON.parse(String(init?.body));
    writes.push(body.state);
    return Response.json({ data: body });
  });
  let retained!: () => void;
  const captured = new Promise<void>((resolve) => { retained = resolve; });
  let acknowledged!: () => void;
  const saved = new Promise<void>((resolve) => { acknowledged = resolve; });
  const writer = new WorkspaceSessionWriter(accountId, seed, (state) => {
    if (state.kind === "Pending") retained();
    if (state.kind === "Saved") acknowledged();
  }, null, scheduleDelivery);
  let recovery: WorkspaceSessionWriter | undefined;
  const get = IDBObjectStore.prototype.get;
  try {
    writer.capture(first);
    await captured;
    const store = new WorkspaceSessionStore();
    const row = await store.next(accountId);
    expect(row?.state).toEqual(first);
    let recovered!: () => void;
    const recoverySaved = new Promise<void>((resolve) => { recovered = resolve; });
    recovery = new WorkspaceSessionWriter(accountId, first, (state) => {
      if (state.kind === "Saved") recovered();
    }, row, scheduleDelivery);
    recovery.flush();
    await recoverySaved;
    recovery.close();
    expect(await store.next(accountId)).toBeNull();

    let armed = true;
    // Observe the real browser request before the awaiting writer resumes. No
    // database result or transaction is substituted.
    IDBObjectStore.prototype.get = function (key) {
      const request = get.call(this, key);
      if (armed && this.name === "sessions") {
        armed = false;
        request.addEventListener("success", () => { writer.capture(latest); }, { once: true });
      }
      return request;
    };
    writer.flush();
    await saved;
    expect(writes, "missing old row falsely acknowledged newer navigation").toEqual([first, latest]);
    expect(await store.next(accountId)).toBeNull();
  } finally {
    IDBObjectStore.prototype.get = get;
    writer.close();
    recovery?.close();
  }
});
