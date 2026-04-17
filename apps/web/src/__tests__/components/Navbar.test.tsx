import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
import { OPEN_UPLOAD_EVENT } from "@/components/CommandPalette";

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

  it("keeps Search as the explicit desktop search destination", () => {
    render(<Navbar />);

    expect(screen.getByRole("link", { name: "Search", hidden: true })).toHaveAttribute(
      "href",
      "/search"
    );
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
    const librariesLink = screen.getByRole("link", { name: "Libraries", hidden: true });
    expect(librariesLink.className).toMatch(/active/i);
  });

  it("exposes an Add content button without rendering an upload sheet", () => {
    render(<Navbar />);

    expect(screen.getByLabelText("Add content")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Add content" })).not.toBeInTheDocument();
  });

  it("dispatches the upload event when Add content is clicked", async () => {
    const user = userEvent.setup();
    const onOpenUpload = vi.fn();
    window.addEventListener(OPEN_UPLOAD_EVENT, onOpenUpload as EventListener);

    render(<Navbar />);

    await user.click(screen.getByLabelText("Add content"));

    expect(onOpenUpload).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_UPLOAD_EVENT, onOpenUpload as EventListener);
  });
});
