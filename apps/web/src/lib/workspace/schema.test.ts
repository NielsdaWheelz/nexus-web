import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  MAX_PANE_HISTORY_STACK_LENGTH,
  MAX_TOTAL_PANE_HISTORY_ENTRIES,
  createDefaultWorkspaceState,
  getWorkspacePrimaryPanes,
  sanitizeWorkspaceState,
} from "@/lib/workspace/schema";
import {
  MAX_STANDARD_PANE_WIDTH_PX,
  resolvePaneRouteWidthContract,
} from "@/lib/panes/paneRouteModel";
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

function primary(
  id: string,
  href: string,
  input: {
    primaryWidthPx?: number;
    visibility?: "visible" | "minimized";
    attachedSecondaryPaneId?: string | null;
    history?: { back: string[]; forward: string[] };
  } = {},
) {
  return {
    id,
    href,
    primaryWidthPx: input.primaryWidthPx ?? 720,
    visibility: input.visibility ?? "visible",
    history: input.history ?? { back: [], forward: [] },
    attachedSecondaryPaneId: input.attachedSecondaryPaneId ?? null,
  };
}

function state(input: {
  activePrimaryPaneId?: string;
  primaryPanes: ReturnType<typeof primary>[];
  secondaryPanesById?: Record<string, unknown>;
}) {
  return {
    activePrimaryPaneId: input.activePrimaryPaneId ?? input.primaryPanes[0]!.id,
    primaryPaneOrder: input.primaryPanes.map((pane) => pane.id),
    primaryPanesById: Object.fromEntries(
      input.primaryPanes.map((pane) => [pane.id, pane]),
    ),
    secondaryPanesById: input.secondaryPanesById ?? {},
  };
}

describe("workspace schema", () => {
  it("creates a default workspace with the workspace primary width", () => {
    const current = createDefaultWorkspaceState(
      "/media/abc",
      workspacePrimaryMetrics,
    );
    const panes = getWorkspacePrimaryPanes(current);
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({
      href: "/media/abc",
      primaryWidthPx: workspacePrimaryMetrics.primaryDefaultWidthPx,
      visibility: "visible",
      history: { back: [], forward: [] },
      attachedSecondaryPaneId: null,
    });
    expect(current.activePrimaryPaneId).toBe(panes[0]?.id);
    expect(current.secondaryPanesById).toEqual({});
  });

  it("normalizes only same-origin http(s) workspace hrefs", () => {
    expect(normalizeWorkspaceHref("/libraries")).toBe("/libraries");
    expect(normalizeWorkspaceHref("https://example.com/libraries")).toBeNull();
    expect(normalizeWorkspaceHref("javascript:alert(1)")).toBeNull();
  });

  it("hard-resets malformed workspace payloads", () => {
    const current = sanitize({ activePrimaryPaneId: "pane-1" });
    const panes = getWorkspacePrimaryPanes(current);
    expect(panes).toHaveLength(1);
    expect(panes[0]?.href).toBe("/libraries");
    expect(panes[0]?.attachedSecondaryPaneId).toBeNull();
    expect(current.secondaryPanesById).toEqual({});
  });

  it("sanitizes pane history hrefs", () => {
    const current = sanitize(
      state({
        primaryPanes: [
          primary("pane-1", "/media/1", {
            history: {
              back: ["http://localhost/libraries?sort=recent"],
              forward: ["/media/2#chapter"],
            },
          }),
        ],
      }),
      { baseOrigin: "http://localhost" },
    );
    expect(getWorkspacePrimaryPanes(current)[0]?.history).toEqual({
      back: ["/libraries?sort=recent"],
      forward: ["/media/2#chapter"],
    });
  });

  it("rejects malformed pane history hrefs", () => {
    const current = sanitize(
      state({
        primaryPanes: [
          primary("pane-1", "/media/1", {
            history: { back: ["https://example.com/media/0"], forward: [] },
          }),
        ],
      }),
      { baseOrigin: "http://localhost" },
    );
    expect(getWorkspacePrimaryPanes(current)[0]?.href).toBe("/libraries");
  });

  it("resets invalid primary topology", () => {
    const oversized = state({
      activePrimaryPaneId: "pane-0",
      primaryPanes: Array.from({ length: MAX_PANES + 1 }, (_, index) =>
        primary(`pane-${index}`, `/media/${index}`),
      ),
    });
    const current = sanitize(oversized);
    const panes = getWorkspacePrimaryPanes(current);
    expect(panes).toHaveLength(1);
    expect(panes[0]?.href).toBe("/libraries");
  });

  it("clamps persisted primary widths to the workspace floor", () => {
    const current = sanitize(
      state({
        activePrimaryPaneId: "pane-1",
        primaryPanes: [
          primary("pane-1", "/libraries", { primaryWidthPx: 10 }),
          primary("pane-2", "/media/1", { primaryWidthPx: 99999 }),
        ],
      }),
    );
    const panes = getWorkspacePrimaryPanes(current);
    expect(panes[0]?.primaryWidthPx).toBe(
      workspacePrimaryMetrics.primaryMinWidthPx,
    );
    expect(panes[1]?.primaryWidthPx).toBe(99999);
  });

  it("rejects primary panes that omit required fields", () => {
    const current = sanitize({
      activePrimaryPaneId: "pane-1",
      primaryPaneOrder: ["pane-1"],
      primaryPanesById: {
        "pane-1": {
          id: "pane-1",
          href: "/media/1",
          visibility: "visible",
          history: { back: [], forward: [] },
          attachedSecondaryPaneId: null,
        },
      },
      secondaryPanesById: {},
    });
    const panes = getWorkspacePrimaryPanes(current);
    expect(panes).toHaveLength(1);
    expect(panes[0]?.href).toBe("/libraries");
  });

  it("sanitizes compatible attached secondary panes", () => {
    const current = sanitize(
      state({
        primaryPanes: [
          primary("pane-1", "/media/1", {
            attachedSecondaryPaneId: "secondary-1",
          }),
        ],
        secondaryPanesById: {
          "secondary-1": {
            id: "secondary-1",
            parentPrimaryPaneId: "pane-1",
            groupId: "reader-tools",
            activeSurfaceId: "reader-evidence",
            widthPx: 9999,
            visibility: "visible",
          },
        },
      }),
    );
    const pane = getWorkspacePrimaryPanes(current)[0]!;
    expect(pane.attachedSecondaryPaneId).toBe("secondary-1");
    expect(current.secondaryPanesById["secondary-1"]).toEqual({
      id: "secondary-1",
      parentPrimaryPaneId: "pane-1",
      groupId: "reader-tools",
      activeSurfaceId: "reader-evidence",
      widthPx: 720,
      visibility: "visible",
    });
  });

  it("drops incompatible attached secondary panes", () => {
    const current = sanitize(
      state({
        primaryPanes: [
          primary("pane-1", "/libraries", {
            attachedSecondaryPaneId: "secondary-1",
          }),
        ],
        secondaryPanesById: {
          "secondary-1": {
            id: "secondary-1",
            parentPrimaryPaneId: "pane-1",
            groupId: "reader-tools",
            activeSurfaceId: "reader-evidence",
            widthPx: 320,
            visibility: "visible",
          },
        },
      }),
    );
    expect(getWorkspacePrimaryPanes(current)[0]?.attachedSecondaryPaneId).toBeNull();
    expect(current.secondaryPanesById).toEqual({});
  });

  it("drops attached secondary pane with a stale surface ID no longer in the surface registry", () => {
    const current = sanitize(
      state({
        primaryPanes: [
          primary("pane-1", "/media/1", {
            attachedSecondaryPaneId: "secondary-1",
          }),
        ],
        secondaryPanesById: {
          "secondary-1": {
            id: "secondary-1",
            parentPrimaryPaneId: "pane-1",
            groupId: "reader-tools",
            activeSurfaceId: "reader-highlights",
            widthPx: 320,
            visibility: "visible",
          },
        },
      }),
    );
    expect(getWorkspacePrimaryPanes(current)[0]?.attachedSecondaryPaneId).toBeNull();
    expect(current.secondaryPanesById).toEqual({});
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
    expect(resolvePaneTransitionWidth(900, false, workspacePrimaryMetrics)).toBe(684);
    expect(resolvePaneTransitionWidth(2200, true, workspacePrimaryMetrics)).toBe(
      2200,
    );
  });

  it("keeps minimized panes when the active pane is visible", () => {
    const current = sanitize(
      state({
        activePrimaryPaneId: "pane-2",
        primaryPanes: [
          primary("pane-1", "/libraries", { visibility: "minimized" }),
          primary("pane-2", "/media/1", { primaryWidthPx: 720 }),
        ],
      }),
    );
    expect(getWorkspacePrimaryPanes(current).map((pane) => pane.visibility)).toEqual([
      "minimized",
      "visible",
    ]);
    expect(current.activePrimaryPaneId).toBe("pane-2");
  });

  it("resets when the requested active pane is minimized", () => {
    const current = sanitize(
      state({
        activePrimaryPaneId: "pane-1",
        primaryPanes: [
          primary("pane-1", "/libraries", { visibility: "minimized" }),
          primary("pane-2", "/media/1"),
        ],
      }),
      { fallbackHref: "/conversations" },
    );
    const panes = getWorkspacePrimaryPanes(current);
    expect(panes).toHaveLength(1);
    expect(panes[0]?.href).toBe("/conversations");
    expect(current.activePrimaryPaneId).toBe(panes[0]?.id);
  });

  it("trims pane history deterministically", () => {
    const history = Array.from({ length: 20 }, (_, index) => `/media/${index}`);
    const current = sanitize(
      state({
        activePrimaryPaneId: "pane-0",
        primaryPanes: Array.from({ length: 5 }, (_, index) =>
          primary(`pane-${index}`, `/media/current-${index}`, {
            history: { back: history, forward: history },
          }),
        ),
      }),
    );

    const panes = getWorkspacePrimaryPanes(current);
    for (const pane of panes) {
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
    const total = panes.reduce(
      (count, pane) => count + pane.history.back.length + pane.history.forward.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_PANE_HISTORY_ENTRIES);
  });
});
