import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  WORKSPACE_SCHEMA_VERSION,
  createDefaultWorkspaceState,
  normalizeWorkspaceHref,
  sanitizeWorkspaceState,
} from "@/lib/workspace/schema";

describe("workspace schema", () => {
  it("creates a default workspace with a single pane", () => {
    const state = createDefaultWorkspaceState("/media/abc");
    expect(state.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.href).toBe("/media/abc");
    expect(state.panes[0]?.widthPx).toBe(480);
    expect(state.activePaneId).toBe(state.panes[0]?.id);
  });

  it("normalizes only same-origin http(s) workspace hrefs", () => {
    expect(normalizeWorkspaceHref("/libraries")).toBe("/libraries");
    expect(normalizeWorkspaceHref("https://example.com/libraries")).toBeNull();
    expect(normalizeWorkspaceHref("javascript:alert(1)")).toBeNull();
  });

  it("falls back to a safe default when schemaVersion mismatches", () => {
    const state = sanitizeWorkspaceState(
      { schemaVersion: 999, activePaneId: "x", panes: [] },
      { fallbackHref: "/conversations" }
    );
    expect(state.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(state.panes[0]?.href).toBe("/conversations");
  });

  it("caps pane count during sanitization", () => {
    const oversized = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-0",
      panes: Array.from({ length: MAX_PANES + 10 }, (_, i) => ({
        id: `pane-${i}`,
        href: `/media/${i}`,
        widthPx: 480,
      })),
    };
    const state = sanitizeWorkspaceState(oversized, { fallbackHref: "/libraries" });
    expect(state.panes.length).toBeLessThanOrEqual(MAX_PANES);
  });

  it("drops companion panes whose source pane does not exist", () => {
    const state = sanitizeWorkspaceState(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activePaneId: "pane-1",
        panes: [
          { id: "pane-1", href: "/libraries", widthPx: 480 },
          { id: "pane-2", href: "/media/1", widthPx: 360, companionOfPaneId: "nonexistent" },
        ],
      },
      { fallbackHref: "/libraries" }
    );
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.id).toBe("pane-1");
  });

  it("clamps pane widths to valid range", () => {
    const state = sanitizeWorkspaceState(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activePaneId: "pane-1",
        panes: [
          { id: "pane-1", href: "/libraries", widthPx: 10 },
          { id: "pane-2", href: "/media/1", widthPx: 99999 },
        ],
      },
      { fallbackHref: "/libraries" }
    );
    expect(state.panes[0]?.widthPx).toBe(320);
    expect(state.panes[1]?.widthPx).toBe(1400);
  });
});
