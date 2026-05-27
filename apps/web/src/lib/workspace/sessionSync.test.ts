import { describe, expect, it } from "vitest";
import {
  isNonTrivialSession,
  prepareRestoredState,
  workspaceStatesEqual,
} from "@/lib/workspace/sessionSync";
import {
  WORKSPACE_SCHEMA_VERSION,
  type WorkspacePaneStateV5,
  type WorkspaceStateV5,
} from "@/lib/workspace/schema";

const emptyHistory = () => ({ back: [], forward: [] });

const librariesPane: WorkspacePaneStateV5 = {
  id: "pane-1",
  href: "/libraries",
  widthPx: 480,
  visibility: "visible" as const,
  history: emptyHistory(),
};

const mediaPane: WorkspacePaneStateV5 = {
  id: "pane-2",
  href: "/media/123",
  widthPx: 720,
  visibility: "visible" as const,
  history: emptyHistory(),
};

describe("isNonTrivialSession", () => {
  it("treats a single /libraries pane as trivial", () => {
    const state: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-1",
      panes: [librariesPane],
    };
    expect(isNonTrivialSession(state)).toBe(false);
  });

  it("treats a single non-/libraries pane as non-trivial", () => {
    const state: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [mediaPane],
    };
    expect(isNonTrivialSession(state)).toBe(true);
  });

  it("treats two or more panes as non-trivial", () => {
    const state: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-1",
      panes: [librariesPane, { ...mediaPane }],
    };
    expect(isNonTrivialSession(state)).toBe(true);
  });

  it("treats a single /libraries pane with history as non-trivial", () => {
    const state: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-1",
      panes: [{ ...librariesPane, history: { back: ["/media/123"], forward: [] } }],
    };
    expect(isNonTrivialSession(state)).toBe(true);
  });
});

describe("workspaceStatesEqual", () => {
  it("returns true for identical states", () => {
    const a: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(true);
  });

  it("returns false when schemaVersion differs", () => {
    const a: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b = {
      schemaVersion: 3,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    } as unknown as WorkspaceStateV5;
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when activePaneId differs", () => {
    const a: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-other",
      panes: [{ ...mediaPane }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when pane count differs", () => {
    const a: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }, { ...librariesPane }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when a pane id differs", () => {
    const a: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane, id: "pane-different" }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when a pane href differs", () => {
    const a: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane, href: "/media/456" }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when a pane widthPx differs", () => {
    const a: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane, widthPx: 900 }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when a pane visibility differs", () => {
    const a: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane, visibility: "minimized" }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when pane history differs", () => {
    const a: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane, history: { back: ["/libraries"], forward: [] } }],
    };
    const b: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane, history: { back: [], forward: ["/libraries"] } }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });
});

describe("prepareRestoredState", () => {
  it("round-trips a well-formed raw WorkspaceStateV5", () => {
    const raw: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activePaneId: "pane-2",
      panes: [{ ...librariesPane }, { ...mediaPane }],
    };
    expect(prepareRestoredState(raw)).toEqual(raw);
  });

  it("returns a default workspace for null", () => {
    const result = prepareRestoredState(null);
    expect(result.panes).toHaveLength(1);
    expect(result.panes[0].href).toBe("/libraries");
  });

  it("returns a default workspace for a garbage value", () => {
    const result = prepareRestoredState({ nonsense: true });
    expect(result.panes).toHaveLength(1);
    expect(result.panes[0].href).toBe("/libraries");
  });
});
