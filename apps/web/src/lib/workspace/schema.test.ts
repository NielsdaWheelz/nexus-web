import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  MAX_PANE_HISTORY_STACK_LENGTH,
  MAX_TOTAL_PANE_HISTORY_ENTRIES,
  WORKSPACE_SCHEMA_VERSION,
  createDefaultWorkspaceState,
  sanitizeWorkspaceState,
} from "@/lib/workspace/schema";
import { MAX_STANDARD_PANE_WIDTH_PX, resolvePaneRouteWidthContract } from "@/lib/panes/paneRouteModel";
import { resolvePaneTransitionWidth } from "@/lib/workspace/paneWidth";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function sanitize(
  value: unknown,
  options: { fallbackHref?: string; baseOrigin?: string } = {},
) {
  return sanitizeWorkspaceState(value, {
    fallbackHref: options.fallbackHref ?? "/libraries",
    baseOrigin: options.baseOrigin,
    workspacePrimaryMetrics,
  });
}

describe("workspace schema", () => {
  it("creates a default workspace with the workspace primary width", () => {
    const state = createDefaultWorkspaceState("/media/abc", workspacePrimaryMetrics);
    expect(state.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.href).toBe("/media/abc");
    expect(state.panes[0]?.widthPx).toBe(workspacePrimaryMetrics.primaryDefaultWidthPx);
    expect(state.panes[0]?.visibility).toBe("visible");
    expect(state.panes[0]?.history).toEqual({ back: [], forward: [] });
    expect(state.activePaneId).toBe(state.panes[0]?.id);
  });

  it("normalizes only same-origin http(s) workspace hrefs", () => {
    expect(normalizeWorkspaceHref("/libraries")).toBe("/libraries");
    expect(normalizeWorkspaceHref("https://example.com/libraries")).toBeNull();
    expect(normalizeWorkspaceHref("javascript:alert(1)")).toBeNull();
  });

  it("falls back to a safe default when schemaVersion mismatches", () => {
    const state = sanitize(
      { schemaVersion: 999, activePaneId: "x", panes: [] },
      { fallbackHref: "/conversations" },
    );
    expect(state.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(state.panes[0]?.href).toBe("/conversations");
  });

  it("rejects pane payloads without visibility", () => {
    const state = sanitize({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-1",
      panes: [{ id: "pane-1", href: "/media/1", widthPx: 480 }],
    });
    expect(state.panes[0]?.href).toBe("/libraries");
  });

  it("rejects pane payloads without pane history", () => {
    const state = sanitize({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-1",
      panes: [
        { id: "pane-1", href: "/media/1", widthPx: 480, visibility: "visible" },
      ],
    });
    expect(state.panes[0]?.href).toBe("/libraries");
  });

  it("sanitizes pane history hrefs", () => {
    const state = sanitize(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activePaneId: "pane-1",
        panes: [
          {
            id: "pane-1",
            href: "/media/1",
            widthPx: 480,
            visibility: "visible",
            history: {
              back: ["http://localhost/libraries?sort=recent"],
              forward: ["/media/2#chapter"],
            },
          },
        ],
      },
      { baseOrigin: "http://localhost" },
    );
    expect(state.panes[0]?.history).toEqual({
      back: ["/libraries?sort=recent"],
      forward: ["/media/2#chapter"],
    });
  });

  it("rejects malformed pane history hrefs", () => {
    const state = sanitize(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activePaneId: "pane-1",
        panes: [
          {
            id: "pane-1",
            href: "/media/1",
            widthPx: 480,
            visibility: "visible",
            history: { back: ["https://example.com/media/0"], forward: [] },
          },
        ],
      },
      { baseOrigin: "http://localhost" },
    );
    expect(state.panes[0]?.href).toBe("/libraries");
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
        history: { back: [], forward: [] },
      })),
    };
    const state = sanitize(oversized);
    expect(state.panes.length).toBeLessThanOrEqual(MAX_PANES);
  });

  it("clamps persisted pane widths to the workspace floor", () => {
    const state = sanitize({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-1",
      panes: [
        { id: "pane-1", href: "/libraries", widthPx: 10, visibility: "visible", history: { back: [], forward: [] } },
        { id: "pane-2", href: "/media/1", widthPx: 99999, visibility: "visible", history: { back: [], forward: [] } },
      ],
    });
    expect(state.panes[0]?.widthPx).toBe(workspacePrimaryMetrics.primaryMinWidthPx);
    expect(state.panes[1]?.widthPx).toBe(99999);
  });

  it("uses workspace defaults when a persisted pane omits widthPx", () => {
    const state = sanitize({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-1",
      panes: [
        { id: "pane-1", href: "/media/1", visibility: "visible", history: { back: [], forward: [] } },
        { id: "pane-2", href: "/libraries", visibility: "visible", history: { back: [], forward: [] } },
        { id: "pane-3", href: "/podcasts/p1", visibility: "visible", history: { back: [], forward: [] } },
        { id: "pane-4", href: "/settings", visibility: "visible", history: { back: [], forward: [] } },
      ],
    });
    expect(state.panes.map((pane) => pane.widthPx)).toEqual([
      684,
      684,
      684,
      684,
    ]);
  });

  it("keeps route width policy to max width and intrinsic permission", () => {
    expect(resolvePaneRouteWidthContract("/media/1")).toEqual({
      maxWidthPx: 2400,
      allowsIntrinsicPrimaryWidth: true,
    });
    expect(resolvePaneRouteWidthContract("/settings")).toEqual({
      maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
      allowsIntrinsicPrimaryWidth: false,
    });
  });

  it("resolves transition widths from resource preservation only", () => {
    expect(
      resolvePaneTransitionWidth(900, false, workspacePrimaryMetrics),
    ).toBe(684);
    expect(
      resolvePaneTransitionWidth(2200, true, workspacePrimaryMetrics),
    ).toBe(2200);
  });

  it("keeps minimized panes when the active pane is visible", () => {
    const state = sanitize({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [
        { id: "pane-1", href: "/libraries", widthPx: 480, visibility: "minimized", history: { back: [], forward: [] } },
        { id: "pane-2", href: "/media/1", widthPx: 520, visibility: "visible", history: { back: [], forward: [] } },
      ],
    });
    expect(state.panes.map((pane) => pane.visibility)).toEqual(["minimized", "visible"]);
    expect(state.activePaneId).toBe("pane-2");
  });

  it("falls back when the requested active pane is minimized", () => {
    const state = sanitize(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activePaneId: "pane-1",
        panes: [
          { id: "pane-1", href: "/libraries", widthPx: 480, visibility: "minimized", history: { back: [], forward: [] } },
          { id: "pane-2", href: "/media/1", widthPx: 520, visibility: "visible", history: { back: [], forward: [] } },
        ],
      },
      { fallbackHref: "/conversations" },
    );
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.href).toBe("/conversations");
    expect(state.activePaneId).toBe(state.panes[0]?.id);
  });

  it("trims pane history deterministically", () => {
    const history = Array.from({ length: 20 }, (_, index) => `/media/${index}`);
    const state = sanitize({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-0",
      panes: Array.from({ length: 5 }, (_, index) => ({
        id: `pane-${index}`,
        href: `/media/current-${index}`,
        widthPx: 480,
        visibility: "visible",
        history: { back: history, forward: history },
      })),
    });

    for (const pane of state.panes) {
      expect(pane.history.back.length).toBeLessThanOrEqual(
        MAX_PANE_HISTORY_STACK_LENGTH,
      );
      expect(pane.history.forward.length).toBeLessThanOrEqual(
        MAX_PANE_HISTORY_STACK_LENGTH,
      );
      if (pane.history.back.length > 0) {
        expect(pane.history.back[pane.history.back.length - 1]).toBe("/media/19");
      }
    }
    const total = state.panes.reduce(
      (count, pane) => count + pane.history.back.length + pane.history.forward.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_PANE_HISTORY_ENTRIES);
  });
});
