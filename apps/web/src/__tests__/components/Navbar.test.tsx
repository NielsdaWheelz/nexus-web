import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const {
  mockNavigatePane,
  mockActivatePane,
  MOCK_STORE,
} = vi.hoisted(() => {
  const mockNavigatePane = vi.fn();
  const mockActivatePane = vi.fn();
  return {
    mockNavigatePane,
    mockActivatePane,
    MOCK_STORE: {
      state: {
        schemaVersion: 3,
        activePaneId: "pane-test-1",
        panes: [
          { id: "pane-test-1", href: "/libraries", widthPx: 480 },
          { id: "pane-test-2", href: "/conversations", widthPx: 480 },
        ],
      },
      runtimeTitleByPaneId: new Map(),
      openHintByPaneId: new Map(),
      resourceTitleByRef: new Map(),
      activatePane: mockActivatePane,
      openPane: vi.fn(),
      navigatePane: mockNavigatePane,
      closePane: vi.fn(),
      closePaneFamily: vi.fn(),
      resizePane: vi.fn(),
      publishPaneTitle: vi.fn(),
    },
  };
});

vi.mock("@/lib/workspace/store", () => ({
  useWorkspaceStore: () => MOCK_STORE,
}));

// Mock next/navigation (needed by next/link internally)
vi.mock("next/navigation", () => ({
  usePathname: () => "/libraries",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import Navbar from "@/components/Navbar";

describe("Navbar", () => {
  beforeEach(() => {
    mockNavigatePane.mockClear();
    mockActivatePane.mockClear();
    vi.stubGlobal("innerWidth", 1200);
    window.dispatchEvent(new Event("resize"));
  });

  it("renders the logo", () => {
    render(<Navbar />);
    expect(screen.getByText("Nexus")).toBeInTheDocument();
  });

  it("renders the libraries link", () => {
    render(<Navbar />);
    expect(screen.getByText("Libraries")).toBeInTheDocument();
  });

  it("toggles collapsed state", () => {
    const onToggle = vi.fn();
    render(<Navbar onToggle={onToggle} />);

    const toggleButton = screen.getByLabelText("Collapse navigation");
    fireEvent.click(toggleButton);

    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("shows expand button when collapsed", () => {
    const onToggle = vi.fn();
    render(<Navbar onToggle={onToggle} />);

    const collapseButton = screen.getByLabelText("Collapse navigation");
    fireEvent.click(collapseButton);

    const expandButton = screen.getByLabelText("Expand navigation");
    expect(expandButton).toBeInTheDocument();
  });

  it("highlights active link", () => {
    render(<Navbar />);
    const librariesLink = screen.getByText("Libraries").closest("a");
    expect(librariesLink?.className).toMatch(/active/i);
  });

  it("renders a mobile bottom nav with a tabs button", async () => {
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));

    render(<Navbar />);

    expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tabs" })).toBeInTheDocument();
  });

  it("renders mobile nav buttons as icon-only without visible text labels", () => {
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));

    render(<Navbar />);

    const nav = screen.getByRole("navigation", { name: "Mobile navigation" });
    const labels = ["Libraries", "Discover", "Chat", "Search", "Settings", "Tabs"];

    for (const label of labels) {
      expect(within(nav).queryByText(label)).not.toBeInTheDocument();
      expect(within(nav).getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("opens a mobile tab switcher and allows pane activation", async () => {
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));
    const user = userEvent.setup();

    render(<Navbar />);

    await user.click(screen.getByRole("button", { name: "Tabs" }));
    const dialog = screen.getByRole("dialog", { name: "Open tabs" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Libraries" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Sign Out" })).toBeInTheDocument();
    const chatTab = within(dialog).getByRole("button", { name: "Chats" });
    await user.click(chatTab);

    expect(mockActivatePane).toHaveBeenCalledTimes(1);
    expect(mockActivatePane).toHaveBeenCalledWith("pane-test-2");
    expect(screen.queryByRole("dialog", { name: "Open tabs" })).not.toBeInTheDocument();
  });

  it("locks body scroll while the mobile tab switcher is open", async () => {
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));
    const user = userEvent.setup();

    const { unmount } = render(<Navbar />);

    const tabsButton = screen.getByRole("button", { name: "Tabs" });
    expect(document.body.style.overflow).toBe("");
    await user.click(tabsButton);
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    expect(document.body.style.overflow).toBe("");

    await user.click(tabsButton);
    await user.click(screen.getByRole("button", { name: "Close tabs" }));
    expect(document.body.style.overflow).toBe("");

    await user.click(tabsButton);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
