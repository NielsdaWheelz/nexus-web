import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

const { apiFetchMock, mockWorkspaceStore, requestOpenInAppPaneMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  mockWorkspaceStore: {
    state: {
      schemaVersion: 5,
      activePaneId: "pane-a",
      panes: [
        {
          id: "pane-a",
          href: "/settings/billing",
          widthPx: 480,
          visibility: "visible",
          history: { back: [], forward: [] },
        },
        {
          id: "pane-b",
          href: "/libraries",
          widthPx: 480,
          visibility: "visible",
          history: { back: [], forward: [] },
        },
        {
          id: "pane-c",
          href: "/settings/local-vault",
          widthPx: 480,
          visibility: "visible",
          history: { back: [], forward: [] },
        },
      ],
    },
    runtimeTitleByPaneId: new Map(),
    activatePane: vi.fn(),
    openPane: vi.fn(),
    navigatePane: vi.fn(),
    goBackPane: vi.fn(),
    goForwardPane: vi.fn(),
    closePane: vi.fn(),
    resizePane: vi.fn(),
    minimizePane: vi.fn(),
    restorePane: vi.fn(),
    publishPaneTitle: vi.fn(),
  },
  requestOpenInAppPaneMock: vi.fn(),
}));

vi.mock("@/lib/workspace/store", () => ({
  useWorkspaceStore: () => mockWorkspaceStore,
  resolveWorkspacePaneTitle: (pane: { href: string }) => {
    if (pane.href === "/settings/billing") return { title: "Billing" };
    if (pane.href === "/settings/local-vault") return { title: "Local Vault" };
    if (pane.href === "/libraries") return { title: "Libraries" };
    return { title: "Pane" };
  },
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

import CommandPalette from "@/components/CommandPalette";

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
    vi.stubGlobal("innerWidth", 1280);
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/me/palette-history")) {
        return {
          data: {
            recent: [
              {
                target_key: "/settings/billing",
                target_kind: "href",
                target_href: "/settings/billing",
                title_snapshot: "Billing",
                source: "recent",
                last_used_at: "2026-04-17T12:00:00Z",
              },
              {
                target_key: "/settings/local-vault",
                target_kind: "href",
                target_href: "/settings/local-vault",
                title_snapshot: "Local Vault",
                source: "recent",
                last_used_at: "2026-04-17T12:00:00Z",
              },
              {
                target_key: "/libraries",
                target_kind: "href",
                target_href: "/libraries",
                title_snapshot: "Libraries",
                source: "recent",
                last_used_at: "2026-04-17T12:00:00Z",
              },
            ],
            frecency_boosts: {},
          },
        };
      }
      if (path === "/api/oracle/readings") {
        return { data: [] };
      }
      throw new Error(`Unhandled apiFetch call: ${path}`);
    });
  });

  afterEach(() => {
    setUserAgent(DEFAULT_USER_AGENT);
  });

  it("hides local vault but keeps billing destinations", async () => {
    render(
      <FeedbackProvider>
        <CommandPalette />
      </FeedbackProvider>
    );

    openPalette();

    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear scope" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Billing").length).toBeGreaterThan(0);
    expect(screen.queryByText("Local Vault")).not.toBeInTheDocument();
    expect(screen.getAllByText("Libraries").length).toBeGreaterThan(0);
  });
});
