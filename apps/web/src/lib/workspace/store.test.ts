import { describe, expect, it } from "vitest";
import {
  createDefaultWorkspaceState,
  createPaneId,
  type WorkspacePaneStateV4,
} from "@/lib/workspace/schema";
import { workspaceReducer } from "@/lib/workspace/store";

function makePane(
  id: string,
  href: string,
  visibility: WorkspacePaneStateV4["visibility"] = "visible"
): WorkspacePaneStateV4 {
  return { id, href, widthPx: 480, visibility };
}

describe("workspace reducer", () => {
  it("opens a new pane after the opener", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const newPaneId = createPaneId();
    const next = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(newPaneId, "/conversations")],
      afterPaneId: initial.panes[0]!.id,
      activate: true,
    });
    expect(next.panes).toHaveLength(2);
    expect(next.panes[1]?.href).toBe("/conversations");
    expect(next.panes[1]?.visibility).toBe("visible");
    expect(next.activePaneId).toBe(newPaneId);
  });

  it("opens panes as visible", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const newPaneId = createPaneId();
    const next = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(newPaneId, "/conversations", "minimized")],
      afterPaneId: null,
      activate: false,
    });

    expect(next.panes.find((pane) => pane.id === newPaneId)?.visibility).toBe("visible");
    expect(next.activePaneId).toBe(initial.activePaneId);
  });

  it("closes a pane and activates the nearest surviving pane", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const withTwo = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(secondId, "/conversations")],
      afterPaneId: null,
      activate: false,
    });
    const next = workspaceReducer(withTwo, {
      type: "close_pane",
      paneId: initial.panes[0]!.id,
    });
    expect(next.panes).toHaveLength(1);
    expect(next.activePaneId).toBe(secondId);
  });

  it("resets to fallback when closing the last pane", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const next = workspaceReducer(initial, {
      type: "close_pane",
      paneId: initial.panes[0]!.id,
    });
    expect(next.panes).toHaveLength(1);
    expect(next.panes[0]?.href).toBe("/libraries");
  });

  it("navigates a pane and makes it active", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const next = workspaceReducer(initial, {
      type: "navigate_pane",
      paneId: initial.panes[0]!.id,
      href: "/settings",
      activate: true,
    });
    expect(next.panes[0]?.href).toBe("/settings");
    expect(next.activePaneId).toBe(initial.panes[0]!.id);
  });

  it("can update a background pane without activating it", () => {
    const initial = createDefaultWorkspaceState("/media/media-1");
    const chatId = createPaneId();
    const withChat = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(chatId, "/conversations/new")],
      afterPaneId: null,
      activate: false,
    });
    const next = workspaceReducer(withChat, {
      type: "navigate_pane",
      paneId: chatId,
      href: "/conversations/conversation-1",
      activate: false,
    });

    expect(next.panes.find((pane) => pane.id === chatId)?.href).toBe(
      "/conversations/conversation-1",
    );
    expect(next.panes.find((pane) => pane.id === chatId)?.visibility).toBe("visible");
    expect(next.activePaneId).toBe(initial.activePaneId);
  });

  it("activates only visible panes", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const withTwo = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(secondId, "/conversations")],
      afterPaneId: null,
      activate: false,
    });
    const withMinimized = workspaceReducer(withTwo, {
      type: "minimize_pane",
      paneId: secondId,
    });
    const next = workspaceReducer(withMinimized, {
      type: "activate_pane",
      paneId: secondId,
    });

    expect(next.activePaneId).toBe(initial.activePaneId);
  });

  it("navigates with activation by making a minimized pane visible and active", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const withTwo = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(secondId, "/conversations/new")],
      afterPaneId: null,
      activate: false,
    });
    const withMinimized = workspaceReducer(withTwo, {
      type: "minimize_pane",
      paneId: secondId,
    });
    const next = workspaceReducer(withMinimized, {
      type: "navigate_pane",
      paneId: secondId,
      href: "/conversations/conversation-1",
      activate: true,
    });

    expect(next.panes.find((pane) => pane.id === secondId)?.href).toBe(
      "/conversations/conversation-1"
    );
    expect(next.panes.find((pane) => pane.id === secondId)?.visibility).toBe("visible");
    expect(next.activePaneId).toBe(secondId);
  });

  it("navigates without activation by preserving pane visibility", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const withTwo = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(secondId, "/conversations/new")],
      afterPaneId: null,
      activate: false,
    });
    const withMinimized = workspaceReducer(withTwo, {
      type: "minimize_pane",
      paneId: secondId,
    });
    const next = workspaceReducer(withMinimized, {
      type: "navigate_pane",
      paneId: secondId,
      href: "/conversations/conversation-1",
      activate: false,
    });

    expect(next.panes.find((pane) => pane.id === secondId)?.href).toBe(
      "/conversations/conversation-1"
    );
    expect(next.panes.find((pane) => pane.id === secondId)?.visibility).toBe("minimized");
    expect(next.activePaneId).toBe(initial.activePaneId);
  });

  it("does not minimize the last visible pane", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const next = workspaceReducer(initial, {
      type: "minimize_pane",
      paneId: initial.panes[0]!.id,
    });

    expect(next.panes[0]?.visibility).toBe("visible");
    expect(next.activePaneId).toBe(initial.activePaneId);
  });

  it("minimizes an inactive pane without changing the active pane", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const withTwo = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(secondId, "/conversations")],
      afterPaneId: null,
      activate: false,
    });
    const next = workspaceReducer(withTwo, {
      type: "minimize_pane",
      paneId: secondId,
    });

    expect(next.panes.find((pane) => pane.id === secondId)?.visibility).toBe("minimized");
    expect(next.activePaneId).toBe(initial.activePaneId);
  });

  it("minimizes the active pane and activates the nearest visible pane to the right", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const thirdId = createPaneId();
    const withThree = workspaceReducer(
      workspaceReducer(initial, {
        type: "open_pane",
        panes: [makePane(secondId, "/conversations")],
        afterPaneId: null,
        activate: true,
      }),
      {
        type: "open_pane",
        panes: [makePane(thirdId, "/media/1")],
        afterPaneId: secondId,
        activate: false,
      }
    );
    const next = workspaceReducer(withThree, {
      type: "minimize_pane",
      paneId: secondId,
    });

    expect(next.panes.find((pane) => pane.id === secondId)?.visibility).toBe("minimized");
    expect(next.activePaneId).toBe(thirdId);
  });

  it("minimizes the active pane and falls back to the previous visible pane", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const withTwo = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(secondId, "/conversations")],
      afterPaneId: null,
      activate: true,
    });
    const next = workspaceReducer(withTwo, {
      type: "minimize_pane",
      paneId: secondId,
    });

    expect(next.panes.find((pane) => pane.id === secondId)?.visibility).toBe("minimized");
    expect(next.activePaneId).toBe(initial.activePaneId);
  });

  it("restores a pane by making it visible and active", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const withTwo = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(secondId, "/conversations")],
      afterPaneId: null,
      activate: false,
    });
    const withMinimized = workspaceReducer(withTwo, {
      type: "minimize_pane",
      paneId: secondId,
    });
    const next = workspaceReducer(withMinimized, {
      type: "restore_pane",
      paneId: secondId,
    });

    expect(next.panes.find((pane) => pane.id === secondId)?.visibility).toBe("visible");
    expect(next.activePaneId).toBe(secondId);
  });

  it("closes minimized panes", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const withTwo = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(secondId, "/conversations")],
      afterPaneId: null,
      activate: false,
    });
    const withMinimized = workspaceReducer(withTwo, {
      type: "minimize_pane",
      paneId: secondId,
    });
    const next = workspaceReducer(withMinimized, {
      type: "close_pane",
      paneId: secondId,
    });

    expect(next.panes).toHaveLength(1);
    expect(next.panes.some((pane) => pane.id === secondId)).toBe(false);
    expect(next.activePaneId).toBe(initial.activePaneId);
  });

  it("resizes a pane and clamps the width", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const next = workspaceReducer(initial, {
      type: "resize_pane",
      paneId: initial.panes[0]!.id,
      widthPx: 99999,
    });
    expect(next.panes[0]?.widthPx).toBe(1400);
  });

  it("resizes a minimized pane without restoring it", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const withTwo = workspaceReducer(initial, {
      type: "open_pane",
      panes: [makePane(secondId, "/conversations")],
      afterPaneId: null,
      activate: false,
    });
    const withMinimized = workspaceReducer(withTwo, {
      type: "minimize_pane",
      paneId: secondId,
    });
    const next = workspaceReducer(withMinimized, {
      type: "resize_pane",
      paneId: secondId,
      widthPx: 99999,
    });

    const resizedPane = next.panes.find((pane) => pane.id === secondId);
    expect(resizedPane?.widthPx).toBe(1400);
    expect(resizedPane?.visibility).toBe("minimized");
  });
});
