import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
  DEFAULT_MEDIA_PANE_WIDTH_PX,
  DEFAULT_PODCAST_DETAIL_PANE_WIDTH_PX,
  DEFAULT_STANDARD_PANE_WIDTH_PX,
  MAX_MEDIA_PANE_WIDTH_PX,
  MAX_PANES,
  MAX_STANDARD_PANE_WIDTH_PX,
  MIN_PANE_WIDTH_PX,
  WORKSPACE_SCHEMA_VERSION,
  createDefaultWorkspaceState,
  normalizeWorkspaceHref,
  resolvePaneWidthContract,
  sanitizeWorkspaceState,
} from "@/lib/workspace/schema";

describe("workspace schema", () => {
  it("creates a default workspace with a single pane", () => {
    const state = createDefaultWorkspaceState("/media/abc");
    expect(state.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.href).toBe("/media/abc");
    expect(state.panes[0]?.widthPx).toBe(DEFAULT_MEDIA_PANE_WIDTH_PX);
    expect(state.panes[0]?.visibility).toBe("visible");
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

  it("rejects pane payloads without visibility", () => {
    const state = sanitizeWorkspaceState(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activePaneId: "pane-1",
        panes: [{ id: "pane-1", href: "/media/1", widthPx: 480 }],
      },
      { fallbackHref: "/libraries" }
    );
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.href).toBe("/libraries");
    expect(state.panes[0]?.visibility).toBe("visible");
  });

  it("caps pane count during sanitization", () => {
    const oversized = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-0",
      panes: Array.from({ length: MAX_PANES + 10 }, (_, i) => ({
        id: `pane-${i}`,
        href: `/media/${i}`,
        widthPx: 480,
        visibility: "visible",
      })),
    };
    const state = sanitizeWorkspaceState(oversized, { fallbackHref: "/libraries" });
    expect(state.panes.length).toBeLessThanOrEqual(MAX_PANES);
  });

  it("clamps pane widths by route", () => {
    const state = sanitizeWorkspaceState(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activePaneId: "pane-1",
        panes: [
          { id: "pane-1", href: "/libraries", widthPx: 10, visibility: "visible" },
          { id: "pane-2", href: "/media/1", widthPx: 99999, visibility: "visible" },
          { id: "pane-3", href: "/conversations", widthPx: 99999, visibility: "visible" },
        ],
      },
      { fallbackHref: "/libraries" }
    );
    expect(state.panes[0]?.widthPx).toBe(MIN_PANE_WIDTH_PX);
    expect(state.panes[1]?.widthPx).toBe(MAX_MEDIA_PANE_WIDTH_PX);
    expect(state.panes[2]?.widthPx).toBe(MAX_STANDARD_PANE_WIDTH_PX);
  });

  it("uses route defaults when a persisted pane omits widthPx", () => {
    const state = sanitizeWorkspaceState(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activePaneId: "pane-1",
        panes: [
          { id: "pane-1", href: "/media/1", visibility: "visible" },
          { id: "pane-2", href: "/libraries", visibility: "visible" },
          { id: "pane-3", href: "/podcasts/p1", visibility: "visible" },
          { id: "pane-4", href: "/settings", visibility: "visible" },
        ],
      },
      { fallbackHref: "/libraries" }
    );
    expect(state.panes.map((pane) => pane.widthPx)).toEqual([
      DEFAULT_MEDIA_PANE_WIDTH_PX,
      DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
      DEFAULT_PODCAST_DETAIL_PANE_WIDTH_PX,
      DEFAULT_STANDARD_PANE_WIDTH_PX,
    ]);
  });

  it("uses the standard width contract for unsupported route shapes", () => {
    for (const href of [
      "/media",
      "/pages",
      "/pages/a/b",
      "/daily/a/b",
      "/notes/a/b",
      "/podcasts/a/b",
      "/libraries/one/two",
      "/authors",
      "/authors/a/b",
    ]) {
      expect(resolvePaneWidthContract(href)).toMatchObject({
        defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
        minWidthPx: MIN_PANE_WIDTH_PX,
        maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
      });
    }
  });

  it("keeps minimized panes when the active pane is visible", () => {
    const state = sanitizeWorkspaceState(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activePaneId: "pane-2",
        panes: [
          { id: "pane-1", href: "/libraries", widthPx: 480, visibility: "minimized" },
          { id: "pane-2", href: "/media/1", widthPx: 520, visibility: "visible" },
        ],
      },
      { fallbackHref: "/libraries" }
    );
    expect(state.panes.map((pane) => pane.visibility)).toEqual(["minimized", "visible"]);
    expect(state.activePaneId).toBe("pane-2");
  });

  it("falls back when the requested active pane is minimized", () => {
    const state = sanitizeWorkspaceState(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activePaneId: "pane-1",
        panes: [
          { id: "pane-1", href: "/libraries", widthPx: 480, visibility: "minimized" },
          { id: "pane-2", href: "/media/1", widthPx: 520, visibility: "visible" },
        ],
      },
      { fallbackHref: "/conversations" }
    );
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.href).toBe("/conversations");
    expect(state.activePaneId).toBe(state.panes[0]?.id);
  });
});
