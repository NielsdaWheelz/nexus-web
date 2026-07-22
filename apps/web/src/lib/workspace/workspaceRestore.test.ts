import { describe, expect, it } from "vitest";
import {
  isNonTrivialSession,
  mergeRestoredWorkspaceWithDeepLink,
  prepareRestoredState,
  selectRestoredState,
  workspaceStatesEqual,
} from "@/lib/workspace/workspaceRestore";
import {
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
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
    href,
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
    groupId: input.groupId ?? "reader-tools",
    activeSurfaceId: input.activeSurfaceId ?? "reader-evidence",
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
  getWorkspacePrimaryPanes(state).map((pane) => pane.href);

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
              history: { back: ["/media/123"], forward: [] },
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
        primary("pane-2", "/media/123", { history: { back: ["/libraries"], forward: [] } }),
      ],
    });
    const b = workspace({
      primaryPanes: [
        primary("pane-2", "/media/123", { history: { back: [], forward: ["/libraries"] } }),
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
            groupId: "reader-tools",
            activeSurfaceId: "reader-evidence",
            visibility: "visible",
            widthPx,
          }),
        },
      });
    expect(workspaceStatesEqual(build(320), build(420))).toBe(false);
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

  it("returns a default workspace for null", () => {
    const result = prepareRestoredState(null, metrics, false);
    expect(getWorkspacePrimaryPanes(result)).toHaveLength(1);
    expect(getWorkspacePrimaryPanes(result)[0]?.href).toBe("/lectern");
  });

  it("returns a default workspace for garbage state", () => {
    const garbage = prepareRestoredState({ nonsense: true }, metrics, false);
    expect(getWorkspacePrimaryPanes(garbage)[0]?.href).toBe("/lectern");
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

  // Machine-output-in-place AC-9 — a session persisted before the drawers were
  // deleted references removed group/surface ids; restore drops the secondary
  // pane and opens the primary cleanly (P-4 / R6).
  it("drops a stored library-intelligence secondary pane on restore", () => {
    const raw = workspace({
      primaryPanes: [
        primary("pane-1", "/libraries", { attachedSecondaryPaneId: "secondary-1" }),
      ],
      secondaryPanesById: {
        "secondary-1": secondary({ parentPrimaryPaneId: "pane-1" }),
      },
    });
    const stale = {
      ...raw,
      secondaryPanesById: {
        "secondary-1": {
          ...raw.secondaryPanesById["secondary-1"],
          groupId: "library-tools",
          activeSurfaceId: "library-intelligence",
        },
      },
    };

    const restored = prepareRestoredState(stale, metrics, false);

    expect(hrefs(restored)).toEqual(["/libraries"]);
    expect(getWorkspacePrimaryPanes(restored)[0]?.attachedSecondaryPaneId).toBeNull();
    expect(Object.keys(restored.secondaryPanesById)).toHaveLength(0);
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
          history: { back: ["/notes"], forward: [] },
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
      href: "/lectern",
      visibility: "visible",
      primaryWidthPx: 640,
      history: { back: ["/notes"], forward: [] },
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
      href: "/notes",
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
          history: { back: ["/libraries"], forward: [FORWARD_MEDIA_HREF] },
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
      href: `${DEEP_LINK_MEDIA_HREF}?loc=chapter-2`,
      visibility: "visible",
      primaryWidthPx: 960,
      attachedSecondaryPaneId: null,
      history: { back: ["/libraries"], forward: [FORWARD_MEDIA_HREF] },
    });
  });
});
