import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { PaneRuntimeLayout } from "@/lib/workspace/paneSizing";
import { usePaneFixedChrome } from "@/components/workspace/PaneFixedChrome";

const hostMocks = vi.hoisted(() => ({
  bodyInstanceId: 0,
  mountedBodyIds: [] as number[],
  unmountedBodyIds: [] as number[],
  runtimeLayout: null as PaneRuntimeLayout | null,
  fixedChromeWidthPx: null as number | null,
  store: {
    state: {
      primaryPaneOrder: ["pane-1"],
      primaryPanesById: {
        "pane-1": {
          id: "pane-1",
          href: "/media/media-1",
          primaryWidthPx: 640,
          attachedSecondaryPaneId: null,
          visibility: "visible" as const,
          history: { back: [], forward: [] } as { back: string[]; forward: string[] },
        },
      },
      secondaryPanesById: {},
      activePrimaryPaneId: "pane-1",
    },
    workspacePrimaryMetrics: {
      primaryMinWidthPx: 684,
      primaryDefaultWidthPx: 684,
    },
    runtimeTitleByPaneId: new Map(),
    activatePane: vi.fn(),
    openPane: vi.fn(),
    navigatePane: vi.fn(),
    goBackPane: vi.fn(),
    goForwardPane: vi.fn(),
    closePane: vi.fn(),
    resizePrimaryPane: vi.fn(),
    requestSecondarySurface: vi.fn(),
    closeSecondaryPane: vi.fn(),
    dropSecondaryPane: vi.fn(),
    setSecondarySurface: vi.fn(),
    resizeSecondaryPane: vi.fn(),
    minimizePane: vi.fn(),
    restorePane: vi.fn(),
    publishPaneTitle: vi.fn(),
  },
}));

function mediaRoute(href: string) {
  const url = new URL(href, "http://localhost");
  const id = url.pathname.split("/")[2] ?? "";
  return {
    id: "media",
    pathname: url.pathname,
    params: { id },
    staticTitle: "Media",
    titleMode: "dynamic",
    resourceRef: id ? `media:${id}` : null,
    render: () => <TestPaneBody />,
    definition: {
      bodyMode: "document",
      maxWidthPx: 2400,
      allowsIntrinsicPrimaryWidth: true,
    },
  };
}

function TestPaneBody() {
  const instanceId = useRef(++hostMocks.bodyInstanceId);
  const paneRuntime = usePaneRuntime();
  usePaneFixedChrome(
    hostMocks.fixedChromeWidthPx === null
      ? null
      : {
          id: "reader-overview-ruler",
          widthPx: hostMocks.fixedChromeWidthPx,
          body: <div>Fixed chrome</div>,
        },
  );
  useEffect(() => {
    const id = instanceId.current;
    hostMocks.mountedBodyIds.push(id);
    return () => {
      hostMocks.unmountedBodyIds.push(id);
    };
  }, []);
  useEffect(() => {
    if (hostMocks.runtimeLayout !== null) {
      paneRuntime?.setPaneLayout(hostMocks.runtimeLayout);
    }
  }, [paneRuntime]);
  return (
    <div data-testid="route-body" data-instance-id={instanceId.current}>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/authors/body-author" data-pane-title-hint="Body Author">
        Body Author
      </a>
    </div>
  );
}

vi.mock("@/lib/panes/paneRouteRegistry", () => ({
  resolvePaneRoute: (href: string) => mediaRoute(href),
}));

vi.mock("@/lib/workspace/store", () => ({
  useWorkspaceHostStore: () => hostMocks.store,
  resolveWorkspacePaneTitle: (pane: { href: string }) => {
    const route = mediaRoute(pane.href);
    return {
      chrome: null,
      resourceKey: route.resourceRef ? `${route.id}:${route.resourceRef}` : route.pathname,
      route,
      title: "Media",
      titleState: "pending",
      titleSource: "fallback",
    };
  },
}));

vi.mock("@/components/workspace/PaneShell", () => ({
  default: ({
    children,
    sizing,
    secondarySizing,
    fixedChromePublication,
    navigation,
  }: {
    children: ReactNode;
    sizing: { primaryMinWidthPx: number };
    secondarySizing: { widthPx: number } | null;
    fixedChromePublication: { widthPx: number } | null;
    navigation: {
      canGoBack: boolean;
      canGoForward: boolean;
      onBack: () => void;
      onForward: () => void;
    };
  }) => (
    <section
      data-testid="pane-shell"
      data-min-width-px={sizing.primaryMinWidthPx}
      data-fixed-chrome-width-px={fixedChromePublication?.widthPx ?? 0}
      data-secondary-width-px={secondarySizing?.widthPx ?? 0}
    >
      <nav aria-label="Mock pane chrome">
        <button
          type="button"
          onClick={navigation.onBack}
          disabled={!navigation.canGoBack}
        >
          Go back in this pane
        </button>
        <button
          type="button"
          onClick={navigation.onForward}
          disabled={!navigation.canGoForward}
        >
          Go forward in this pane
        </button>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/authors/author-1" data-pane-title-hint="Chrome Author">
          Chrome Author
        </a>
      </nav>
      {children}
    </section>
  ),
}));

vi.mock("@/components/workspace/WorkspacePaneStrip", () => ({
  default: () => null,
}));

vi.mock("@/components/workspace/usePaneCanvas", () => ({
  usePaneCanvas: () => ({
    canvasRef: { current: null },
    onWheel: vi.fn(),
    edges: { atStart: false, atEnd: false },
    inViewPaneIds: new Set(["pane-1"]),
    handleChromeMouseDown: vi.fn(),
    scrollPaneIntoView: vi.fn(),
  }),
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => false,
}));

vi.mock("@/lib/keybindings", () => ({
  loadKeybindings: () => ({}),
  matchesKeyEvent: () => false,
}));

vi.mock("@/lib/workspace/telemetry", () => ({
  emitWorkspaceTelemetry: vi.fn(),
}));

import WorkspaceHost from "@/components/workspace/WorkspaceHost";

function setPaneHref(
  href: string,
  history: { back: string[]; forward: string[] } = { back: [], forward: [] }
) {
  hostMocks.store.state = {
    primaryPaneOrder: ["pane-1"],
    primaryPanesById: {
      "pane-1": {
        id: "pane-1",
        href,
        primaryWidthPx: 640,
        attachedSecondaryPaneId: null,
        visibility: "visible",
        history,
      },
    },
    secondaryPanesById: {},
    activePrimaryPaneId: "pane-1",
  };
}

describe("WorkspaceHost pane route lifecycle", () => {
  beforeEach(() => {
    hostMocks.bodyInstanceId = 0;
    hostMocks.mountedBodyIds = [];
    hostMocks.unmountedBodyIds = [];
    hostMocks.runtimeLayout = null;
    hostMocks.fixedChromeWidthPx = null;
    hostMocks.store.activatePane.mockReset();
    hostMocks.store.openPane.mockReset();
    hostMocks.store.navigatePane.mockReset();
    hostMocks.store.goBackPane.mockReset();
    hostMocks.store.goForwardPane.mockReset();
    hostMocks.store.resizePrimaryPane.mockReset();
    hostMocks.store.requestSecondarySurface.mockReset();
    hostMocks.store.closeSecondaryPane.mockReset();
    hostMocks.store.dropSecondaryPane.mockReset();
    hostMocks.store.setSecondarySurface.mockReset();
    hostMocks.store.resizeSecondaryPane.mockReset();
    setPaneHref("/media/media-1");
  });

  it("does not remount the route body for same-resource location changes", () => {
    const { rerender } = render(<WorkspaceHost />);
    const firstInstance = screen.getByTestId("route-body").dataset.instanceId;

    setPaneHref("/media/media-1?loc=chapter-2");
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-instance-id",
      firstInstance,
    );
    expect(hostMocks.mountedBodyIds).toHaveLength(1);
    expect(hostMocks.unmountedBodyIds).toHaveLength(0);
  });

  it("remounts the route body when the resource changes", () => {
    const { rerender } = render(<WorkspaceHost />);
    const firstInstance = screen.getByTestId("route-body").dataset.instanceId;

    setPaneHref("/media/media-2");
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("route-body")).not.toHaveAttribute(
      "data-instance-id",
      firstInstance,
    );
    expect(hostMocks.mountedBodyIds).toHaveLength(2);
    expect(hostMocks.unmountedBodyIds).toEqual([Number(firstInstance)]);
  });

  it("auto-resizes a visible pane when runtime content raises the minimum width", async () => {
    hostMocks.runtimeLayout = {
      primaryWidth: { kind: "intrinsic", widthPx: 900 },
    };

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.resizePrimaryPane).toHaveBeenCalledWith("pane-1", 900);
    });
  });

  it("ignores stale runtime layout records after the pane resource changes", async () => {
    hostMocks.runtimeLayout = {
      primaryWidth: { kind: "intrinsic", widthPx: 900 },
    };
    const { rerender } = render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.resizePrimaryPane).toHaveBeenCalledWith("pane-1", 900);
    });

    hostMocks.store.resizePrimaryPane.mockClear();
    hostMocks.runtimeLayout = null;
    setPaneHref("/media/media-2");
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-min-width-px",
      "684",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-fixed-chrome-width-px",
      "0",
    );
    expect(hostMocks.store.resizePrimaryPane).toHaveBeenCalledWith("pane-1", 684);
  });

  it("routes pane chrome internal links through the current pane", () => {
    render(<WorkspaceHost />);

    fireEvent.click(screen.getByRole("link", { name: "Chrome Author" }));

    expect(hostMocks.store.navigatePane).toHaveBeenCalledWith(
      "pane-1",
      "/authors/author-1",
      { titleHint: "Chrome Author" },
    );
    expect(hostMocks.store.openPane).not.toHaveBeenCalled();
  });

  it("routes header Back and Forward through the target pane only", () => {
    setPaneHref("/media/media-2", {
      back: ["/media/media-1"],
      forward: ["/media/media-3"],
    });

    render(<WorkspaceHost />);

    fireEvent.click(screen.getByRole("button", { name: "Go back in this pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Go forward in this pane" }));

    expect(hostMocks.store.goBackPane).toHaveBeenCalledWith("pane-1");
    expect(hostMocks.store.goForwardPane).toHaveBeenCalledWith("pane-1");
    expect(hostMocks.store.navigatePane).not.toHaveBeenCalled();
  });

  it("routes route body internal links through the same pane boundary", () => {
    render(<WorkspaceHost />);

    fireEvent.click(screen.getByRole("link", { name: "Body Author" }));

    expect(hostMocks.store.navigatePane).toHaveBeenCalledWith(
      "pane-1",
      "/authors/body-author",
      { titleHint: "Body Author" },
    );
    expect(hostMocks.store.openPane).not.toHaveBeenCalled();
  });

  it("opens pane chrome internal links in a sibling pane on Shift-click", () => {
    render(<WorkspaceHost />);

    fireEvent.click(screen.getByRole("link", { name: "Chrome Author" }), {
      shiftKey: true,
    });

    expect(hostMocks.store.openPane).toHaveBeenCalledWith({
      href: "/authors/author-1",
      openerPaneId: "pane-1",
      activate: true,
      titleHint: "Chrome Author",
    });
    expect(hostMocks.store.navigatePane).not.toHaveBeenCalled();
  });
});
