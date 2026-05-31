import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import {
  mergeRestoredWorkspaceWithDeepLink,
  resolveWorkspacePaneTitle,
  useWorkspaceStore,
  WorkspaceStoreProvider,
  type WorkspacePaneTitleRecord,
  type WorkspacePaneTitleSource,
} from "@/lib/workspace/store";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

type WorkspaceStore = ReturnType<typeof useWorkspaceStore>;

function pane(
  id: string,
  href: string,
  input: Partial<
    Pick<
      WorkspacePrimaryPaneState,
      "primaryWidthPx" | "visibility" | "history" | "attachedSecondaryPaneId"
    >
  > = {},
): WorkspacePrimaryPaneState {
  return {
    id,
    href,
    primaryWidthPx: input.primaryWidthPx ?? 560,
    visibility: input.visibility ?? "visible",
    history: input.history ?? { back: [], forward: [] },
    attachedSecondaryPaneId: input.attachedSecondaryPaneId ?? null,
  };
}

function workspaceState(input: {
  activePrimaryPaneId?: string;
  primaryPanes: WorkspacePrimaryPaneState[];
  secondaryPanesById?: WorkspaceState["secondaryPanesById"];
}): WorkspaceState {
  return createWorkspaceStateFromPrimaryPanes({
    activePrimaryPaneId: input.activePrimaryPaneId ?? input.primaryPanes[0]!.id,
    primaryPanes: input.primaryPanes,
    secondaryPanesById: input.secondaryPanesById,
  });
}

function primaryPanes(state: WorkspaceState): WorkspacePrimaryPaneState[] {
  return getWorkspacePrimaryPanes(state);
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
    <WorkspaceStoreProvider workspacePrimaryMetrics={workspacePrimaryMetrics}>
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
    expect(primaryPanes(workspace().state).length).toBeGreaterThan(0);
  });

  return workspace;
}

function activeHref(store: WorkspaceStore): string {
  return primaryPanes(store.state).find((pane) => pane.id === store.state.activePrimaryPaneId)?.href ?? "";
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

describe("mergeRestoredWorkspaceWithDeepLink", () => {
  const restored = workspaceState({
    activePrimaryPaneId: "pane-saved-libraries",
    primaryPanes: [
      pane("pane-saved-libraries", "/libraries"),
      pane("pane-saved-notes", "/notes", { primaryWidthPx: 480 }),
    ],
  });

  it("keeps a neutral /libraries open as pure saved-session restore", () => {
    const deepLink = workspaceState({
      activePrimaryPaneId: "pane-url-libraries",
      primaryPanes: [pane("pane-url-libraries", "/libraries")],
    });

    expect(
      mergeRestoredWorkspaceWithDeepLink(
        restored,
        deepLink,
        workspacePrimaryMetrics,
      ),
    ).toBe(restored);
  });

  it("adds an explicit deep link as the active pane instead of letting restore override it", () => {
    const deepLink = workspaceState({
      activePrimaryPaneId: "pane-url-media",
      primaryPanes: [
        pane("pane-url-media", "/media/media-123", { primaryWidthPx: 1280 }),
      ],
    });

    const merged = mergeRestoredWorkspaceWithDeepLink(
      restored,
      deepLink,
      workspacePrimaryMetrics,
    );

    expect(primaryPanes(merged).map((item) => item.href)).toEqual([
      "/libraries",
      "/notes",
      "/media/media-123",
    ]);
    expect(merged.activePrimaryPaneId).toBe("pane-url-media");
  });

  it("reuses and activates the saved pane for same-resource deep links", () => {
    const savedWithMedia = workspaceState({
      activePrimaryPaneId: "pane-saved-libraries",
      primaryPanes: [
        ...primaryPanes(restored),
        pane("pane-saved-media", "/media/media-123", {
          primaryWidthPx: 960,
          visibility: "minimized",
          history: { back: ["/libraries"], forward: ["/media/media-999"] },
        }),
      ],
    });
    const deepLink = workspaceState({
      activePrimaryPaneId: "pane-url-media",
      primaryPanes: [
        pane("pane-url-media", "/media/media-123?loc=chapter-2", {
          primaryWidthPx: 1280,
        }),
      ],
    });

    const merged = mergeRestoredWorkspaceWithDeepLink(
      savedWithMedia,
      deepLink,
      workspacePrimaryMetrics,
    );

    expect(primaryPanes(merged)).toHaveLength(3);
    expect(merged.activePrimaryPaneId).toBe("pane-saved-media");
    expect(primaryPanes(merged).find((item) => item.id === "pane-saved-media")).toMatchObject({
      href: "/media/media-123?loc=chapter-2",
      visibility: "visible",
      primaryWidthPx: 960,
      attachedSecondaryPaneId: null,
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
    const openerPaneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().openPane({ href: "/conversations", openerPaneId });
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state).map((pane) => pane.href)).toEqual([
        "/libraries",
        "/conversations",
      ]);
    });
    expect(activeHref(workspace())).toBe("/conversations");
    expect(primaryPanes(workspace().state)[1]?.visibility).toBe("visible");
    flushWorkspaceSession();
  });

  it("opens new panes at the workspace default width", async () => {
    const workspace = await mountWorkspaceStore();

    act(() => {
      workspace().openPane({ href: "/media/media-1" });
    });

    await waitFor(() => {
      expect(activeHref(workspace())).toBe("/media/media-1");
      expect(primaryPanes(workspace().state)[1]?.primaryWidthPx).toBe(
        workspacePrimaryMetrics.primaryDefaultWidthPx,
      );
    });
    flushWorkspaceSession();
  });

  it("opens a new primary pane without seeding secondary state", async () => {
    const workspace = await mountWorkspaceStore();

    act(() => {
      workspace().openPane({ href: "/libraries/library-1" });
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)[1]?.attachedSecondaryPaneId).toBeNull();
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
    const conversationPaneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().openPane({ href: "/conversations/conversation-1?run=run-new" });
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(2);
      expect(workspace().state.activePrimaryPaneId).toBe(conversationPaneId);
      expect(activeHref(workspace())).toBe("/conversations/conversation-1?run=run-new");
    });
    flushWorkspaceSession();
  });

  it("records pane-local history for push navigation and traverses it", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/media-2");
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/media-2");
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
        back: ["/media/media-1"],
        forward: [],
      });
    });

    act(() => {
      workspace().goBackPane(paneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/media-1");
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
        back: [],
        forward: ["/media/media-2"],
      });
    });

    act(() => {
      workspace().goForwardPane(paneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/media-2");
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
        back: ["/media/media-1"],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("replace navigation updates href without changing pane history", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/media-2");
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.history.back).toEqual(["/media/media-1"]);
    });

    act(() => {
      workspace().navigatePane(paneId, "/media/media-3", { replace: true });
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/media-3");
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
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
      expect(primaryPanes(workspace().state)).toHaveLength(1);
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/media-1?loc=chapter-2");
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
        back: ["/media/media-1"],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("does not record history for same-href navigation", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/media-1");
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
        back: [],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("preserves resized width when duplicate opens reuse a resource pane", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().resizePrimaryPane(paneId, 900);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.primaryWidthPx).toBe(900);
    });

    act(() => {
      workspace().openPane({ href: "/media/media-1?loc=chapter-2" });
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(1);
      expect(primaryPanes(workspace().state)[0]).toMatchObject({
        href: "/media/media-1?loc=chapter-2",
        primaryWidthPx: 900,
      });
    });
    flushWorkspaceSession();
  });

  it("opens, switches, resizes, and closes a secondary without changing primary width", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().resizePrimaryPane(paneId, 900);
      workspace().requestSecondarySurface(paneId, "reader-highlights");
    });

    await waitFor(() => {
      const primaryPane = primaryPanes(workspace().state)[0]!;
      const secondaryPane =
        workspace().state.secondaryPanesById[primaryPane.attachedSecondaryPaneId!];
      expect(primaryPane.primaryWidthPx).toBe(900);
      expect(secondaryPane).toMatchObject({
        parentPrimaryPaneId: paneId,
        groupId: "reader-tools",
        activeSurfaceId: "reader-highlights",
        widthPx: 360,
        visibility: "visible",
      });
    });
    const secondaryPaneId = primaryPanes(workspace().state)[0]!.attachedSecondaryPaneId!;

    act(() => {
      workspace().resizeSecondaryPane(secondaryPaneId, 9999);
      workspace().setSecondarySurface(secondaryPaneId, "reader-doc-chat");
      workspace().closeSecondaryPane(secondaryPaneId);
    });

    await waitFor(() => {
      const primaryPane = primaryPanes(workspace().state)[0]!;
      const secondaryPane =
        workspace().state.secondaryPanesById[primaryPane.attachedSecondaryPaneId!];
      expect(primaryPane.primaryWidthPx).toBe(900);
      expect(secondaryPane).toMatchObject({
        groupId: "reader-tools",
        activeSurfaceId: "reader-doc-chat",
        widthPx: 720,
        visibility: "collapsed",
      });
    });
    flushWorkspaceSession();
  });

  it("mutating one secondary leaves every sibling primary and secondary width unchanged", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneAId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().openPane({ href: "/media/media-2" });
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(2);
    });
    const paneBId = primaryPanes(workspace().state).find(
      (pane) => pane.href === "/media/media-2",
    )!.id;

    // Give each pane a distinct primary width and an attached reader-tools secondary.
    act(() => {
      workspace().resizePrimaryPane(paneAId, 820);
      workspace().resizePrimaryPane(paneBId, 760);
      workspace().requestSecondarySurface(paneAId, "reader-highlights");
      workspace().requestSecondarySurface(paneBId, "reader-highlights");
    });

    let paneBSecondaryId = "";
    await waitFor(() => {
      const paneB = primaryPanes(workspace().state).find((pane) => pane.id === paneBId)!;
      expect(paneB.attachedSecondaryPaneId).not.toBeNull();
      paneBSecondaryId = paneB.attachedSecondaryPaneId!;
    });

    act(() => {
      workspace().resizeSecondaryPane(paneBSecondaryId, 500);
    });
    await waitFor(() => {
      expect(workspace().state.secondaryPanesById[paneBSecondaryId]?.widthPx).toBe(500);
    });

    // Snapshot the sibling (pane B) before touching pane A's secondary.
    const paneBPrimaryWidthBefore = primaryPanes(workspace().state).find(
      (pane) => pane.id === paneBId,
    )!.primaryWidthPx;
    const paneBSecondaryBefore =
      workspace().state.secondaryPanesById[paneBSecondaryId];
    const paneASecondaryId = primaryPanes(workspace().state).find(
      (pane) => pane.id === paneAId,
    )!.attachedSecondaryPaneId!;

    // Resize, switch, and collapse pane A's secondary.
    act(() => {
      workspace().resizeSecondaryPane(paneASecondaryId, 680);
      workspace().setSecondarySurface(paneASecondaryId, "reader-doc-chat");
      workspace().closeSecondaryPane(paneASecondaryId);
    });

    await waitFor(() => {
      expect(
        workspace().state.secondaryPanesById[paneASecondaryId],
      ).toMatchObject({
        activeSurfaceId: "reader-doc-chat",
        widthPx: 680,
        visibility: "collapsed",
      });
    });

    // Pane A's own primary width is untouched by its secondary operations.
    expect(
      primaryPanes(workspace().state).find((pane) => pane.id === paneAId)!
        .primaryWidthPx,
    ).toBe(820);

    // The sibling pane B and its secondary are completely unchanged.
    const paneBAfter = primaryPanes(workspace().state).find(
      (pane) => pane.id === paneBId,
    )!;
    expect(paneBAfter.primaryWidthPx).toBe(paneBPrimaryWidthBefore);
    expect(paneBAfter.attachedSecondaryPaneId).toBe(paneBSecondaryId);
    expect(workspace().state.secondaryPanesById[paneBSecondaryId]).toEqual(
      paneBSecondaryBefore,
    );
    flushWorkspaceSession();
  });

  it("drops incompatible secondarys across resource navigation", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().requestSecondarySurface(paneId, "reader-highlights");
      workspace().navigatePane(paneId, "/libraries/library-1");
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/libraries/library-1");
      expect(primaryPanes(workspace().state)[0]?.attachedSecondaryPaneId).toBeNull();
      expect(workspace().state.secondaryPanesById).toEqual({});
    });
    flushWorkspaceSession();
  });

  it("resets resized width across different resources", async () => {
    const workspace = await mountWorkspaceStore("/libraries");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().resizePrimaryPane(paneId, 900);
      workspace().navigatePane(paneId, "/conversations");
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]).toMatchObject({
        href: "/conversations",
        primaryWidthPx: workspacePrimaryMetrics.primaryDefaultWidthPx,
      });
    });
    flushWorkspaceSession();
  });

  it("resets pane width when navigating to a different resource", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().resizePrimaryPane(paneId, 99999);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.primaryWidthPx).toBe(99999);
    });

    act(() => {
      workspace().navigatePane(paneId, "/libraries");
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/libraries");
      expect(primaryPanes(workspace().state)[0]?.primaryWidthPx).toBe(
        workspacePrimaryMetrics.primaryDefaultWidthPx,
      );
      expect(workspace().state.activePrimaryPaneId).toBe(paneId);
    });
    flushWorkspaceSession();
  });

  it("uses workspace defaults while traversing history across resources", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().resizePrimaryPane(paneId, 2200);
      workspace().navigatePane(paneId, "/libraries");
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]).toMatchObject({
        href: "/libraries",
        primaryWidthPx: workspacePrimaryMetrics.primaryDefaultWidthPx,
        history: { back: ["/media/media-1"], forward: [] },
      });
    });

    act(() => {
      workspace().goBackPane(paneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]).toMatchObject({
        href: "/media/media-1",
        primaryWidthPx: workspacePrimaryMetrics.primaryDefaultWidthPx,
        history: { back: [], forward: ["/libraries"] },
      });
    });

    act(() => {
      workspace().goForwardPane(paneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]).toMatchObject({
        href: "/libraries",
        primaryWidthPx: workspacePrimaryMetrics.primaryDefaultWidthPx,
        history: { back: ["/media/media-1"], forward: [] },
      });
    });
    flushWorkspaceSession();
  });

  it("keeps the last visible pane open and restores minimized panes", async () => {
    const workspace = await mountWorkspaceStore();
    const firstPaneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().minimizePane(firstPaneId);
    });
    expect(primaryPanes(workspace().state)[0]?.visibility).toBe("visible");

    act(() => {
      workspace().openPane({ href: "/conversations", activate: false });
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(2);
    });
    const secondPaneId = primaryPanes(workspace().state)[1]!.id;

    act(() => {
      workspace().minimizePane(secondPaneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state).find((pane) => pane.id === secondPaneId)?.visibility).toBe(
        "minimized",
      );
      expect(workspace().state.activePrimaryPaneId).toBe(firstPaneId);
    });

    act(() => {
      workspace().restorePane(secondPaneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state).find((pane) => pane.id === secondPaneId)?.visibility).toBe(
        "visible",
      );
      expect(workspace().state.activePrimaryPaneId).toBe(secondPaneId);
    });
    flushWorkspaceSession();
  });

  it("ignores minimized-pane activation and inactive navigation keeps it minimized", async () => {
    const workspace = await mountWorkspaceStore();
    const firstPaneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().openPane({ href: "/conversations/new", activate: false });
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(2);
    });
    const secondPaneId = primaryPanes(workspace().state)[1]!.id;

    act(() => {
      workspace().minimizePane(secondPaneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state).find((pane) => pane.id === secondPaneId)?.visibility).toBe(
        "minimized",
      );
    });

    act(() => {
      workspace().activatePane(secondPaneId);
    });
    expect(workspace().state.activePrimaryPaneId).toBe(firstPaneId);

    act(() => {
      workspace().navigatePane(secondPaneId, "/conversations/conversation-1", {
        activate: false,
      });
    });
    await waitFor(() => {
      const secondPane = primaryPanes(workspace().state).find((pane) => pane.id === secondPaneId);
      expect(secondPane?.href).toBe("/conversations/conversation-1");
      expect(secondPane?.visibility).toBe("minimized");
      expect(workspace().state.activePrimaryPaneId).toBe(firstPaneId);
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
    const secondPaneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().openPane({
        href: "/media/media-1",
        openerPaneId: secondPaneId,
        activate: false,
      });
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(3);
    });
    const thirdPaneId = primaryPanes(workspace().state)[2]!.id;

    act(() => {
      workspace().minimizePane(secondPaneId);
    });
    await waitFor(() => {
      expect(workspace().state.activePrimaryPaneId).toBe(thirdPaneId);
      expect(primaryPanes(workspace().state).find((pane) => pane.id === secondPaneId)?.visibility).toBe(
        "minimized",
      );
    });
    flushWorkspaceSession();
  });

  it("resizes and closes minimized panes without restoring them", async () => {
    const workspace = await mountWorkspaceStore();
    const firstPaneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().openPane({ href: "/conversations", activate: false });
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(2);
    });
    const secondPaneId = primaryPanes(workspace().state)[1]!.id;

    act(() => {
      workspace().minimizePane(secondPaneId);
      workspace().resizePrimaryPane(secondPaneId, 99999);
    });
    await waitFor(() => {
      const secondPane = primaryPanes(workspace().state).find((pane) => pane.id === secondPaneId);
      expect(secondPane?.visibility).toBe("minimized");
      expect(secondPane?.primaryWidthPx).toBe(99999);
    });

    act(() => {
      workspace().closePane(secondPaneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(1);
      expect(workspace().state.activePrimaryPaneId).toBe(firstPaneId);
    });
    flushWorkspaceSession();
  });

  it("falls back to the default pane when closing the last pane", async () => {
    const workspace = await mountWorkspaceStore("/settings");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().closePane(paneId);
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(1);
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/libraries");
    });
    flushWorkspaceSession();
  });

  it("publishes runtime titles and keeps them across same-resource location changes", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePrimaryPaneId;
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
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/media-1?loc=chapter-2");
      expect(workspace().runtimeTitleByPaneId.get(paneId)?.title).toBe("My Book");
    });
    flushWorkspaceSession();
  });

  it("clears runtime titles when the pane navigates to a different resource", async () => {
    const workspace = await mountWorkspaceStore("/media/media-1");
    const paneId = workspace().state.activePrimaryPaneId;
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
    const paneId = workspace().state.activePrimaryPaneId;
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
      const activePane = primaryPanes(workspace().state).find(
        (pane) => pane.id === workspace().state.activePrimaryPaneId,
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
      const paneId = workspace().state.activePrimaryPaneId;
      expect(resolveWorkspacePaneTitle(primaryPanes(workspace().state)[1]!, workspace().runtimeTitleByPaneId)).toMatchObject({
        title: "Library Row Title",
        titleState: "resolved",
        titleSource: "hint",
      });
      expect(workspace().runtimeTitleByPaneId.get(paneId)?.source).toBe("hint");
    });

    const paneId = workspace().state.activePrimaryPaneId;
    const resourceKey = resolvePaneRouteIdentity("/media/media-1").resourceKey;
    act(() => {
      workspace().publishPaneTitle({ paneId, resourceKey, title: "Runtime Title" });
    });

    await waitFor(() => {
      expect(resolveWorkspacePaneTitle(primaryPanes(workspace().state)[1]!, workspace().runtimeTitleByPaneId)).toMatchObject({
        title: "Runtime Title",
        titleState: "resolved",
        titleSource: "runtime",
      });
    });
    flushWorkspaceSession();
  });

  it("uses title hints for same-pane navigation", async () => {
    const workspace = await mountWorkspaceStore("/libraries/library-1");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/media-1", {
        titleHint: "Library Row Title",
      });
    });

    await waitFor(() => {
      const activePane = primaryPanes(workspace().state).find(
        (pane) => pane.id === workspace().state.activePrimaryPaneId,
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
      expect(primaryPanes(workspace().state)).toHaveLength(2);
      const activePane = primaryPanes(workspace().state).find(
        (pane) => pane.id === workspace().state.activePrimaryPaneId,
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

  it("deep-links into a stored multi-pane session and focuses the requested pane", async () => {
    window.history.replaceState({}, "", "/conversations/conversation-1");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me/workspace-session" && init?.method === "PUT") {
        return jsonResponse({ data: null });
      }
      if (url.pathname === "/api/me/workspace-session") {
        return jsonResponse({
          data: {
            own: {
              state: workspaceState({
                activePrimaryPaneId: "pane-libraries",
                primaryPanes: [
                  pane("pane-libraries", "/libraries"),
                  pane("pane-conversation", "/conversations/conversation-1"),
                  pane("pane-notes", "/notes"),
                ],
              }),
            },
            most_recent_elsewhere: null,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}`);
    });

    let store: WorkspaceStore | null = null;
    render(
      <WorkspaceStoreProvider workspacePrimaryMetrics={workspacePrimaryMetrics}>
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
      expect(primaryPanes(workspace().state).map((item) => item.href)).toEqual([
        "/libraries",
        "/conversations/conversation-1",
        "/notes",
      ]);
      expect(activeHref(workspace())).toBe("/conversations/conversation-1");
    });
    expect(window.location.search).not.toContain("wsv");
    expect(window.location.search).not.toContain("ws=");
    flushWorkspaceSession();
  });

  it("projects the active pane href to the address bar via replaceState, never pushState", async () => {
    const workspace = await mountWorkspaceStore("/libraries");
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    act(() => {
      workspace().openPane({ href: "/conversations/conversation-1?run=run-1" });
    });

    await waitFor(() => {
      expect(activeHref(workspace())).toBe("/conversations/conversation-1?run=run-1");
      expect(window.location.pathname).toBe("/conversations/conversation-1");
      expect(window.location.search).toBe("?run=run-1");
    });
    expect(window.location.search).not.toContain("wsv");
    expect(window.location.search).not.toContain("ws=");
    expect(pushStateSpy).not.toHaveBeenCalled();
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
