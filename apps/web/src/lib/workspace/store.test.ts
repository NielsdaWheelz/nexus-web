import { describe, expect, it } from "vitest";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { workspaceReducer } from "@/lib/workspace/store";

describe("workspace reducer", () => {
  it("opens a tab inside the active group", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const next = workspaceReducer(initial, {
      type: "open_tab",
      href: "/conversations",
      activate: true,
    });
    expect(next.groups[0]?.tabs).toHaveLength(2);
    expect(next.groups[0]?.tabs[1]?.href).toBe("/conversations");
    expect(next.groups[0]?.activeTabId).toBe(next.groups[0]?.tabs[1]?.id);
  });

  it("opens a brand-new group with a tab", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const next = workspaceReducer(initial, {
      type: "open_group_with_tab",
      href: "/media/123",
    });
    expect(next.groups).toHaveLength(2);
    expect(next.activeGroupId).toBe(next.groups[1]?.id);
    expect(next.groups[1]?.tabs[0]?.href).toBe("/media/123");
  });

  it("never deletes the final group when closing tabs", () => {
    const initial = createDefaultWorkspaceState("/libraries");
    const groupId = initial.groups[0]?.id ?? "";
    const tabId = initial.groups[0]?.tabs[0]?.id ?? "";
    const next = workspaceReducer(initial, {
      type: "close_tab",
      groupId,
      tabId,
    });
    expect(next.groups).toHaveLength(1);
    expect(next.groups[0]?.tabs).toHaveLength(1);
  });
});
