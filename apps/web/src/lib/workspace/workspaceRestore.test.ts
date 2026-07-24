import { describe, expect, it } from "vitest";
import {
  applyPaneVisitTransition,
  isNonTrivialSession,
  mergeRestoredWorkspaceWithDeepLink,
  prepareRestoredState,
  selectRestoredState,
  traversePaneHistory,
  workspaceStatesEqual,
} from "@/lib/workspace/workspaceRestore";
import {
  assumePaneVisitId,
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  type PaneVisit,
  type WorkspaceAttachedSecondaryPaneState,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const metrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};
const DEEP_LINK_MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const FORWARD_MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const DEEP_LINK_MEDIA_HREF = `/media/${DEEP_LINK_MEDIA_ID}`;
const FORWARD_MEDIA_HREF = `/media/${FORWARD_MEDIA_ID}`;

const emptyHistory = () => ({ back: [], forward: [] });
let nextVisitIndex = 1;

function paneVisit(href: string): PaneVisit {
  const id = assumePaneVisitId(
    `00000000-0000-4000-8000-${String(nextVisitIndex).padStart(12, "0")}`,
  );
  nextVisitIndex += 1;
  return { id, href };
}

function primary(
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
    currentVisit: paneVisit(href),
    primaryWidthPx: input.primaryWidthPx ?? 684,
    visibility: input.visibility ?? "visible",
    history: input.history ?? emptyHistory(),
    attachedSecondaryPaneId: input.attachedSecondaryPaneId ?? null,
  };
}

function secondary(
  input: Partial<WorkspaceAttachedSecondaryPaneState> = {},
): WorkspaceAttachedSecondaryPaneState {
  return {
    id: input.id ?? "secondary-1",
    parentPrimaryPaneId: input.parentPrimaryPaneId ?? "pane-1",
    groupId: input.groupId ?? "resource-inspector",
    activeSurfaceId: input.activeSurfaceId ?? "resource-evidence",
    widthPx: input.widthPx ?? 420,
    visibility: input.visibility ?? "collapsed",
  };
}

function workspace(input: {
  activePrimaryPaneId?: string;
  primaryPanes: WorkspacePrimaryPaneState[];
  secondaryPanesById?: Record<string, WorkspaceAttachedSecondaryPaneState>;
}): WorkspaceState {
  return createWorkspaceStateFromPrimaryPanes({
    activePrimaryPaneId: input.activePrimaryPaneId ?? input.primaryPanes[0]!.id,
    primaryPanes: input.primaryPanes,
    secondaryPanesById: input.secondaryPanesById,
  });
}

const hrefs = (state: WorkspaceState) =>
  getWorkspacePrimaryPanes(state).map((pane) => pane.currentVisit.href);

const librariesPane = primary("pane-1", "/libraries");
const lecternPane = primary("pane-lectern", "/lectern");
const mediaPane = primary("pane-2", "/media/123", { primaryWidthPx: 720 });

describe("isNonTrivialSession", () => {
  it("treats a single /lectern pane as trivial", () => {
    expect(isNonTrivialSession(workspace({ primaryPanes: [lecternPane] }))).toBe(false);
  });

  it("treats a single non-/lectern pane as non-trivial", () => {
    expect(isNonTrivialSession(workspace({ primaryPanes: [mediaPane] }))).toBe(true);
  });

  it("treats two or more panes as non-trivial", () => {
    expect(
      isNonTrivialSession(workspace({ primaryPanes: [lecternPane, { ...mediaPane }] })),
    ).toBe(true);
  });

  it("treats a single /lectern pane with history as non-trivial", () => {
    expect(
      isNonTrivialSession(
        workspace({
          primaryPanes: [
            primary("pane-1", "/lectern", {
              history: { back: [paneVisit("/media/123")], forward: [] },
            }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("treats a single /lectern pane with attached secondary state as non-trivial", () => {
    expect(
      isNonTrivialSession(
        workspace({
          primaryPanes: [
            primary("pane-1", "/lectern", { attachedSecondaryPaneId: "secondary-1" }),
          ],
          secondaryPanesById: { "secondary-1": secondary() },
        }),
      ),
    ).toBe(true);
  });
});

describe("workspaceStatesEqual", () => {
  it("returns true for identical states", () => {
    const a = workspace({ activePrimaryPaneId: "pane-2", primaryPanes: [mediaPane] });
    const b = workspace({ activePrimaryPaneId: "pane-2", primaryPanes: [mediaPane] });
    expect(workspaceStatesEqual(a, b)).toBe(true);
  });

  it("returns false when activePrimaryPaneId differs", () => {
    const a = workspace({
      activePrimaryPaneId: "pane-2",
      primaryPanes: [librariesPane, mediaPane],
    });
    const b = workspace({
      activePrimaryPaneId: "pane-1",
      primaryPanes: [librariesPane, mediaPane],
    });
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when primary order differs", () => {
    const a = workspace({ primaryPanes: [librariesPane, mediaPane] });
    const b = workspace({ primaryPanes: [mediaPane, librariesPane] });
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when a primary pane field differs", () => {
    const a = workspace({ primaryPanes: [mediaPane] });
    const b = workspace({
      primaryPanes: [primary("pane-2", "/media/456", { primaryWidthPx: 720 })],
    });
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when primary history differs", () => {
    const a = workspace({
      primaryPanes: [
        primary("pane-2", "/media/123", {
          history: { back: [paneVisit("/libraries")], forward: [] },
        }),
      ],
    });
    const b = workspace({
      primaryPanes: [
        primary("pane-2", "/media/123", {
          history: { back: [], forward: [paneVisit("/libraries")] },
        }),
      ],
    });
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when top-level secondary state differs", () => {
    const build = (widthPx: number) =>
      workspace({
        primaryPanes: [
          primary("pane-2", "/media/123", { attachedSecondaryPaneId: "secondary-1" }),
        ],
        secondaryPanesById: {
          "secondary-1": secondary({
            parentPrimaryPaneId: "pane-2",
            groupId: "resource-inspector",
            activeSurfaceId: "resource-evidence",
            visibility: "visible",
            widthPx,
          }),
        },
      });
    expect(workspaceStatesEqual(build(320), build(420))).toBe(false);
  });
});

describe("PaneVisit state algebra", () => {
  it("pushes the exact current visit and installs a caller-minted target", () => {
    const current = primary("pane-1", "/libraries", {
      history: {
        back: [paneVisit("/lectern")],
        forward: [paneVisit("/notes")],
      },
    });
    const target = paneVisit("/media/123");

    const result = applyPaneVisitTransition(
      current,
      { mode: "push", visit: target },
      metrics,
      null,
    );

    expect(result.currentVisit).toBe(target);
    expect(result.history.back.at(-1)).toBe(current.currentVisit);
    expect(result.history.forward).toEqual([]);
  });

  it("replaces href while retaining the visit id and both stacks", () => {
    const current = primary("pane-1", DEEP_LINK_MEDIA_HREF, {
      history: {
        back: [paneVisit("/libraries")],
        forward: [paneVisit(FORWARD_MEDIA_HREF)],
      },
    });

    const result = applyPaneVisitTransition(
      current,
      { mode: "replace", href: `${DEEP_LINK_MEDIA_HREF}?loc=chapter-2` },
      metrics,
      null,
    );

    expect(result.currentVisit).toEqual({
      id: current.currentVisit.id,
      href: `${DEEP_LINK_MEDIA_HREF}?loc=chapter-2`,
    });
    expect(result.history).toBe(current.history);
  });

  it("traverses Back and Forward symmetrically by visit occurrence", () => {
    const backVisit = paneVisit("/libraries");
    const current = primary("pane-1", "/notes", {
      history: { back: [backVisit], forward: [] },
    });

    const wentBack = traversePaneHistory(
      current,
      "Back",
      metrics,
      null,
    );
    expect(wentBack?.currentVisit).toBe(backVisit);
    expect(wentBack?.history).toEqual({
      back: [],
      forward: [current.currentVisit],
    });

    const wentForward = traversePaneHistory(
      wentBack!,
      "Forward",
      metrics,
      null,
    );
    expect(wentForward?.currentVisit).toBe(current.currentVisit);
    expect(wentForward?.history).toEqual({
      back: [backVisit],
      forward: [],
    });
  });

  it("returns null when the requested traversal direction is unavailable", () => {
    const current = primary("pane-1", "/libraries");
    expect(traversePaneHistory(current, "Back", metrics, null)).toBeNull();
    expect(traversePaneHistory(current, "Forward", metrics, null)).toBeNull();
  });
});

describe("prepareRestoredState", () => {
  it("round-trips a well-formed raw WorkspaceState", () => {
    const raw = workspace({
      activePrimaryPaneId: "pane-2",
      primaryPanes: [{ ...librariesPane }, { ...mediaPane }],
    });
    expect(prepareRestoredState(raw, metrics, false)).toEqual(raw);
  });

  it("defects on null trusted persisted state", () => {
    expect(() => prepareRestoredState(null, metrics, false)).toThrow(
      "workspace state must be an object",
    );
  });

  it("defects on malformed trusted persisted state", () => {
    expect(() =>
      prepareRestoredState({ nonsense: true }, metrics, false),
    ).toThrow("workspace state must contain exactly");
  });

  it("adapts persisted primary and secondary widths after exact parsing", () => {
    const raw = workspace({
      primaryPanes: [
        primary("pane-1", "/media/123", {
          primaryWidthPx: 10,
          attachedSecondaryPaneId: "secondary-1",
        }),
      ],
      secondaryPanesById: {
        "secondary-1": secondary({
          widthPx: 9999,
        }),
      },
    });

    const restored = prepareRestoredState(raw, metrics, false);

    expect(getWorkspacePrimaryPanes(restored)[0]?.primaryWidthPx).toBe(
      metrics.primaryMinWidthPx,
    );
    expect(restored.secondaryPanesById["secondary-1"]?.widthPx).toBe(720);
  });

  it("filters Local Vault panes for the Android shell", () => {
    const raw = workspace({
      activePrimaryPaneId: "pane-2",
      primaryPanes: [
        primary("pane-1", "/settings/local-vault"),
        primary("pane-2", "/settings/billing"),
      ],
    });
    expect(hrefs(prepareRestoredState(raw, metrics, true))).toEqual(["/settings/billing"]);
  });

});

describe("selectRestoredState", () => {
  const ownRaw = workspace({ primaryPanes: [mediaPane] });
  const elsewhereRaw = workspace({ primaryPanes: [primary("pane-9", "/notes")] });

  it("returns this device's own session when it is non-trivial", () => {
    expect(hrefs(selectRestoredState(ownRaw, elsewhereRaw, metrics, false)!)).toEqual([
      "/media/123",
    ]);
  });

  it("falls back to the most-recent-elsewhere session when own is trivial", () => {
    const trivialOwn = workspace({ primaryPanes: [lecternPane] });
    expect(hrefs(selectRestoredState(trivialOwn, elsewhereRaw, metrics, false)!)).toEqual([
      "/notes",
    ]);
  });

  it("falls back to elsewhere when own is absent", () => {
    expect(hrefs(selectRestoredState(null, elsewhereRaw, metrics, false)!)).toEqual([
      "/notes",
    ]);
  });

  it("returns null when neither session is non-trivial", () => {
    const trivialOwn = workspace({ primaryPanes: [lecternPane] });
    expect(selectRestoredState(trivialOwn, null, metrics, false)).toBeNull();
    expect(selectRestoredState(null, null, metrics, false)).toBeNull();
  });

  // AC-9 parity (server == client restore) is guaranteed by construction: both the server
  // bootstrap and the client store import THIS one module (enforced by the R6 source gate in
  // firstPaintCutover.guards.test.ts). What's left to assert here is that the resolver itself
  // is deterministic — same inputs, same output — so that shared module yields identical state.
  it("is deterministic for identical inputs", () => {
    const a = selectRestoredState(ownRaw, elsewhereRaw, metrics, false);
    const b = selectRestoredState(ownRaw, elsewhereRaw, metrics, false);
    expect(workspaceStatesEqual(a!, b!)).toBe(true);
  });
});

describe("mergeRestoredWorkspaceWithDeepLink", () => {
  const restored = workspace({
    activePrimaryPaneId: "pane-saved-libraries",
    primaryPanes: [
      primary("pane-saved-libraries", "/libraries"),
      primary("pane-saved-notes", "/notes", { primaryWidthPx: 480 }),
    ],
  });

  it("appends and activates the Lectern home intent over a saved session", () => {
    const deepLink = workspace({
      activePrimaryPaneId: "pane-url-lectern",
      primaryPanes: [primary("pane-url-lectern", "/lectern")],
    });

    const merged = mergeRestoredWorkspaceWithDeepLink(restored, deepLink, metrics);

    expect(hrefs(merged)).toEqual(["/libraries", "/notes", "/lectern"]);
    expect(merged.activePrimaryPaneId).toBe("pane-url-lectern");
  });

  it("reuses and activates an existing Lectern pane for the home intent", () => {
    const singlePaneRestore = workspace({
      activePrimaryPaneId: "pane-saved-notes",
      primaryPanes: [
        primary("pane-saved-notes", "/notes"),
        primary("pane-saved-lectern", "/lectern", {
          primaryWidthPx: 640,
          visibility: "minimized",
          history: { back: [paneVisit("/notes")], forward: [] },
        }),
      ],
    });
    const deepLink = workspace({
      activePrimaryPaneId: "pane-url-lectern",
      primaryPanes: [primary("pane-url-lectern", "/lectern")],
    });

    const merged = mergeRestoredWorkspaceWithDeepLink(singlePaneRestore, deepLink, metrics);

    expect(merged.activePrimaryPaneId).toBe("pane-saved-lectern");
    expect(getWorkspacePrimaryPanes(merged)).toHaveLength(2);
    expect(
      getWorkspacePrimaryPanes(merged).find(({ id }) => id === "pane-saved-lectern"),
    ).toMatchObject({
      currentVisit: { href: "/lectern" },
      visibility: "visible",
      primaryWidthPx: 640,
      history: { back: [{ href: "/notes" }], forward: [] },
    });
  });

  it("adds an explicit deep link as the active pane instead of letting restore override it", () => {
    const deepLink = workspace({
      activePrimaryPaneId: "pane-url-media",
      primaryPanes: [
        primary("pane-url-media", DEEP_LINK_MEDIA_HREF, { primaryWidthPx: 1280 }),
      ],
    });

    const merged = mergeRestoredWorkspaceWithDeepLink(restored, deepLink, metrics);

    expect(hrefs(merged)).toEqual(["/libraries", "/notes", DEEP_LINK_MEDIA_HREF]);
    expect(merged.activePrimaryPaneId).toBe("pane-url-media");
  });

  it("reuses and activates a saved pane for exact-route deep links", () => {
    const deepLink = workspace({
      activePrimaryPaneId: "pane-url-notes",
      primaryPanes: [primary("pane-url-notes", "/notes", { primaryWidthPx: 1280 })],
    });

    const merged = mergeRestoredWorkspaceWithDeepLink(restored, deepLink, metrics);

    expect(hrefs(merged)).toEqual(["/libraries", "/notes"]);
    expect(merged.activePrimaryPaneId).toBe("pane-saved-notes");
    expect(
      getWorkspacePrimaryPanes(merged).find((item) => item.id === "pane-saved-notes"),
    ).toMatchObject({
      currentVisit: { href: "/notes" },
      visibility: "visible",
      primaryWidthPx: 480,
    });
  });

  it("reuses and activates the saved pane for same-resource deep links", () => {
    const savedWithMedia = workspace({
      activePrimaryPaneId: "pane-saved-libraries",
      primaryPanes: [
        ...getWorkspacePrimaryPanes(restored),
        primary("pane-saved-media", DEEP_LINK_MEDIA_HREF, {
          primaryWidthPx: 960,
          visibility: "minimized",
          history: {
            back: [paneVisit("/libraries")],
            forward: [paneVisit(FORWARD_MEDIA_HREF)],
          },
        }),
      ],
    });
    const deepLink = workspace({
      activePrimaryPaneId: "pane-url-media",
      primaryPanes: [
        primary("pane-url-media", `${DEEP_LINK_MEDIA_HREF}?loc=chapter-2`, {
          primaryWidthPx: 1280,
        }),
      ],
    });

    const merged = mergeRestoredWorkspaceWithDeepLink(savedWithMedia, deepLink, metrics);

    expect(getWorkspacePrimaryPanes(merged)).toHaveLength(3);
    expect(merged.activePrimaryPaneId).toBe("pane-saved-media");
    expect(
      getWorkspacePrimaryPanes(merged).find((item) => item.id === "pane-saved-media"),
    ).toMatchObject({
      currentVisit: { href: `${DEEP_LINK_MEDIA_HREF}?loc=chapter-2` },
      visibility: "visible",
      primaryWidthPx: 960,
      attachedSecondaryPaneId: null,
      history: {
        back: [{ href: "/libraries" }],
        forward: [{ href: FORWARD_MEDIA_HREF }],
      },
    });
  });
});
