import { afterEach, describe, expect, it, vi } from "vitest";
import { putWorkspaceSession } from "@/lib/workspace/sessionSync";
import {
  createWorkspaceStateFromPrimaryPanes,
  type WorkspaceState,
} from "@/lib/workspace/schema";

const state: WorkspaceState = createWorkspaceStateFromPrimaryPanes({
  activePrimaryPaneId: "pane-1",
  primaryPanes: [
    {
      id: "pane-1",
      href: "/media/123",
      primaryWidthPx: 684,
      visibility: "visible",
      history: { back: [], forward: [] },
      attachedSecondaryPaneId: null,
    },
  ],
});

function okResponse(): Response {
  return new Response(JSON.stringify({ data: null }), {
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("putWorkspaceSession", () => {
  it("PUTs the state with no device_id (the BFF injects it from the cookie)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());

    await putWorkspaceSession(state);

    const [path, init] = fetchSpy.mock.calls[0]!;
    expect(path).toBe("/api/me/workspace-session");
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ state });
    expect(body).not.toHaveProperty("device_id");
  });

  it("uses a keepalive PUT for the flush path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());

    await putWorkspaceSession(state, true);

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.keepalive).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({ state });
  });
});
