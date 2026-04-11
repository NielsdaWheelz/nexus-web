import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

const mockIsMobileViewport = vi.hoisted(() => ({ value: false }));

const { paneShellSpy, mockStore } = vi.hoisted(() => ({
  paneShellSpy: vi.fn(),
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

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => mockIsMobileViewport.value,
}));

vi.mock("@/lib/panes/paneRuntime", () => ({
  PaneRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PaneRootNavigationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePaneRuntime: () => null,
  usePaneRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePaneSearchParams: () => new URLSearchParams(),
  usePaneParam: () => null,
  useSetPaneTitle: () => {},
}));

vi.mock("@/components/workspace/PaneShell", () => ({
  default: (props: { paneId: string; title: string; children: React.ReactNode; isMobile?: boolean; isActive?: boolean; widthPx: number; minWidthPx: number; maxWidthPx: number; bodyMode: string; onResizePane: () => void }) => {
    paneShellSpy(props);
    return (
      <div
        data-testid={`pane-shell-${props.paneId}`}
        data-title={props.title}
        data-pane-shell="true"
        data-active={props.isActive ? "true" : "false"}
        data-mobile={props.isMobile ? "true" : "false"}
        style={props.isMobile ? { width: "100%", minWidth: "100%", maxWidth: "100%" } : {}}
      >
        <div data-testid="pane-shell-chrome" data-pane-chrome-focus="true" tabIndex={-1} />
        <div data-testid="pane-shell-body" data-body-mode={props.bodyMode}>
          {props.children}
        </div>
      </div>
    );
  },
  usePaneChromeOverride: () => {},
}));

vi.mock("@/components/workspace/PaneStrip", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="pane-strip">{children}</div>,
}));

vi.mock("@/components/workspace/WorkspaceTabsBar", () => ({
  default: (props: { tabs: Array<{ paneId: string; title: string; isActive: boolean }>; onActivatePane: (id: string, opts?: { focusPaneChrome?: boolean }) => void; onClosePane: (id: string) => void }) => (
    <div data-testid="workspace-tabs-bar" role="tablist">
      {props.tabs.map((tab) => (
        <button
          key={tab.paneId}
          role="tab"
          aria-selected={tab.isActive}
          onClick={() => props.onActivatePane(tab.paneId)}
        >
          {tab.title}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/lib/workspace/store", () => ({
  useWorkspaceStore: () => mockStore,
}));

vi.mock("@/lib/workspace/telemetry", () => ({
  emitWorkspaceTelemetry: vi.fn(),
}));

import WorkspaceHost from "@/components/workspace/WorkspaceHost";

function latestPaneShellProps() {
  const latestCall = paneShellSpy.mock.calls.at(-1)?.[0];
  if (!latestCall) {
    throw new Error("PaneShell was not rendered");
  }
  return latestCall as { paneId: string; title: string };
}

describe("WorkspaceHost", () => {
  beforeEach(() => {
    paneShellSpy.mockClear();
    mockIsMobileViewport.value = false;
    mockStore.state = {
      schemaVersion: 3 as const,
      activePaneId: "pane-1",
      panes: [{ id: "pane-1", href: "/conversations/conv-1", widthPx: 560 }],
    };
    mockStore.runtimeTitleByPaneId = new Map();
    mockStore.openHintByPaneId = new Map();
    mockStore.resourceTitleByRef = new Map();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("prefers runtime pane titles over static chrome titles", () => {
    mockStore.runtimeTitleByPaneId = new Map([["pane-1", "Weekly planning"]]);

    render(<WorkspaceHost />);

    expect(latestPaneShellProps().title).toBe("Weekly planning");
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

    expect(latestPaneShellProps().title).toBe("Roadmap review");
  });

  // --- Tests migrated from WorkspaceShell.test.tsx ---

  it("scrolls the activated pane into view when selecting its tab", async () => {
    const scrollIntoViewMock = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
    mockStore.state = {
      schemaVersion: 3 as const,
      activePaneId: "pane-a",
      panes: [
        { id: "pane-a", href: "/libraries", widthPx: 560 },
        { id: "pane-b", href: "/search", widthPx: 560 },
      ],
    };
    const user = userEvent.setup();

    render(<WorkspaceHost />);

    await user.click(screen.getByRole("tab", { name: "Search" }));

    expect(mockStore.activatePane).toHaveBeenCalledWith("pane-b");
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it("moves focus into the activated pane chrome when selecting a tab", async () => {
    mockStore.state = {
      schemaVersion: 3 as const,
      activePaneId: "pane-a",
      panes: [
        { id: "pane-a", href: "/libraries", widthPx: 560 },
        { id: "pane-b", href: "/search", widthPx: 560 },
      ],
    };
    const user = userEvent.setup();

    render(<WorkspaceHost />);

    await user.click(screen.getByRole("tab", { name: "Search" }));

    const paneChromes = screen.getAllByTestId("pane-shell-chrome");
    expect(paneChromes[1]).toHaveFocus();
  });

  it("renders only the active pane at full viewport width on mobile", () => {
    mockIsMobileViewport.value = true;
    mockStore.state = {
      schemaVersion: 3 as const,
      activePaneId: "pane-a",
      panes: [
        { id: "pane-a", href: "/libraries", widthPx: 560 },
        { id: "pane-b", href: "/search", widthPx: 560 },
      ],
    };

    render(<WorkspaceHost />);

    expect(screen.getByTestId("pane-shell-pane-a")).toBeInTheDocument();
    expect(screen.queryByTestId("pane-shell-pane-b")).not.toBeInTheDocument();
  });

  it("moves focus into newly activated pane chrome on mobile pane switch", async () => {
    mockIsMobileViewport.value = true;
    const user = userEvent.setup();
    const activePaneId = { value: "pane-a" };
    mockStore.state = {
      schemaVersion: 3 as const,
      activePaneId: "pane-a",
      panes: [
        { id: "pane-a", href: "/libraries", widthPx: 560 },
        { id: "pane-b", href: "/search", widthPx: 560 },
      ],
    };
    mockStore.activatePane = vi.fn((id: string) => {
      activePaneId.value = id;
      mockStore.state = {
        ...mockStore.state,
        activePaneId: id,
      };
    });

    const { rerender } = render(<WorkspaceHost />);

    // Simulate switching to pane-b (e.g., via command palette)
    mockStore.state = {
      ...mockStore.state,
      activePaneId: "pane-b",
    };
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("pane-shell-chrome")).toHaveFocus();
  });
});
