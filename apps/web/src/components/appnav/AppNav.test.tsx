import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import AppNav from "./AppNav";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";

const COLLAPSE_KEY = "nexus.nav.collapsed.v1";

const { mockWorkspaceStore, mockIsMobile } = vi.hoisted(() => ({
  mockWorkspaceStore: {
    state: {
      activePrimaryPaneId: "pane-a",
      primaryPaneOrder: ["pane-a"],
      primaryPanesById: {
        "pane-a": {
          id: "pane-a",
          href: "/libraries",
          primaryWidthPx: 480,
          attachedSecondaryPaneId: null,
          visibility: "visible",
          history: { back: [], forward: [] },
        },
      },
      secondaryPanesById: {},
    },
    navigatePane: vi.fn(),
  },
  mockIsMobile: { value: false },
}));

vi.mock("@/lib/workspace/store", () => ({
  useWorkspaceStore: () => mockWorkspaceStore,
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => mockIsMobile.value,
}));

vi.mock("@/lib/api/useResource", () => ({
  useResource: () => ({ status: "ready", data: { data: { pins: [] } } }),
}));

describe("AppNav (desktop rail)", () => {
  beforeEach(() => {
    localStorage.clear();
    mockWorkspaceStore.navigatePane.mockClear();
  });

  it("renders grouped destinations and marks the active one with aria-current", () => {
    render(<AppNav />);

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();

    // Active pane is /libraries → exactly the Libraries link is current.
    expect(screen.getByRole("link", { name: "Libraries" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Browse" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Oracle" })).toBeInTheDocument();
  });

  it("intercepts a destination click into a same-pane navigation", () => {
    render(<AppNav />);

    fireEvent.click(screen.getByRole("link", { name: "Libraries" }));

    expect(mockWorkspaceStore.navigatePane).toHaveBeenCalledWith("pane-a", "/libraries");
  });

  it("persists collapse and keeps every nav link accessibly named while collapsed", () => {
    render(<AppNav />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));

    expect(localStorage.getItem(COLLAPSE_KEY)).toBe("1");
    expect(screen.getByRole("button", { name: "Expand navigation" })).toBeInTheDocument();
    // Visible labels are hidden when collapsed, but the accessible name must survive.
    expect(screen.getByRole("link", { name: "Libraries" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Oracle" })).toBeInTheDocument();
  });

  it("opens the command palette from the command bar", () => {
    const onOpen = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    render(<AppNav />);

    fireEvent.click(screen.getByRole("button", { name: "Search or ask anything" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
  });

  it("opens an account menu with Settings and Sign Out", async () => {
    render(<AppNav />);

    fireEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(await screen.findByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign Out" })).toBeInTheDocument();
  });
});

describe("AppNav (mobile sheet)", () => {
  beforeEach(() => {
    mockIsMobile.value = true;
    localStorage.clear();
    mockWorkspaceStore.navigatePane.mockClear();
  });

  afterEach(() => {
    mockIsMobile.value = false;
  });

  it("closes an open NavSheet when OPEN_COMMAND_PALETTE_EVENT fires", async () => {
    render(
      <MobileChromeProvider>
        <AppNav />
      </MobileChromeProvider>,
    );

    // Open the sheet via the mobile top-bar brand button.
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();

    // Dispatch the palette event — the sheet's useEffect listener calls setSheetOpen(false).
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
    });

    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });
});
