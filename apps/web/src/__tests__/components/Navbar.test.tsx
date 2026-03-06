import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const {
  mockNavigateTab,
  mockActivateGroup,
  mockActivateTab,
  MOCK_STORE,
} = vi.hoisted(() => {
  const mockNavigateTab = vi.fn();
  const mockActivateGroup = vi.fn();
  const mockActivateTab = vi.fn();
  return {
    mockNavigateTab,
    mockActivateGroup,
    mockActivateTab,
    MOCK_STORE: {
      state: {
        schemaVersion: 2,
        activeGroupId: "group-test-1",
        groups: [
          {
            id: "group-test-1",
            activeTabId: "tab-test-1",
            tabs: [
              { id: "tab-test-1", href: "/libraries" },
              { id: "tab-test-2", href: "/conversations" },
            ],
          },
        ],
      },
      meta: { lastDecodeError: null, lastEncodeError: null },
      runtimeTitleByTabId: new Map(),
      openHintByTabId: new Map(),
      resourceTitleByRef: new Map(),
      activateGroup: mockActivateGroup,
      activateTab: mockActivateTab,
      openTab: vi.fn(),
      openGroupWithTab: vi.fn(),
      navigateTab: mockNavigateTab,
      closeTab: vi.fn(),
      closeGroup: vi.fn(),
      setGroupWidth: vi.fn(),
      publishTabTitle: vi.fn(),
      replaceState: vi.fn(),
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
    mockNavigateTab.mockClear();
    mockActivateGroup.mockClear();
    mockActivateTab.mockClear();
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
      // No visible text label inside the nav button
      expect(within(nav).queryByText(label)).not.toBeInTheDocument();
      // Accessible name still present via aria-label
      expect(within(nav).getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("opens a mobile tab switcher and allows tab activation", async () => {
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

    expect(mockActivateGroup).toHaveBeenCalledTimes(1);
    expect(mockActivateGroup).toHaveBeenCalledWith("group-test-1");
    expect(mockActivateTab).toHaveBeenCalledTimes(1);
    expect(mockActivateTab).toHaveBeenCalledWith("group-test-1", "tab-test-2");
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
