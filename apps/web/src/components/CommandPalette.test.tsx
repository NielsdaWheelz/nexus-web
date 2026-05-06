import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import CommandPalette from "./CommandPalette";

// Stub modules with minimal shapes CommandPalette actually uses.
vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/panes/openInAppPane", () => ({
  requestOpenInAppPane: vi.fn(),
  consumePendingPaneOpenQueue: vi.fn(() => []),
  setPaneGraphReady: vi.fn(),
  isOpenInAppPaneMessage: vi.fn(() => false),
  NEXUS_OPEN_PANE_EVENT: "nexus-open-pane",
}));

vi.mock("@/lib/panes/paneRouteRegistry", () => ({
  resolvePaneRoute: vi.fn(() => ({ id: "unknown", params: {} })),
  resolveWorkspacePaneTitle: vi.fn(() => ({ title: "Pane", route: { id: "unknown" } })),
}));

vi.mock("@/lib/workspace/store", () => ({
  useWorkspaceStore: vi.fn(() => ({
    state: { panes: [], activePaneId: null },
    runtimeTitleByPaneId: new Map(),
    activatePane: vi.fn(),
    closePane: vi.fn(),
    restorePane: vi.fn(),
  })),
  resolveWorkspacePaneTitle: vi.fn(() => ({ title: "Pane", route: { id: "unknown" } })),
}));

vi.mock("@/components/addContentEvents", () => ({
  dispatchOpenAddContent: vi.fn(),
}));

vi.mock("@/components/commandPaletteEvents", () => ({
  OPEN_COMMAND_PALETTE_EVENT: "open-command-palette",
}));

vi.mock("@/lib/notes/api", () => ({
  createNotePage: vi.fn(),
}));

vi.mock("@/lib/search/resultRowAdapter", () => ({
  fetchSearchResultPage: vi.fn(() => Promise.resolve({ rows: [] })),
  ALL_SEARCH_TYPES: [],
}));

vi.mock("@/lib/keybindings", () => ({
  loadKeybindings: vi.fn(() => ({ "open-palette": "cmd+k" })),
  matchesKeyEvent: vi.fn(() => false),
  formatKeyCombo: vi.fn((c: string) => c),
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: vi.fn(() => false),
}));

vi.mock("@/lib/ui/useFocusTrap", () => ({
  useFocusTrap: vi.fn(),
}));

import { apiFetch } from "@/lib/api/client";

const mockApiFetch = vi.mocked(apiFetch);

async function openPalette() {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("open-command-palette"));
  });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    // Default: recents API returns empty, oracle readings returns empty.
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/api/me/command-palette-recents") {
        return Promise.resolve({ data: [] });
      }
      if (path === "/api/oracle/readings") {
        return Promise.resolve([]);
      }
      return Promise.resolve({});
    });
  });

  it("shows the Oracle nav entry under Navigate when palette opens", async () => {
    render(<CommandPalette />);
    await openPalette();

    // Wait for the Navigate section heading to appear.
    await screen.findByText("Navigate");

    // The Navigate section should contain an "Oracle" button.
    expect(screen.getByText("Oracle")).toBeInTheDocument();
  });

  it("renders two Recent folios entries for completed readings and omits the failed one", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/api/me/command-palette-recents") {
        return Promise.resolve({ data: [] });
      }
      if (path === "/api/oracle/readings") {
        return Promise.resolve([
          { id: "r1", folio_number: 12, folio_motto: "AVDENTES FORTVNA IVVAT", folio_theme: "Of Courage", status: "complete" },
          { id: "r2", folio_number: 7, folio_motto: "THE SOLITARY LAMP", folio_theme: "Of Solitude", status: "complete" },
          { id: "r3", folio_number: 3, folio_motto: "PER ASPERA", folio_theme: "Of Trials", status: "failed" },
        ]);
      }
      return Promise.resolve({});
    });

    render(<CommandPalette />);
    await openPalette();

    // Wait for the "Recent folios" section heading to appear.
    await screen.findByText("Recent folios");

    // Two completed folios should appear (partial text match via aria button text).
    expect(screen.getByText("Folio XII · Of Courage · AVDENTES FORTVNA IVVAT")).toBeInTheDocument();
    expect(screen.getByText("Folio VII · Of Solitude · THE SOLITARY LAMP")).toBeInTheDocument();

    // The failed reading should not appear.
    expect(screen.queryByText(/PER ASPERA/)).not.toBeInTheDocument();
  });

  it("does not render Recent folios section when there are no completed readings", async () => {
    render(<CommandPalette />);
    await openPalette();

    // Wait for palette to render its Navigate section (oracle fetch has resolved to []).
    await screen.findByText("Navigate");

    // Wait for oracle fetch to have been called.
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/api/oracle/readings");
    });

    expect(screen.queryByText("Recent folios")).not.toBeInTheDocument();
  });
});
