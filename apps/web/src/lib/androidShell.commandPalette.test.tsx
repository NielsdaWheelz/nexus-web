import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

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
      panes: [
        { id: "pane-a", href: "/settings/billing", widthPx: 480 },
        { id: "pane-b", href: "/libraries", widthPx: 480 },
        { id: "pane-c", href: "/settings/local-vault", widthPx: 480 },
      ],
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

const DEFAULT_USER_AGENT = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

function openPalette() {
  act(() => {
    window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
  });
}

describe("CommandPalette android shell gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/me/command-palette-recents") {
        return {
          data: [
            {
              href: "/settings/billing",
              title_snapshot: "Billing",
              last_used_at: "2026-04-17T12:00:00Z",
            },
            {
              href: "/settings/local-vault",
              title_snapshot: "Local Vault",
              last_used_at: "2026-04-17T12:00:00Z",
            },
            {
              href: "/libraries",
              title_snapshot: "Libraries",
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
  });

  afterEach(() => {
    setUserAgent(DEFAULT_USER_AGENT);
  });

  it("hides local vault but keeps billing destinations", async () => {
    render(<CommandPalette />);

    openPalette();

    expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
    expect(screen.getAllByText("Billing").length).toBeGreaterThan(0);
    expect(screen.queryByText("Local Vault")).not.toBeInTheDocument();
    expect(screen.getAllByText("Libraries").length).toBeGreaterThan(0);
  });
});
