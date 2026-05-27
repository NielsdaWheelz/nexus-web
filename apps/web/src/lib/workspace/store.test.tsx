import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MEDIA_PANE_WIDTH_PX,
  MAX_MEDIA_PANE_WIDTH_PX,
  MAX_STANDARD_PANE_WIDTH_PX,
  WORKSPACE_SCHEMA_VERSION,
  type WorkspacePaneStateV5,
  type WorkspaceStateV5,
} from "@/lib/workspace/schema";
import {
  mergeRestoredWorkspaceWithUrlIntent,
  resolveWorkspacePaneTitle,
  useWorkspaceStore,
  WorkspaceStoreProvider,
  type WorkspacePaneTitleRecord,
  type WorkspacePaneTitleSource,
} from "@/lib/workspace/store";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";

type WorkspaceStore = ReturnType<typeof useWorkspaceStore>;

function pane(
  id: string,
  href: string,
  input: Partial<Pick<WorkspacePaneStateV5, "widthPx" | "visibility" | "history">> = {}
): WorkspacePaneStateV5 {
  return {
    id,
    href,
    widthPx: input.widthPx ?? 560,
    visibility: input.visibility ?? "visible",
    history: input.history ?? { back: [], forward: [] },
  };
}

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

function titleRecord(
  href: string,
  title: string,
  source: WorkspacePaneTitleSource = "runtime",
): WorkspacePaneTitleRecord {
  return {
    title,
    source,
    resourceKey: resolvePaneRouteIdentity(href).resourceKey,
  };
}

describe("mergeRestoredWorkspaceWithUrlIntent", () => {
  const restored: WorkspaceStateV5 = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activePaneId: "pane-saved-libraries",
    panes: [
      pane("pane-saved-libraries", "/libraries"),
      pane("pane-saved-notes", "/notes", { widthPx: 480 }),
    ],
  };

  it("keeps a neutral /libraries open as pure saved-session restore", () => {
    const urlIntent: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-url-libraries",
      panes: [pane("pane-url-libraries", "/libraries")],
    };

    expect(mergeRestoredWorkspaceWithUrlIntent(restored, urlIntent)).toBe(restored);
  });

  it("adds an explicit direct URL as the active pane instead of letting restore override it", () => {
    const urlIntent: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-url-media",
      panes: [pane("pane-url-media", "/media/media-123", { widthPx: 1280 })],
    };

    const merged = mergeRestoredWorkspaceWithUrlIntent(restored, urlIntent);

    expect(merged.panes.map((pane) => pane.href)).toEqual([
      "/libraries",
      "/notes",
      "/media/media-123",
    ]);
    expect(merged.activePaneId).toBe("pane-url-media");
  });

  it("reuses and activates the saved pane for same-resource direct URLs", () => {
    const savedWithMedia: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-saved-libraries",
      panes: [
        ...restored.panes,
        pane("pane-saved-media", "/media/media-123", {
          widthPx: 960,
          visibility: "minimized",
          history: { back: ["/libraries"], forward: ["/media/media-999"] },
        }),
      ],
    };
    const urlIntent: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-url-media",
      panes: [
        pane("pane-url-media", "/media/media-123?loc=chapter-2", {
          widthPx: 1280,
        }),
      ],
    };

    const merged = mergeRestoredWorkspaceWithUrlIntent(savedWithMedia, urlIntent);

    expect(merged.panes).toHaveLength(3);
    expect(merged.activePaneId).toBe("pane-saved-media");
    expect(merged.panes.find((pane) => pane.id === "pane-saved-media")).toMatchObject({
      href: "/media/media-123?loc=chapter-2",
      visibility: "visible",
      widthPx: 960,
      history: { back: ["/libraries"], forward: ["/media/media-999"] },
    });
  });
});

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

  it("opens new panes at the route default width", async () => {
    const workspace = await mountWorkspaceStore();

    act(() => {
      workspace().openPane({ href: "/media/media-1" });
    });

    await waitFor(() => {
      expect(activeHref(workspace())).toBe("/media/media-1");
      expect(workspace().state.panes[1]?.widthPx).toBe(DEFAULT_MEDIA_PANE_WIDTH_PX);
    });
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

  it("records pane-local history for push navigation and traverses it", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/media-2");
    });
    await waitFor(() => {
      expect(workspace().state.panes[0]?.href).toBe("/media/media-2");
      expect(workspace().state.panes[0]?.history).toEqual({
        back: ["/media/media-1"],
        forward: [],
      });
    });

    act(() => {
      workspace().goBackPane(paneId);
    });
    await waitFor(() => {
      expect(workspace().state.panes[0]?.href).toBe("/media/media-1");
      expect(workspace().state.panes[0]?.history).toEqual({
        back: [],
        forward: ["/media/media-2"],
      });
    });

    act(() => {
      workspace().goForwardPane(paneId);
    });
    await waitFor(() => {
      expect(workspace().state.panes[0]?.href).toBe("/media/media-2");
      expect(workspace().state.panes[0]?.history).toEqual({
        back: ["/media/media-1"],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("replace navigation updates href without changing pane history", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/media-2");
    });
    await waitFor(() => {
      expect(workspace().state.panes[0]?.history.back).toEqual(["/media/media-1"]);
    });

    act(() => {
      workspace().navigatePane(paneId, "/media/media-3", { replace: true });
    });
    await waitFor(() => {
      expect(workspace().state.panes[0]?.href).toBe("/media/media-3");
      expect(workspace().state.panes[0]?.history).toEqual({
        back: ["/media/media-1"],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("records pane-local history when duplicate opens retarget an existing pane", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");

    act(() => {
      workspace().openPane({ href: "/media/media-1?loc=chapter-2" });
    });

    await waitFor(() => {
      expect(workspace().state.panes).toHaveLength(1);
      expect(workspace().state.panes[0]?.href).toBe("/media/media-1?loc=chapter-2");
      expect(workspace().state.panes[0]?.history).toEqual({
        back: ["/media/media-1"],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("does not record history for same-href navigation", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/media-1");
    });

    await waitFor(() => {
      expect(workspace().state.panes[0]?.history).toEqual({
        back: [],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("preserves resized width when duplicate opens reuse a resource pane", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePaneId;

    act(() => {
      workspace().resizePane(paneId, 900);
    });
    await waitFor(() => {
      expect(workspace().state.panes[0]?.widthPx).toBe(900);
    });

    act(() => {
      workspace().openPane({ href: "/media/media-1?loc=chapter-2" });
    });

    await waitFor(() => {
      expect(workspace().state.panes).toHaveLength(1);
      expect(workspace().state.panes[0]).toMatchObject({
        href: "/media/media-1?loc=chapter-2",
        widthPx: 900,
      });
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

  it("publishes runtime titles and keeps them across same-resource location changes", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePaneId;
    const resourceKey = resolvePaneRouteIdentity("/media/media-1").resourceKey;

    act(() => {
      workspace().publishPaneTitle({ paneId, resourceKey, title: "My Book" });
    });
    await waitFor(() => {
      expect(workspace().runtimeTitleByPaneId.get(paneId)?.title).toBe("My Book");
    });

    act(() => {
      workspace().navigatePane(paneId, "/media/media-1?loc=chapter-2");
    });
    await waitFor(() => {
      expect(workspace().state.panes[0]?.href).toBe("/media/media-1?loc=chapter-2");
      expect(workspace().runtimeTitleByPaneId.get(paneId)?.title).toBe("My Book");
    });
    flushWorkspaceSession();
  });

  it("clears runtime titles when the pane navigates to a different resource", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePaneId;
    const resourceKey = resolvePaneRouteIdentity("/media/media-1").resourceKey;

    act(() => {
      workspace().publishPaneTitle({ paneId, resourceKey, title: "My Book" });
    });
    await waitFor(() => {
      expect(workspace().runtimeTitleByPaneId.get(paneId)?.title).toBe("My Book");
    });

    act(() => {
      workspace().navigatePane(paneId, "/media/media-2");
    });
    await waitFor(() => {
      expect(workspace().runtimeTitleByPaneId.has(paneId)).toBe(false);
    });
    flushWorkspaceSession();
  });

  it("ignores stale runtime title publishes from a previous resource", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePaneId;
    const oldResourceKey = resolvePaneRouteIdentity("/media/media-1").resourceKey;

    act(() => {
      workspace().navigatePane(paneId, "/media/media-2");
      workspace().publishPaneTitle({
        paneId,
        resourceKey: oldResourceKey,
        title: "Old Book",
      });
    });

    await waitFor(() => {
      const activePane = workspace().state.panes.find(
        (pane) => pane.id === workspace().state.activePaneId,
      );
      expect(activePane?.href).toBe("/media/media-2");
      expect(workspace().runtimeTitleByPaneId.has(paneId)).toBe(false);
      expect(resolveWorkspacePaneTitle(activePane!, workspace().runtimeTitleByPaneId)).toMatchObject({
        title: "Media",
        titleState: "pending",
        titleSource: "fallback",
      });
    });
    flushWorkspaceSession();
  });

  it("uses title hints for dynamic panes until runtime titles supersede them", async () => {
    const workspace = await mountWorkspaceStore("/libraries");

    act(() => {
      workspace().openPane({ href: "/media/media-1", titleHint: "Library Row Title" });
    });

    await waitFor(() => {
      const paneId = workspace().state.activePaneId;
      expect(resolveWorkspacePaneTitle(workspace().state.panes[1]!, workspace().runtimeTitleByPaneId)).toMatchObject({
        title: "Library Row Title",
        titleState: "resolved",
        titleSource: "hint",
      });
      expect(workspace().runtimeTitleByPaneId.get(paneId)?.source).toBe("hint");
    });

    const paneId = workspace().state.activePaneId;
    const resourceKey = resolvePaneRouteIdentity("/media/media-1").resourceKey;
    act(() => {
      workspace().publishPaneTitle({ paneId, resourceKey, title: "Runtime Title" });
    });

    await waitFor(() => {
      expect(resolveWorkspacePaneTitle(workspace().state.panes[1]!, workspace().runtimeTitleByPaneId)).toMatchObject({
        title: "Runtime Title",
        titleState: "resolved",
        titleSource: "runtime",
      });
    });
    flushWorkspaceSession();
  });

  it("uses title hints for same-pane navigation", async () => {
    const workspace = await mountWorkspaceStore("/libraries/library-1");
    const paneId = workspace().state.activePaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/media-1", {
        titleHint: "Library Row Title",
      });
    });

    await waitFor(() => {
      const activePane = workspace().state.panes.find(
        (pane) => pane.id === workspace().state.activePaneId,
      );
      expect(activePane?.href).toBe("/media/media-1");
      expect(resolveWorkspacePaneTitle(activePane!, workspace().runtimeTitleByPaneId)).toMatchObject({
        title: "Library Row Title",
        titleState: "resolved",
        titleSource: "hint",
      });
    });
    flushWorkspaceSession();
  });

  it("applies the latest title hint when duplicate opens reuse one resource pane", async () => {
    const workspace = await mountWorkspaceStore("/libraries");

    act(() => {
      workspace().openPane({ href: "/media/media-1", titleHint: "First title" });
      workspace().openPane({
        href: "/media/media-1?loc=chapter-2",
        titleHint: "Second title",
      });
    });

    await waitFor(() => {
      expect(workspace().state.panes).toHaveLength(2);
      const activePane = workspace().state.panes.find(
        (pane) => pane.id === workspace().state.activePaneId,
      );
      expect(activePane?.href).toBe("/media/media-1?loc=chapter-2");
      expect(resolveWorkspacePaneTitle(activePane!, workspace().runtimeTitleByPaneId)).toMatchObject({
        title: "Second title",
        titleState: "resolved",
        titleSource: "hint",
      });
    });
    flushWorkspaceSession();
  });
});

describe("resolveWorkspacePaneTitle", () => {
  const empty = new Map<string, WorkspacePaneTitleRecord>();

  it("returns pending for a dynamic route with no runtime title", () => {
    const pane = { id: "p1", href: "/media/m1" };
    const result = resolveWorkspacePaneTitle(pane, empty);
    expect(result.titleState).toBe("pending");
    expect(result.title.length).toBeGreaterThan(0);
  });

  it("returns resolved with the runtime title when one is published", () => {
    const pane = { id: "p1", href: "/media/m1" };
    const result = resolveWorkspacePaneTitle(
      pane,
      new Map([["p1", titleRecord("/media/m1", "My Book")]]),
    );
    expect(result.titleState).toBe("resolved");
    expect(result.title).toBe("My Book");
  });

  it("ignores stale title records from a different resource", () => {
    const pane = { id: "p1", href: "/media/m2" };
    const result = resolveWorkspacePaneTitle(
      pane,
      new Map([["p1", titleRecord("/media/m1", "My Book")]]),
    );
    expect(result.titleState).toBe("pending");
    expect(result.title).toBe("Media");
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
