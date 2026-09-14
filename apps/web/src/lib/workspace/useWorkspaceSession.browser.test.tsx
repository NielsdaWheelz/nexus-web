import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultWorkspaceState,
  createPaneVisit,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import { useWorkspaceSession } from "@/lib/workspace/useWorkspaceSession";
import { WorkspaceSessionStore, type PendingWorkspaceSession } from "./sessionStore";

let accountId = crypto.randomUUID();

function SessionOwner({ state, recovered = null }: { state: WorkspaceState; recovered?: PendingWorkspaceSession | null }) {
  const { persistence, retry } = useWorkspaceSession(state, true, accountId, recovered);
  return <><output aria-label="Save status">{persistence.kind}</output><button onClick={retry}>Retry</button></>;
}

function navigate(state: WorkspaceState, href: string): WorkspaceState {
  const paneId = state.activePrimaryPaneId;
  return {
    ...state,
    primaryPanesById: {
      ...state.primaryPanesById,
      [paneId]: {
        ...state.primaryPanesById[paneId],
        currentVisit: createPaneVisit(href),
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  accountId = crypto.randomUUID();
});

it("keeps newer navigation behind the outstanding save", async () => {
  const writes: WorkspaceState[] = [];
  let acknowledge: (() => void) | undefined;
  let outstanding = 0;
  let overlapped = false;
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body: { state: WorkspaceState } = JSON.parse(String(init?.body));
    if (outstanding > 0) overlapped = true;
    outstanding += 1;
    writes.push(body.state);
    if (writes.length === 1) {
      await new Promise<void>((resolve) => { acknowledge = resolve; });
    }
    outstanding -= 1;
    return Response.json({ data: body });
  });
  const seed = createDefaultWorkspaceState("/libraries", {
    primaryMinWidthPx: 684, primaryDefaultWidthPx: 684,
  });
  const view = render(<SessionOwner state={seed} />);
  const first = navigate(seed, "/notes");
  view.rerender(<SessionOwner state={first} />);
  await waitFor(() => expect(writes).toEqual([first]), { timeout: 2000 });
  const latest = navigate(first, "/lectern");
  view.rerender(<SessionOwner state={latest} />);
  window.dispatchEvent(new Event("pagehide"));
  // Delivery is asynchronous: settle the newer capture through a real storage
  // round trip, by which point a writer that ignored the outstanding request is
  // already on the wire. The stub also records any overlapping dispatch.
  const store = new WorkspaceSessionStore();
  await waitFor(async () => expect((await store.next(accountId))?.state).toEqual(latest));
  expect(writes, "newer workspace save overtook the outstanding save").toEqual([first]);
  acknowledge?.();
  await waitFor(() => expect(writes).toEqual([first, latest]));
  expect(overlapped, "a workspace save was dispatched while another was outstanding").toBe(false);
});

it("delivers a layout whose only local copy vanished before it was sent", async () => {
  const writes: WorkspaceState[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body: { state: WorkspaceState } = JSON.parse(String(init?.body));
    writes.push(body.state);
    return Response.json({ data: body });
  });
  const seed = createDefaultWorkspaceState("/libraries", {
    primaryMinWidthPx: 684, primaryDefaultWidthPx: 684,
  });
  const view = render(<SessionOwner state={seed} />);
  const wanted = navigate(seed, "/notes");
  view.rerender(<SessionOwner state={wanted} />);
  const store = new WorkspaceSessionStore();
  const row = await waitFor(async () => {
    const stored = await store.next(accountId);
    expect(stored?.state).toEqual(wanted);
    if (stored === null) throw new Error("no retained workspace row");
    return stored;
  });
  // Eviction and cleared site data leave exactly this: an absent row that was
  // never delivered. Absence must not stand in for an acknowledgment.
  await store.remove(row);
  await waitFor(() => expect(writes).toEqual([wanted]), { timeout: 2000 });
  await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
  expect(await store.next(accountId)).toBeNull();
});

it("recovers a disposed owner's durable capture before saving the replacement", async () => {
  const writes: { body: unknown; keepalive: boolean }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), window.location.origin);
    const method = init?.method ?? request?.method ?? "GET";
    if (url.pathname !== "/api/me/workspace-session" || method !== "PUT") {
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }
    const body = init?.body ?? (request ? await request.text() : null);
    if (typeof body !== "string") throw new Error("Workspace PUT must contain JSON");
    writes.push({ body: JSON.parse(body), keepalive: init?.keepalive ?? false });
    return new Response(JSON.stringify({ data: JSON.parse(body) }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const metrics = { primaryMinWidthPx: 684, primaryDefaultWidthPx: 684 };
  const firstSeed = createDefaultWorkspaceState("/libraries", metrics);
  const { rerender, unmount } = render(<SessionOwner state={firstSeed} />);
  const closedCapture = navigate(firstSeed, "/notes");
  rerender(<SessionOwner state={closedCapture} />);
  const store = new WorkspaceSessionStore();
  await waitFor(async () => expect((await store.next(accountId))?.state).toEqual(closedCapture));
  unmount();

  const recovered = await store.next(accountId);
  const secondSeed = closedCapture;
  const view = render(<SessionOwner state={secondSeed} recovered={recovered} />);
  const liveCapture = navigate(secondSeed, "/lectern");
  view.rerender(<SessionOwner state={liveCapture} recovered={recovered} />);
  // B's real one-second debounce occurs after A's obsolete timer was due.
  await waitFor(() => {
    expect(writes).toContainEqual({ body: { state: liveCapture }, keepalive: false });
  }, { timeout: 2000 });
  expect(writes, "durable captures must survive the replacement lifecycle").toEqual([
    { body: { state: closedCapture }, keepalive: false },
    { body: { state: liveCapture }, keepalive: false },
  ]);

  const liveFlush = navigate(liveCapture, "/notes");
  view.rerender(<SessionOwner state={liveFlush} recovered={recovered} />);
  window.dispatchEvent(new Event("pagehide"));
  await waitFor(() => {
    expect(writes).toEqual([
      { body: { state: closedCapture }, keepalive: false },
      { body: { state: liveCapture }, keepalive: false },
      { body: { state: liveFlush }, keepalive: true },
    ]);
  });
});

it("retains an unacknowledged layout after gateway failure and retries it", async () => {
  let available = false;
  let failed = false;
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!available) failed = true;
    return new Response(available ? JSON.stringify({ data: JSON.parse(String(init?.body)) }) : "gateway unavailable", {
      status: available ? 200 : 502,
    });
  });
  const seed = createDefaultWorkspaceState("/libraries", {
    primaryMinWidthPx: 684, primaryDefaultWidthPx: 684,
  });
  const view = render(<SessionOwner state={seed} />);
  const wanted = navigate(seed, "/notes");
  view.rerender(<SessionOwner state={wanted} />);
  window.dispatchEvent(new Event("pagehide"));
  const store = new WorkspaceSessionStore();
  await waitFor(() => expect(failed).toBe(true));
  await waitFor(async () => expect((await store.next(accountId))?.state).toEqual(wanted));
  expect(screen.getByLabelText("Save status")).toHaveTextContent("SyncFailure");
  available = true;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
  expect(await store.next(accountId)).toBeNull();
});

it("still reaches the account when device storage is unavailable, never claiming local durability", async () => {
  const store = new WorkspaceSessionStore();
  await store.next(accountId);
  const availableStorage = indexedDB;
  vi.stubGlobal("indexedDB", {
    open() { throw new DOMException("Device storage is unavailable", "SecurityError"); },
  });
  const writes: WorkspaceState[] = [];
  let release: (() => void) | undefined;
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body: { state: WorkspaceState } = JSON.parse(String(init?.body));
    writes.push(body.state);
    await new Promise<void>((resolve) => { release = resolve; });
    return Response.json({ data: body });
  });
  const seed = createDefaultWorkspaceState("/libraries", {
    primaryMinWidthPx: 684, primaryDefaultWidthPx: 684,
  });
  const view = render(<SessionOwner state={seed} />);
  const wanted = navigate(seed, "/notes");
  view.rerender(<SessionOwner state={wanted} />);
  await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("LocalFailure"));
  // The server is the durability owner; the denied local row is recovery only.
  await waitFor(() => expect(writes).toEqual([wanted]), { timeout: 2000 });
  expect(screen.getByLabelText("Save status")).toHaveTextContent("LocalFailure");
  release?.();
  await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
  vi.stubGlobal("indexedDB", availableStorage);
  expect(await store.next(accountId)).toBeNull();
});

it("an old acknowledgment cannot delete a newer durable layout", async () => {
  const store = new WorkspaceSessionStore();
  const writerId = crypto.randomUUID();
  const seed = createDefaultWorkspaceState("/libraries", {
    primaryMinWidthPx: 684, primaryDefaultWidthPx: 684,
  });
  const first = { accountId, writerId, sequence: 1, state: seed };
  const latest = { ...first, sequence: 2, state: navigate(seed, "/notes") };
  await store.put(first);
  await store.put(latest);
  await store.remove(first);
  expect(await store.next(accountId)).toEqual(latest);
  expect(await store.next(crypto.randomUUID())).toBeNull();
  await store.remove(latest);
  expect(await store.next(accountId)).toBeNull();
});
