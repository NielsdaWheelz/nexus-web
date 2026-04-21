import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch, mockSetPaneGraphReady } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockSetPaneGraphReady: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock("@/lib/panes/openInAppPane", () => ({
  NEXUS_OPEN_PANE_EVENT: "nexus:open-pane",
  consumePendingPaneOpenQueue: () => [],
  isOpenInAppPaneMessage: () => false,
  setPaneGraphReady: (...args: unknown[]) => mockSetPaneGraphReady(...args),
}));

vi.mock("@/lib/panes/paneRouteRegistry", () => ({
  resolvePaneRoute: (href: string) => {
    const pathname = new URL(href, "http://localhost").pathname;
    if (pathname === "/libraries") {
      return {
        id: "libraries",
        pathname,
        params: {},
        staticTitle: "Libraries",
        resourceRef: null,
        render: null,
        definition: { defaultWidthPx: 480 },
      };
    }
    if (pathname === "/search") {
      return {
        id: "search",
        pathname,
        params: {},
        staticTitle: "Search",
        resourceRef: null,
        render: null,
        definition: { defaultWidthPx: 480 },
      };
    }
    if (pathname === "/settings") {
      return {
        id: "settings",
        pathname,
        params: {},
        staticTitle: "Settings",
        resourceRef: null,
        render: null,
        definition: { defaultWidthPx: 480 },
      };
    }
    if (pathname.startsWith("/media/")) {
      const mediaId = pathname.split("/")[2] ?? "unknown";
      return {
        id: "media",
        pathname,
        params: { id: mediaId },
        staticTitle: "Media",
        resourceRef: `media:${mediaId}`,
        render: null,
        definition: { defaultWidthPx: 480 },
      };
    }
    return {
      id: "unsupported",
      pathname,
      params: {},
      staticTitle: "Pane",
      resourceRef: null,
      render: null,
      definition: { defaultWidthPx: 480 },
    };
  },
}));

vi.mock("@/lib/workspace/telemetry", () => ({
  emitWorkspaceTelemetry: vi.fn(),
}));

import { WorkspaceStoreProvider, useWorkspaceStore } from "./store";

function WorkspaceStoreHarness() {
  const {
    state,
    activatePane,
    navigatePane,
    openPane,
    publishPaneTitle,
  } = useWorkspaceStore();

  const activePane = state.panes.find((pane) => pane.id === state.activePaneId) ?? null;

  return (
    <>
      <button type="button" onClick={() => openPane({ href: "/search", activate: true })}>
        Open Explicit
      </button>
      <button
        type="button"
        onClick={() => {
          if (activePane) {
            navigatePane(activePane.id, "/settings");
          }
        }}
      >
        Navigate Active
      </button>
      <button
        type="button"
        onClick={() => {
          if (activePane) {
            activatePane(activePane.id);
          }
        }}
      >
        Activate Active
      </button>
      <button
        type="button"
        onClick={() => {
          if (activePane) {
            publishPaneTitle(activePane.id, "Stable title");
          }
        }}
      >
        Publish Active Title
      </button>
      <div data-testid="active-pane-href">{activePane?.href ?? ""}</div>
    </>
  );
}

describe("WorkspaceStoreProvider command palette recents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({ data: null });
    window.history.replaceState({}, "", "/libraries");
  });

  it("posts recents for open-pane events, explicit openPane, navigatePane, and later title snapshots", async () => {
    const user = userEvent.setup();

    render(
      <WorkspaceStoreProvider>
        <WorkspaceStoreHarness />
      </WorkspaceStoreProvider>
    );

    expect(await screen.findByTestId("active-pane-href")).toHaveTextContent("/libraries");
    expect(mockApiFetch).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("nexus:open-pane", {
          detail: {
            href: "/media/media-1?fragment=f-1",
            titleHint: "Hint title",
            resourceRef: "media:media-1",
          },
        })
      );
    });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenNthCalledWith(
        1,
        "/api/me/command-palette-recents",
        {
          method: "POST",
          body: JSON.stringify({
            href: "/media/media-1?fragment=f-1",
            title_snapshot: "Hint title",
          }),
        }
      );
    });

    await user.click(screen.getByRole("button", { name: "Publish Active Title" }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenNthCalledWith(
        2,
        "/api/me/command-palette-recents",
        {
          method: "POST",
          body: JSON.stringify({
            href: "/media/media-1?fragment=f-1",
            title_snapshot: "Stable title",
          }),
        }
      );
    });

    await user.click(screen.getByRole("button", { name: "Open Explicit" }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenNthCalledWith(
        3,
        "/api/me/command-palette-recents",
        {
          method: "POST",
          body: JSON.stringify({ href: "/search" }),
        }
      );
    });

    await user.click(screen.getByRole("button", { name: "Navigate Active" }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenNthCalledWith(
        4,
        "/api/me/command-palette-recents",
        {
          method: "POST",
          body: JSON.stringify({ href: "/settings" }),
        }
      );
    });
  });

  it("does not post recents for hydration, popstate, activatePane, or ungated publishPaneTitle", async () => {
    const user = userEvent.setup();

    render(
      <WorkspaceStoreProvider>
        <WorkspaceStoreHarness />
      </WorkspaceStoreProvider>
    );

    expect(await screen.findByTestId("active-pane-href")).toHaveTextContent("/libraries");
    expect(mockApiFetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Activate Active" }));
    await user.click(screen.getByRole("button", { name: "Publish Active Title" }));

    act(() => {
      window.history.pushState({}, "", "/search");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("active-pane-href")).toHaveTextContent("/search");
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
