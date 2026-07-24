import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  MAX_PANE_HISTORY_STACK_LENGTH,
  MAX_TOTAL_PANE_HISTORY_ENTRIES,
  assumePaneVisitId,
  createDefaultWorkspaceState,
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  parsePersistedWorkspaceState,
  trimWorkspacePaneHistory,
  type PaneVisit,
  type WorkspacePrimaryPaneState,
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

function visit(index: number, href: string): PaneVisit {
  return {
    id: assumePaneVisitId(
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ),
    href,
  };
}

function primary(
  id: string,
  href: string,
  input: {
    visitIndex?: number;
    primaryWidthPx?: number;
    visibility?: "visible" | "minimized";
    attachedSecondaryPaneId?: string | null;
    history?: { back: PaneVisit[]; forward: PaneVisit[] };
  } = {},
): WorkspacePrimaryPaneState {
  return {
    id,
    currentVisit: visit(input.visitIndex ?? Number(id.replace(/\D/g, "")) + 1, href),
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

function rawState(primaryPanes: Record<string, unknown>[]) {
  return {
    activePrimaryPaneId: primaryPanes[0]!.id,
    primaryPaneOrder: primaryPanes.map((pane) => pane.id),
    primaryPanesById: Object.fromEntries(
      primaryPanes.map((pane) => [pane.id, pane]),
    ),
    secondaryPanesById: {},
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
      currentVisit: {
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
        href: "/media/abc",
      },
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

  it("rejects malformed workspace payloads instead of replacing them", () => {
    expect(() =>
      parsePersistedWorkspaceState({ activePrimaryPaneId: "pane-1" }),
    ).toThrow("workspace state must contain exactly");
  });

  it("exact-decodes canonical PaneVisit history without rewriting it", () => {
    const raw = state({
      primaryPanes: [
        primary("pane-1", "/media/1", {
          history: {
            back: [visit(10, "/libraries?sort=recent")],
            forward: [visit(11, "/media/2#chapter")],
          },
        }),
      ],
    });
    const current = parsePersistedWorkspaceState(raw, {
      baseOrigin: "http://localhost",
    });
    expect(current).toEqual(raw);
  });

  it("rejects non-canonical visit ids and duplicate ids across the whole workspace", () => {
    const duplicateId = assumePaneVisitId(
      "00000000-0000-4000-8000-000000000099",
    );
    const duplicated = state({
      primaryPanes: [
        {
          ...primary("pane-1", "/media/1"),
          currentVisit: { id: duplicateId, href: "/media/1" },
          history: {
            back: [{ id: duplicateId, href: "/libraries" }],
            forward: [],
          },
        },
      ],
    });
    expect(() => parsePersistedWorkspaceState(duplicated)).toThrow(
      "duplicates another PaneVisit id",
    );

    const uppercasePane = primary("pane-1", "/media/1");
    const uppercase = rawState([
      {
        ...uppercasePane,
        currentVisit: {
          id: "00000000-0000-4000-8000-0000000000AA",
          href: "/media/1",
        },
      },
    ]);
    expect(() => parsePersistedWorkspaceState(uppercase)).toThrow(
      "canonical lowercase UUID",
    );
  });

  it("rejects workspace hrefs that would require normalization", () => {
    const raw = state({
      primaryPanes: [
        {
          ...primary("pane-1", "/media/1"),
          currentVisit: {
            id: visit(20, "/media/1").id,
            href: "http://localhost/media/1",
          },
        },
      ],
    });
    expect(() =>
      parsePersistedWorkspaceState(raw, {
        baseOrigin: "http://localhost",
      }),
    ).toThrow("canonical workspace href");
  });

  it("rejects malformed pane history hrefs", () => {
    const raw = state({
      primaryPanes: [
        primary("pane-1", "/media/1", {
          history: {
            back: [
              {
                id: visit(30, "/media/0").id,
                href: "https://example.com/media/0",
              },
            ],
            forward: [],
          },
        }),
      ],
    });
    expect(() =>
      parsePersistedWorkspaceState(raw, {
        baseOrigin: "http://localhost",
      }),
    ).toThrow("canonical workspace href");
  });

  it("rejects extra fields at every persisted object boundary", () => {
    const pane = primary("pane-1", "/media/1");
    expect(() =>
      parsePersistedWorkspaceState({
        ...state({ primaryPanes: [pane] }),
        extra: true,
      }),
    ).toThrow("workspace state must contain exactly");
    const currentVisitWithExtra = {
      ...pane.currentVisit,
      extra: true,
    };
    expect(() =>
      parsePersistedWorkspaceState(
        rawState([{ ...pane, currentVisit: currentVisitWithExtra }]),
      ),
    ).toThrow("currentVisit must contain exactly");
  });

  it("rejects invalid primary topology", () => {
    const oversized = state({
      activePrimaryPaneId: "pane-0",
      primaryPanes: Array.from({ length: MAX_PANES + 1 }, (_, index) =>
        primary(`pane-${index}`, `/media/${index}`),
      ),
    });
    expect(() => parsePersistedWorkspaceState(oversized)).toThrow(
      `must contain 1-${MAX_PANES} panes`,
    );
  });

  it("preserves valid persisted widths for restore-time layout adaptation", () => {
    const current = parsePersistedWorkspaceState(
      state({
        primaryPanes: [primary("pane-1", "/libraries", { primaryWidthPx: 10 })],
      }),
    );
    const panes = getWorkspacePrimaryPanes(current);
    expect(panes[0]?.primaryWidthPx).toBe(10);
  });

  it("rejects primary panes that omit required fields", () => {
    expect(() =>
      parsePersistedWorkspaceState({
        activePrimaryPaneId: "pane-1",
        primaryPaneOrder: ["pane-1"],
        primaryPanesById: {
          "pane-1": {
            id: "pane-1",
            currentVisit: visit(40, "/media/1"),
            visibility: "visible",
            history: { back: [], forward: [] },
            attachedSecondaryPaneId: null,
          },
        },
        secondaryPanesById: {},
      }),
    ).toThrow("must contain exactly");
  });

  it("exact-decodes compatible attached secondary panes without clamping", () => {
    const current = parsePersistedWorkspaceState(
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
            groupId: "resource-inspector",
            activeSurfaceId: "resource-evidence",
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
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
      widthPx: 9999,
      visibility: "visible",
    });
  });

  it("rejects incompatible attached secondary panes", () => {
    expect(() =>
      parsePersistedWorkspaceState(
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
              groupId: "resource-inspector",
              activeSurfaceId: "resource-evidence",
              widthPx: 320,
              visibility: "visible",
            },
          },
        }),
      ),
    ).toThrow("incompatible with its primary pane");
  });

  it("rejects stale secondary surface ids", () => {
    expect(() =>
      parsePersistedWorkspaceState(
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
              groupId: "resource-inspector",
              activeSurfaceId: "reader-highlights",
              widthPx: 320,
              visibility: "visible",
            },
          },
        }),
      ),
    ).toThrow("invalid group or surface");
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
    const current = parsePersistedWorkspaceState(
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

  it("rejects when the requested active pane is minimized", () => {
    expect(() =>
      parsePersistedWorkspaceState(
        state({
          activePrimaryPaneId: "pane-1",
          primaryPanes: [
            primary("pane-1", "/libraries", { visibility: "minimized" }),
            primary("pane-2", "/media/1"),
          ],
        }),
      ),
    ).toThrow("must identify a visible pane");
  });

  it("trims the far ends of Back and Forward", () => {
    const back = Array.from({ length: 20 }, (_, index) =>
      visit(100 + index, `/media/back-${index}`),
    );
    const forward = Array.from({ length: 20 }, (_, index) =>
      visit(200 + index, `/media/forward-${index}`),
    );
    const untrimmed = createWorkspaceStateFromPrimaryPanes({
      activePrimaryPaneId: "pane-1",
      primaryPanes: [
        primary("pane-1", "/media/current", {
          history: { back, forward },
        }),
      ],
    });
    const current = trimWorkspacePaneHistory(untrimmed);
    const pane = getWorkspacePrimaryPanes(current)[0]!;
    expect(pane.history.back.map(({ href }) => href)).toEqual(
      Array.from({ length: 12 }, (_, index) => `/media/back-${index + 8}`),
    );
    expect(pane.history.forward.map(({ href }) => href)).toEqual(
      Array.from({ length: 12 }, (_, index) => `/media/forward-${index}`),
    );
  });

  it("enforces the deterministic workspace-wide history budget", () => {
    const primaryPanes = Array.from({ length: 5 }, (_, paneIndex) =>
      primary(`pane-${paneIndex}`, `/media/current-${paneIndex}`, {
        visitIndex: 1000 + paneIndex,
        history: {
          back: Array.from({ length: 12 }, (_, index) =>
            visit(2000 + paneIndex * 100 + index, `/media/back-${paneIndex}-${index}`),
          ),
          forward: Array.from({ length: 12 }, (_, index) =>
            visit(
              3000 + paneIndex * 100 + index,
              `/media/forward-${paneIndex}-${index}`,
            ),
          ),
        },
      }),
    );
    const current = trimWorkspacePaneHistory(
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: "pane-0",
        primaryPanes,
      }),
    );
    const panes = getWorkspacePrimaryPanes(current);
    const total = panes.reduce(
      (count, pane) => count + pane.history.back.length + pane.history.forward.length,
      0,
    );
    expect(total).toBe(MAX_TOTAL_PANE_HISTORY_ENTRIES);
    expect(panes[0]?.history.back).toHaveLength(MAX_PANE_HISTORY_STACK_LENGTH);
    expect(panes[0]?.history.forward).toHaveLength(MAX_PANE_HISTORY_STACK_LENGTH);
    expect(panes[1]?.history).toEqual({ back: [], forward: [] });
  });
});
