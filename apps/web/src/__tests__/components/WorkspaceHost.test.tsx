import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const { workspaceShellSpy, mockStore } = vi.hoisted(() => ({
  workspaceShellSpy: vi.fn(),
  mockStore: {
    state: {
      schemaVersion: 3 as const,
      activePaneId: "pane-1",
      panes: [{ id: "pane-1", href: "/conversations/conv-1", widthPx: 560 }],
    },
    runtimeTitleByPaneId: new Map<string, string>(),
    openHintByPaneId: new Map<string, { titleHint?: string; resourceRef?: string | null }>(),
    resourceTitleByRef: new Map<
      string,
      { title: string; updatedAtMs: number; expiresAtMs: number }
    >(),
    activatePane: vi.fn(),
    openPane: vi.fn(),
    navigatePane: vi.fn(),
    closePane: vi.fn(),
    closePaneFamily: vi.fn(),
    resizePane: vi.fn(),
    publishPaneTitle: vi.fn(),
  },
}));

vi.mock("@/components/PaneRouteRenderer", () => ({
  default: () => <div data-testid="pane-route-renderer" />,
}));

vi.mock("@/components/workspace/WorkspaceShell", () => ({
  default: (props: unknown) => {
    workspaceShellSpy(props);
    return <div data-testid="workspace-shell" />;
  },
}));

vi.mock("@/lib/workspace/store", () => ({
  useWorkspaceStore: () => mockStore,
}));

vi.mock("@/lib/workspace/telemetry", () => ({
  emitWorkspaceTelemetry: vi.fn(),
}));

import WorkspaceHost from "@/components/workspace/WorkspaceHost";

function latestShellProps() {
  const latestCall = workspaceShellSpy.mock.calls.at(-1)?.[0];
  if (!latestCall) {
    throw new Error("WorkspaceShell was not rendered");
  }
  return latestCall as { panes: Array<{ title: string }> };
}

describe("WorkspaceHost", () => {
  beforeEach(() => {
    workspaceShellSpy.mockClear();
    mockStore.runtimeTitleByPaneId = new Map();
    mockStore.openHintByPaneId = new Map();
    mockStore.resourceTitleByRef = new Map();
  });

  it("prefers runtime pane titles over static chrome titles", () => {
    mockStore.runtimeTitleByPaneId = new Map([["pane-1", "Weekly planning"]]);

    render(<WorkspaceHost />);

    expect(latestShellProps().panes[0]?.title).toBe("Weekly planning");
  });

  it("uses cached resource titles when runtime titles are absent", () => {
    mockStore.resourceTitleByRef = new Map([
      [
        "conversation:conv-1",
        {
          title: "Roadmap review",
          updatedAtMs: 1_000,
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);

    render(<WorkspaceHost />);

    expect(latestShellProps().panes[0]?.title).toBe("Roadmap review");
  });
});
