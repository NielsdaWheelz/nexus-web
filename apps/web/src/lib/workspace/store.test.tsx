import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultWorkspaceState,
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  MAX_PANE_HISTORY_STACK_LENGTH,
  MAX_TOTAL_PANE_HISTORY_ENTRIES,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import {
  resolvePaneRouteKey,
  resolveWorkspacePaneLabel,
  useWorkspaceStore,
  WorkspaceStoreProvider,
  type WorkspacePaneLabelRecord,
  type WorkspacePaneLabelSource,
} from "@/lib/workspace/store";
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

// Only the capture PUT is allowed: restore is server-side now, so a client GET to
// /api/me/workspace-session is a regression and must fail the test loudly (AC-2/R4).
function mockWorkspaceSession() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === "/api/me/workspace-session" && init?.method === "PUT") {
      return jsonResponse({ data: null });
    }
    throw new Error(`Unexpected fetch call: ${url.pathname} (${init?.method ?? "GET"})`);
  });
}

function StoreProbe({ onStore }: { onStore: (store: WorkspaceStore) => void }) {
  onStore(useWorkspaceStore());
  return null;
}

// Render the provider seeded with a server-restored state (the cutover path: the store
// starts from initialState, no client restore round-trip). Captures every rendered state so
// a test can assert the FIRST commit already has the settled pane set (AC-1, no flash).
function renderSeeded(initialState: WorkspaceState, path: string) {
  window.history.replaceState({}, "", path);
  const fetchSpy = mockWorkspaceSession();
  const snapshots: WorkspaceState[] = [];
  let store: WorkspaceStore | null = null;
  render(
    <WorkspaceStoreProvider
      workspacePrimaryMetrics={workspacePrimaryMetrics}
      initialState={initialState}
    >
      <StoreProbe
        onStore={(nextStore) => {
          snapshots.push(nextStore.state);
          store = nextStore;
        }}
      />
    </WorkspaceStoreProvider>,
  );
  return {
    fetchSpy,
    snapshots,
    workspace: () => {
      if (!store) {
        throw new Error("Workspace store has not mounted yet");
      }
      return store;
    },
  };
}

async function mountWorkspaceStore(path = "/libraries") {
  window.history.replaceState({}, "", path);
  mockWorkspaceSession();

  let store: WorkspaceStore | null = null;

  render(
    <WorkspaceStoreProvider
      workspacePrimaryMetrics={workspacePrimaryMetrics}
      initialState={createDefaultWorkspaceState(path, workspacePrimaryMetrics)}
    >
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

function labelRecord(
  href: string,
  label: string,
  source: WorkspacePaneLabelSource = "runtime",
): WorkspacePaneLabelRecord {
  return {
    label,
    source,
    routeKey: resolvePaneRouteKey(href),
  };
}

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

  it("restores and activates an existing matching Lectern pane", async () => {
    const workspace = await mountWorkspaceStore();

    act(() => {
      workspace().openPane({ href: "/lectern", activate: false });
    });
    await waitFor(() => expect(primaryPanes(workspace().state)).toHaveLength(2));
    const lecternPaneId = primaryPanes(workspace().state)[1]!.id;

    act(() => {
      workspace().minimizePane(lecternPaneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[1]?.visibility).toBe("minimized");
    });

    act(() => {
      workspace().openPane({ href: "/lectern" });
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(2);
      expect(workspace().state.activePrimaryPaneId).toBe(lecternPaneId);
      expect(primaryPanes(workspace().state)[1]).toMatchObject({
        href: "/lectern",
        visibility: "visible",
      });
    });
    flushWorkspaceSession();
  });

  it("opens new panes at the workspace default width", async () => {
    const workspace = await mountWorkspaceStore();

    act(() => {
      workspace().openPane({ href: "/media/11111111-1111-4111-8111-111111111111" });
    });

    await waitFor(() => {
      expect(activeHref(workspace())).toBe("/media/11111111-1111-4111-8111-111111111111");
      expect(primaryPanes(workspace().state)[1]?.primaryWidthPx).toBe(
        workspacePrimaryMetrics.primaryDefaultWidthPx,
      );
    });
    flushWorkspaceSession();
  });

  it("opens a new primary pane without seeding secondary state", async () => {
    const workspace = await mountWorkspaceStore();

    act(() => {
      workspace().openPane({ href: "/libraries/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)[1]?.attachedSecondaryPaneId).toBeNull();
    });
    flushWorkspaceSession();
  });

  it("opens distinct route instances instead of deduping by unresolved resource", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");

    act(() => {
      workspace().openPane({ href: "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?run=run-old" });
    });
    await waitFor(() => {
      expect(activeHref(workspace())).toBe("/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?run=run-old");
    });
    const conversationPaneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().openPane({ href: "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?run=run-new" });
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(3);
      expect(workspace().state.activePrimaryPaneId).not.toBe(conversationPaneId);
      expect(activeHref(workspace())).toBe("/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?run=run-new");
    });
    flushWorkspaceSession();
  });

  it("records pane-local history for push navigation and traverses it", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/22222222-2222-4222-8222-222222222222");
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/22222222-2222-4222-8222-222222222222");
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
        back: ["/media/11111111-1111-4111-8111-111111111111"],
        forward: [],
      });
    });

    act(() => {
      workspace().goBackPane(paneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/11111111-1111-4111-8111-111111111111");
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
        back: [],
        forward: ["/media/22222222-2222-4222-8222-222222222222"],
      });
    });

    act(() => {
      workspace().goForwardPane(paneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/22222222-2222-4222-8222-222222222222");
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
        back: ["/media/11111111-1111-4111-8111-111111111111"],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("replace navigation updates href without changing pane history", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/22222222-2222-4222-8222-222222222222");
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.history.back).toEqual(["/media/11111111-1111-4111-8111-111111111111"]);
    });

    act(() => {
      workspace().navigatePane(paneId, "/media/33333333-3333-4333-8333-333333333333", { replace: true });
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/33333333-3333-4333-8333-333333333333");
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
        back: ["/media/11111111-1111-4111-8111-111111111111"],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("reader-style replace at the 48-entry boundary leaves every pane's history untouched", async () => {
    const fullStack = (label: string): { back: string[]; forward: string[] } => ({
      back: Array.from(
        { length: MAX_PANE_HISTORY_STACK_LENGTH },
        (_, index) => `/${label}-${index}`,
      ),
      forward: [],
    });
    // The active pane carries a non-empty forward stack (10 back + 2 forward,
    // still 12 total) so the deep-equal history assertions below prove replace
    // leaves forward untouched too. An all-back seed can't distinguish a true
    // replace from a push-then-pop mis-implementation that clears forward.
    const activeMediaStack = (): { back: string[]; forward: string[] } => ({
      back: Array.from({ length: 10 }, (_, index) => `/media-${index}`),
      forward: Array.from({ length: 2 }, (_, index) => `/media-forward-${index}`),
    });
    const mediaHref = "/media/11111111-1111-4111-8111-111111111111";
    const initialState = workspaceState({
      activePrimaryPaneId: "pane-media",
      primaryPanes: [
        pane("pane-libraries", "/libraries", { history: fullStack("libraries") }),
        pane("pane-conversation", "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
          history: fullStack("conversation"),
        }),
        pane("pane-notes", "/notes", { history: fullStack("notes") }),
        pane("pane-media", mediaHref, { history: activeMediaStack() }),
      ],
    });
    const { workspace } = renderSeeded(initialState, mediaHref);
    const paneId = "pane-media";

    // Precondition: every stack is already at its own 12-entry cap and the workspace
    // total sits exactly at the 48-entry budget.
    const historyByPaneId = new Map(
      primaryPanes(workspace().state).map((item) => [item.id, item.history]),
    );
    const totalBefore = [...historyByPaneId.values()].reduce(
      (count, history) => count + history.back.length + history.forward.length,
      0,
    );
    expect(totalBefore).toBe(MAX_TOTAL_PANE_HISTORY_ENTRIES);

    let lastHref = mediaHref;
    act(() => {
      for (let index = 1; index <= 20; index += 1) {
        lastHref = `${mediaHref}?loc=chapter-${index}`;
        workspace().navigatePane(paneId, lastHref, { replace: true });
      }
    });

    await waitFor(() => {
      expect(activeHref(workspace())).toBe(lastHref);
      for (const item of primaryPanes(workspace().state)) {
        expect(item.history).toEqual(historyByPaneId.get(item.id));
      }
    });

    // Contrast guard: a push after the replaces DOES add a checkpoint, proving this test
    // would catch a push-vs-replace regression.
    act(() => {
      workspace().navigatePane(paneId, "/media/22222222-2222-4222-8222-222222222222");
    });
    await waitFor(() => {
      const mediaPane = primaryPanes(workspace().state).find((item) => item.id === paneId);
      expect(mediaPane?.history.back[mediaPane.history.back.length - 1]).toBe(lastHref);
      // Push clears forward; replace must not have — this is only a real contrast
      // guard because the seed above gave the active pane a non-empty forward stack.
      expect(mediaPane?.history.forward).toEqual([]);
    });
    flushWorkspaceSession();
  });

  it("opens same-resource location routes as separate route instances", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");

    act(() => {
      workspace().openPane({ href: "/media/11111111-1111-4111-8111-111111111111?loc=chapter-2" });
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(2);
      expect(activeHref(workspace())).toBe("/media/11111111-1111-4111-8111-111111111111?loc=chapter-2");
      expect(
        primaryPanes(workspace().state).find((pane) => pane.href.endsWith("?loc=chapter-2"))
          ?.history,
      ).toEqual({
        back: [],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("does not record history for same-href navigation", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/11111111-1111-4111-8111-111111111111");
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.history).toEqual({
        back: [],
        forward: [],
      });
    });
    flushWorkspaceSession();
  });

  it("uses default width when opening a same-resource location route instance", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().resizePrimaryPane(paneId, 900);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.primaryWidthPx).toBe(900);
    });

    act(() => {
      workspace().openPane({ href: "/media/11111111-1111-4111-8111-111111111111?loc=chapter-2" });
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(2);
      expect(primaryPanes(workspace().state)[0]).toMatchObject({
        href: "/media/11111111-1111-4111-8111-111111111111",
        primaryWidthPx: 900,
      });
      expect(primaryPanes(workspace().state)[1]).toMatchObject({
        href: "/media/11111111-1111-4111-8111-111111111111?loc=chapter-2",
        primaryWidthPx: workspacePrimaryMetrics.primaryDefaultWidthPx,
      });
    });
    flushWorkspaceSession();
  });

  it("opens, switches, resizes, and closes a secondary without changing primary width", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().resizePrimaryPane(paneId, 900);
      workspace().requestSecondarySurface(paneId, "reader-evidence");
    });

    await waitFor(() => {
      const primaryPane = primaryPanes(workspace().state)[0]!;
      const secondaryPane =
        workspace().state.secondaryPanesById[primaryPane.attachedSecondaryPaneId!];
      expect(primaryPane.primaryWidthPx).toBe(900);
      expect(secondaryPane).toMatchObject({
        parentPrimaryPaneId: paneId,
        groupId: "reader-tools",
        activeSurfaceId: "reader-evidence",
        widthPx: 360,
        visibility: "visible",
      });
    });
    const secondaryPaneId = primaryPanes(workspace().state)[0]!.attachedSecondaryPaneId!;

    act(() => {
      workspace().resizeSecondaryPane(secondaryPaneId, 9999);
      workspace().setSecondarySurface(secondaryPaneId, "reader-evidence");
      workspace().closeSecondaryPane(secondaryPaneId);
    });

    await waitFor(() => {
      const primaryPane = primaryPanes(workspace().state)[0]!;
      const secondaryPane =
        workspace().state.secondaryPanesById[primaryPane.attachedSecondaryPaneId!];
      expect(primaryPane.primaryWidthPx).toBe(900);
      expect(secondaryPane).toMatchObject({
        groupId: "reader-tools",
        activeSurfaceId: "reader-evidence",
        widthPx: 720,
        visibility: "collapsed",
      });
    });
    flushWorkspaceSession();
  });

  it("mutating one secondary leaves every sibling primary and secondary width unchanged", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneAId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().openPane({ href: "/media/22222222-2222-4222-8222-222222222222" });
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(2);
    });
    const paneBId = primaryPanes(workspace().state).find(
      (pane) => pane.href === "/media/22222222-2222-4222-8222-222222222222",
    )!.id;

    // Give each pane a distinct primary width and an attached reader-tools secondary.
    act(() => {
      workspace().resizePrimaryPane(paneAId, 820);
      workspace().resizePrimaryPane(paneBId, 760);
      workspace().requestSecondarySurface(paneAId, "reader-evidence");
      workspace().requestSecondarySurface(paneBId, "reader-evidence");
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
      workspace().setSecondarySurface(paneASecondaryId, "reader-evidence");
      workspace().closeSecondaryPane(paneASecondaryId);
    });

    await waitFor(() => {
      expect(
        workspace().state.secondaryPanesById[paneASecondaryId],
      ).toMatchObject({
        activeSurfaceId: "reader-evidence",
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
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().requestSecondarySurface(paneId, "reader-evidence");
      workspace().navigatePane(paneId, "/libraries/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/libraries/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      expect(primaryPanes(workspace().state)[0]?.attachedSecondaryPaneId).toBeNull();
      expect(workspace().state.secondaryPanesById).toEqual({});
    });
    flushWorkspaceSession();
  });

  it("preserves compatible secondarys across same-resource route-instance navigation", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111?loc=chapter-1");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().requestSecondarySurface(paneId, "reader-evidence");
    });

    let secondaryPaneId: string | null = null;
    await waitFor(() => {
      secondaryPaneId = primaryPanes(workspace().state)[0]?.attachedSecondaryPaneId ?? null;
      expect(secondaryPaneId).not.toBeNull();
    });

    act(() => {
      workspace().navigatePane(paneId, "/media/11111111-1111-4111-8111-111111111111?loc=chapter-2");
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe(
        "/media/11111111-1111-4111-8111-111111111111?loc=chapter-2",
      );
      expect(primaryPanes(workspace().state)[0]?.attachedSecondaryPaneId).toBe(
        secondaryPaneId,
      );
      expect(Object.keys(workspace().state.secondaryPanesById)).toContain(
        secondaryPaneId,
      );
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
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
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
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().resizePrimaryPane(paneId, 2200);
      workspace().navigatePane(paneId, "/libraries");
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]).toMatchObject({
        href: "/libraries",
        primaryWidthPx: workspacePrimaryMetrics.primaryDefaultWidthPx,
        history: { back: ["/media/11111111-1111-4111-8111-111111111111"], forward: [] },
      });
    });

    act(() => {
      workspace().goBackPane(paneId);
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]).toMatchObject({
        href: "/media/11111111-1111-4111-8111-111111111111",
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
        history: { back: ["/media/11111111-1111-4111-8111-111111111111"], forward: [] },
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
      workspace().navigatePane(secondPaneId, "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        activate: false,
      });
    });
    await waitFor(() => {
      const secondPane = primaryPanes(workspace().state).find((pane) => pane.id === secondPaneId);
      expect(secondPane?.href).toBe("/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
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
        href: "/media/11111111-1111-4111-8111-111111111111",
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
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/lectern");
    });
    flushWorkspaceSession();
  });

  it("clears runtime labels across route-instance location changes", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneId = workspace().state.activePrimaryPaneId;
    const routeKey = resolvePaneRouteKey("/media/11111111-1111-4111-8111-111111111111");

    act(() => {
      workspace().publishPaneLabel({ paneId, routeKey, label: "My Book" });
    });
    await waitFor(() => {
      expect(workspace().runtimeLabelByPaneId.get(paneId)?.label).toBe("My Book");
    });

    act(() => {
      workspace().navigatePane(paneId, "/media/11111111-1111-4111-8111-111111111111?loc=chapter-2");
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)[0]?.href).toBe("/media/11111111-1111-4111-8111-111111111111?loc=chapter-2");
      expect(workspace().runtimeLabelByPaneId.has(paneId)).toBe(false);
    });
    flushWorkspaceSession();
  });

  it("clears runtime labels when the pane navigates to a different resource", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneId = workspace().state.activePrimaryPaneId;
    const routeKey = resolvePaneRouteKey("/media/11111111-1111-4111-8111-111111111111");

    act(() => {
      workspace().publishPaneLabel({ paneId, routeKey, label: "My Book" });
    });
    await waitFor(() => {
      expect(workspace().runtimeLabelByPaneId.get(paneId)?.label).toBe("My Book");
    });

    act(() => {
      workspace().navigatePane(paneId, "/media/22222222-2222-4222-8222-222222222222");
    });
    await waitFor(() => {
      expect(workspace().runtimeLabelByPaneId.has(paneId)).toBe(false);
    });
    flushWorkspaceSession();
  });

  it("ignores stale runtime label publishes from a previous resource", async () => {
    const workspace = await mountWorkspaceStore("/media/11111111-1111-4111-8111-111111111111");
    const paneId = workspace().state.activePrimaryPaneId;
    const oldRouteKey = resolvePaneRouteKey("/media/11111111-1111-4111-8111-111111111111");

    act(() => {
      workspace().navigatePane(paneId, "/media/22222222-2222-4222-8222-222222222222");
      workspace().publishPaneLabel({
        paneId,
        routeKey: oldRouteKey,
        label: "Old Book",
      });
    });

    await waitFor(() => {
      const activePane = primaryPanes(workspace().state).find(
        (pane) => pane.id === workspace().state.activePrimaryPaneId,
      );
      expect(activePane?.href).toBe("/media/22222222-2222-4222-8222-222222222222");
      expect(workspace().runtimeLabelByPaneId.has(paneId)).toBe(false);
      expect(resolveWorkspacePaneLabel(activePane!, workspace().runtimeLabelByPaneId)).toMatchObject({
        label: "Media",
        labelState: "pending",
        labelSource: "fallback",
      });
    });
    flushWorkspaceSession();
  });

  it("uses label hints for dynamic panes until runtime labels supersede them", async () => {
    const workspace = await mountWorkspaceStore("/libraries");

    act(() => {
      workspace().openPane({ href: "/media/11111111-1111-4111-8111-111111111111", labelHint: "Library Row Label" });
    });

    await waitFor(() => {
      const paneId = workspace().state.activePrimaryPaneId;
      expect(resolveWorkspacePaneLabel(primaryPanes(workspace().state)[1]!, workspace().runtimeLabelByPaneId)).toMatchObject({
        label: "Library Row Label",
        labelState: "resolved",
        labelSource: "hint",
      });
      expect(workspace().runtimeLabelByPaneId.get(paneId)?.source).toBe("hint");
    });

    const paneId = workspace().state.activePrimaryPaneId;
    const routeKey = resolvePaneRouteKey("/media/11111111-1111-4111-8111-111111111111");
    act(() => {
      workspace().publishPaneLabel({ paneId, routeKey, label: "Runtime Label" });
    });

    await waitFor(() => {
      expect(resolveWorkspacePaneLabel(primaryPanes(workspace().state)[1]!, workspace().runtimeLabelByPaneId)).toMatchObject({
        label: "Runtime Label",
        labelState: "resolved",
        labelSource: "runtime",
      });
    });
    flushWorkspaceSession();
  });

  it("uses label hints for same-pane navigation", async () => {
    const workspace = await mountWorkspaceStore("/libraries/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const paneId = workspace().state.activePrimaryPaneId;

    act(() => {
      workspace().navigatePane(paneId, "/media/11111111-1111-4111-8111-111111111111", {
        labelHint: "Library Row Label",
      });
    });

    await waitFor(() => {
      const activePane = primaryPanes(workspace().state).find(
        (pane) => pane.id === workspace().state.activePrimaryPaneId,
      );
      expect(activePane?.href).toBe("/media/11111111-1111-4111-8111-111111111111");
      expect(resolveWorkspacePaneLabel(activePane!, workspace().runtimeLabelByPaneId)).toMatchObject({
        label: "Library Row Label",
        labelState: "resolved",
        labelSource: "hint",
      });
    });
    flushWorkspaceSession();
  });

  it("applies the latest label hint to the opened route instance", async () => {
    const workspace = await mountWorkspaceStore("/libraries");

    act(() => {
      workspace().openPane({ href: "/media/11111111-1111-4111-8111-111111111111", labelHint: "First label" });
      workspace().openPane({
        href: "/media/11111111-1111-4111-8111-111111111111?loc=chapter-2",
        labelHint: "Second label",
      });
    });

    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(3);
      const activePane = primaryPanes(workspace().state).find(
        (pane) => pane.id === workspace().state.activePrimaryPaneId,
      );
      expect(activePane?.href).toBe("/media/11111111-1111-4111-8111-111111111111?loc=chapter-2");
      expect(resolveWorkspacePaneLabel(activePane!, workspace().runtimeLabelByPaneId)).toMatchObject({
        label: "Second label",
        labelState: "resolved",
        labelSource: "hint",
      });
    });
    flushWorkspaceSession();
  });

  it("seeds the server-restored pane set on the first commit, no flash, no round-trip (AC-1/AC-2)", () => {
    const initialState = workspaceState({
      activePrimaryPaneId: "pane-conversation",
      primaryPanes: [
        pane("pane-libraries", "/libraries"),
        pane("pane-conversation", "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        pane("pane-notes", "/notes"),
      ],
    });
    const { snapshots, fetchSpy, workspace } = renderSeeded(
      initialState,
      "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );

    // The very FIRST rendered state already has all three panes — no 1→N swap.
    expect(primaryPanes(snapshots[0]!).map((item) => item.href)).toEqual([
      "/libraries",
      "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "/notes",
    ]);
    expect(snapshots.every((state) => primaryPanes(state).length === 3)).toBe(true);
    expect(activeHref(workspace())).toBe("/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    // No restore round-trip: every fetch (if any) is the capture PUT, never a GET.
    expect(
      fetchSpy.mock.calls.every(([, init]) => init?.method === "PUT"),
    ).toBe(true);
    flushWorkspaceSession();
  });

  it("never fetches the workspace session on load, even across metric changes", () => {
    const initialState = workspaceState({
      activePrimaryPaneId: "pane-conversation",
      primaryPanes: [
        pane("pane-libraries", "/libraries"),
        pane("pane-conversation", "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      ],
    });
    window.history.replaceState({}, "", "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const fetchSpy = mockWorkspaceSession();
    let store: WorkspaceStore | null = null;
    const { rerender } = render(
      <WorkspaceStoreProvider
        workspacePrimaryMetrics={workspacePrimaryMetrics}
        initialState={initialState}
      >
        <StoreProbe onStore={(nextStore) => { store = nextStore; }} />
      </WorkspaceStoreProvider>,
    );
    rerender(
      <WorkspaceStoreProvider
        workspacePrimaryMetrics={{ primaryMinWidthPx: 720, primaryDefaultWidthPx: 720 }}
        initialState={initialState}
      >
        <StoreProbe onStore={(nextStore) => { store = nextStore; }} />
      </WorkspaceStoreProvider>,
    );

    expect(store).not.toBeNull();
    expect(primaryPanes(store!.state).map((item) => item.href)).toEqual([
      "/libraries",
      "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
    expect(fetchSpy.mock.calls.every(([, init]) => init?.method === "PUT")).toBe(true);
    flushWorkspaceSession();
  });

  it("captures pane changes with a device-id-free PUT body (R2)", async () => {
    const { fetchSpy, workspace } = renderSeeded(
      workspaceState({ primaryPanes: [pane("pane-libraries", "/libraries")] }),
      "/libraries",
    );

    act(() => {
      workspace().openPane({ href: "/libraries/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    });
    await waitFor(() => {
      expect(primaryPanes(workspace().state)).toHaveLength(2);
    });
    flushWorkspaceSession();

    const putCall = fetchSpy.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse(String(putCall![1]?.body));
    expect(Object.keys(body)).toEqual(["state"]);
    expect(body).not.toHaveProperty("device_id");
    expect(body.state.primaryPaneOrder).toHaveLength(2);
  });

  it("projects the active pane href to the address bar via replaceState, never pushState", async () => {
    const workspace = await mountWorkspaceStore("/libraries");
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    act(() => {
      workspace().openPane({ href: "/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?run=run-1" });
    });

    await waitFor(() => {
      expect(activeHref(workspace())).toBe("/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?run=run-1");
      expect(window.location.pathname).toBe("/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      expect(window.location.search).toBe("?run=run-1");
    });
    expect(pushStateSpy).not.toHaveBeenCalled();
    flushWorkspaceSession();
  });

  it("projects the seeded active pane href onto a bare-landing address bar", async () => {
    const initialState = workspaceState({
      activePrimaryPaneId: "pane-notes",
      primaryPanes: [pane("pane-libraries", "/libraries"), pane("pane-notes", "/notes")],
    });
    const { workspace } = renderSeeded(initialState, "/libraries");

    await waitFor(() => {
      expect(window.location.pathname).toBe("/notes");
    });
    expect(activeHref(workspace())).toBe("/notes");
    flushWorkspaceSession();
  });

  it("folds a client-only URL hash into the active pane without disturbing the restored layout", async () => {
    // The hash never reaches the server, so the seeded active pane carries no hash; the
    // mount-time fold must add it to the active pane (same resource → pane preserved) and
    // leave the rest of the restored multi-pane layout untouched.
    const initialState = workspaceState({
      activePrimaryPaneId: "pane-media",
      primaryPanes: [
        pane("pane-libraries", "/libraries"),
        pane("pane-media", "/media/11111111-1111-4111-8111-111111111111"),
      ],
    });
    const { workspace } = renderSeeded(initialState, "/media/11111111-1111-4111-8111-111111111111#loc=chapter-2");

    await waitFor(() => {
      expect(activeHref(workspace())).toBe("/media/11111111-1111-4111-8111-111111111111#loc=chapter-2");
    });
    expect(primaryPanes(workspace().state).map((item) => item.href)).toEqual([
      "/libraries",
      "/media/11111111-1111-4111-8111-111111111111#loc=chapter-2",
    ]);
    flushWorkspaceSession();
  });

  it("folds a later client-side URL hash into the matching active pane", async () => {
    const mediaHref = "/media/11111111-1111-4111-8111-111111111111";
    const initialState = workspaceState({
      activePrimaryPaneId: "pane-media",
      primaryPanes: [pane("pane-media", mediaHref)],
    });
    const { workspace } = renderSeeded(initialState, mediaHref);

    await waitFor(() => {
      expect(activeHref(workspace())).toBe(mediaHref);
    });

    act(() => {
      window.history.replaceState(null, "", `${mediaHref}#evidence-span-1`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => {
      expect(activeHref(workspace())).toBe(`${mediaHref}#evidence-span-1`);
    });
    flushWorkspaceSession();
  });

});

describe("resolveWorkspacePaneLabel", () => {
  const empty = new Map<string, WorkspacePaneLabelRecord>();

  it("returns pending for a dynamic route with no runtime label", () => {
    const pane = { id: "p1", href: "/media/m1" };
    const result = resolveWorkspacePaneLabel(pane, empty);
    expect(result.labelState).toBe("pending");
    expect(result.label.length).toBeGreaterThan(0);
  });

  it("returns resolved with the runtime label when one is published", () => {
    const pane = { id: "p1", href: "/media/m1" };
    const result = resolveWorkspacePaneLabel(
      pane,
      new Map([["p1", labelRecord("/media/m1", "My Book")]]),
    );
    expect(result.labelState).toBe("resolved");
    expect(result.label).toBe("My Book");
  });

  it("ignores stale label records from a different resource", () => {
    const pane = { id: "p1", href: "/media/m2" };
    const result = resolveWorkspacePaneLabel(
      pane,
      new Map([["p1", labelRecord("/media/m1", "My Book")]]),
    );
    expect(result.labelState).toBe("pending");
    expect(result.label).toBe("Media");
  });

  it("returns resolved for a static route with the route label", () => {
    const pane = { id: "p2", href: "/libraries" };
    const result = resolveWorkspacePaneLabel(pane, empty);
    expect(result.labelState).toBe("resolved");
    expect(result.label).toBe("Libraries");
  });

  it("label is always a non-empty string", () => {
    for (const href of ["/media/m1", "/libraries"]) {
      const result = resolveWorkspacePaneLabel({ id: "px", href }, empty);
      expect(result.label.length).toBeGreaterThan(0);
    }
  });
});
