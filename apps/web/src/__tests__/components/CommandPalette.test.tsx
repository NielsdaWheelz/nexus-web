import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  apiFetchMock,
  mockViewportState,
  mockWorkspaceStore,
  requestOpenInAppPaneMock,
} = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
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
  requestOpenInAppPaneMock: vi.fn(),
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
  requestOpenInAppPane: (...args: unknown[]) => requestOpenInAppPaneMock(...args),
}));

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  isApiError: () => false,
}));

import CommandPalette, { OPEN_COMMAND_PALETTE_EVENT } from "@/components/CommandPalette";
import PaneShell from "@/components/workspace/PaneShell";

const COMMAND_PALETTE_RECENT_STORAGE_KEY = "nexus.commandPalette.recent.v1";

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewportState.isMobile = true;
    document.body.style.overflow = "";
    localStorage.clear();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/me/command-palette-recents") {
        return { data: [] };
      }
      if (path.startsWith("/api/search?")) {
        return { results: [], page: { has_more: false, next_cursor: null } };
      }
      throw new Error(`Unhandled apiFetch call: ${path}`);
    });
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  function openPalette() {
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
    });
  }

  it("opens on the mobile launcher event and uses search-first copy", async () => {
    render(<CommandPalette />);

    openPalette();

    expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Search" })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search or run an action...")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("reads recent destinations from the authenticated API and still shows static commands", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/me/command-palette-recents") {
        return {
          data: [
            {
              href: "/media/media-1",
              title_snapshot: "Deep Work",
              last_used_at: "2026-04-17T12:00:00Z",
            },
          ],
        };
      }
      if (path.startsWith("/api/search?")) {
        return { results: [], page: { has_more: false, next_cursor: null } };
      }
      throw new Error(`Unhandled apiFetch call: ${path}`);
    });

    render(<CommandPalette />);

    openPalette();

    expect(await screen.findByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("Deep Work")).toBeInTheDocument();
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getAllByText("Libraries").length).toBeGreaterThan(0);
    expect(screen.getByText("Browse")).toBeInTheDocument();
    expect(screen.getByText("Chats")).toBeInTheDocument();
    expect(screen.queryByText("Discover")).not.toBeInTheDocument();
    expect(screen.queryByText("Documents")).not.toBeInTheDocument();
    expect(screen.queryByText("Videos")).not.toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/me/command-palette-recents");
  });

  it("reopens a recent destination from its href", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/me/command-palette-recents") {
        return {
          data: [
            {
              href: "/media/media-1",
              title_snapshot: "Deep Work",
              last_used_at: "2026-04-17T12:00:00Z",
            },
          ],
        };
      }
      if (path.startsWith("/api/search?")) {
        return { results: [], page: { has_more: false, next_cursor: null } };
      }
      throw new Error(`Unhandled apiFetch call: ${path}`);
    });

    render(<CommandPalette />);

    openPalette();
    await screen.findByText("Deep Work");

    await user.click(screen.getByRole("option", { name: /Deep Work/i }));

    expect(requestOpenInAppPaneMock).toHaveBeenCalledWith("/media/media-1", {
      titleHint: "Deep Work",
    });
  });

  it("does not read or write command-palette recent local storage", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      COMMAND_PALETTE_RECENT_STORAGE_KEY,
      JSON.stringify(["nav-settings"])
    );

    render(<CommandPalette />);

    openPalette();
    await screen.findByRole("dialog", { name: "Search" });

    expect(screen.queryByText("Recent")).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("option", { name: /Libraries/i })[0]!);

    expect(localStorage.getItem(COMMAND_PALETTE_RECENT_STORAGE_KEY)).toBe(
      JSON.stringify(["nav-settings"])
    );
  });

  it("shows an icon-only mobile Search trigger that opens the existing palette", async () => {
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

    const trigger = screen.getByRole("button", { name: "Search" });
    expect(trigger).not.toHaveTextContent(/\S/);

    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Search" });
    expect(within(dialog).getByRole("heading", { name: "Search" })).toBeInTheDocument();
    expect(
      within(dialog).getByPlaceholderText("Search or run an action...")
    ).toBeInTheDocument();
  });
});
