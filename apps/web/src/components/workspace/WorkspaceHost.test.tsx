import type { ComponentProps, ReactNode } from "react";
import { useContext, useEffect, useMemo, useRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import type { ResourceLocatorResolution } from "@/lib/resources/resourceLocators";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import type { PaneRuntimeLayout } from "@/lib/workspace/paneSizing";
import {
  PaneFixedChromeContext,
  usePaneFixedChrome,
} from "@/components/workspace/PaneFixedChrome";
import {
  PaneSecondaryContext,
  usePaneSecondary,
} from "@/components/workspace/PaneSecondary";
import type {
  PaneFixedChromePublication,
  PanePrimaryChromePublication,
  PaneSecondaryPublication,
} from "@/lib/panes/panePublications";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import type {
  WorkspaceSecondaryActivation,
  WorkspaceSecondaryGroupId,
  WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";

const MEDIA_ID_1 = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID_2 = "22222222-2222-4222-8222-222222222222";
const MEDIA_ID_3 = "33333333-3333-4333-8333-333333333333";
const MEDIA_HREF_1 = `/media/${MEDIA_ID_1}`;
const MEDIA_HREF_2 = `/media/${MEDIA_ID_2}`;
const MEDIA_HREF_3 = `/media/${MEDIA_ID_3}`;

const hostMocks = vi.hoisted(() => ({
  bodyInstanceId: 0,
  mountedBodyIds: [] as number[],
  unmountedBodyIds: [] as number[],
  paneShellSnapshots: [] as {
    fixedChromeWidthPx: number;
    secondarySurfaces: string;
  }[],
  mobileSecondaryInputs: [] as {
    primaryPaneId: string;
    returnFocusTo?: () => HTMLElement | null;
  }[],
  useActualPaneShell: false,
  primaryChromePublicationByPaneId: new Map<
    string,
    PanePrimaryChromePublication
  >(),
  isMobile: false,
  canvasEdges: { atStart: false, atEnd: false },
  paneCanvasInputs: [] as { mode: string; paneIds: string[] }[],
  runtimeLayout: null as PaneRuntimeLayout | null,
  fixedChromeWidthPx: null as number | null,
  secondaryPublication: null as PaneSecondaryPublication | null,
  fixedChromeWidthByPaneId: new Map<string, number | null>(),
  secondaryPublicationByPaneId: new Map<
    string,
    PaneSecondaryPublication | null
  >(),
  secondaryPublisherByPaneId: new Map<
    string,
    (publication: PaneSecondaryPublication | null) => void
  >(),
  fixedChromePublisherByPaneId: new Map<
    string,
    (publication: PaneFixedChromePublication | null) => void
  >(),
  openInNewPaneRequest: null as {
    href: string;
    labelHint?: string;
    activation: WorkspaceSecondaryActivation;
  } | null,
  resolveResourceLocators: vi.fn<
    (locators: readonly unknown[]) => Promise<ResourceLocatorResolution[]>
  >(async () => []),
  store: {
    state: {
      primaryPaneOrder: ["pane-1"],
      primaryPanesById: {
        "pane-1": {
          id: "pane-1",
          href: "/media/11111111-1111-4111-8111-111111111111",
          primaryWidthPx: 640,
          attachedSecondaryPaneId: null as string | null,
          visibility: "visible" as const,
          history: { back: [], forward: [] } as {
            back: string[];
            forward: string[];
          },
        },
      } as Record<
        string,
        {
          id: string;
          href: string;
          primaryWidthPx: number;
          attachedSecondaryPaneId: string | null;
          visibility: "visible" | "minimized";
          history: { back: string[]; forward: string[] };
        }
      >,
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
    runtimeLabelByPaneId: new Map(),
    pendingSecondaryActivationByPaneId: new Map(),
    activatePane: vi.fn(),
    openPane: vi.fn(),
    acknowledgePendingSecondaryActivation: vi.fn(),
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
    publishPaneLabel: vi.fn(),
  },
}));

function mediaResourceItem(id: string): ResourceItem {
  const ref = `media:${id}`;
  return {
    ref,
    scheme: "media",
    id,
    label: "Media",
    summary: "",
    route: `/media/${id}`,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/media/${id}`,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: true,
        userLinkTarget: "direct",
        noteReferenceTarget: true,
      },
      attachable: true,
      chatSubject: "readable",
      readable: "media",
      inspectable: "media_document_map",
      citableResultType: "media",
      citationOutputSource: false,
      appSearchScope: true,
      conversationSearchScope: true,
      promptRender: "label",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: {},
  };
}

function mediaRoute(href: string) {
  const url = new URL(href, "http://localhost");
  const id = url.pathname.split("/")[2] ?? "";
  return {
    id: "media",
    pathname: url.pathname,
    params: { id },
    defaultLabel: "Media",
    labelMode: "dynamic",
    header: { kind: "resource", pendingLabel: "Loading media…" } as const,
    definition: {
      id: "media",
      bodyMode: "document",
      maxWidthPx: 2400,
      allowsIntrinsicPrimaryWidth: true,
    },
  };
}

function TestPaneBody() {
  const instanceId = useRef(++hostMocks.bodyInstanceId);
  const paneRuntime = usePaneRuntime();
  const publishSecondary = useContext(PaneSecondaryContext);
  const publishFixedChrome = useContext(PaneFixedChromeContext);
  usePanePrimaryChrome(
    paneRuntime
      ? (hostMocks.primaryChromePublicationByPaneId.get(paneRuntime.paneId) ??
          null)
      : null,
  );
  const didOpenInNewPaneRef = useRef(false);
  const fixedChromeWidthPx = paneRuntime
    ? (hostMocks.fixedChromeWidthByPaneId.get(paneRuntime.paneId) ??
      hostMocks.fixedChromeWidthPx)
    : hostMocks.fixedChromeWidthPx;
  const fixedChromePublication = useMemo<PaneFixedChromePublication | null>(
    () =>
      fixedChromeWidthPx === null
        ? null
        : {
            id: "reader-document-map-overview-rail",
            widthPx: fixedChromeWidthPx,
            body: <div>Fixed chrome</div>,
          },
    [fixedChromeWidthPx],
  );
  usePaneFixedChrome(fixedChromePublication);
  const secondaryPublication = paneRuntime
    ? (hostMocks.secondaryPublicationByPaneId.get(paneRuntime.paneId) ??
      hostMocks.secondaryPublication)
    : hostMocks.secondaryPublication;
  usePaneSecondary(secondaryPublication);
  useEffect(() => {
    if (!paneRuntime || !publishSecondary || !publishFixedChrome) return;
    hostMocks.secondaryPublisherByPaneId.set(
      paneRuntime.paneId,
      publishSecondary,
    );
    hostMocks.fixedChromePublisherByPaneId.set(
      paneRuntime.paneId,
      publishFixedChrome,
    );
  }, [paneRuntime, publishFixedChrome, publishSecondary]);
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
    paneRuntime.openInNewPane(
      request.href,
      request.labelHint,
      request.activation,
    );
  }, [paneRuntime]);
  return (
    <div
      data-testid="route-body"
      data-instance-id={instanceId.current}
      data-runtime-pane-id={paneRuntime?.paneId ?? "none"}
      data-runtime-secondary-id={paneRuntime?.secondaryPane?.id ?? "none"}
      data-runtime-resource-ref={paneRuntime?.resourceRef ?? "none"}
      data-runtime-resource-status={paneRuntime?.resourceStatus ?? "none"}
      data-runtime-dossier-activation={
        paneRuntime?.secondaryActivation?.kind ?? "none"
      }
      data-runtime-dossier-revision={
        paneRuntime?.secondaryActivation?.kind === "DossierRevision"
          ? paneRuntime.secondaryActivation.revisionRef
          : "none"
      }
    >
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- justify-eslint-override: test fixture uses a plain anchor so WorkspaceHost link interception is the behavior under test */}
      <a href="/authors/body-author" data-pane-label-hint="Body Author">
        Body Author
      </a>
      <button
        type="button"
        onClick={(event) =>
          paneRuntime?.requestSecondarySurface("resource-evidence", {
            returnFocusTo: event.currentTarget,
          })
        }
      >
        Open Companion
      </button>
      <button
        type="button"
        onClick={() => paneRuntime?.acknowledgeSecondaryActivation()}
      >
        Acknowledge secondary activation
      </button>
    </div>
  );
}

vi.mock("@/lib/panes/paneRenderRegistry", () => ({
  renderPane: () => <TestPaneBody />,
  preloadPane: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/workspace/store", async () => {
  // Use the real route-identity resolver so the descriptor routeKey matches
  // the key the host computes via resolvePaneRouteIdentity for pending
  // cross-pane secondary requests. Mocking it to a different shape would let the
  // pending-request tests pass for the wrong reason (key mismatch, not policy).
  const { resolvePaneRouteIdentity } = await import("@/lib/panes/paneIdentity");
  return {
    useWorkspaceHostStore: () => hostMocks.store,
    resolvePaneRouteKey: (href: string) =>
      resolvePaneRouteIdentity(href).routeKey,
    resolveWorkspacePaneLabel: (pane: { href: string }) => {
      const route = mediaRoute(pane.href);
      return {
        routeKey: resolvePaneRouteIdentity(pane.href).routeKey,
        route,
        label: "Media",
        labelState: "pending",
        labelSource: "fallback",
      };
    },
  };
});

vi.mock("@/components/workspace/PaneShell", async () => {
  const { default: ActualPaneShell } = await vi.importActual<
    typeof import("@/components/workspace/PaneShell")
  >("@/components/workspace/PaneShell");
  return {
    default: (props: ComponentProps<typeof ActualPaneShell>) => {
      if (hostMocks.useActualPaneShell) {
        return <ActualPaneShell {...props} />;
      }
      const {
        children,
        sizing,
        secondaryPane,
        secondarySizing,
        secondaryPublication,
        fixedChromePublication,
        navigation,
        isMobile,
        paneId,
        routeKey,
        routeHeader,
        label,
        labelPending,
      } = props;
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
          data-secondary-active-surface={
            secondaryPane?.activeSurfaceId ?? "none"
          }
          data-secondary-surfaces={secondarySurfaces}
          data-mobile={isMobile ? "true" : "false"}
          data-pane-id-contract={paneId}
          data-route-key={routeKey}
          data-route-header-kind={routeHeader.kind}
          data-label={label}
          data-label-pending={labelPending ? "true" : "false"}
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
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- justify-eslint-override: mock pane chrome uses a plain anchor so WorkspaceHost link interception is the behavior under test */}
            <a href="/authors/author-1" data-pane-label-hint="Chrome Author">
              Chrome Author
            </a>
          </nav>
          {children}
        </section>
      );
    },
  };
});

vi.mock("@/components/workspace/WorkspacePaneStrip", () => ({
  default: () => <div data-testid="workspace-pane-strip" />,
}));

vi.mock("@/components/workspace/MobileSecondaryPaneHost", async () => {
  const { secondaryPublicationIncludesSurface } = await vi.importActual<
    typeof import("@/lib/panes/panePublications")
  >("@/lib/panes/panePublications");
  return {
    default: ({
      primaryPaneId,
      secondary,
      publication,
      returnFocusTo,
    }: {
      primaryPaneId: string;
      secondary: {
        groupId: WorkspaceSecondaryGroupId;
        activeSurfaceId: WorkspaceSecondarySurfaceId;
        visibility: "visible" | "collapsed";
      } | null;
      publication: PaneSecondaryPublication | null;
      returnFocusTo?: () => HTMLElement | null;
    }) => {
      hostMocks.mobileSecondaryInputs.push({ primaryPaneId, returnFocusTo });
      if (
        secondary?.visibility !== "visible" ||
        !publication ||
        secondary.groupId !== publication.groupId ||
        !secondaryPublicationIncludesSurface(
          publication,
          secondary.activeSurfaceId,
        )
      ) {
        return null;
      }
      return <div data-testid="mobile-secondary-host" />;
    },
  };
});

vi.mock("@/components/workspace/usePaneCanvas", () => ({
  usePaneCanvas: (input: { mode: string; paneIds: string[] }) => {
    hostMocks.paneCanvasInputs.push(input);
    return {
      canvasRef: { current: null },
      onWheel: vi.fn(),
      edges: hostMocks.canvasEdges,
      inViewPaneIds: new Set(["pane-1"]),
      handleChromeMouseDown: vi.fn(),
      scrollPaneIntoView: vi.fn(),
    };
  },
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => hostMocks.isMobile,
}));

vi.mock("@/lib/keybindings", () => ({
  matchesKeyEvent: () => false,
}));

vi.mock("@/lib/keybindingsProvider", () => ({
  useKeybindings: () => ({}),
}));

vi.mock("@/lib/renderEnvironment/provider", () => ({
  RenderEnvironmentProvider: ({ children }: { children: ReactNode }) =>
    children,
  useRenderEnvironment: () => ({
    androidShell: false,
    platform: "other",
    displayLocale: "en-US",
    displayTimeZone: "UTC",
    currentInstant: "2026-06-03T12:00:00.000Z",
    currentLocalDate: "2026-06-03",
    initialViewport: "desktop",
  }),
  useAndroidShell: () => false,
  useViewportState: () => ({
    kind: "desktop",
    isMobile: false,
    hydrated: true,
  }),
}));

vi.mock("@/lib/workspace/telemetry", () => ({
  emitWorkspaceTelemetry: vi.fn(),
}));

vi.mock("@/lib/resources/resourceLocators", () => ({
  resolveResourceLocators: (locators: readonly unknown[]) =>
    hostMocks.resolveResourceLocators(locators),
}));

import WorkspaceHost from "@/components/workspace/WorkspaceHost";

function setPaneHref(
  href: string,
  history: { back: string[]; forward: string[] } = { back: [], forward: [] },
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

function setTwoPaneHrefs(firstHref: string, secondHref: string) {
  hostMocks.store.state = {
    primaryPaneOrder: ["pane-1", "pane-2"],
    primaryPanesById: {
      "pane-1": {
        id: "pane-1",
        href: firstHref,
        primaryWidthPx: 640,
        attachedSecondaryPaneId: null,
        visibility: "visible",
        history: { back: [], forward: [] },
      },
      "pane-2": {
        id: "pane-2",
        href: secondHref,
        primaryWidthPx: 640,
        attachedSecondaryPaneId: null,
        visibility: "visible",
        history: { back: [], forward: [] },
      },
    },
    secondaryPanesById: {},
    activePrimaryPaneId: "pane-2",
  };
}

describe("WorkspaceHost pane route lifecycle", () => {
  beforeEach(() => {
    hostMocks.bodyInstanceId = 0;
    hostMocks.mountedBodyIds = [];
    hostMocks.unmountedBodyIds = [];
    hostMocks.paneShellSnapshots = [];
    hostMocks.mobileSecondaryInputs = [];
    hostMocks.useActualPaneShell = false;
    hostMocks.primaryChromePublicationByPaneId = new Map();
    hostMocks.isMobile = false;
    hostMocks.canvasEdges = { atStart: false, atEnd: false };
    hostMocks.paneCanvasInputs = [];
    hostMocks.runtimeLayout = null;
    hostMocks.fixedChromeWidthPx = null;
    hostMocks.secondaryPublication = null;
    hostMocks.fixedChromeWidthByPaneId = new Map();
    hostMocks.secondaryPublicationByPaneId = new Map();
    hostMocks.secondaryPublisherByPaneId = new Map();
    hostMocks.fixedChromePublisherByPaneId = new Map();
    hostMocks.openInNewPaneRequest = null;
    hostMocks.resolveResourceLocators.mockReset();
    hostMocks.resolveResourceLocators.mockResolvedValue([]);
    hostMocks.store.activatePane.mockReset();
    hostMocks.store.openPane.mockReset();
    hostMocks.store.acknowledgePendingSecondaryActivation.mockReset();
    hostMocks.store.pendingSecondaryActivationByPaneId = new Map();
    hostMocks.store.acknowledgePendingSecondaryActivation.mockImplementation(
      (paneId: string) => {
        hostMocks.store.pendingSecondaryActivationByPaneId.delete(paneId);
      },
    );
    hostMocks.store.navigatePane.mockReset();
    hostMocks.store.goBackPane.mockReset();
    hostMocks.store.goForwardPane.mockReset();
    hostMocks.store.resizePrimaryPane.mockReset();
    hostMocks.store.requestSecondarySurface.mockReset();
    hostMocks.store.closeSecondaryPane.mockReset();
    hostMocks.store.dropSecondaryPane.mockReset();
    hostMocks.store.setSecondarySurface.mockReset();
    hostMocks.store.resizeSecondaryPane.mockReset();
    hostMocks.store.runtimeLabelByPaneId = new Map();
    setPaneHref(MEDIA_HREF_1);
  });

  it("preserves the route body for same-resource location changes", () => {
    const { rerender } = render(<WorkspaceHost />);
    const firstInstance = screen.getByTestId("route-body").dataset.instanceId;

    setPaneHref(`${MEDIA_HREF_1}?loc=chapter-2`);
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-instance-id",
      firstInstance,
    );
    expect(hostMocks.mountedBodyIds).toHaveLength(1);
    expect(hostMocks.unmountedBodyIds).toEqual([]);
  });

  it("passes the resolved route header and pane label contract to PaneShell", () => {
    render(<WorkspaceHost />);

    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-pane-id-contract",
      "pane-1",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-route-header-kind",
      "resource",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-label",
      "Media",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-label-pending",
      "true",
    );
    expect(
      screen.getByTestId("pane-shell").getAttribute("data-route-key"),
    ).toContain(MEDIA_ID_1);
  });

  it("contains an actual current route/header mismatch to its pane", async () => {
    setTwoPaneHrefs(MEDIA_HREF_1, MEDIA_HREF_2);
    hostMocks.useActualPaneShell = true;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const view = render(
        <MobileChromeProvider>
          <WorkspaceHost />
        </MobileChromeProvider>,
      );
      const initialBoundary = screen.getByTestId("pane-error-boundary-pane-1");
      const initialWidth = initialBoundary.getBoundingClientRect().width;
      expect(initialWidth).toBeGreaterThan(0);

      hostMocks.primaryChromePublicationByPaneId.set("pane-1", {
        header: {
          kind: "section",
          folio: { kind: "none" },
          pending: false,
        },
      });
      setTwoPaneHrefs(MEDIA_HREF_3, MEDIA_HREF_2);
      view.rerender(
        <MobileChromeProvider>
          <WorkspaceHost />
        </MobileChromeProvider>,
      );

      expect(
        await screen.findByText(
          "This pane failed to render. Close it and retry.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("region", { name: "Pane failed to render" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-pane-id",
        "pane-2",
      );
      expect(
        screen.getByRole("region", { name: "Loading media…" }),
      ).toContainElement(screen.getByTestId("route-body"));
      expect(screen.getByTestId("workspace-pane-strip")).toBeInTheDocument();
      const failedBoundary = screen.getByTestId("pane-error-boundary-pane-1");
      expect(failedBoundary.getBoundingClientRect().width).toBe(initialWidth);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("contains an invalid current secondary publication to its pane", async () => {
    setTwoPaneHrefs(MEDIA_HREF_1, MEDIA_HREF_2);
    hostMocks.secondaryPublicationByPaneId.set("pane-1", {
      groupId: "resource-inspector",
      defaultSurfaceId: "resource-contents",
      surfaces: [],
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      render(<WorkspaceHost />);

      expect(
        await screen.findByRole("region", { name: "Pane failed to render" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-pane-id",
        "pane-2",
      );
      expect(screen.getByTestId("workspace-pane-strip")).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("contains an invalid current fixed-chrome publication to its pane", async () => {
    setTwoPaneHrefs(MEDIA_HREF_1, MEDIA_HREF_2);
    hostMocks.fixedChromeWidthByPaneId.set("pane-1", Number.NaN);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      render(<WorkspaceHost />);

      expect(
        await screen.findByRole("region", { name: "Pane failed to render" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-pane-id",
        "pane-2",
      );
      expect(screen.getByTestId("workspace-pane-strip")).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("ignores stale invalid publications and stale cleanup before normalization", async () => {
    const view = render(<WorkspaceHost />);
    await waitFor(() => {
      expect(hostMocks.secondaryPublisherByPaneId.get("pane-1")).toBeDefined();
      expect(hostMocks.fixedChromePublisherByPaneId.get("pane-1")).toBeDefined();
    });
    const staleSecondaryPublisher =
      hostMocks.secondaryPublisherByPaneId.get("pane-1");
    const staleFixedChromePublisher =
      hostMocks.fixedChromePublisherByPaneId.get("pane-1");
    if (!staleSecondaryPublisher || !staleFixedChromePublisher) {
      throw new Error("Expected route-scoped publication callbacks");
    }

    hostMocks.secondaryPublication = READER_TOOLS_EVIDENCE_ONLY;
    hostMocks.fixedChromeWidthPx = 48;
    setPaneHref(MEDIA_HREF_2);
    view.rerender(<WorkspaceHost />);
    await waitFor(() =>
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-secondary-surfaces",
        "resource-evidence",
      ),
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-fixed-chrome-width-px",
      "48",
    );

    expect(() => {
      act(() => {
        staleSecondaryPublisher({
          groupId: "resource-inspector",
          defaultSurfaceId: "resource-contents",
          surfaces: [],
        });
        staleFixedChromePublisher({
          id: "reader-document-map-overview-rail",
          widthPx: Number.NaN,
          body: <div>Stale invalid fixed chrome</div>,
        });
        staleSecondaryPublisher(null);
        staleFixedChromePublisher(null);
      });
    }).not.toThrow();

    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-surfaces",
      "resource-evidence",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-fixed-chrome-width-px",
      "48",
    );
  });

  it("uses desktop canvas mode and renders desktop edge fades", () => {
    hostMocks.canvasEdges = { atStart: true, atEnd: true };

    render(<WorkspaceHost />);

    expect(hostMocks.paneCanvasInputs[0]).toEqual({
      mode: "desktop",
      paneIds: ["pane-1"],
    });
    expect(screen.getByTestId("workspace-pane-strip")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-edge-fade-start")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-edge-fade-end")).toBeInTheDocument();
  });

  it("remounts the route body when the resource changes", () => {
    const { rerender } = render(<WorkspaceHost />);
    const firstInstance = screen.getByTestId("route-body").dataset.instanceId;

    setPaneHref(MEDIA_HREF_2);
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("route-body")).not.toHaveAttribute(
      "data-instance-id",
      firstInstance,
    );
    expect(hostMocks.mountedBodyIds).toHaveLength(2);
    expect(hostMocks.unmountedBodyIds).toEqual([Number(firstInstance)]);
  });

  it("publishes resolved route resources through the pane runtime", async () => {
    hostMocks.resolveResourceLocators.mockResolvedValueOnce([
      {
        locator: { kind: "resource_ref", ref: `media:${MEDIA_ID_1}` },
        resourceItem: mediaResourceItem(MEDIA_ID_1),
        canonicalHref: MEDIA_HREF_1,
      },
    ]);

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.resolveResourceLocators).toHaveBeenCalledWith([
        { kind: "resource_ref", ref: `media:${MEDIA_ID_1}` },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-resource-ref",
        `media:${MEDIA_ID_1}`,
      );
    });
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-resource-status",
      "ready",
    );
  });

  it("auto-resizes a visible pane when runtime content raises the minimum width", async () => {
    hostMocks.runtimeLayout = {
      primaryWidth: { kind: "intrinsic", widthPx: 900 },
    };

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.resizePrimaryPane).toHaveBeenCalledWith(
        "pane-1",
        900,
      );
    });
  });

  it("ignores stale runtime layout records after the pane route changes", async () => {
    hostMocks.runtimeLayout = {
      primaryWidth: { kind: "intrinsic", widthPx: 900 },
    };
    const { rerender } = render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.resizePrimaryPane).toHaveBeenCalledWith(
        "pane-1",
        900,
      );
    });

    hostMocks.store.resizePrimaryPane.mockClear();
    hostMocks.runtimeLayout = null;
    setPaneHref(MEDIA_HREF_2);
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-min-width-px",
      "684",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-fixed-chrome-width-px",
      "0",
    );
    expect(hostMocks.store.resizePrimaryPane).toHaveBeenCalledWith(
      "pane-1",
      684,
    );
  });

  it("routes pane chrome internal links through the current pane", () => {
    render(<WorkspaceHost />);

    fireEvent.click(screen.getByRole("link", { name: "Chrome Author" }));

    expect(hostMocks.store.navigatePane).toHaveBeenCalledWith(
      "pane-1",
      "/authors/author-1",
      { labelHint: "Chrome Author" },
    );
    expect(hostMocks.store.openPane).not.toHaveBeenCalled();
  });

  it("routes header Back and Forward through the target pane only", () => {
    setPaneHref(MEDIA_HREF_2, {
      back: [MEDIA_HREF_1],
      forward: [MEDIA_HREF_3],
    });

    render(<WorkspaceHost />);

    fireEvent.click(
      screen.getByRole("button", { name: "Go back in this pane" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Go forward in this pane" }),
    );

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
      { labelHint: "Body Author" },
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
      labelHint: "Chrome Author",
    });
    expect(hostMocks.store.navigatePane).not.toHaveBeenCalled();
  });
});

const READER_TOOLS_EVIDENCE_ONLY: PaneSecondaryPublication = {
  groupId: "resource-inspector",
  defaultSurfaceId: "resource-evidence",
  surfaces: [{ id: "resource-evidence", body: <div>Evidence</div> }],
};

const READER_TOOLS_HIGHLIGHTS_ONLY = READER_TOOLS_EVIDENCE_ONLY;

const READER_TOOLS_WITH_DOC_CHAT: PaneSecondaryPublication = {
  groupId: "resource-inspector",
  defaultSurfaceId: "resource-evidence",
  surfaces: [
    { id: "resource-contents", body: <div>Contents</div> },
    { id: "resource-evidence", body: <div>Evidence</div> },
  ],
};

const RESOURCE_DOSSIER_PUBLICATION: PaneSecondaryPublication = {
  groupId: "resource-inspector",
  defaultSurfaceId: "resource-dossier",
  surfaces: [{ id: "resource-dossier", body: <div>Dossier</div> }],
};

const CONVERSATION_CONTEXT_PUBLICATION: PaneSecondaryPublication = {
  groupId: "resource-inspector",
  defaultSurfaceId: "resource-context",
  surfaces: [{ id: "resource-context", body: <div>References</div> }],
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
        href: MEDIA_HREF_1,
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

function setSecondaryPaneHref(href: string) {
  hostMocks.store.state = {
    ...hostMocks.store.state,
    primaryPanesById: {
      ...hostMocks.store.state.primaryPanesById,
      "pane-1": {
        ...hostMocks.store.state.primaryPanesById["pane-1"]!,
        href,
      },
    },
  };
}

describe("WorkspaceHost secondary publication validation", () => {
  beforeEach(() => {
    hostMocks.bodyInstanceId = 0;
    hostMocks.mountedBodyIds = [];
    hostMocks.unmountedBodyIds = [];
    hostMocks.paneShellSnapshots = [];
    hostMocks.mobileSecondaryInputs = [];
    hostMocks.useActualPaneShell = false;
    hostMocks.primaryChromePublicationByPaneId = new Map();
    hostMocks.isMobile = false;
    hostMocks.canvasEdges = { atStart: false, atEnd: false };
    hostMocks.paneCanvasInputs = [];
    hostMocks.runtimeLayout = null;
    hostMocks.fixedChromeWidthPx = null;
    hostMocks.secondaryPublication = null;
    hostMocks.fixedChromeWidthByPaneId = new Map();
    hostMocks.secondaryPublicationByPaneId = new Map();
    hostMocks.secondaryPublisherByPaneId = new Map();
    hostMocks.fixedChromePublisherByPaneId = new Map();
    hostMocks.openInNewPaneRequest = null;
    hostMocks.store.openPane.mockReset();
    hostMocks.store.acknowledgePendingSecondaryActivation.mockReset();
    hostMocks.store.pendingSecondaryActivationByPaneId = new Map();
    hostMocks.store.acknowledgePendingSecondaryActivation.mockImplementation(
      (paneId: string) => {
        hostMocks.store.pendingSecondaryActivationByPaneId.delete(paneId);
      },
    );
    hostMocks.store.requestSecondarySurface.mockReset();
    hostMocks.store.dropSecondaryPane.mockReset();
    hostMocks.store.setSecondarySurface.mockReset();
    hostMocks.store.runtimeLabelByPaneId = new Map();
    setPaneHref(MEDIA_HREF_1);
  });

  it("does not render a visible secondary without a matching publication", () => {
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
    });
    hostMocks.secondaryPublication = null;

    render(<WorkspaceHost />);

    const shell = screen.getByTestId("pane-shell");
    expect(shell).toHaveAttribute("data-secondary-pane-id", "none");
    expect(shell).toHaveAttribute("data-secondary-width-px", "0");
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-secondary-id",
      "secondary-1",
    );
    expect(hostMocks.store.dropSecondaryPane).not.toHaveBeenCalled();
  });

  it("renders and exposes a visible secondary backed by a matching publication", async () => {
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
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

  it("republishes secondary and fixed chrome when a same-resource route instance changes", async () => {
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
    });
    hostMocks.secondaryPublication = READER_TOOLS_HIGHLIGHTS_ONLY;
    hostMocks.fixedChromeWidthPx = 48;
    const { rerender } = render(<WorkspaceHost />);

    await waitFor(() => {
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-secondary-pane-id",
        "secondary-1",
      );
    });

    setSecondaryPaneHref(`${MEDIA_HREF_1}?loc=chapter-2`);
    rerender(<WorkspaceHost />);

    await waitFor(() => {
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-secondary-pane-id",
        "secondary-1",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-fixed-chrome-width-px",
        "48",
      );
    });
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-secondary-id",
      "secondary-1",
    );
  });

  it("keeps secondary runtime state during the publication gap for a same-resource route instance", async () => {
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
    });
    hostMocks.secondaryPublication = READER_TOOLS_HIGHLIGHTS_ONLY;
    const { rerender } = render(<WorkspaceHost />);

    await waitFor(() => {
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-secondary-pane-id",
        "secondary-1",
      );
    });

    hostMocks.secondaryPublication = null;
    setSecondaryPaneHref(`${MEDIA_HREF_1}?loc=chapter-2`);
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-pane-id",
      "none",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-surfaces",
      "none",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-width-px",
      "0",
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-secondary-id",
      "secondary-1",
    );
  });

  it("does not clear and republish secondary or fixed chrome on unrelated host renders", async () => {
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
    });
    hostMocks.secondaryPublication = READER_TOOLS_HIGHLIGHTS_ONLY;
    hostMocks.fixedChromeWidthPx = 48;

    const { rerender } = render(<WorkspaceHost />);

    await waitFor(() => {
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-secondary-surfaces",
        "resource-evidence",
      );
    });
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-fixed-chrome-width-px",
      "48",
    );

    hostMocks.paneShellSnapshots = [];
    hostMocks.store.runtimeLabelByPaneId = new Map([
      [
        "pane-1",
        {
          label: "Resolved media",
          source: "runtime",
          routeKey: "media:/media/11111111-1111-4111-8111-111111111111",
        },
      ],
    ]);
    rerender(<WorkspaceHost />);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(hostMocks.paneShellSnapshots).toEqual([
      { fixedChromeWidthPx: 48, secondarySurfaces: "resource-evidence" },
    ]);
  });

  it("renders the new subject default while repairing a same-group stale surface", async () => {
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
    });
    hostMocks.secondaryPublication = CONVERSATION_CONTEXT_PUBLICATION;

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.setSecondarySurface).toHaveBeenCalledWith(
        "secondary-1",
        "resource-context",
      );
    });
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-pane-id",
      "secondary-1",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-active-surface",
      "resource-context",
    );
    expect(hostMocks.store.dropSecondaryPane).not.toHaveBeenCalled();
  });

  it("repairs a persisted secondary surface to the published default when the active surface is unpublished", async () => {
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-contents",
    });
    hostMocks.secondaryPublication = READER_TOOLS_EVIDENCE_ONLY;

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.setSecondarySurface).toHaveBeenCalledWith(
        "secondary-1",
        "resource-evidence",
      );
    });
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-pane-id",
      "secondary-1",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-active-surface",
      "resource-evidence",
    );
    expect(hostMocks.store.dropSecondaryPane).not.toHaveBeenCalled();
  });

  it("publishes a pane-runtime Dossier activation through the workspace store", async () => {
    const activation = {
      kind: "DossierRevision",
      surfaceId: "resource-dossier",
      revisionRef:
        "artifact_revision:44444444-4444-4444-8444-444444444444",
    } as const;
    hostMocks.openInNewPaneRequest = {
      href: MEDIA_HREF_1,
      labelHint: "Dossier",
      activation,
    };

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.openPane).toHaveBeenCalledWith({
        href: MEDIA_HREF_1,
        openerPaneId: "pane-1",
        activate: true,
        labelHint: "Dossier",
        secondaryActivation: activation,
      });
    });
  });

  it("launches a pending cross-pane secondary request once the target publishes the surface", async () => {
    hostMocks.secondaryPublication = READER_TOOLS_WITH_DOC_CHAT;
    const activation = { kind: "Surface", surfaceId: "resource-evidence" } as const;
    hostMocks.store.pendingSecondaryActivationByPaneId = new Map([
      ["pane-1", { routeKey: `media:${MEDIA_HREF_1}`, activation }],
    ]);

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.requestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "resource-evidence",
      );
      expect(
        hostMocks.store.acknowledgePendingSecondaryActivation,
      ).toHaveBeenCalledWith("pane-1", `media:${MEDIA_HREF_1}`, activation);
    });
  });

  it("discards a pending cross-pane secondary request when the target publishes without the surface", async () => {
    hostMocks.secondaryPublication = READER_TOOLS_EVIDENCE_ONLY;
    const activation = { kind: "Surface", surfaceId: "resource-contents" } as const;
    hostMocks.store.pendingSecondaryActivationByPaneId = new Map([
      ["pane-1", { routeKey: `media:${MEDIA_HREF_1}`, activation }],
    ]);

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(screen.getByTestId("pane-shell")).toHaveAttribute(
        "data-secondary-surfaces",
        "resource-evidence",
      );
    });
    expect(hostMocks.store.requestSecondarySurface).not.toHaveBeenCalled();
    expect(
      hostMocks.store.acknowledgePendingSecondaryActivation,
    ).toHaveBeenCalledWith("pane-1", `media:${MEDIA_HREF_1}`, activation);
  });

  it("delivers and acknowledges an exact Dossier revision inside the target pane runtime", async () => {
    const revisionRef =
      "artifact_revision:44444444-4444-4444-8444-444444444444";
    hostMocks.secondaryPublication = RESOURCE_DOSSIER_PUBLICATION;
    const activation = {
        kind: "DossierRevision",
        surfaceId: "resource-dossier",
        revisionRef,
      } as const;
    hostMocks.store.pendingSecondaryActivationByPaneId = new Map([
      ["pane-1", { routeKey: `media:${MEDIA_HREF_1}`, activation }],
    ]);

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.requestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "resource-dossier",
      );
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-dossier-revision",
        revisionRef,
      );
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Acknowledge secondary activation",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-dossier-revision",
        "none",
      );
    });
  });

  it("delivers and acknowledges the canonical current Dossier for an artifact head", async () => {
    hostMocks.secondaryPublication = RESOURCE_DOSSIER_PUBLICATION;
    const activation = {
        kind: "DossierCurrent",
        surfaceId: "resource-dossier",
      } as const;
    hostMocks.store.pendingSecondaryActivationByPaneId = new Map([
      ["pane-1", { routeKey: `media:${MEDIA_HREF_1}`, activation }],
    ]);

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.requestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "resource-dossier",
      );
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-dossier-activation",
        "DossierCurrent",
      );
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Acknowledge secondary activation",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-dossier-activation",
        "none",
      );
    });
  });

  it("uses mobile canvas mode and mobile secondary sheet without desktop edge chrome", () => {
    hostMocks.isMobile = true;
    hostMocks.canvasEdges = { atStart: true, atEnd: true };
    hostMocks.fixedChromeWidthPx = 48;
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
    });
    hostMocks.secondaryPublication = READER_TOOLS_HIGHLIGHTS_ONLY;

    render(<WorkspaceHost />);

    expect(hostMocks.paneCanvasInputs[0]).toEqual({
      mode: "disabled",
      paneIds: ["pane-1"],
    });
    expect(screen.queryByTestId("workspace-pane-strip")).toBeNull();
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-mobile",
      "true",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-fixed-chrome-width-px",
      "0",
    );
    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-secondary-width-px",
      "0",
    );
    expect(screen.getByTestId("mobile-secondary-host")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-edge-fade-start")).toBeNull();
    expect(screen.queryByTestId("workspace-edge-fade-end")).toBeNull();
  });

  it("passes the pane-scoped mobile secondary return-focus target explicitly", async () => {
    hostMocks.isMobile = true;
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
    });
    hostMocks.secondaryPublication = READER_TOOLS_HIGHLIGHTS_ONLY;

    render(<WorkspaceHost />);

    await screen.findByTestId("mobile-secondary-host");
    const trigger = screen.getByRole("button", { name: "Open Companion" });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(hostMocks.store.requestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "resource-evidence",
      );
    });
    const mobileInput = hostMocks.mobileSecondaryInputs.at(-1);
    expect(mobileInput?.primaryPaneId).toBe("pane-1");
    expect(mobileInput?.returnFocusTo?.()).toBe(trigger);
  });
});
