import { describe, expect, it } from "vitest";
import {
  isNonTrivialSession,
  prepareRestoredState,
  workspaceStatesEqual,
} from "@/lib/workspace/sessionSync";
import type { WorkspaceStateV4 } from "@/lib/workspace/schema";

const librariesPane = {
  id: "pane-1",
  href: "/libraries",
  widthPx: 480,
  visibility: "visible" as const,
};

const mediaPane = {
  id: "pane-2",
  href: "/media/123",
  widthPx: 720,
  visibility: "visible" as const,
};

describe("isNonTrivialSession", () => {
  it("treats a single /libraries pane as trivial", () => {
    const state: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-1",
      panes: [librariesPane],
    };
    expect(isNonTrivialSession(state)).toBe(false);
  });

  it("treats a single non-/libraries pane as non-trivial", () => {
    const state: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [mediaPane],
    };
    expect(isNonTrivialSession(state)).toBe(true);
  });

  it("treats two or more panes as non-trivial", () => {
    const state: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-1",
      panes: [librariesPane, { ...mediaPane }],
    };
    expect(isNonTrivialSession(state)).toBe(true);
  });
});

describe("workspaceStatesEqual", () => {
  it("returns true for identical states", () => {
    const a: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(true);
  });

  it("returns false when schemaVersion differs", () => {
    const a: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b = {
      schemaVersion: 3,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    } as unknown as WorkspaceStateV4;
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when activePaneId differs", () => {
    const a: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-other",
      panes: [{ ...mediaPane }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when pane count differs", () => {
    const a: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }, { ...librariesPane }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when a pane id differs", () => {
    const a: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane, id: "pane-different" }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when a pane href differs", () => {
    const a: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane, href: "/media/456" }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when a pane widthPx differs", () => {
    const a: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane, widthPx: 900 }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });

  it("returns false when a pane visibility differs", () => {
    const a: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane }],
    };
    const b: WorkspaceStateV4 = {
      schemaVersion: 4,
      activePaneId: "pane-2",
      panes: [{ ...mediaPane, visibility: "minimized" }],
    };
    expect(workspaceStatesEqual(a, b)).toBe(false);
  });
});

describe("prepareRestoredState", () => {
  it("round-trips a well-formed raw WorkspaceStateV4", () => {
    const raw: WorkspaceStateV4 = {
      schemaVersion: 4,
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
