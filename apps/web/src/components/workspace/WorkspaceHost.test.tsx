import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hostMocks = vi.hoisted(() => ({
  bodyInstanceId: 0,
  mountedBodyIds: [] as number[],
  unmountedBodyIds: [] as number[],
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
  useEffect(() => {
    const id = instanceId.current;
    hostMocks.mountedBodyIds.push(id);
    return () => {
      hostMocks.unmountedBodyIds.push(id);
    };
  }, []);
  return <div data-testid="route-body" data-instance-id={instanceId.current} />;
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
  default: ({ children }: { children: ReactNode }) => (
    <section data-testid="pane-shell">{children}</section>
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
});
