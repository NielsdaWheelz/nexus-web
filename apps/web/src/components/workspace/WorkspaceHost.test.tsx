import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { PaneRuntimeLayout } from "@/lib/workspace/paneSizing";
import {
  usePaneFixedChrome,
  type PaneFixedChromePublication,
} from "@/components/workspace/PaneFixedChrome";
import {
  usePaneSecondary,
  type PaneSecondaryPublication,
} from "@/components/workspace/PaneSecondary";
import type {
  WorkspaceSecondaryGroupId,
  WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";

const hostMocks = vi.hoisted(() => ({
  bodyInstanceId: 0,
  mountedBodyIds: [] as number[],
  unmountedBodyIds: [] as number[],
  paneShellSnapshots: [] as {
    fixedChromeWidthPx: number;
    secondarySurfaces: string;
  }[],
  runtimeLayout: null as PaneRuntimeLayout | null,
  fixedChromeWidthPx: null as number | null,
  secondaryPublication: null as PaneSecondaryPublication | null,
  openInNewPaneRequest: null as {
    href: string;
    titleHint?: string;
    surfaceId: WorkspaceSecondarySurfaceId;
  } | null,
  store: {
    state: {
      primaryPaneOrder: ["pane-1"],
      primaryPanesById: {
        "pane-1": {
          id: "pane-1",
          href: "/media/media-1",
          primaryWidthPx: 640,
          attachedSecondaryPaneId: null as string | null,
          visibility: "visible" as const,
          history: { back: [], forward: [] } as { back: string[]; forward: string[] },
        },
      },
      secondaryPanesById: {} as Record<
        string,
        {
          id: string;
          parentPrimaryPaneId: string;
          groupId: WorkspaceSecondaryGroupId;
          activeSurfaceId: WorkspaceSecondarySurfaceId;
          widthPx: number;
          visibility: "visible" | "collapsed";
        }
      >,
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
  const didOpenInNewPaneRef = useRef(false);
  const fixedChromeWidthPx = hostMocks.fixedChromeWidthPx;
  const fixedChromePublication = useMemo<PaneFixedChromePublication | null>(
    () =>
      fixedChromeWidthPx === null
        ? null
        : {
            id: "reader-overview-ruler",
            widthPx: fixedChromeWidthPx,
            body: <div>Fixed chrome</div>,
          },
    [fixedChromeWidthPx],
  );
  usePaneFixedChrome(fixedChromePublication);
  usePaneSecondary(hostMocks.secondaryPublication);
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
  useEffect(() => {
    const request = hostMocks.openInNewPaneRequest;
    if (!request || !paneRuntime || didOpenInNewPaneRef.current) {
      return;
    }
    didOpenInNewPaneRef.current = true;
    paneRuntime.openInNewPane(request.href, request.titleHint, request.surfaceId);
  }, [paneRuntime]);
  return (
    <div
      data-testid="route-body"
      data-instance-id={instanceId.current}
      data-runtime-secondary-id={paneRuntime?.secondaryPane?.id ?? "none"}
    >
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/authors/body-author" data-pane-title-hint="Body Author">
        Body Author
      </a>
    </div>
  );
}

vi.mock("@/lib/panes/paneRenderRegistry", () => ({
  renderPane: () => <TestPaneBody />,
}));

vi.mock("@/lib/workspace/store", async () => {
  // Use the real route-identity resolver so the descriptor resourceKey matches
  // the key the host computes via resolvePaneRouteIdentity for pending
  // cross-pane secondary requests. Mocking it to a different shape would let the
  // pending-request tests pass for the wrong reason (key mismatch, not policy).
  const { resolvePaneRouteIdentity } = await import("@/lib/panes/paneIdentity");
  return {
    useWorkspaceHostStore: () => hostMocks.store,
    resolveWorkspacePaneTitle: (pane: { href: string }) => {
      const route = mediaRoute(pane.href);
      return {
        chrome: null,
        resourceKey: resolvePaneRouteIdentity(pane.href).resourceKey,
        route,
        title: "Media",
        titleState: "pending",
        titleSource: "fallback",
      };
    },
  };
});

vi.mock("@/components/workspace/PaneShell", () => ({
  default: ({
    children,
    sizing,
    secondaryPane,
    secondarySizing,
    secondaryPublication,
    fixedChromePublication,
    navigation,
  }: {
    children: ReactNode;
    sizing: { primaryMinWidthPx: number };
    secondaryPane: { id: string } | null;
    secondarySizing: { widthPx: number } | null;
    secondaryPublication: { surfaces: readonly { id: string }[] } | null;
    fixedChromePublication: { widthPx: number } | null;
    navigation: {
      canGoBack: boolean;
      canGoForward: boolean;
      onBack: () => void;
      onForward: () => void;
    };
  }) => {
    const secondarySurfaces = secondaryPublication
      ? secondaryPublication.surfaces.map((surface) => surface.id).join(",")
      : "none";
    hostMocks.paneShellSnapshots.push({
      fixedChromeWidthPx: fixedChromePublication?.widthPx ?? 0,
      secondarySurfaces,
    });
    return (
      <section
        data-testid="pane-shell"
        data-min-width-px={sizing.primaryMinWidthPx}
        data-fixed-chrome-width-px={fixedChromePublication?.widthPx ?? 0}
        data-secondary-width-px={secondarySizing?.widthPx ?? 0}
        data-secondary-pane-id={secondaryPane?.id ?? "none"}
        data-secondary-surfaces={secondarySurfaces}
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
    );
  },
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
    hostMocks.paneShellSnapshots = [];
    hostMocks.runtimeLayout = null;
    hostMocks.fixedChromeWidthPx = null;
    hostMocks.secondaryPublication = null;
    hostMocks.openInNewPaneRequest = null;
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
    hostMocks.store.runtimeTitleByPaneId = new Map();
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

const READER_TOOLS_HIGHLIGHTS_ONLY: PaneSecondaryPublication = {
  groupId: "reader-tools",
  defaultSurfaceId: "reader-highlights",
  surfaces: [{ id: "reader-highlights", body: <div>Highlights</div> }],
};

const READER_TOOLS_WITH_DOC_CHAT: PaneSecondaryPublication = {
  groupId: "reader-tools",
  defaultSurfaceId: "reader-highlights",
  surfaces: [
    { id: "reader-highlights", body: <div>Highlights</div> },
    { id: "reader-doc-chat", body: <div>Document chat</div> },
  ],
};

const CONVERSATION_CONTEXT_PUBLICATION: PaneSecondaryPublication = {
  groupId: "conversation-context",
  defaultSurfaceId: "conversation-references",
  surfaces: [{ id: "conversation-references", body: <div>References</div> }],
};

function setPaneWithSecondary(secondary: {
  groupId: WorkspaceSecondaryGroupId;
  activeSurfaceId: WorkspaceSecondarySurfaceId;
  widthPx?: number;
  visibility?: "visible" | "collapsed";
}) {
  hostMocks.store.state = {
    primaryPaneOrder: ["pane-1"],
    primaryPanesById: {
      "pane-1": {
        id: "pane-1",
        href: "/media/media-1",
        primaryWidthPx: 640,
        attachedSecondaryPaneId: "secondary-1",
        visibility: "visible",
        history: { back: [], forward: [] },
      },
    },
    secondaryPanesById: {
      "secondary-1": {
        id: "secondary-1",
        parentPrimaryPaneId: "pane-1",
        groupId: secondary.groupId,
        activeSurfaceId: secondary.activeSurfaceId,
        widthPx: secondary.widthPx ?? 360,
        visibility: secondary.visibility ?? "visible",
      },
    },
    activePrimaryPaneId: "pane-1",
  };
}

describe("WorkspaceHost secondary publication validation", () => {
  beforeEach(() => {
    hostMocks.bodyInstanceId = 0;
    hostMocks.mountedBodyIds = [];
    hostMocks.unmountedBodyIds = [];
    hostMocks.paneShellSnapshots = [];
    hostMocks.runtimeLayout = null;
    hostMocks.fixedChromeWidthPx = null;
    hostMocks.secondaryPublication = null;
    hostMocks.openInNewPaneRequest = null;
    hostMocks.store.openPane.mockReset();
    hostMocks.store.requestSecondarySurface.mockReset();
    hostMocks.store.dropSecondaryPane.mockReset();
    hostMocks.store.setSecondarySurface.mockReset();
    hostMocks.store.runtimeTitleByPaneId = new Map();
    setPaneHref("/media/media-1");
  });

  it("does not render or expose a visible secondary without a matching publication", () => {
    setPaneWithSecondary({
      groupId: "reader-tools",
      activeSurfaceId: "reader-highlights",
    });
    hostMocks.secondaryPublication = null;

    render(<WorkspaceHost />);

    const shell = screen.getByTestId("pane-shell");
    expect(shell).toHaveAttribute("data-secondary-pane-id", "none");
    expect(shell).toHaveAttribute("data-secondary-width-px", "0");
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-secondary-id",
      "none",
    );
    expect(hostMocks.store.dropSecondaryPane).not.toHaveBeenCalled();
  });

  it("renders and exposes a visible secondary backed by a matching publication", async () => {
    setPaneWithSecondary({
      groupId: "reader-tools",
      activeSurfaceId: "reader-highlights",
    });
    hostMocks.secondaryPublication = READER_TOOLS_HIGHLIGHTS_ONLY;

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-secondary-pane-id",
        "secondary-1",
      );
    });
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-width-px",
      "360",
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-secondary-id",
      "secondary-1",
    );
    expect(hostMocks.store.dropSecondaryPane).not.toHaveBeenCalled();
  });

  it("does not clear and republish secondary or fixed chrome on unrelated host renders", async () => {
    setPaneWithSecondary({
      groupId: "reader-tools",
      activeSurfaceId: "reader-highlights",
    });
    hostMocks.secondaryPublication = READER_TOOLS_HIGHLIGHTS_ONLY;
    hostMocks.fixedChromeWidthPx = 48;

    const { rerender } = render(<WorkspaceHost />);

    await waitFor(() => {
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-secondary-surfaces",
        "reader-highlights",
      );
    });
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-fixed-chrome-width-px",
      "48",
    );

    hostMocks.paneShellSnapshots = [];
    hostMocks.store.runtimeTitleByPaneId = new Map([["pane-1", "Resolved media"]]);
    rerender(<WorkspaceHost />);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(hostMocks.paneShellSnapshots).toEqual([
      { fixedChromeWidthPx: 48, secondarySurfaces: "reader-highlights" },
    ]);
  });

  it("drops a persisted secondary when the publication group no longer matches", async () => {
    setPaneWithSecondary({
      groupId: "reader-tools",
      activeSurfaceId: "reader-highlights",
    });
    hostMocks.secondaryPublication = CONVERSATION_CONTEXT_PUBLICATION;

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.dropSecondaryPane).toHaveBeenCalledWith("secondary-1");
    });
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-pane-id",
      "none",
    );
    expect(hostMocks.store.setSecondarySurface).not.toHaveBeenCalled();
  });

  it("repairs a persisted secondary surface to the published default when the active surface is unpublished", async () => {
    setPaneWithSecondary({
      groupId: "reader-tools",
      activeSurfaceId: "reader-doc-chat",
    });
    hostMocks.secondaryPublication = READER_TOOLS_HIGHLIGHTS_ONLY;

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.setSecondarySurface).toHaveBeenCalledWith(
        "secondary-1",
        "reader-highlights",
      );
    });
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-pane-id",
      "none",
    );
    expect(hostMocks.store.dropSecondaryPane).not.toHaveBeenCalled();
  });

  it("launches a pending cross-pane secondary request once the target publishes the surface", async () => {
    hostMocks.secondaryPublication = READER_TOOLS_WITH_DOC_CHAT;
    hostMocks.openInNewPaneRequest = {
      href: "/media/media-1",
      titleHint: "Doc chat",
      surfaceId: "reader-doc-chat",
    };

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.requestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "reader-doc-chat",
      );
    });
  });

  it("discards a pending cross-pane secondary request when the target publishes without the surface", async () => {
    hostMocks.secondaryPublication = READER_TOOLS_HIGHLIGHTS_ONLY;
    hostMocks.openInNewPaneRequest = {
      href: "/media/media-1",
      titleHint: "Doc chat",
      surfaceId: "reader-doc-chat",
    };

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-secondary-surfaces",
        "reader-highlights",
      );
    });
    expect(hostMocks.store.requestSecondarySurface).not.toHaveBeenCalled();
  });
});
