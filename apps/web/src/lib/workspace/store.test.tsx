import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_MEDIA_PANE_WIDTH_PX,
  MAX_STANDARD_PANE_WIDTH_PX,
} from "@/lib/workspace/schema";
import {
  resolveWorkspacePaneTitle,
  useWorkspaceStore,
  WorkspaceStoreProvider,
} from "@/lib/workspace/store";

type WorkspaceStore = ReturnType<typeof useWorkspaceStore>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function mockWorkspaceSession() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin);

    if (url.pathname === "/api/me/workspace-session" && init?.method === "PUT") {
      return jsonResponse({ data: null });
    }
    if (url.pathname === "/api/me/workspace-session") {
      return jsonResponse({
        data: { own: null, most_recent_elsewhere: null },
      });
    }

    throw new Error(`Unexpected fetch call: ${url.pathname}`);
  });
}

function StoreProbe({ onStore }: { onStore: (store: WorkspaceStore) => void }) {
  onStore(useWorkspaceStore());
  return null;
}

async function mountWorkspaceStore(path = "/libraries") {
  window.history.replaceState({}, "", path);
  mockWorkspaceSession();

  let store: WorkspaceStore | null = null;

  render(
    <WorkspaceStoreProvider>
      <StoreProbe onStore={(nextStore) => { store = nextStore; }} />
    </WorkspaceStoreProvider>,
  );

  const workspace = () => {
    if (!store) {
      throw new Error("Workspace store has not mounted yet");
    }
    return store;
  };

  await waitFor(() => {
    expect(workspace().state.panes.length).toBeGreaterThan(0);
  });

  return workspace;
}

function activeHref(store: WorkspaceStore): string {
  return store.state.panes.find((pane) => pane.id === store.state.activePaneId)?.href ?? "";
}

function flushWorkspaceSession() {
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
}

describe("WorkspaceStoreProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
  });

  it("opens a pane after the opener and activates it", async () => {
    const workspace = await mountWorkspaceStore();
    const openerPaneId = workspace().state.activePaneId;

    act(() => {
      workspace().openPane({ href: "/conversations", openerPaneId });
    });

    await waitFor(() => {
      expect(workspace().state.panes.map((pane) => pane.href)).toEqual([
        "/libraries",
        "/conversations",
      ]);
    });
    expect(activeHref(workspace())).toBe("/conversations");
    expect(workspace().state.panes[1]?.visibility).toBe("visible");
    flushWorkspaceSession();
  });

  it("reuses an existing resource pane instead of duplicating it", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");

    act(() => {
      workspace().openPane({ href: "/conversations/conversation-1?run=run-old" });
    });
    await waitFor(() => {
      expect(activeHref(workspace())).toBe("/conversations/conversation-1?run=run-old");
    });
    const conversationPaneId = workspace().state.activePaneId;

    act(() => {
      workspace().openPane({ href: "/conversations/conversation-1?run=run-new" });
    });

    await waitFor(() => {
      expect(workspace().state.panes).toHaveLength(2);
      expect(workspace().state.activePaneId).toBe(conversationPaneId);
      expect(activeHref(workspace())).toBe("/conversations/conversation-1?run=run-new");
    });
    flushWorkspaceSession();
  });

  it("navigates and clamps pane width through the public store action", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePaneId;

    act(() => {
      workspace().resizePane(paneId, 99999);
    });
    await waitFor(() => {
      expect(workspace().state.panes[0]?.widthPx).toBe(MAX_MEDIA_PANE_WIDTH_PX);
    });

    act(() => {
      workspace().navigatePane(paneId, "/libraries");
    });
    await waitFor(() => {
      expect(workspace().state.panes[0]?.href).toBe("/libraries");
      expect(workspace().state.panes[0]?.widthPx).toBe(MAX_STANDARD_PANE_WIDTH_PX);
      expect(workspace().state.activePaneId).toBe(paneId);
    });
    flushWorkspaceSession();
  });

  it("keeps the last visible pane open and restores minimized panes", async () => {
    const workspace = await mountWorkspaceStore();
    const firstPaneId = workspace().state.activePaneId;

    act(() => {
      workspace().minimizePane(firstPaneId);
    });
    expect(workspace().state.panes[0]?.visibility).toBe("visible");

    act(() => {
      workspace().openPane({ href: "/conversations", activate: false });
    });
    await waitFor(() => {
      expect(workspace().state.panes).toHaveLength(2);
    });
    const secondPaneId = workspace().state.panes[1]!.id;

    act(() => {
      workspace().minimizePane(secondPaneId);
    });
    await waitFor(() => {
      expect(workspace().state.panes.find((pane) => pane.id === secondPaneId)?.visibility).toBe(
        "minimized",
      );
      expect(workspace().state.activePaneId).toBe(firstPaneId);
    });

    act(() => {
      workspace().restorePane(secondPaneId);
    });
    await waitFor(() => {
      expect(workspace().state.panes.find((pane) => pane.id === secondPaneId)?.visibility).toBe(
        "visible",
      );
      expect(workspace().state.activePaneId).toBe(secondPaneId);
    });
    flushWorkspaceSession();
  });

  it("ignores minimized-pane activation and inactive navigation keeps it minimized", async () => {
    const workspace = await mountWorkspaceStore();
    const firstPaneId = workspace().state.activePaneId;

    act(() => {
      workspace().openPane({ href: "/conversations/new", activate: false });
    });
    await waitFor(() => {
      expect(workspace().state.panes).toHaveLength(2);
    });
    const secondPaneId = workspace().state.panes[1]!.id;

    act(() => {
      workspace().minimizePane(secondPaneId);
    });
    await waitFor(() => {
      expect(workspace().state.panes.find((pane) => pane.id === secondPaneId)?.visibility).toBe(
        "minimized",
      );
    });

    act(() => {
      workspace().activatePane(secondPaneId);
    });
    expect(workspace().state.activePaneId).toBe(firstPaneId);

    act(() => {
      workspace().navigatePane(secondPaneId, "/conversations/conversation-1", {
        activate: false,
      });
    });
    await waitFor(() => {
      const secondPane = workspace().state.panes.find((pane) => pane.id === secondPaneId);
      expect(secondPane?.href).toBe("/conversations/conversation-1");
      expect(secondPane?.visibility).toBe("minimized");
      expect(workspace().state.activePaneId).toBe(firstPaneId);
    });
    flushWorkspaceSession();
  });

  it("minimizing the active pane activates the nearest visible pane to the right", async () => {
    const workspace = await mountWorkspaceStore();

    act(() => {
      workspace().openPane({ href: "/conversations", activate: true });
    });
    await waitFor(() => {
      expect(activeHref(workspace())).toBe("/conversations");
    });
    const secondPaneId = workspace().state.activePaneId;

    act(() => {
      workspace().openPane({
        href: "/media/media-1",
        openerPaneId: secondPaneId,
        activate: false,
      });
    });
    await waitFor(() => {
      expect(workspace().state.panes).toHaveLength(3);
    });
    const thirdPaneId = workspace().state.panes[2]!.id;

    act(() => {
      workspace().minimizePane(secondPaneId);
    });
    await waitFor(() => {
      expect(workspace().state.activePaneId).toBe(thirdPaneId);
      expect(workspace().state.panes.find((pane) => pane.id === secondPaneId)?.visibility).toBe(
        "minimized",
      );
    });
    flushWorkspaceSession();
  });

  it("resizes and closes minimized panes without restoring them", async () => {
    const workspace = await mountWorkspaceStore();
    const firstPaneId = workspace().state.activePaneId;

    act(() => {
      workspace().openPane({ href: "/conversations", activate: false });
    });
    await waitFor(() => {
      expect(workspace().state.panes).toHaveLength(2);
    });
    const secondPaneId = workspace().state.panes[1]!.id;

    act(() => {
      workspace().minimizePane(secondPaneId);
      workspace().resizePane(secondPaneId, 99999);
    });
    await waitFor(() => {
      const secondPane = workspace().state.panes.find((pane) => pane.id === secondPaneId);
      expect(secondPane?.visibility).toBe("minimized");
      expect(secondPane?.widthPx).toBe(MAX_STANDARD_PANE_WIDTH_PX);
    });

    act(() => {
      workspace().closePane(secondPaneId);
    });
    await waitFor(() => {
      expect(workspace().state.panes).toHaveLength(1);
      expect(workspace().state.activePaneId).toBe(firstPaneId);
    });
    flushWorkspaceSession();
  });

  it("falls back to the default pane when closing the last pane", async () => {
    const workspace = await mountWorkspaceStore("/settings");
    const paneId = workspace().state.activePaneId;

    act(() => {
      workspace().closePane(paneId);
    });

    await waitFor(() => {
      expect(workspace().state.panes).toHaveLength(1);
      expect(workspace().state.panes[0]?.href).toBe("/libraries");
    });
    flushWorkspaceSession();
  });

  it("publishes runtime titles and clears them when the pane navigates", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePaneId;

    act(() => {
      workspace().publishPaneTitle(paneId, "My Book");
    });
    await waitFor(() => {
      expect(workspace().runtimeTitleByPaneId.get(paneId)).toBe("My Book");
    });

    act(() => {
      workspace().navigatePane(paneId, "/media/media-2");
    });
    await waitFor(() => {
      expect(workspace().runtimeTitleByPaneId.has(paneId)).toBe(false);
    });
    flushWorkspaceSession();
  });
});

describe("resolveWorkspacePaneTitle", () => {
  const empty = new Map<string, string>();

  it("returns pending for a dynamic route with no runtime title", () => {
    const pane = { id: "p1", href: "/media/m1" };
    const result = resolveWorkspacePaneTitle(pane, empty);
    expect(result.titleState).toBe("pending");
    expect(result.title.length).toBeGreaterThan(0);
  });

  it("returns resolved with the runtime title when one is published", () => {
    const pane = { id: "p1", href: "/media/m1" };
    const result = resolveWorkspacePaneTitle(pane, new Map([["p1", "My Book"]]));
    expect(result.titleState).toBe("resolved");
    expect(result.title).toBe("My Book");
  });

  it("returns resolved for a static route with the route label", () => {
    const pane = { id: "p2", href: "/libraries" };
    const result = resolveWorkspacePaneTitle(pane, empty);
    expect(result.titleState).toBe("resolved");
    expect(result.title).toBe("Libraries");
  });

  it("title is always a non-empty string", () => {
    for (const href of ["/media/m1", "/libraries"]) {
      const result = resolveWorkspacePaneTitle({ id: "px", href }, empty);
      expect(result.title.length).toBeGreaterThan(0);
    }
  });
});
