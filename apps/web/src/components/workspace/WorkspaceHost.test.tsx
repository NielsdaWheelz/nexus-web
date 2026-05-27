import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";

const hostMocks = vi.hoisted(() => ({
  bodyInstanceId: 0,
  mountedBodyIds: [] as number[],
  unmountedBodyIds: [] as number[],
  runtimeMinWidthPx: null as number | null,
  runtimeExtraWidthPx: null as number | null,
  store: {
    state: {
      panes: [
        {
          id: "pane-1",
          href: "/media/media-1",
          widthPx: 640,
          visibility: "visible" as const,
        },
      ],
      activePaneId: "pane-1",
    },
    runtimeTitleByPaneId: new Map(),
    activatePane: vi.fn(),
    openPane: vi.fn(),
    navigatePane: vi.fn(),
    closePane: vi.fn(),
    resizePane: vi.fn(),
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
      minWidthPx: 320,
      maxWidthPx: 2400,
    },
  };
}

function TestPaneBody() {
  const instanceId = useRef(++hostMocks.bodyInstanceId);
  const paneRuntime = usePaneRuntime();
  useEffect(() => {
    const id = instanceId.current;
    hostMocks.mountedBodyIds.push(id);
    return () => {
      hostMocks.unmountedBodyIds.push(id);
    };
  }, []);
  useEffect(() => {
    if (hostMocks.runtimeMinWidthPx !== null) {
      paneRuntime?.setPaneMinWidth(hostMocks.runtimeMinWidthPx);
    }
    if (hostMocks.runtimeExtraWidthPx !== null) {
      paneRuntime?.setPaneExtraWidth(hostMocks.runtimeExtraWidthPx);
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
  getParentHref: () => null,
  resolvePaneRoute: (href: string) => mediaRoute(href),
}));

vi.mock("@/lib/workspace/store", () => ({
  useWorkspaceStore: () => hostMocks.store,
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
    minWidthPx,
    extraWidthPx,
  }: {
    children: ReactNode;
    minWidthPx: number;
    extraWidthPx: number;
  }) => (
    <section
      data-testid="pane-shell"
      data-min-width-px={minWidthPx}
      data-extra-width-px={extraWidthPx}
    >
      <nav aria-label="Mock pane chrome">
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

function setPaneHref(href: string) {
  hostMocks.store.state = {
    panes: [
      {
        id: "pane-1",
        href,
        widthPx: 640,
        visibility: "visible",
      },
    ],
    activePaneId: "pane-1",
  };
}

describe("WorkspaceHost pane route lifecycle", () => {
  beforeEach(() => {
    hostMocks.bodyInstanceId = 0;
    hostMocks.mountedBodyIds = [];
    hostMocks.unmountedBodyIds = [];
    hostMocks.runtimeMinWidthPx = null;
    hostMocks.runtimeExtraWidthPx = null;
    hostMocks.store.activatePane.mockReset();
    hostMocks.store.openPane.mockReset();
    hostMocks.store.navigatePane.mockReset();
    hostMocks.store.resizePane.mockReset();
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
    hostMocks.runtimeMinWidthPx = 900;

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.resizePane).toHaveBeenCalledWith("pane-1", 900);
    });
  });

  it("ignores stale runtime width records after the pane resource changes", async () => {
    hostMocks.runtimeMinWidthPx = 900;
    hostMocks.runtimeExtraWidthPx = 360;
    const { rerender } = render(<WorkspaceHost />);

    await waitFor(() => {
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-extra-width-px",
        "360",
      );
    });
    await waitFor(() => {
      expect(hostMocks.store.resizePane).toHaveBeenCalledWith("pane-1", 900);
    });

    hostMocks.store.resizePane.mockClear();
    hostMocks.runtimeMinWidthPx = null;
    hostMocks.runtimeExtraWidthPx = null;
    setPaneHref("/media/media-2");
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-min-width-px",
      "320",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-extra-width-px",
      "0",
    );
    expect(hostMocks.store.resizePane).not.toHaveBeenCalled();
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
