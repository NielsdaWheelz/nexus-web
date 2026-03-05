import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { mockNavigateTab, MOCK_STORE } = vi.hoisted(() => {
  const mockNavigateTab = vi.fn();
  return {
    mockNavigateTab,
    MOCK_STORE: {
      state: {
        schemaVersion: 2,
        activeGroupId: "group-test-1",
        groups: [
          {
            id: "group-test-1",
            activeTabId: "tab-test-1",
            tabs: [{ id: "tab-test-1", href: "/libraries" }],
          },
        ],
      },
      meta: { lastDecodeError: null, lastEncodeError: null },
      activateGroup: vi.fn(),
      activateTab: vi.fn(),
      openTab: vi.fn(),
      openGroupWithTab: vi.fn(),
      navigateTab: mockNavigateTab,
      closeTab: vi.fn(),
      closeGroup: vi.fn(),
      setGroupWidth: vi.fn(),
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
});
