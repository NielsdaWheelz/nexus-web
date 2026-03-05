import { describe, expect, it } from "vitest";
import {
  MAX_PANE_GROUPS,
  MAX_TABS_PER_GROUP,
  WORKSPACE_SCHEMA_VERSION,
  createDefaultWorkspaceState,
  normalizeWorkspaceHref,
  sanitizeWorkspaceState,
} from "@/lib/workspace/schema";

describe("workspace schema", () => {
  it("creates a default workspace rooted at the provided href", () => {
    const state = createDefaultWorkspaceState("/media/abc");
    expect(state.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]?.tabs).toHaveLength(1);
    expect(state.groups[0]?.tabs[0]?.href).toBe("/media/abc");
  });

  it("normalizes only same-origin http(s) workspace hrefs", () => {
    expect(normalizeWorkspaceHref("/libraries")).toBe("/libraries");
    expect(normalizeWorkspaceHref("https://example.com/libraries")).toBeNull();
    expect(normalizeWorkspaceHref("javascript:alert(1)")).toBeNull();
  });

  it("falls back to a safe default when schemaVersion mismatches", () => {
    const state = sanitizeWorkspaceState(
      {
        schemaVersion: 999,
        activeGroupId: "x",
        groups: [],
      },
      { fallbackHref: "/conversations" }
    );
    expect(state.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(state.groups[0]?.tabs[0]?.href).toBe("/conversations");
  });

  it("caps group and tab counts during sanitization", () => {
    const oversized = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activeGroupId: "group-1",
      groups: Array.from({ length: MAX_PANE_GROUPS + 4 }, (_, groupIdx) => ({
        id: `group-${groupIdx}`,
        activeTabId: `tab-${groupIdx}-0`,
        tabs: Array.from({ length: MAX_TABS_PER_GROUP + 10 }, (_, tabIdx) => ({
          id: `tab-${groupIdx}-${tabIdx}`,
          href: `/media/${groupIdx}-${tabIdx}`,
        })),
      })),
    };
    const state = sanitizeWorkspaceState(oversized, { fallbackHref: "/libraries" });
    expect(state.groups.length).toBeLessThanOrEqual(MAX_PANE_GROUPS);
    for (const group of state.groups) {
      expect(group.tabs.length).toBeLessThanOrEqual(MAX_TABS_PER_GROUP);
    }
  });
});
