import { describe, expect, it } from "vitest";
import {
  isNonTrivialSession,
  prepareRestoredState,
  workspaceStatesEqual,
} from "@/lib/workspace/sessionSync";
import {
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  type WorkspaceAttachedSecondaryPaneState,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

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
    groupId: input.groupId ?? "library-tools",
    activeSurfaceId: input.activeSurfaceId ?? "library-chat",
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

const librariesPane = primary("pane-1", "/libraries");
const mediaPane = primary("pane-2", "/media/123", { primaryWidthPx: 720 });

describe("isNonTrivialSession", () => {
  it("treats a single /libraries pane as trivial", () => {
    expect(isNonTrivialSession(workspace({ primaryPanes: [librariesPane] }))).toBe(
      false,
    );
  });

  it("treats a single non-/libraries pane as non-trivial", () => {
    expect(isNonTrivialSession(workspace({ primaryPanes: [mediaPane] }))).toBe(
      true,
    );
  });

  it("treats two or more panes as non-trivial", () => {
    expect(
      isNonTrivialSession(
        workspace({ primaryPanes: [librariesPane, { ...mediaPane }] }),
      ),
    ).toBe(true);
  });

  it("treats a single /libraries pane with history as non-trivial", () => {
    expect(
      isNonTrivialSession(
        workspace({
          primaryPanes: [
            primary("pane-1", "/libraries", {
              history: { back: ["/media/123"], forward: [] },
            }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("treats a single /libraries pane with attached secondary state as non-trivial", () => {
    expect(
      isNonTrivialSession(
        workspace({
          primaryPanes: [
            primary("pane-1", "/libraries", {
              attachedSecondaryPaneId: "secondary-1",
            }),
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
          history: { back: ["/libraries"], forward: [] },
        }),
      ],
    });
    const b = workspace({
      primaryPanes: [
        primary("pane-2", "/media/123", {
          history: { back: [], forward: ["/libraries"] },
        }),
      ],
    });
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when top-level secondary state differs", () => {
    const a = workspace({
      primaryPanes: [
        primary("pane-2", "/media/123", {
          attachedSecondaryPaneId: "secondary-1",
        }),
      ],
      secondaryPanesById: {
        "secondary-1": secondary({
          parentPrimaryPaneId: "pane-2",
          groupId: "reader-tools",
          activeSurfaceId: "reader-highlights",
          visibility: "visible",
        }),
      },
    });
    const b = workspace({
      primaryPanes: [
        primary("pane-2", "/media/123", {
          attachedSecondaryPaneId: "secondary-1",
        }),
      ],
      secondaryPanesById: {
        "secondary-1": secondary({
          parentPrimaryPaneId: "pane-2",
          groupId: "reader-tools",
          activeSurfaceId: "reader-doc-chat",
          visibility: "visible",
        }),
      },
    });
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });
});

describe("prepareRestoredState", () => {
  it("round-trips a well-formed raw WorkspaceState", () => {
    const raw = workspace({
      activePrimaryPaneId: "pane-2",
      primaryPanes: [{ ...librariesPane }, { ...mediaPane }],
    });
    expect(prepareRestoredState(raw, workspacePrimaryMetrics, false)).toEqual(raw);
  });

  it("returns a default workspace for null", () => {
    const result = prepareRestoredState(null, workspacePrimaryMetrics, false);
    const panes = getWorkspacePrimaryPanes(result);
    expect(panes).toHaveLength(1);
    expect(panes[0]?.href).toBe("/libraries");
  });

  it("returns a default workspace for garbage state", () => {
    const garbage = prepareRestoredState({ nonsense: true }, workspacePrimaryMetrics, false);
    expect(getWorkspacePrimaryPanes(garbage)[0]?.href).toBe("/libraries");
  });

  it("filters Local Vault panes for the Android shell", () => {
    const raw = workspace({
      activePrimaryPaneId: "pane-2",
      primaryPanes: [
        primary("pane-1", "/settings/local-vault"),
        primary("pane-2", "/settings/billing"),
      ],
    });
    const restored = prepareRestoredState(raw, workspacePrimaryMetrics, true);
    expect(getWorkspacePrimaryPanes(restored).map((pane) => pane.href)).toEqual([
      "/settings/billing",
    ]);
  });
});
