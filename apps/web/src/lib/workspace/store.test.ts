import { describe, expect, it } from "vitest";
import { createDefaultWorkspaceState, createPaneId } from "@/lib/workspace/schema";
import { workspaceReducer } from "@/lib/workspace/store";

describe("workspace reducer", () => {
  it("opens a new pane after the opener", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const newPaneId = createPaneId();
    const next = workspaceReducer(initial, {
      type: "open_pane",
      panes: [{ id: newPaneId, href: "/conversations", widthPx: 480 }],
      afterPaneId: initial.panes[0]!.id,
      activate: true,
    });
    expect(next.panes).toHaveLength(2);
    expect(next.panes[1]?.href).toBe("/conversations");
    expect(next.activePaneId).toBe(newPaneId);
  });

  it("closes a pane and activates the nearest surviving pane", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const secondId = createPaneId();
    const withTwo = workspaceReducer(initial, {
      type: "open_pane",
      panes: [{ id: secondId, href: "/conversations", widthPx: 480 }],
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
    });
    expect(next.panes[0]?.href).toBe("/settings");
    expect(next.activePaneId).toBe(initial.panes[0]!.id);
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
});
