import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultWorkspaceState,
  createPaneVisit,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import { useWorkspaceSession } from "@/lib/workspace/useWorkspaceSession";

function SessionOwner({ state }: { state: WorkspaceState }) {
  useWorkspaceSession(state, true);
  return null;
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
});

it("cancels a replaced owner's pending capture while the live owner still saves and flushes", async () => {
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
    return new Response(JSON.stringify({ data: null }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const metrics = { primaryMinWidthPx: 684, primaryDefaultWidthPx: 684 };
  const firstSeed = createDefaultWorkspaceState("/libraries", metrics);
  const { rerender, unmount } = render(<SessionOwner state={firstSeed} />);
  rerender(<SessionOwner state={navigate(firstSeed, "/notes")} />);
  unmount();

  const secondSeed = createDefaultWorkspaceState("/conversations", metrics);
  const view = render(<SessionOwner state={secondSeed} />);
  const liveCapture = navigate(secondSeed, "/lectern");
  view.rerender(<SessionOwner state={liveCapture} />);
  // B's real one-second debounce occurs after A's obsolete timer was due.
  await waitFor(() => {
    expect(writes).toContainEqual({ body: { state: liveCapture }, keepalive: false });
  }, { timeout: 2000 });
  expect(writes, "A disposed workspace owner wrote during the replacement lifecycle").toEqual([
    { body: { state: liveCapture }, keepalive: false },
  ]);

  const liveFlush = navigate(liveCapture, "/notes");
  view.rerender(<SessionOwner state={liveFlush} />);
  window.dispatchEvent(new Event("pagehide"));
  await waitFor(() => {
    expect(writes).toEqual([
      { body: { state: liveCapture }, keepalive: false },
      { body: { state: liveFlush }, keepalive: true },
    ]);
  });
});
