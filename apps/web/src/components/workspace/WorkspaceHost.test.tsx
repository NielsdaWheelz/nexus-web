import type { ComponentProps, ReactNode } from "react";
import { useContext, useEffect, useMemo, useRef } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import type { ResourceLocatorResolution } from "@/lib/resources/resourceLocators";
import { usePaneRouter, usePaneRuntime } from "@/lib/panes/paneRuntime";
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
import type { PaneEntryDelivery } from "@/lib/workspace/targetActivation";
import {
  assumePaneVisitId,
  type PaneVisit,
  type WorkspacePaneHistory,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import MobilePaneBar from "@/components/appnav/MobilePaneBar";

const LIBRARY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PODCAST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_PODCAST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEDIA_ID_1 = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID_2 = "22222222-2222-4222-8222-222222222222";
const MEDIA_ID_3 = "33333333-3333-4333-8333-333333333333";
const MEDIA_HREF_1 = `/media/${MEDIA_ID_1}`;
const MEDIA_HREF_2 = `/media/${MEDIA_ID_2}`;
const MEDIA_HREF_3 = `/media/${MEDIA_ID_3}`;
let nextVisitIndex = 1;

function paneVisit(href: string): PaneVisit {
  const id = assumePaneVisitId(
    `00000000-0000-4000-8000-${String(nextVisitIndex).padStart(12, "0")}`,
  );
  nextVisitIndex += 1;
  return { id, href };
}

const hostMocks = vi.hoisted(() => ({
  bodyInstanceId: 0,
  bodyRenderCountByPaneId: new Map<string, number>(),
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
  matchesKeyEvent: vi.fn(),
  keybindings: { "Pane.Search": "Meta+f" } as Record<string, string>,
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
  targetActivationRequest: null as {
    href: string;
    labelHint?: string;
    activation: WorkspaceSecondaryActivation;
  } | null,
  resolveResourceLocators: vi.fn<
    (locators: readonly unknown[]) => Promise<ResourceLocatorResolution[]>
  >(async () => []),
  store: {
    state: null as unknown as WorkspaceState,
    workspacePrimaryMetrics: {
      primaryMinWidthPx: 684,
      primaryDefaultWidthPx: 684,
    },
    runtimeLabelByPaneId: new Map(),
    pendingSecondaryActivationByPaneId: new Map(),
    pendingPaneEntryDeliveryByPaneId: new Map<string, PaneEntryDelivery>(),
    cancelledPaneEntryActivationIds: new Set<string>(),
    activatePane: vi.fn(),
    activateWorkspaceTarget: vi.fn(),
    acknowledgePendingSecondaryActivation: vi.fn(),
    acknowledgePaneEntryDelivery: vi.fn(),
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
    publishPaneAliases: vi.fn(),
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
      sharing: "ResourceGrants",
      libraryPlacement: "ManageEntries",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: {},
  };
}

function libraryResourceItem(id: string): ResourceItem {
  const ref = `library:${id}`;
  return {
    ...mediaResourceItem(id),
    ref,
    scheme: "library",
    route: `/libraries/${id}`,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/libraries/${id}`,
      unresolvedReason: null,
    },
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
      returnMemento: { kind: "Excluded", owner: "Reader" },
      maxWidthPx: 2400,
      allowsIntrinsicPrimaryWidth: true,
    },
  };
}

function routeForHostTest(href: string) {
  const resolvedRoute = resolvePaneRouteModel(href);
  if (
    resolvedRoute.id === "library" ||
    resolvedRoute.id === "podcasts" ||
    resolvedRoute.id === "podcastDetail"
  ) {
    return resolvedRoute;
  }
  const route = mediaRoute(href);
  switch (route.pathname) {
    case "/libraries":
      return {
        ...route,
        id: "libraries",
        defaultLabel: "Libraries",
        labelMode: "static",
        header: { kind: "section" } as const,
        definition: {
          ...route.definition,
          id: "libraries",
          bodyMode: "standard",
          returnMemento: { kind: "ShellScroll" } as const,
        },
      };
    case "/stats":
      return {
        ...route,
        id: "stats",
        defaultLabel: "Stats",
        labelMode: "static",
        header: { kind: "section" } as const,
        definition: {
          ...route.definition,
          id: "stats",
          bodyMode: "standard",
          queryNavigation: "in-place" as const,
          returnMemento: { kind: "ShellScroll" } as const,
        },
      };
    case "/atlas":
      return {
        ...route,
        id: "atlas",
        defaultLabel: "Atlas",
        labelMode: "static",
        header: { kind: "section" } as const,
        definition: {
          ...route.definition,
          id: "atlas",
          bodyMode: "document",
          returnMemento: { kind: "NoVerticalScroll" } as const,
        },
      };
    case "/conversations/new":
      return {
        ...route,
        id: "conversationNew",
        defaultLabel: "New chat",
        labelMode: "static",
        header: { kind: "section" } as const,
        definition: {
          ...route.definition,
          id: "conversationNew",
          bodyMode: "contained",
          returnMemento: { kind: "Excluded", owner: "Chat" } as const,
        },
      };
    default:
      return route;
  }
}

function TestPaneBody() {
  const instanceId = useRef(++hostMocks.bodyInstanceId);
  const paneRuntime = usePaneRuntime();
  const paneId = paneRuntime?.paneId ?? "none";
  hostMocks.bodyRenderCountByPaneId.set(
    paneId,
    (hostMocks.bodyRenderCountByPaneId.get(paneId) ?? 0) + 1,
  );
  const publishSecondary = useContext(PaneSecondaryContext);
  const publishFixedChrome = useContext(PaneFixedChromeContext);
  usePanePrimaryChrome(
    paneRuntime
      ? (hostMocks.primaryChromePublicationByPaneId.get(paneRuntime.paneId) ??
          null)
      : null,
  );
  const didActivateTargetRef = useRef(false);
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
    const request = hostMocks.targetActivationRequest;
    if (!request || !paneRuntime || didActivateTargetRef.current) {
      return;
    }
    didActivateTargetRef.current = true;
    paneRuntime.activateTarget({
      target: {
        href: request.href,
        labelHint: request.labelHint,
        secondaryActivation: request.activation,
      },
      disposition: { kind: "Fork" },
    });
  }, [paneRuntime]);
  return (
    <div
      data-testid="route-body"
      data-instance-id={instanceId.current}
      data-runtime-pane-id={paneRuntime?.paneId ?? "none"}
      data-runtime-href={paneRuntime?.href ?? "none"}
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
      data-runtime-transient-surface={
        paneRuntime?.transientSecondarySurface?.id ?? "none"
      }
      data-runtime-transient-expanded={
        paneRuntime?.transientSecondarySurface?.expanded ? "true" : "false"
      }
      style={hostMocks.useActualPaneShell ? { minHeight: 1200 } : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- justify-eslint-override: test fixture uses a plain anchor so WorkspaceHost link interception is the behavior under test */}
      <a href="/authors/body-author" data-pane-label-hint="Body Author">
        Body Author
      </a>
      <input aria-label="Pane body control" />
      <div
        data-testid="route-body-scrollport"
        tabIndex={-1}
        style={{ height: 20, overflow: "auto" }}
      >
        <div style={{ height: 500 }}>Scrollable body fixture</div>
      </div>
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
        onClick={(event) =>
          paneRuntime?.requestTransientSecondarySurface("resource-search", {
            returnFocusTo: event.currentTarget,
          })
        }
      >
        Show search results
      </button>
      <button
        type="button"
        onClick={() => paneRuntime?.previewTransientSecondaryResult()}
      >
        Preview search result
      </button>
      <button
        type="button"
        onClick={() => paneRuntime?.closeTransientSecondarySurface()}
      >
        End search results
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
    resolveWorkspacePaneLabel: (pane: { currentVisit: PaneVisit }) => {
      const route = routeForHostTest(pane.currentVisit.href);
      return {
        routeKey: resolvePaneRouteIdentity(pane.currentVisit.href).routeKey,
        route,
        label: route.defaultLabel,
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
    default: function MockPaneShell(
      props: ComponentProps<typeof ActualPaneShell>,
    ) {
      const router = usePaneRouter();
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
              onClick={router.back}
              disabled={!router.canGoBack}
            >
              Go back in this pane
            </button>
            <button
              type="button"
              onClick={router.forward}
              disabled={!router.canGoForward}
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
      transientSurface,
      transientExpanded,
      returnFocusTo,
    }: {
      primaryPaneId: string;
      secondary: {
        groupId: WorkspaceSecondaryGroupId;
        activeSurfaceId: WorkspaceSecondarySurfaceId;
        visibility: "visible" | "collapsed";
      } | null;
      publication: PaneSecondaryPublication | null;
      transientSurface?: { id: "resource-search" } | null;
      transientExpanded?: boolean;
      returnFocusTo?: () => HTMLElement | null;
    }) => {
      hostMocks.mobileSecondaryInputs.push({ primaryPaneId, returnFocusTo });
      if (transientSurface) {
        return transientExpanded ? (
          <div data-testid="mobile-secondary-host">
            {transientSurface.id}
          </div>
        ) : null;
      }
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
  matchesKeyEvent: (combo: string, event: KeyboardEvent) =>
    hostMocks.matchesKeyEvent(combo, event),
}));

vi.mock("@/lib/keybindingsProvider", () => ({
  useKeybindings: () => hostMocks.keybindings,
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
    kind: hostMocks.isMobile ? "mobile" : "desktop",
    isMobile: hostMocks.isMobile,
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

import WorkspaceHostImpl from "@/components/workspace/WorkspaceHost";

function WorkspaceHost() {
  return (
    <FeedbackProvider>
      <LibraryPlacementControllerProvider>
        <ShareControllerProvider>
          <PaneReturnMementoProvider>
            <WorkspaceHostImpl />
          </PaneReturnMementoProvider>
        </ShareControllerProvider>
      </LibraryPlacementControllerProvider>
    </FeedbackProvider>
  );
}

function TestAppNav() {
  return hostMocks.isMobile ? <MobilePaneBar /> : null;
}

function setPaneHref(
  href: string,
  history: WorkspacePaneHistory = { back: [], forward: [] },
) {
  hostMocks.store.state = {
    primaryPaneOrder: ["pane-1"],
    primaryPanesById: {
      "pane-1": {
        id: "pane-1",
        currentVisit: paneVisit(href),
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

function replaceCurrentPaneHref(href: string) {
  const pane = hostMocks.store.state.primaryPanesById["pane-1"];
  if (!pane) {
    throw new Error("Expected pane-1 to exist");
  }
  hostMocks.store.state = {
    ...hostMocks.store.state,
    primaryPanesById: {
      ...hostMocks.store.state.primaryPanesById,
      "pane-1": {
        ...pane,
        currentVisit: { ...pane.currentVisit, href },
      },
    },
  };
}

function setTwoPaneHrefs(firstHref: string, secondHref: string) {
  hostMocks.store.state = {
    primaryPaneOrder: ["pane-1", "pane-2"],
    primaryPanesById: {
      "pane-1": {
        id: "pane-1",
        currentVisit: paneVisit(firstHref),
        primaryWidthPx: 640,
        attachedSecondaryPaneId: null,
        visibility: "visible",
        history: { back: [], forward: [] },
      },
      "pane-2": {
        id: "pane-2",
        currentVisit: paneVisit(secondHref),
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
    nextVisitIndex = 1;
    hostMocks.bodyInstanceId = 0;
    hostMocks.bodyRenderCountByPaneId = new Map();
    hostMocks.mountedBodyIds = [];
    hostMocks.unmountedBodyIds = [];
    hostMocks.paneShellSnapshots = [];
    hostMocks.mobileSecondaryInputs = [];
    hostMocks.useActualPaneShell = false;
    hostMocks.keybindings = { "Pane.Search": "Meta+f" };
    hostMocks.matchesKeyEvent.mockReset();
    hostMocks.matchesKeyEvent.mockImplementation(
      (combo: string, event: KeyboardEvent) =>
        combo === "Meta+f" &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f",
    );
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
    hostMocks.targetActivationRequest = null;
    hostMocks.resolveResourceLocators.mockReset();
    hostMocks.resolveResourceLocators.mockResolvedValue([]);
    hostMocks.store.activatePane.mockReset();
    hostMocks.store.activateWorkspaceTarget.mockReset();
    hostMocks.store.acknowledgePendingSecondaryActivation.mockReset();
    hostMocks.store.pendingSecondaryActivationByPaneId = new Map();
    hostMocks.store.acknowledgePaneEntryDelivery.mockReset();
    hostMocks.store.pendingPaneEntryDeliveryByPaneId = new Map();
    hostMocks.store.publishPaneAliases.mockReset();
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

  it("routes Cmd/Ctrl+F from an editor to the active capable pane", async () => {
    hostMocks.useActualPaneShell = true;
    hostMocks.primaryChromePublicationByPaneId.set("pane-1", {
      search: {
        kind: "FilterRows",
        query: "",
        inputLabel: "Filter pane items",
        placeholder: "Filter",
        onQueryChange: vi.fn(),
        onDismiss: vi.fn(),
        rowStatus: {
          kind: "Complete",
          visibleCount: 1,
          totalCount: 1,
          unit: { singular: "item", plural: "items" },
        },
        activeDomainControlCount: 0,
      },
    });
    render(
      <MobileChromeProvider>
        <WorkspaceHost />
      </MobileChromeProvider>,
    );
    const editor = screen.getByRole("textbox", { name: "Pane body control" });
    editor.focus();

    expect(
      fireEvent.keyDown(editor, { key: "f", metaKey: true }),
    ).toBe(false);
    const search = await screen.findByRole("searchbox", {
      name: "Filter pane items",
    });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it("leaves native Find unprevented when the active pane is incapable", () => {
    render(<WorkspaceHost />);
    const editor = screen.getByRole("textbox", { name: "Pane body control" });

    expect(
      fireEvent.keyDown(editor, { key: "f", ctrlKey: true }),
    ).toBe(true);
    expect(screen.queryByTestId("pane-contextual-row")).toBeNull();
  });

  it("does not rerender mounted route bodies when only the active pane changes", () => {
    setTwoPaneHrefs("/libraries", "/stats");
    const view = render(<WorkspaceHost />);
    const initialRenderCounts = new Map(hostMocks.bodyRenderCountByPaneId);

    hostMocks.store.state = {
      ...hostMocks.store.state,
      activePrimaryPaneId: "pane-1",
    };
    view.rerender(<WorkspaceHost />);

    expect(hostMocks.bodyRenderCountByPaneId).toEqual(initialRenderCounts);
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

  it("keeps Stats query replacements mounted while its canonical pane identity changes", () => {
    setPaneHref("/stats?view=stats&period=day&anchor=2026-07-24");
    const { rerender } = render(<WorkspaceHost />);
    const firstInstance = screen.getByTestId("route-body").dataset.instanceId;
    const control = screen.getByRole("textbox", { name: "Pane body control" });
    const scrollport = screen.getByTestId("route-body-scrollport");
    scrollport.scrollTop = 180;
    control.focus();

    replaceCurrentPaneHref("/stats?view=year&year=2026");
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-route-key",
      "stats:/stats?view=year&year=2026",
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-href",
      "/stats?view=year&year=2026",
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-instance-id",
      firstInstance,
    );
    expect(
      screen.getByRole("textbox", { name: "Pane body control" }),
    ).toHaveFocus();
    expect(screen.getByTestId("route-body-scrollport").scrollTop).toBe(180);
    expect(
      screen.queryByText(
        /This route is not yet supported in side-by-side pane mode/,
      ),
    ).not.toBeInTheDocument();
    expect(hostMocks.mountedBodyIds).toHaveLength(1);
    expect(hostMocks.unmountedBodyIds).toEqual([]);
  });

  it("keeps Library query replacements mounted with focus and scroll intact", () => {
    setPaneHref(`/libraries/${LIBRARY_ID}?sort=title&direction=asc`);
    const { rerender } = render(<WorkspaceHost />);
    const firstInstance = screen.getByTestId("route-body").dataset.instanceId;
    const control = screen.getByRole("textbox", { name: "Pane body control" });
    const scrollport = screen.getByTestId("route-body-scrollport");
    scrollport.scrollTop = 180;
    control.focus();

    replaceCurrentPaneHref(
      `/libraries/${LIBRARY_ID}?sort=creator&direction=asc`,
    );
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("pane-shell")).toHaveAttribute(
      "data-route-key",
      `library:/libraries/${LIBRARY_ID}?sort=creator&direction=asc`,
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-href",
      `/libraries/${LIBRARY_ID}?sort=creator&direction=asc`,
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-instance-id",
      firstInstance,
    );
    expect(
      screen.getByRole("textbox", { name: "Pane body control" }),
    ).toHaveFocus();
    expect(screen.getByTestId("route-body-scrollport").scrollTop).toBe(180);
    expect(hostMocks.mountedBodyIds).toHaveLength(1);
    expect(hostMocks.unmountedBodyIds).toEqual([]);
  });

  it.each([
    [
      "Podcast subscriptions",
      "/podcasts?q=legacy&sort=alpha&unknown=value",
      "/podcasts?sort=alpha",
      `/podcasts/${PODCAST_ID}?state=all&sort=newest`,
    ],
    [
      "Podcast detail",
      `/podcasts/${PODCAST_ID}?q=legacy&state=played&unknown=value&sort=oldest`,
      `/podcasts/${PODCAST_ID}?state=played&sort=oldest`,
      `/podcasts/${OTHER_PODCAST_ID}?state=all&sort=newest`,
    ],
  ])(
    "keeps %s mount canonicalization in place and remounts a new path visit",
    async (_route, initialHref, canonicalHref, nextPathHref) => {
      hostMocks.useActualPaneShell = true;
      hostMocks.primaryChromePublicationByPaneId.set("pane-1", {
        search: {
          kind: "FilterRows",
          query: "retained query",
          inputLabel: "Filter podcast rows",
          placeholder: "Filter",
          onQueryChange: vi.fn(),
          onDismiss: vi.fn(),
          rowStatus: {
            kind: "Complete",
            visibleCount: 1,
            totalCount: 1,
            unit: { singular: "row", plural: "rows" },
          },
          activeDomainControlCount: 1,
          filters: (
            <label>
              Podcast sort
              <select aria-label="Podcast sort" defaultValue="alpha">
                <option value="alpha">Alphabetical</option>
                <option value="recent">Recent</option>
              </select>
            </label>
          ),
        },
      });
      setPaneHref(initialHref);
      const view = render(
        <MobileChromeProvider>
          <WorkspaceHost />
        </MobileChromeProvider>,
      );
      const firstBody = screen.getByTestId("route-body");
      const firstInstance = firstBody.dataset.instanceId;

      fireEvent.click(
        await screen.findByRole("button", { name: /^Filter/ }),
      );
      const search = await screen.findByRole("searchbox", {
        name: "Filter podcast rows",
      });
      const sort = screen.getByRole("combobox", { name: "Podcast sort" });
      sort.focus();
      expect(sort).toHaveFocus();
      expect(search).toHaveValue("retained query");

      replaceCurrentPaneHref(canonicalHref);
      view.rerender(
        <MobileChromeProvider>
          <WorkspaceHost />
        </MobileChromeProvider>,
      );

      expect(screen.getByTestId("route-body")).toBe(firstBody);
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-instance-id",
        firstInstance,
      );
      expect(
        screen.getByRole("searchbox", { name: "Filter podcast rows" }),
      ).toBe(search);
      expect(
        screen.getByRole("combobox", { name: "Podcast sort" }),
      ).toBe(sort);
      expect(sort).toHaveFocus();
      expect(search).toHaveValue("retained query");
      expect(hostMocks.mountedBodyIds).toHaveLength(1);
      expect(hostMocks.unmountedBodyIds).toEqual([]);

      setPaneHref(nextPathHref);
      view.rerender(
        <MobileChromeProvider>
          <WorkspaceHost />
        </MobileChromeProvider>,
      );

      expect(screen.getByTestId("route-body")).not.toBe(firstBody);
      expect(screen.getByTestId("route-body")).not.toHaveAttribute(
        "data-instance-id",
        firstInstance,
      );
      expect(screen.queryByTestId("pane-contextual-row")).toBeNull();
      expect(hostMocks.mountedBodyIds).toHaveLength(2);
      expect(hostMocks.unmountedBodyIds).toEqual([Number(firstInstance)]);
    },
  );

  it("does not reset Library ShellScroll when only the query changes", () => {
    hostMocks.useActualPaneShell = true;
    setPaneHref(`/libraries/${LIBRARY_ID}?sort=title&direction=asc`);
    const { rerender } = render(
      <MobileChromeProvider>
        <WorkspaceHost />
      </MobileChromeProvider>,
    );
    const scrollport = screen.getByTestId("pane-shell-body");
    scrollport.style.height = "100px";
    scrollport.style.flex = "0 0 100px";
    scrollport.scrollTop = 180;
    expect(scrollport.scrollTop).toBe(180);

    replaceCurrentPaneHref(
      `/libraries/${LIBRARY_ID}?sort=creator&direction=asc`,
    );
    rerender(
      <MobileChromeProvider>
        <WorkspaceHost />
      </MobileChromeProvider>,
    );

    expect(screen.getByTestId("pane-shell-body")).toBe(scrollport);
    expect(scrollport.scrollTop).toBe(180);
  });

  it.each([
    [
      "without an instrument",
      {
        menu: {
          kind: "FlatMenu" as const,
          actions: [
            {
              kind: "command" as const,
              id: "reader-option",
              label: "Reader option",
              onSelect: () => {},
            },
          ],
        },
      },
    ],
    [
      "with an instrument",
      {
        instrument: {
          label: "PDF controls",
          content: <button type="button">PDF reader controls</button>,
        },
      },
    ],
  ])(
    "normal mobile activation %s focuses the stable pane landmark",
    async (_case, publication) => {
      hostMocks.isMobile = true;
      hostMocks.useActualPaneShell = true;
      hostMocks.primaryChromePublicationByPaneId.set("pane-1", publication);
      render(
        <MobileChromeProvider>
          <MobilePaneBar />
          <WorkspaceHost />
        </MobileChromeProvider>,
      );

      await waitFor(() =>
        expect(screen.getByTestId("pane-shell-root")).toHaveFocus(),
      );
      expect(screen.getByTestId("pane-shell-root")).toHaveAttribute(
        "data-pane-focus-landmark",
        "true",
      );
      expect(screen.getByTestId("pane-shell-chrome")).toHaveAttribute(
        "data-mobile-chrome-phase",
        "Visible",
      );
    },
  );

  it("preserves the mobile Quick Note handoff focus while AppendNote waits for its editor", async () => {
    hostMocks.isMobile = true;
    hostMocks.useActualPaneShell = true;
    setTwoPaneHrefs(MEDIA_HREF_1, MEDIA_HREF_2);
    const renderTree = () => (
      <MobileChromeProvider>
        <textarea aria-label="Quick Note input handoff" />
        <WorkspaceHost />
      </MobileChromeProvider>
    );
    const view = render(renderTree());

    await waitFor(() =>
      expect(screen.getByTestId("pane-shell-root")).toHaveFocus(),
    );
    const handoff = screen.getByRole("textbox", {
      name: "Quick Note input handoff",
    });
    handoff.focus();
    expect(handoff).toHaveFocus();

    const targetPane = hostMocks.store.state.primaryPanesById["pane-1"];
    if (!targetPane) {
      throw new Error("Expected pane-1 to exist");
    }
    hostMocks.store.pendingPaneEntryDeliveryByPaneId = new Map([
      [
        targetPane.id,
        {
          activationId: "daily-append-1",
          paneId: targetPane.id,
          visitId: targetPane.currentVisit.id,
          entry: {
            kind: "AppendNote",
            noteId: "44444444-4444-4444-8444-444444444444",
            clientMutationId: "daily-capture-1",
            initialText: "Captured thought",
          },
        },
      ],
    ]);
    hostMocks.store.state = {
      ...hostMocks.store.state,
      activePrimaryPaneId: targetPane.id,
    };
    view.rerender(renderTree());

    await waitFor(() =>
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-pane-id",
        targetPane.id,
      ),
    );
    expect(handoff).toHaveFocus();

    const destinationEditor = screen.getByRole("textbox", {
      name: "Pane body control",
    });
    destinationEditor.focus();
    hostMocks.store.pendingPaneEntryDeliveryByPaneId = new Map();
    view.rerender(renderTree());
    expect(destinationEditor).toHaveFocus();

    hostMocks.store.state = {
      ...hostMocks.store.state,
      activePrimaryPaneId: "pane-2",
    };
    view.rerender(renderTree());
    await waitFor(() =>
      expect(screen.getByTestId("pane-shell-root")).toHaveFocus(),
    );
  });

  it("restores active PaneShell focus when mobile mode exits", async () => {
    hostMocks.isMobile = true;
    hostMocks.useActualPaneShell = true;
    const view = render(
      <MobileChromeProvider>
        <TestAppNav />
        <WorkspaceHost />
      </MobileChromeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("pane-shell-root")).toHaveFocus(),
    );

    hostMocks.isMobile = false;
    view.rerender(
      <MobileChromeProvider>
        <TestAppNav />
        <WorkspaceHost />
      </MobileChromeProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("pane-shell-chrome")).toHaveFocus(),
    );
  });

  it("registers only focused active pane chrome when desktop panes become mobile", async () => {
    setTwoPaneHrefs(MEDIA_HREF_1, MEDIA_HREF_2);
    hostMocks.useActualPaneShell = true;
    hostMocks.primaryChromePublicationByPaneId = new Map([
      [
        "pane-1",
        {
          instrument: {
            label: "First reader controls",
            content: <button type="button">First reader controls</button>,
          },
        },
      ],
      [
        "pane-2",
        {
          instrument: {
            label: "Second reader controls",
            content: <button type="button">Second reader controls</button>,
          },
        },
      ],
    ]);
    const view = render(
      <MobileChromeProvider>
        <WorkspaceHost />
      </MobileChromeProvider>,
    );

    await screen.findByRole("button", { name: "Second reader controls" });
    const activeChrome = screen.getAllByTestId("pane-shell-chrome").at(-1);
    if (!activeChrome) {
      throw new Error("Expected active desktop pane chrome");
    }
    activeChrome.focus();
    expect(activeChrome).toHaveFocus();

    hostMocks.isMobile = true;
    view.rerender(
      <MobileChromeProvider>
        <WorkspaceHost />
      </MobileChromeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-pane-id",
        "pane-2",
      );
      expect(screen.getByTestId("pane-shell-root")).toHaveFocus();
      expect(screen.getByTestId("pane-shell-chrome")).toHaveAttribute(
        "data-mobile-chrome-phase",
        "Visible",
      );
    });
    expect(activeChrome).not.toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "First reader controls" }),
    ).toBeNull();
  });

  it.each([
    ["Library", `/libraries/${LIBRARY_ID}?sort=title&direction=asc`],
    ["Stats", "/stats?view=year&year=2026"],
  ])(
    "remounts the %s route body for a new visit occurrence",
    (_route, href) => {
      setPaneHref(href);
      const { rerender } = render(<WorkspaceHost />);
      const firstInstance = screen.getByTestId("route-body").dataset.instanceId;

      setPaneHref(href);
      rerender(<WorkspaceHost />);

      expect(screen.getByTestId("route-body")).not.toHaveAttribute(
        "data-instance-id",
        firstInstance,
      );
      expect(hostMocks.mountedBodyIds).toHaveLength(2);
      expect(hostMocks.unmountedBodyIds).toEqual([Number(firstInstance)]);
    },
  );

  it("remounts a ShellScroll route body for a new visit occurrence", () => {
    setPaneHref("/libraries");
    const { rerender } = render(<WorkspaceHost />);
    const firstInstance = screen.getByTestId("route-body").dataset.instanceId;

    setPaneHref("/libraries");
    rerender(<WorkspaceHost />);

    expect(screen.getByTestId("route-body")).not.toHaveAttribute(
      "data-instance-id",
      firstInstance,
    );
    expect(hostMocks.mountedBodyIds).toHaveLength(2);
    expect(hostMocks.unmountedBodyIds).toEqual([Number(firstInstance)]);
  });

  it.each([
    ["Reader", MEDIA_HREF_1],
    ["Chat", "/conversations/new"],
    ["Atlas", "/atlas"],
  ])("preserves the %s route body across visit occurrences", (_owner, href) => {
    setPaneHref(href);
    const { rerender } = render(<WorkspaceHost />);
    const firstInstance = screen.getByTestId("route-body").dataset.instanceId;

    setPaneHref(href);
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
      expect(
        hostMocks.fixedChromePublisherByPaneId.get("pane-1"),
      ).toBeDefined();
    });
    const staleSecondaryPublisher =
      hostMocks.secondaryPublisherByPaneId.get("pane-1");
    const staleFixedChromePublisher =
      hostMocks.fixedChromePublisherByPaneId.get("pane-1");
    if (!staleSecondaryPublisher || !staleFixedChromePublisher) {
      throw new Error("Expected route-scoped publication callbacks");
    }

    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_EVIDENCE_ONLY;
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

  it("resolves a Library resource locator once across query replacements", async () => {
    let resolveLocator!: (resolutions: ResourceLocatorResolution[]) => void;
    hostMocks.resolveResourceLocators.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLocator = resolve;
        }),
    );
    setPaneHref(`/libraries/${LIBRARY_ID}?sort=title&direction=asc`);
    const { rerender } = render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.resolveResourceLocators).toHaveBeenCalledWith([
        { kind: "resource_ref", ref: `library:${LIBRARY_ID}` },
      ]);
    });

    replaceCurrentPaneHref(
      `/libraries/${LIBRARY_ID}?sort=creator&direction=asc`,
    );
    rerender(<WorkspaceHost />);

    expect(hostMocks.resolveResourceLocators).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveLocator([
        {
          locator: { kind: "resource_ref", ref: `library:${LIBRARY_ID}` },
          resourceItem: libraryResourceItem(LIBRARY_ID),
          canonicalHref: `/libraries/${LIBRARY_ID}`,
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("route-body")).toHaveAttribute(
        "data-runtime-resource-status",
        "ready",
      );
    });
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
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
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
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(hostMocks.store.resizePrimaryPane).not.toHaveBeenCalled();
  });

  it("persists the workspace floor after intrinsic-capable content resolves to workspace sizing", async () => {
    hostMocks.runtimeLayout = {
      primaryWidth: { kind: "workspace" },
    };

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.resizePrimaryPane).toHaveBeenCalledWith(
        "pane-1",
        684,
      );
    });
  });

  it("routes pane chrome internal links through the current pane", () => {
    render(<WorkspaceHost />);

    fireEvent.click(screen.getByRole("link", { name: "Chrome Author" }));

    expect(hostMocks.store.activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: { href: "/authors/author-1", labelHint: "Chrome Author" },
      disposition: { kind: "Follow" },
      modality: "Keyboard",
    });
    expect(hostMocks.store.navigatePane).not.toHaveBeenCalled();
  });

  it("routes header Back and Forward through the target pane only", () => {
    setPaneHref(MEDIA_HREF_2, {
      back: [paneVisit(MEDIA_HREF_1)],
      forward: [paneVisit(MEDIA_HREF_3)],
    });

    render(<WorkspaceHost />);

    fireEvent.click(
      screen.getByRole("button", { name: "Go back in this pane" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Go forward in this pane" }),
    );

    expect(hostMocks.store.goBackPane).toHaveBeenCalledWith(
      "pane-1",
      "Keyboard",
    );
    expect(hostMocks.store.goForwardPane).toHaveBeenCalledWith(
      "pane-1",
      "Keyboard",
    );
    expect(hostMocks.store.navigatePane).not.toHaveBeenCalled();
  });

  it("routes route body internal links through the same pane boundary", () => {
    render(<WorkspaceHost />);

    fireEvent.click(screen.getByRole("link", { name: "Body Author" }));

    expect(hostMocks.store.activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: { href: "/authors/body-author", labelHint: "Body Author" },
      disposition: { kind: "Follow" },
      modality: "Keyboard",
    });
    expect(hostMocks.store.navigatePane).not.toHaveBeenCalled();
  });

  it("opens pane chrome internal links in a sibling pane on Shift-click", () => {
    render(<WorkspaceHost />);

    fireEvent.click(screen.getByRole("link", { name: "Chrome Author" }), {
      detail: 1,
      shiftKey: true,
    });

    expect(hostMocks.store.activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: { href: "/authors/author-1", labelHint: "Chrome Author" },
      disposition: { kind: "Fork" },
      modality: "Pointer",
    });
    expect(hostMocks.store.navigatePane).not.toHaveBeenCalled();
  });
});

const RESOURCE_INSPECTOR_EVIDENCE_ONLY: PaneSecondaryPublication = {
  groupId: "resource-inspector",
  defaultSurfaceId: "resource-evidence",
  surfaces: [{ id: "resource-evidence", body: <div>Evidence</div> }],
};

const RESOURCE_INSPECTOR_HIGHLIGHTS_ONLY = RESOURCE_INSPECTOR_EVIDENCE_ONLY;

const RESOURCE_INSPECTOR_WITH_CONTENTS: PaneSecondaryPublication = {
  groupId: "resource-inspector",
  defaultSurfaceId: "resource-evidence",
  surfaces: [
    { id: "resource-contents", body: <div>Contents</div> },
    { id: "resource-evidence", body: <div>Evidence</div> },
  ],
};

const RESOURCE_INSPECTOR_WITH_SEARCH: PaneSecondaryPublication = {
  ...RESOURCE_INSPECTOR_WITH_CONTENTS,
  transientSurfaces: [
    { id: "resource-search", body: <div>Search matches</div> },
  ],
};

const RESOURCE_SEARCH_ONLY: PaneSecondaryPublication = {
  groupId: "resource-inspector",
  surfaces: [],
  defaultSurfaceId: null,
  transientSurfaces: [
    { id: "resource-search", body: <div>Search matches</div> },
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
        currentVisit: paneVisit(MEDIA_HREF_1),
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
        currentVisit: {
          ...hostMocks.store.state.primaryPanesById["pane-1"]!.currentVisit,
          href,
        },
      },
    },
  };
}

describe("WorkspaceHost secondary publication validation", () => {
  beforeEach(() => {
    nextVisitIndex = 1;
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
    hostMocks.targetActivationRequest = null;
    hostMocks.store.activateWorkspaceTarget.mockReset();
    hostMocks.store.acknowledgePendingSecondaryActivation.mockReset();
    hostMocks.store.pendingSecondaryActivationByPaneId = new Map();
    hostMocks.store.acknowledgePendingSecondaryActivation.mockImplementation(
      (paneId: string) => {
        hostMocks.store.pendingSecondaryActivationByPaneId.delete(paneId);
      },
    );
    hostMocks.store.requestSecondarySurface.mockReset();
    hostMocks.store.closeSecondaryPane.mockReset();
    hostMocks.store.dropSecondaryPane.mockReset();
    hostMocks.store.setSecondarySurface.mockReset();
    hostMocks.store.resizeSecondaryPane.mockReset();
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
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_HIGHLIGHTS_ONLY;

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

  it("accepts the first valid secondary request in the publication commit", async () => {
    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.secondaryPublisherByPaneId.get("pane-1")).toBeDefined();
    });
    const publish = hostMocks.secondaryPublisherByPaneId.get("pane-1");
    if (!publish) throw new Error("Pane secondary publisher was not captured");
    const opener = screen.getByRole("button", { name: "Open Companion" });

    act(() => {
      publish(RESOURCE_INSPECTOR_HIGHLIGHTS_ONLY);
      opener.click();
    });

    expect(hostMocks.store.requestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "resource-evidence",
    );
  });

  it("restores desktop focus on close/Escape, with pane-chrome fallback for a detached opener", async () => {
    hostMocks.useActualPaneShell = true;
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
    });
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_HIGHLIGHTS_ONLY;

    render(
      <MobileChromeProvider>
        <WorkspaceHost />
      </MobileChromeProvider>,
    );

    await screen.findByTestId("workspace-secondary-pane");
    const opener = screen.getByRole("button", { name: "Open Companion" });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Close Evidence" }));

    expect(hostMocks.store.closeSecondaryPane).toHaveBeenCalledWith(
      "secondary-1",
    );
    await waitFor(() => expect(opener).toHaveFocus());

    hostMocks.store.closeSecondaryPane.mockClear();
    fireEvent.click(opener);
    const evidenceTab = screen.getByRole("tab", { name: "Evidence" });
    evidenceTab.focus();
    opener.remove();
    fireEvent.keyDown(evidenceTab, { key: "Escape" });

    expect(hostMocks.store.closeSecondaryPane).toHaveBeenCalledWith(
      "secondary-1",
    );
    await waitFor(() =>
      expect(screen.getByTestId("pane-shell-chrome")).toHaveFocus(),
    );
  });

  it("republishes secondary and fixed chrome when a same-resource route instance changes", async () => {
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-evidence",
    });
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_HIGHLIGHTS_ONLY;
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
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_HIGHLIGHTS_ONLY;
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
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_HIGHLIGHTS_ONLY;
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
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_EVIDENCE_ONLY;

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
      revisionRef: "artifact_revision:44444444-4444-4444-8444-444444444444",
    } as const;
    hostMocks.targetActivationRequest = {
      href: MEDIA_HREF_1,
      labelHint: "Dossier",
      activation,
    };

    render(<WorkspaceHost />);

    await waitFor(() => {
      expect(hostMocks.store.activateWorkspaceTarget).toHaveBeenCalledWith({
        originPaneId: "pane-1",
        target: {
          href: MEDIA_HREF_1,
          labelHint: "Dossier",
          secondaryActivation: activation,
        },
        disposition: { kind: "Fork" },
        modality: "Programmatic",
      });
    });
  });

  it("launches a pending cross-pane secondary request once the target publishes the surface", async () => {
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_WITH_CONTENTS;
    const activation = {
      kind: "Surface",
      surfaceId: "resource-evidence",
    } as const;
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
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_EVIDENCE_ONLY;
    const activation = {
      kind: "Surface",
      surfaceId: "resource-contents",
    } as const;
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
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_HIGHLIGHTS_ONLY;

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
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_HIGHLIGHTS_ONLY;

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

  it("restores the exact durable Companion tab and visibility after closing transient results", async () => {
    hostMocks.useActualPaneShell = true;
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-contents",
      visibility: "visible",
    });
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_WITH_SEARCH;

    render(
      <MobileChromeProvider>
        <WorkspaceHost />
      </MobileChromeProvider>,
    );

    await screen.findByRole("tab", { name: "Contents" });
    fireEvent.click(
      screen.getByRole("button", { name: "Show search results" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Search results" }),
      ).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.getByText("Search matches")).toBeInTheDocument();
    expect(hostMocks.store.requestSecondarySurface).not.toHaveBeenCalled();
    expect(hostMocks.store.setSecondarySurface).not.toHaveBeenCalled();
    expect(hostMocks.store.closeSecondaryPane).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Close Search results" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Contents" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(
      hostMocks.store.state.secondaryPanesById["secondary-1"],
    ).toMatchObject({
      activeSurfaceId: "resource-contents",
      visibility: "visible",
    });
  });

  it("ends transient results when a durable tab is selected and keeps that explicit choice", async () => {
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-contents",
      visibility: "collapsed",
    });
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_WITH_SEARCH;

    render(<WorkspaceHost />);
    fireEvent.click(
      screen.getByRole("button", { name: "Show search results" }),
    );
    await screen.findByRole("tab", { name: "Search results" });

    fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));

    expect(hostMocks.store.requestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "resource-evidence",
    );
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Search results" })).toBeNull(),
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-transient-surface",
      "none",
    );
  });

  it("hides the mobile sheet for result preview, reopens it, and ends back at a collapsed origin", async () => {
    hostMocks.isMobile = true;
    setPaneWithSecondary({
      groupId: "resource-inspector",
      activeSurfaceId: "resource-contents",
      visibility: "collapsed",
    });
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_WITH_SEARCH;

    render(<WorkspaceHost />);
    fireEvent.click(
      screen.getByRole("button", { name: "Show search results" }),
    );
    await screen.findByTestId("mobile-secondary-host");

    fireEvent.click(
      screen.getByRole("button", { name: "Preview search result" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("mobile-secondary-host")).toBeNull(),
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-transient-surface",
      "resource-search",
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-transient-expanded",
      "false",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Show search results" }),
    );
    await screen.findByTestId("mobile-secondary-host");
    fireEvent.click(
      screen.getByRole("button", { name: "End search results" }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("mobile-secondary-host")).toBeNull(),
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-transient-surface",
      "none",
    );
    expect(
      hostMocks.store.state.secondaryPanesById["secondary-1"],
    ).toMatchObject({
      activeSurfaceId: "resource-contents",
      visibility: "collapsed",
    });
  });

  it("prunes transient activation when the pane route key changes", async () => {
    hostMocks.secondaryPublication = RESOURCE_INSPECTOR_WITH_SEARCH;
    const { rerender } = render(<WorkspaceHost />);
    fireEvent.click(
      screen.getByRole("button", { name: "Show search results" }),
    );
    await screen.findByRole("tab", { name: "Search results" });

    setSecondaryPaneHref(`${MEDIA_HREF_1}?loc=chapter-2`);
    rerender(<WorkspaceHost />);

    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Search results" })).toBeNull(),
    );
    expect(screen.getByTestId("route-body")).toHaveAttribute(
      "data-runtime-transient-surface",
      "none",
    );
  });

  it("hosts transient-only results without creating durable Companion state", async () => {
    hostMocks.secondaryPublication = RESOURCE_SEARCH_ONLY;

    render(<WorkspaceHost />);
    fireEvent.click(
      screen.getByRole("button", { name: "Show search results" }),
    );

    await screen.findByText("Search matches");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(hostMocks.store.requestSecondarySurface).not.toHaveBeenCalled();
    expect(Object.keys(hostMocks.store.state.secondaryPanesById)).toEqual([]);

    fireEvent.click(
      screen.getByRole("button", { name: "Close Search results" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Search matches")).toBeNull(),
    );
    expect(Object.keys(hostMocks.store.state.secondaryPanesById)).toEqual([]);
  });
});
