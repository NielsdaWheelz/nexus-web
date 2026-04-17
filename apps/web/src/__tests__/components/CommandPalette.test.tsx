import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockViewportState, mockWorkspaceStore } = vi.hoisted(() => ({
  mockViewportState: { isMobile: true },
  mockWorkspaceStore: {
    state: {
      schemaVersion: 3,
      activePaneId: "pane-a",
      panes: [{ id: "pane-a", href: "/libraries", widthPx: 480 }],
    },
    runtimeTitleByPaneId: new Map(),
    openHintByPaneId: new Map(),
    resourceTitleByRef: new Map(),
    activatePane: vi.fn(),
    closePane: vi.fn(),
  },
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => mockViewportState.isMobile,
}));

vi.mock("@/lib/workspace/store", () => ({
  useWorkspaceStore: () => mockWorkspaceStore,
}));

vi.mock("@/lib/panes/openInAppPane", () => ({
  NEXUS_OPEN_PANE_EVENT: "nexus:open-pane",
  NEXUS_OPEN_PANE_MESSAGE_TYPE: "nexus:open-pane",
  consumePendingPaneOpenQueue: () => [],
  isOpenInAppPaneMessage: () => false,
  normalizePaneHref: (href: string) => href,
  setPaneGraphReady: vi.fn(),
  requestOpenInAppPane: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(),
  isApiError: () => false,
}));

import CommandPalette, { OPEN_COMMAND_PALETTE_EVENT } from "@/components/CommandPalette";
import PaneShell from "@/components/workspace/PaneShell";

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewportState.isMobile = true;
    document.body.style.overflow = "";
    localStorage.clear();
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("opens on the mobile Commands event and uses the cutover copy", async () => {
    render(<CommandPalette />);

    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
    });

    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Commands" })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search or run a command...")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("shows a visible mobile Commands trigger that opens the existing command palette", async () => {
    const user = userEvent.setup();

    render(
      <>
        <PaneShell
          paneId="pane-a"
          title="Libraries"
          widthPx={480}
          minWidthPx={320}
          maxWidthPx={1400}
          bodyMode="standard"
          onResizePane={() => {}}
          isMobile
        >
          <div>Body content</div>
        </PaneShell>
        <CommandPalette />
      </>
    );

    const trigger = screen.getByRole("button", { name: "Commands" });
    expect(trigger).toHaveTextContent("Commands");

    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(within(dialog).getByRole("heading", { name: "Commands" })).toBeInTheDocument();
    expect(
      within(dialog).getByPlaceholderText("Search or run a command...")
    ).toBeInTheDocument();
  });
});
