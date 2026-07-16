"use client";

import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedPaneRoute } from "@/lib/panes/paneRouteTable";
import { renderPane } from "@/lib/panes/paneRenderRegistry";
import {
  PaneRuntimeProvider,
  type PaneResourceStatus,
  type PaneRuntimeLayoutPublication,
} from "@/lib/panes/paneRuntime";
import { resolvePaneResourceLocator } from "@/lib/panes/paneResourceLocator";
import { PaneSecondaryContext } from "@/components/workspace/PaneSecondary";
import { PaneFixedChromeContext } from "@/components/workspace/PaneFixedChrome";
import PaneShell from "@/components/workspace/PaneShell";
import MobileSecondaryPaneHost from "@/components/workspace/MobileSecondaryPaneHost";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { matchesKeyEvent } from "@/lib/keybindings";
import { useKeybindings } from "@/lib/keybindingsProvider";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import type { SurfaceHeaderNavigation } from "@/components/ui/SurfaceHeader";
import type { PaneBodyMode } from "@/lib/panes/paneRouteModel";
import {
  paneRouteAllowsSecondarySurface,
  resolvePaneRouteWidthContract,
} from "@/lib/panes/paneRouteModel";
import {
  getWorkspacePrimaryPanes,
  type WorkspaceAttachedSecondaryPaneState,
  type WorkspacePrimaryPaneState,
} from "@/lib/workspace/schema";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";
import {
  DEFAULT_PANE_RUNTIME_LAYOUT,
  isEmptyPaneRuntimeLayout,
  normalizePaneRuntimeLayout,
  resolveEffectivePaneSizing,
  type EffectivePaneSizing,
  type PaneRuntimeLayout,
  type WorkspacePrimaryMetrics,
} from "@/lib/workspace/paneSizing";
import {
  getSecondaryWidthPolicy,
  resolveEffectiveSecondarySizing,
  type WorkspaceSecondarySizing,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import {
  arePaneFixedChromePublicationsEqual,
  arePaneSecondaryPublicationsEqual,
  normalizePaneFixedChromePublication,
  normalizePaneSecondaryPublication,
  secondaryPublicationIncludesSurface,
  type PaneFixedChromePublication,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";
import { emitWorkspaceTelemetry } from "@/lib/workspace/telemetry";
import {
  paneResourceLocatorKey,
  resolvePaneRouteIdentity,
} from "@/lib/panes/paneIdentity";
import {
  resolvePaneRouteKey,
  resolveWorkspacePaneTitle,
  useWorkspaceHostStore,
  type WorkspacePaneTitleDescriptor,
} from "@/lib/workspace/store";
import type { ResourceItem } from "@/lib/notes/api";
import { resolveResourceLocators } from "@/lib/resources/resourceLocators";
import { usePaneCanvas } from "./usePaneCanvas";
import PaneRouteBoundary from "./PaneRouteBoundary";
import styles from "./WorkspaceHost.module.css";

// ---------------------------------------------------------------------------
// WorkspaceHostPane - host-owned pane render model.
// ---------------------------------------------------------------------------

interface WorkspaceHostPane {
  paneId: string;
  href: string;
  route: ResolvedPaneRoute;
  routeKey: string;
  resourceItem: ResourceItem | null;
  resourceStatus: PaneResourceStatus;
  title: string;
  titleState: "resolved" | "pending";
  toolbar?: React.ReactNode;
  actions?: React.ReactNode;
  options?: ActionMenuOption[];
  navigation: SurfaceHeaderNavigation;
  bodyMode: PaneBodyMode;
  sizing: EffectivePaneSizing;
  runtimeSecondaryPane: WorkspaceAttachedSecondaryPaneState | null;
  secondaryPane: WorkspaceAttachedSecondaryPaneState | null;
  secondarySizing: WorkspaceSecondarySizing | null;
  secondaryPublication: PaneSecondaryPublication | null;
  fixedChromePublication: PaneFixedChromePublication | null;
  isActive: boolean;
  visibility: "visible" | "minimized";
  content: React.ReactNode;
}

interface RuntimePaneLayoutRecord {
  routeKey: string;
  layout: PaneRuntimeLayout;
}

interface PaneSecondaryPublicationRecord {
  routeKey: string;
  publication: PaneSecondaryPublication;
}

interface PaneFixedChromePublicationRecord {
  routeKey: string;
  publication: PaneFixedChromePublication;
}

interface PendingSecondarySurfaceRequest {
  surfaceId: WorkspaceSecondarySurfaceId;
  targetPaneId: string | null;
}

// ---------------------------------------------------------------------------
// PaneRouteErrorBoundary — class component (must remain a class component
// because getDerivedStateFromError requires it).
// ---------------------------------------------------------------------------

class PaneRouteErrorBoundary extends Component<
  { children: React.ReactNode; resetKey: string },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; resetKey: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(): void {
    // Keep pane host stable even if a routed pane crashes.
  }

  componentDidUpdate(prevProps: { children: React.ReactNode; resetKey: string }): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.unsupported}>
          This pane failed to render. Close it and retry.
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// ResolvedPaneRouteView — renders the resolved route or an unsupported message.
// ---------------------------------------------------------------------------

function ResolvedPaneRouteView({ route }: { route: ResolvedPaneRoute }) {
  if (route.id !== "unsupported") {
    return renderPane(route.id);
  }
  return (
    <div className={styles.unsupported}>
      This route is not yet supported in side-by-side pane mode: `{route.pathname}`
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaneRuntimeFrame - owns pane-scoped runtime capabilities for the whole pane
// shell, including chrome and routed body content.
// ---------------------------------------------------------------------------

const PaneRuntimeFrame = memo(function PaneRuntimeFrame({
  paneId,
  isActive,
  href,
  route,
  routeKey,
  resourceItem,
  resourceStatus,
  secondaryPane,
  navigatePane,
  openPane,
  canGoBack,
  canGoForward,
  goBackPane,
  goForwardPane,
  publishPaneTitle,
  publishPaneLayout,
  publishPaneSecondary,
  publishPaneFixedChrome,
  requestSecondarySurface,
  closeSecondaryPane,
  setSecondarySurface,
  children,
}: {
  paneId: string;
  isActive: boolean;
  href: string;
  route: ResolvedPaneRoute;
  routeKey: string;
  resourceItem: ResourceItem | null;
  resourceStatus: PaneResourceStatus;
  secondaryPane: WorkspaceAttachedSecondaryPaneState | null;
  navigatePane: (
    paneId: string,
    href: string,
    options?: { replace?: boolean; activate?: boolean; titleHint?: string },
  ) => void;
  openPane: (input: {
    href: string;
    openerPaneId?: string | null;
    activate?: boolean;
    titleHint?: string;
    secondarySurfaceId?: WorkspaceSecondarySurfaceId;
  }) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  goBackPane: (paneId: string) => void;
  goForwardPane: (paneId: string) => void;
  publishPaneTitle: (input: {
    paneId: string;
    routeKey: string;
    title: string | null;
  }) => void;
  publishPaneLayout: (input: PaneRuntimeLayoutPublication) => void;
  publishPaneSecondary: (input: {
    paneId: string;
    routeKey: string;
    publication: PaneSecondaryPublication | null;
  }) => void;
  publishPaneFixedChrome: (input: {
    paneId: string;
    routeKey: string;
    publication: PaneFixedChromePublication | null;
  }) => void;
  requestSecondarySurface: (
    primaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  closeSecondaryPane: (secondaryPaneId: string) => void;
  setSecondarySurface: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  children: React.ReactNode;
}) {
  const handleReplacePane = useCallback(
    (pid: string, h: string, options?: { titleHint?: string }) =>
      navigatePane(pid, h, { replace: true, titleHint: options?.titleHint }),
    [navigatePane]
  );
  const handleOpenInNewPane = useCallback(
    (
      h: string,
      titleHint?: string,
      secondarySurfaceId?: WorkspaceSecondarySurfaceId,
    ) =>
      openPane({
        href: h,
        openerPaneId: paneId,
        activate: true,
        titleHint,
        secondarySurfaceId,
      }),
    [openPane, paneId]
  );
  const handlePaneSecondaryPublication = useCallback(
    (publication: PaneSecondaryPublication | null) => {
      publishPaneSecondary({ paneId, routeKey, publication });
    },
    [paneId, publishPaneSecondary, routeKey],
  );
  const handlePaneFixedChromePublication = useCallback(
    (publication: PaneFixedChromePublication | null) => {
      publishPaneFixedChrome({ paneId, routeKey, publication });
    },
    [paneId, publishPaneFixedChrome, routeKey],
  );

  return (
    <PaneRuntimeProvider
      paneId={paneId}
      isActive={isActive}
      href={href}
      routeId={route.id}
      routeKey={routeKey}
      resourceItem={resourceItem}
      resourceStatus={resourceStatus}
      secondaryPane={secondaryPane}
      pathParams={route.params}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onNavigatePane={navigatePane}
      onReplacePane={handleReplacePane}
      onOpenInNewPane={handleOpenInNewPane}
      onGoBackPane={goBackPane}
      onGoForwardPane={goForwardPane}
      onSetPaneTitle={publishPaneTitle}
      onSetPaneLayout={publishPaneLayout}
      onRequestSecondarySurface={requestSecondarySurface}
      onCloseSecondaryPane={closeSecondaryPane}
      onSetSecondarySurface={setSecondarySurface}
    >
      <PaneSecondaryContext.Provider value={handlePaneSecondaryPublication}>
        <PaneFixedChromeContext.Provider value={handlePaneFixedChromePublication}>
          <PaneRouteBoundary>{children}</PaneRouteBoundary>
        </PaneFixedChromeContext.Provider>
      </PaneSecondaryContext.Provider>
    </PaneRuntimeProvider>
  );
});

// ---------------------------------------------------------------------------
// PaneContent - renders the routed body content for a single pane.
// ---------------------------------------------------------------------------

const PaneContent = memo(function PaneContent({
  href,
  route,
  routeKey,
}: {
  href: string;
  route: ResolvedPaneRoute;
  routeKey: string;
}) {
  const routeMountKey = useMemo(() => {
    const identity = resolvePaneRouteIdentity(href);
    const resourceKey = paneResourceLocatorKey(identity.resourceLocator);
    return resourceKey ? `${identity.routeId}:${resourceKey}` : routeKey;
  }, [href, routeKey]);

  return (
    <div className={styles.routeShell}>
      <PaneRouteErrorBoundary resetKey={routeMountKey}>
        <ResolvedPaneRouteView key={routeMountKey} route={route} />
      </PaneRouteErrorBoundary>
    </div>
  );
});

// ---------------------------------------------------------------------------
// buildHostPane - builds the pane record consumed by the host layout.
// ---------------------------------------------------------------------------

function upsertOrDeletePaneLayoutRecord(
  current: Map<string, RuntimePaneLayoutRecord>,
  input: PaneRuntimeLayoutPublication,
): Map<string, RuntimePaneLayoutRecord> {
  const layout = normalizePaneRuntimeLayout(input.layout);
  const existing = current.get(input.paneId);
  if (isEmptyPaneRuntimeLayout(layout)) {
    if (!existing || existing.routeKey !== input.routeKey) return current;
    const next = new Map(current);
    next.delete(input.paneId);
    return next;
  }
  if (
    existing?.routeKey === input.routeKey &&
    existing.layout.primaryWidth.kind === layout.primaryWidth.kind &&
    (layout.primaryWidth.kind === "workspace" ||
      existing.layout.primaryWidth.kind === "intrinsic" &&
        existing.layout.primaryWidth.widthPx === layout.primaryWidth.widthPx)
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(input.paneId, { routeKey: input.routeKey, layout });
  return next;
}

function upsertOrDeletePaneSecondaryPublicationRecord(
  current: Map<string, PaneSecondaryPublicationRecord>,
  input: {
    paneId: string;
    routeKey: string;
    publication: PaneSecondaryPublication | null;
  },
): Map<string, PaneSecondaryPublicationRecord> {
  const existing = current.get(input.paneId);
  if (!input.publication) {
    if (!existing || existing.routeKey !== input.routeKey) return current;
    const next = new Map(current);
    next.delete(input.paneId);
    return next;
  }
  const publication = normalizePaneSecondaryPublication(input.publication);
  if (
    existing?.routeKey === input.routeKey &&
    arePaneSecondaryPublicationsEqual(existing.publication, publication)
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(input.paneId, { routeKey: input.routeKey, publication });
  return next;
}

function upsertOrDeletePaneFixedChromePublicationRecord(
  current: Map<string, PaneFixedChromePublicationRecord>,
  input: {
    paneId: string;
    routeKey: string;
    publication: PaneFixedChromePublication | null;
  },
): Map<string, PaneFixedChromePublicationRecord> {
  const existing = current.get(input.paneId);
  if (!input.publication) {
    if (!existing || existing.routeKey !== input.routeKey) return current;
    const next = new Map(current);
    next.delete(input.paneId);
    return next;
  }
  const publication = normalizePaneFixedChromePublication(input.publication);
  if (
    existing?.routeKey === input.routeKey &&
    arePaneFixedChromePublicationsEqual(existing.publication, publication)
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(input.paneId, { routeKey: input.routeKey, publication });
  return next;
}

function getRuntimePaneLayout(
  records: Map<string, RuntimePaneLayoutRecord>,
  paneId: string,
  routeKey: string,
): PaneRuntimeLayout {
  const record = records.get(paneId);
  return record?.routeKey === routeKey
    ? record.layout
    : DEFAULT_PANE_RUNTIME_LAYOUT;
}

function getPaneSecondaryPublication(
  records: Map<string, PaneSecondaryPublicationRecord>,
  paneId: string,
  routeKey: string,
): PaneSecondaryPublication | null {
  const record = records.get(paneId);
  return record?.routeKey === routeKey ? record.publication : null;
}

function getPaneFixedChromePublication(
  records: Map<string, PaneFixedChromePublicationRecord>,
  paneId: string,
  routeKey: string,
): PaneFixedChromePublication | null {
  const record = records.get(paneId);
  return record?.routeKey === routeKey ? record.publication : null;
}

function pruneRuntimePaneLayoutRecords(
  current: Map<string, RuntimePaneLayoutRecord>,
  currentRouteKeyByPaneId: Map<string, string>,
): Map<string, RuntimePaneLayoutRecord> {
  let next: Map<string, RuntimePaneLayoutRecord> | null = null;
  for (const [paneId, record] of current) {
    if (currentRouteKeyByPaneId.get(paneId) === record.routeKey) {
      continue;
    }
    next ??= new Map(current);
    next.delete(paneId);
  }
  return next ?? current;
}

function prunePaneSecondaryPublicationRecords(
  current: Map<string, PaneSecondaryPublicationRecord>,
  currentRouteKeyByPaneId: Map<string, string>,
): Map<string, PaneSecondaryPublicationRecord> {
  let next: Map<string, PaneSecondaryPublicationRecord> | null = null;
  for (const [paneId, record] of current) {
    if (currentRouteKeyByPaneId.get(paneId) === record.routeKey) {
      continue;
    }
    next ??= new Map(current);
    next.delete(paneId);
  }
  return next ?? current;
}

function prunePaneFixedChromePublicationRecords(
  current: Map<string, PaneFixedChromePublicationRecord>,
  currentRouteKeyByPaneId: Map<string, string>,
): Map<string, PaneFixedChromePublicationRecord> {
  let next: Map<string, PaneFixedChromePublicationRecord> | null = null;
  for (const [paneId, record] of current) {
    if (currentRouteKeyByPaneId.get(paneId) === record.routeKey) {
      continue;
    }
    next ??= new Map(current);
    next.delete(paneId);
  }
  return next ?? current;
}

function buildHostPane(input: {
  pane: WorkspacePrimaryPaneState;
  secondaryPane: WorkspaceAttachedSecondaryPaneState | null;
  descriptor: WorkspacePaneTitleDescriptor;
  resourceItem: ResourceItem | null;
  resourceStatus: PaneResourceStatus;
  goBackPane: (paneId: string) => void;
  goForwardPane: (paneId: string) => void;
  isActive: boolean;
  runtimeLayout: PaneRuntimeLayout;
  secondaryPublication: PaneSecondaryPublication | null;
  fixedChromePublication: PaneFixedChromePublication | null;
  isMobile: boolean;
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
}): WorkspaceHostPane {
  const { chrome, routeKey, route, title, titleState } = input.descriptor;

  const routeWidth = route.definition ?? resolvePaneRouteWidthContract(input.pane.href);
  const hasVisibleSecondaryMismatch =
    input.secondaryPane?.visibility === "visible" &&
    input.secondaryPublication &&
    (
      input.secondaryPane.groupId !== input.secondaryPublication.groupId ||
      !secondaryPublicationIncludesSurface(
        input.secondaryPublication,
        input.secondaryPane.activeSurfaceId,
      )
    );
  const runtimeSecondaryPane = hasVisibleSecondaryMismatch
    ? null
    : input.secondaryPane;
  const visibleSecondaryPane =
    input.secondaryPane?.visibility === "visible" &&
    input.secondaryPublication &&
    !hasVisibleSecondaryMismatch
      ? input.secondaryPane
      : input.secondaryPane?.visibility === "collapsed"
        ? input.secondaryPane
        : null;

  return {
    paneId: input.pane.id,
    href: input.pane.href,
    route,
    routeKey,
    resourceItem: input.resourceItem,
    resourceStatus: input.resourceItem?.missing
      ? "missing"
      : input.resourceItem
        ? "ready"
        : input.resourceStatus,
    title,
    titleState,
    toolbar: chrome?.toolbar,
    actions: chrome?.actions,
    navigation: {
      canGoBack: input.pane.history.back.length > 0,
      canGoForward: input.pane.history.forward.length > 0,
      onBack: () => input.goBackPane(input.pane.id),
      onForward: () => input.goForwardPane(input.pane.id),
    },
    bodyMode: route.definition?.bodyMode ?? "standard",
    runtimeSecondaryPane,
    secondaryPane: visibleSecondaryPane,
    sizing: resolveEffectivePaneSizing({
      storedWidthPx: input.pane.primaryWidthPx,
      workspacePrimaryMetrics: input.workspacePrimaryMetrics,
      routeWidth,
      runtimeLayout: input.runtimeLayout,
      fixedChromeWidthPx: input.fixedChromePublication?.widthPx ?? 0,
      isMobile: input.isMobile,
    }),
    secondarySizing:
      !input.isMobile && visibleSecondaryPane
        ? resolveEffectiveSecondarySizing({
            storedWidthPx: visibleSecondaryPane.widthPx,
            policy: getSecondaryWidthPolicy(visibleSecondaryPane.groupId),
          })
        : null,
    secondaryPublication: input.secondaryPublication,
    fixedChromePublication: input.isMobile ? null : input.fixedChromePublication,
    isActive: input.isActive,
    visibility: input.pane.visibility,
    content: <PaneContent href={input.pane.href} route={route} routeKey={routeKey} />,
  };
}

// ---------------------------------------------------------------------------
// WorkspaceHost — the top-level pane orchestrator. Reads workspace state,
// builds pane descriptors, and renders the shell layout with pane strip.
// ---------------------------------------------------------------------------

function WorkspaceHost() {
  const {
    state,
    runtimeTitleByPaneId,
    activatePane,
    openPane,
    navigatePane,
    goBackPane,
    goForwardPane,
    closePane,
    resizePrimaryPane,
    requestSecondarySurface,
    closeSecondaryPane,
    dropSecondaryPane,
    setSecondarySurface,
    resizeSecondaryPane,
    minimizePane,
    restorePane,
    publishPaneTitle,
    workspacePrimaryMetrics,
  } = useWorkspaceHostStore();
  const titleTelemetryByPaneIdRef = useRef<Map<string, string>>(new Map());
  const [runtimeLayoutByPaneId, setRuntimeLayoutByPaneId] = useState<
    Map<string, RuntimePaneLayoutRecord>
  >(() => new Map());
  const [secondaryPublicationByPaneId, setSecondaryPublicationByPaneId] = useState<
    Map<string, PaneSecondaryPublicationRecord>
  >(() => new Map());
  const [fixedChromePublicationByPaneId, setFixedChromePublicationByPaneId] =
    useState<Map<string, PaneFixedChromePublicationRecord>>(() => new Map());
  const [resourceItemByRouteKey, setResourceItemByRouteKey] = useState<Map<string, ResourceItem>>(
    () => new Map(),
  );
  const [resourceStatusByRouteKey, setResourceStatusByRouteKey] = useState<
    Map<string, PaneResourceStatus>
  >(() => new Map());
  const keybindings = useKeybindings();
  const androidShell = useAndroidShell();

  // --- Mobile viewport and pane chrome focus state ---
  const isMobile = useIsMobileViewport();
  const layoutMode = isMobile ? "mobile" : "desktop";
  const paneWrapRefById = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingPaneChromeFocusPaneIdRef = useRef<string | null>(null);
  const pendingSecondarySurfaceByRouteKeyRef = useRef<
    Map<string, PendingSecondarySurfaceRequest>
  >(new Map());
  const primaryPanes = useMemo(() => getWorkspacePrimaryPanes(state), [state]);
  const paneDescriptors = useMemo(
    () =>
      primaryPanes.map((pane) => ({
        pane,
        descriptor: resolveWorkspacePaneTitle(pane, runtimeTitleByPaneId, androidShell),
      })),
    [androidShell, primaryPanes, runtimeTitleByPaneId]
  );
  const currentRouteKeyByPaneId = useMemo(
    () =>
      new Map(
        paneDescriptors.map(({ pane, descriptor }) => [
          pane.id,
          descriptor.routeKey,
        ]),
      ),
    [paneDescriptors],
  );
  const currentRouteKeyByPaneIdRef = useRef(currentRouteKeyByPaneId);
  currentRouteKeyByPaneIdRef.current = currentRouteKeyByPaneId;
  const secondaryPublicationByPaneIdRef = useRef(secondaryPublicationByPaneId);
  secondaryPublicationByPaneIdRef.current = secondaryPublicationByPaneId;
  const resourceStatusByRouteKeyRef = useRef(resourceStatusByRouteKey);
  resourceStatusByRouteKeyRef.current = resourceStatusByRouteKey;
  const resourceLocatorEntries = useMemo(
    () =>
      paneDescriptors.flatMap(({ descriptor }) => {
        const locator = resolvePaneResourceLocator(descriptor.route);
        return locator
          ? [{ routeKey: descriptor.routeKey, locator }]
          : [];
      }),
    [paneDescriptors],
  );
  const resourceLocatorRouteKeys = useMemo(
    () => new Set(resourceLocatorEntries.map((entry) => entry.routeKey)),
    [resourceLocatorEntries],
  );

  useEffect(() => {
    const unresolved = resourceLocatorEntries.filter(
      ({ routeKey }) =>
        !resourceItemByRouteKey.has(routeKey) &&
        !resourceStatusByRouteKeyRef.current.has(routeKey),
    );
    if (unresolved.length === 0) {
      return;
    }

    setResourceStatusByRouteKey((current) => {
      const next = new Map(current);
      for (const entry of unresolved) next.set(entry.routeKey, "pending");
      return next;
    });

    let cancelled = false;
    resolveResourceLocators(unresolved.map((entry) => entry.locator))
      .then((resolutions) => {
        if (cancelled) return;
        setResourceItemByRouteKey((current) => {
          const next = new Map(current);
          resolutions.forEach((resolution, index) => {
            const routeKey = unresolved[index]?.routeKey;
            if (routeKey) next.set(routeKey, resolution.resourceItem);
          });
          return next;
        });
        setResourceStatusByRouteKey((current) => {
          const next = new Map(current);
          for (const entry of unresolved) next.set(entry.routeKey, "ready");
          return next;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setResourceStatusByRouteKey((current) => {
          const next = new Map(current);
          for (const entry of unresolved) next.set(entry.routeKey, "error");
          return next;
        });
      });

    return () => {
      cancelled = true;
    };
  }, [resourceItemByRouteKey, resourceLocatorEntries]);

  const publishPaneLayout = useCallback((input: PaneRuntimeLayoutPublication) => {
    if (currentRouteKeyByPaneIdRef.current.get(input.paneId) !== input.routeKey) {
      return;
    }
    setRuntimeLayoutByPaneId((current) =>
      upsertOrDeletePaneLayoutRecord(current, input),
    );
  }, []);

  const publishPaneSecondary = useCallback(
    (input: {
      paneId: string;
      routeKey: string;
      publication: PaneSecondaryPublication | null;
    }) => {
      if (currentRouteKeyByPaneIdRef.current.get(input.paneId) !== input.routeKey) {
        return;
      }
      setSecondaryPublicationByPaneId((current) =>
        upsertOrDeletePaneSecondaryPublicationRecord(current, input),
      );
    },
    [],
  );

  const publishPaneFixedChrome = useCallback(
    (input: {
      paneId: string;
      routeKey: string;
      publication: PaneFixedChromePublication | null;
    }) => {
      if (currentRouteKeyByPaneIdRef.current.get(input.paneId) !== input.routeKey) {
        return;
      }
      setFixedChromePublicationByPaneId((current) =>
        upsertOrDeletePaneFixedChromePublicationRecord(current, input),
      );
    },
    [],
  );

  const openPaneWithPendingSecondary = useCallback(
    (input: {
      href: string;
      openerPaneId?: string | null;
      activate?: boolean;
      titleHint?: string;
      secondarySurfaceId?: WorkspaceSecondarySurfaceId;
    }) => {
      const href = normalizeWorkspaceHref(input.href);
      if (
        href &&
        input.secondarySurfaceId &&
        paneRouteAllowsSecondarySurface(href, input.secondarySurfaceId)
      ) {
        const routeKey = resolvePaneRouteKey(href);
        pendingSecondarySurfaceByRouteKeyRef.current.set(
          routeKey,
          {
            surfaceId: input.secondarySurfaceId,
            targetPaneId:
              [...currentRouteKeyByPaneIdRef.current].find(
                ([, currentRouteKey]) => currentRouteKey === routeKey,
              )?.[0] ?? null,
          },
        );
      }
      openPane({
        href: input.href,
        openerPaneId: input.openerPaneId,
        activate: input.activate,
        titleHint: input.titleHint,
      });
    },
    [openPane],
  );

  useEffect(() => {
    setRuntimeLayoutByPaneId((current) =>
      pruneRuntimePaneLayoutRecords(current, currentRouteKeyByPaneId),
    );
    setSecondaryPublicationByPaneId((current) =>
      prunePaneSecondaryPublicationRecords(current, currentRouteKeyByPaneId),
    );
    setFixedChromePublicationByPaneId((current) =>
      prunePaneFixedChromePublicationRecords(current, currentRouteKeyByPaneId),
    );
    const liveRouteKeys = new Set(currentRouteKeyByPaneId.values());
    setResourceItemByRouteKey((current) => {
      let next: Map<string, ResourceItem> | null = null;
      for (const routeKey of current.keys()) {
        if (liveRouteKeys.has(routeKey)) continue;
        next ??= new Map(current);
        next.delete(routeKey);
      }
      return next ?? current;
    });
    setResourceStatusByRouteKey((current) => {
      let next: Map<string, PaneResourceStatus> | null = null;
      for (const routeKey of current.keys()) {
        if (liveRouteKeys.has(routeKey)) continue;
        next ??= new Map(current);
        next.delete(routeKey);
      }
      return next ?? current;
    });
  }, [currentRouteKeyByPaneId]);

  useEffect(() => {
    const nextTelemetryByPaneId = new Map<string, string>();

    for (const { pane, descriptor } of paneDescriptors) {
      const telemetryKey = [
        descriptor.title,
        descriptor.titleState,
        descriptor.route.id,
      ].join("|");
      nextTelemetryByPaneId.set(pane.id, telemetryKey);
      if (titleTelemetryByPaneIdRef.current.get(pane.id) === telemetryKey) {
        continue;
      }
      emitWorkspaceTelemetry({
        type: "title",
        status: "ok",
        errorCode: null,
        titleState: descriptor.titleState,
        routeId: descriptor.route.id,
      });
    }

    titleTelemetryByPaneIdRef.current = nextTelemetryByPaneId;
  }, [paneDescriptors]);

  const panes = useMemo(
    () =>
      paneDescriptors.map(({ pane, descriptor }) =>
        buildHostPane({
          pane,
          secondaryPane: pane.attachedSecondaryPaneId
            ? state.secondaryPanesById[pane.attachedSecondaryPaneId] ?? null
            : null,
          descriptor,
          resourceItem: resourceItemByRouteKey.get(descriptor.routeKey) ?? null,
          resourceStatus:
            resourceStatusByRouteKey.get(descriptor.routeKey) ??
            (resourceLocatorRouteKeys.has(descriptor.routeKey) ? "pending" : "none"),
          goBackPane,
          goForwardPane,
          isActive: pane.id === state.activePrimaryPaneId,
          runtimeLayout: getRuntimePaneLayout(
            runtimeLayoutByPaneId,
            pane.id,
            descriptor.routeKey,
          ),
          secondaryPublication: getPaneSecondaryPublication(
            secondaryPublicationByPaneId,
            pane.id,
            descriptor.routeKey,
          ),
          fixedChromePublication: getPaneFixedChromePublication(
            fixedChromePublicationByPaneId,
            pane.id,
            descriptor.routeKey,
          ),
          isMobile,
          workspacePrimaryMetrics,
        })
      ),
    [
      paneDescriptors,
      state.activePrimaryPaneId,
      state.secondaryPanesById,
      goBackPane,
      goForwardPane,
      resourceItemByRouteKey,
      resourceLocatorRouteKeys,
      resourceStatusByRouteKey,
      runtimeLayoutByPaneId,
      secondaryPublicationByPaneId,
      fixedChromePublicationByPaneId,
      isMobile,
      workspacePrimaryMetrics,
    ]
  );
  const panesRef = useRef(panes);
  panesRef.current = panes;

  const { canvasRef, onWheel, edges, inViewPaneIds, handleChromeMouseDown, scrollPaneIntoView } =
    usePaneCanvas({
      mode: layoutMode === "desktop" ? "desktop" : "disabled",
      paneIds: panes.map((pane) => pane.paneId),
    });

  useEffect(() => {
    const pending = pendingSecondarySurfaceByRouteKeyRef.current;
    if (pending.size === 0) {
      return;
    }
    for (const [routeKey, request] of pending) {
      const pane = request.targetPaneId
        ? panes.find(
            (item) =>
              item.paneId === request.targetPaneId && item.routeKey === routeKey,
          )
        : panes.find((item) => item.routeKey === routeKey);
      if (!pane) {
        if (request.targetPaneId) {
          pending.delete(routeKey);
        }
        continue;
      }
      if (!paneRouteAllowsSecondarySurface(pane.href, request.surfaceId)) {
        pending.delete(routeKey);
        continue;
      }
      if (!request.targetPaneId) {
        pending.set(routeKey, { ...request, targetPaneId: pane.paneId });
      }
      if (!pane.secondaryPublication) {
        continue;
      }
      pending.delete(routeKey);
      if (
        secondaryPublicationIncludesSurface(
          pane.secondaryPublication,
          request.surfaceId,
        )
      ) {
        requestSecondarySurface(pane.paneId, request.surfaceId);
      }
    }
  }, [panes, requestSecondarySurface]);

  useEffect(() => {
    if (isMobile) {
      return;
    }
    for (const pane of panes) {
      const correctionPx = pane.sizing.storedWidthCorrectionPx;
      if (pane.visibility === "visible" && correctionPx !== null) {
        resizePrimaryPane(pane.paneId, correctionPx);
      }
    }
  }, [isMobile, panes, resizePrimaryPane]);

  useEffect(() => {
    if (isMobile) {
      return;
    }
    for (const pane of panes) {
      const correctionPx = pane.secondarySizing?.storedWidthCorrectionPx ?? null;
      if (correctionPx !== null && pane.secondaryPane) {
        resizeSecondaryPane(pane.secondaryPane.id, correctionPx);
      }
    }
  }, [isMobile, panes, resizeSecondaryPane]);

  useEffect(() => {
    for (const primaryPane of primaryPanes) {
      const secondaryPane = primaryPane.attachedSecondaryPaneId
        ? state.secondaryPanesById[primaryPane.attachedSecondaryPaneId] ?? null
        : null;
      if (!secondaryPane) {
        continue;
      }
      const routeKey = currentRouteKeyByPaneId.get(primaryPane.id);
      const publication = routeKey
        ? getPaneSecondaryPublication(
            secondaryPublicationByPaneId,
            primaryPane.id,
            routeKey,
          )
        : null;
      if (!publication) {
        continue;
      }
      if (secondaryPane.groupId !== publication.groupId) {
        dropSecondaryPane(secondaryPane.id);
        continue;
      }
      if (!secondaryPublicationIncludesSurface(publication, secondaryPane.activeSurfaceId)) {
        setSecondarySurface(secondaryPane.id, publication.defaultSurfaceId);
      }
    }
  }, [
    currentRouteKeyByPaneId,
    dropSecondaryPane,
    primaryPanes,
    secondaryPublicationByPaneId,
    setSecondarySurface,
    state.secondaryPanesById,
  ]);

  const canUsePublishedSecondarySurface = useCallback(
    (paneId: string, surfaceId: WorkspaceSecondarySurfaceId): boolean => {
      const routeKey = currentRouteKeyByPaneIdRef.current.get(paneId);
      if (!routeKey) {
        return false;
      }
      const publication = getPaneSecondaryPublication(
        secondaryPublicationByPaneIdRef.current,
        paneId,
        routeKey,
      );
      return secondaryPublicationIncludesSurface(publication, surfaceId);
    },
    [],
  );

  const handleRequestSecondarySurface = useCallback(
    (paneId: string, surfaceId: WorkspaceSecondarySurfaceId) => {
      if (!canUsePublishedSecondarySurface(paneId, surfaceId)) {
        return;
      }
      requestSecondarySurface(paneId, surfaceId);
    },
    [canUsePublishedSecondarySurface, requestSecondarySurface],
  );

  const handleSetSecondarySurface = useCallback(
    (secondaryPaneId: string, surfaceId: WorkspaceSecondarySurfaceId) => {
      const pane = panesRef.current.find(
        (item) => item.secondaryPane?.id === secondaryPaneId,
      );
      if (!pane || !canUsePublishedSecondarySurface(pane.paneId, surfaceId)) {
        return;
      }
      setSecondarySurface(secondaryPaneId, surfaceId);
    },
    [canUsePublishedSecondarySurface, setSecondarySurface],
  );

  const visiblePaneCount = primaryPanes.filter((pane) => pane.visibility === "visible").length;
  const stripItems = useMemo(
    () =>
      panes.map((pane) => ({
        paneId: pane.paneId,
        href: pane.href,
        title: pane.title,
        titleState: pane.titleState,
        isActive: pane.isActive,
        visibility: pane.visibility,
        canMinimize: pane.visibility === "visible" && visiblePaneCount > 1,
        isInView: inViewPaneIds.has(pane.paneId),
      })),
    [panes, visiblePaneCount, inViewPaneIds]
  );

  const activePane =
    panes.find(
      (pane) =>
        pane.paneId === state.activePrimaryPaneId && pane.visibility === "visible"
    ) ??
    panes.find((pane) => pane.visibility === "visible") ??
    null;
  const renderedPanes = isMobile ? (activePane ? [activePane] : []) : panes;

  // --- Pane chrome focus management ---
  const focusPaneChrome = useCallback((targetPaneId: string) => {
    const paneWrap = paneWrapRefById.current.get(targetPaneId);
    if (!paneWrap) {
      return false;
    }
    const chrome = paneWrap.querySelector<HTMLElement>(
      '[data-pane-chrome-focus="true"]'
    );
    if (!chrome) {
      return false;
    }
    chrome.focus({ preventScroll: true });
    pendingPaneChromeFocusPaneIdRef.current = null;
    return true;
  }, []);

  useEffect(() => {
    const targetPaneId =
      pendingPaneChromeFocusPaneIdRef.current ??
      (isMobile ? state.activePrimaryPaneId : null);
    if (!targetPaneId) {
      return;
    }
    focusPaneChrome(targetPaneId);
  }, [state.activePrimaryPaneId, isMobile, focusPaneChrome]);

  useEffect(() => {
    scrollPaneIntoView(state.activePrimaryPaneId);
  }, [state.activePrimaryPaneId, scrollPaneIntoView]);

  const handleActivatePane = useCallback(
    (paneId: string, options?: { focusPaneChrome?: boolean }) => {
      const shouldFocusPaneChrome = options?.focusPaneChrome !== false;
      activatePane(paneId);
      if (!shouldFocusPaneChrome) {
        return;
      }
      pendingPaneChromeFocusPaneIdRef.current = paneId;
      window.requestAnimationFrame(() => {
        if (pendingPaneChromeFocusPaneIdRef.current === paneId) {
          focusPaneChrome(paneId);
        }
      });
    },
    [activatePane, focusPaneChrome]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }
      const nextCombo = keybindings["pane-next"];
      const prevCombo = keybindings["pane-previous"];
      const isNext = Boolean(nextCombo) && matchesKeyEvent(nextCombo, event);
      const isPrevious = Boolean(prevCombo) && matchesKeyEvent(prevCombo, event);
      if (!isNext && !isPrevious) {
        return;
      }
      event.preventDefault();
      const visible = primaryPanes.filter((pane) => pane.visibility === "visible");
      if (visible.length < 2) {
        return;
      }
      const index = visible.findIndex((pane) => pane.id === state.activePrimaryPaneId);
      const targetIndex = (index + (isNext ? 1 : -1) + visible.length) % visible.length;
      handleActivatePane(visible[targetIndex].id);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [primaryPanes, state.activePrimaryPaneId, keybindings, handleActivatePane]);

  // --- Close handler ---
  const handleClosePane = useCallback(
    (paneId: string) => {
      closePane(paneId);
    },
    [closePane]
  );

  return (
    <section className={styles.host} aria-label="Workspace host">
      {!isMobile && (
        <WorkspacePaneStrip
          items={stripItems}
          onActivatePane={handleActivatePane}
          onMinimizePane={minimizePane}
          onRestorePane={restorePane}
          onClosePane={handleClosePane}
        />
      )}
      <div className={styles.canvasViewport}>
        <div ref={canvasRef} className={styles.paneCanvas} onWheel={onWheel}>
          {renderedPanes.map((pane) => (
            <div
              key={pane.paneId}
              className={styles.paneWrap}
              data-pane-id={pane.paneId}
              data-active={pane.isActive ? "true" : "false"}
              data-mobile={isMobile ? "true" : "false"}
              data-minimized={pane.visibility === "minimized" ? "true" : "false"}
              hidden={pane.visibility === "minimized"}
              inert={pane.visibility === "minimized" ? true : undefined}
              ref={(element) => {
                if (element) {
                  paneWrapRefById.current.set(pane.paneId, element);
                } else {
                  paneWrapRefById.current.delete(pane.paneId);
                }
              }}
              onMouseDown={() => handleActivatePane(pane.paneId, { focusPaneChrome: false })}
            >
              <PaneRuntimeFrame
                paneId={pane.paneId}
                isActive={pane.isActive}
                href={pane.href}
                route={pane.route}
                routeKey={pane.routeKey}
                resourceItem={pane.resourceItem}
                resourceStatus={pane.resourceStatus}
                secondaryPane={pane.runtimeSecondaryPane}
                navigatePane={navigatePane}
                openPane={openPaneWithPendingSecondary}
                canGoBack={pane.navigation.canGoBack}
                canGoForward={pane.navigation.canGoForward}
                goBackPane={goBackPane}
                goForwardPane={goForwardPane}
                publishPaneTitle={publishPaneTitle}
                publishPaneLayout={publishPaneLayout}
                publishPaneSecondary={publishPaneSecondary}
                publishPaneFixedChrome={publishPaneFixedChrome}
                requestSecondarySurface={handleRequestSecondarySurface}
                closeSecondaryPane={closeSecondaryPane}
                setSecondarySurface={handleSetSecondarySurface}
              >
                <PaneShell
                  paneId={pane.paneId}
                  href={pane.href}
                  title={pane.title}
                  titlePending={pane.titleState === "pending"}
                  toolbar={pane.toolbar}
                  actions={pane.actions}
                  options={pane.options}
                  navigation={pane.navigation}
                  sizing={pane.sizing}
                  secondaryPane={pane.secondaryPane}
                  secondarySizing={pane.secondarySizing}
                  secondaryPublication={pane.secondaryPublication}
                  fixedChromePublication={pane.fixedChromePublication}
                  bodyMode={pane.bodyMode}
                  onResizePrimaryPane={resizePrimaryPane}
                  onResizeSecondaryPane={resizeSecondaryPane}
                  onCloseSecondaryPane={closeSecondaryPane}
                  onSetSecondarySurface={handleSetSecondarySurface}
                  onChromeMouseDown={handleChromeMouseDown}
                  isActive={pane.isActive}
                  isMobile={isMobile}
                >
                  {pane.content}
                </PaneShell>
                {isMobile && pane.secondaryPane ? (
                  <MobileSecondaryPaneHost
                    secondaryPaneId={pane.secondaryPane.id}
                    secondary={pane.secondaryPane}
                    publication={pane.secondaryPublication}
                    onClose={closeSecondaryPane}
                    onActiveSurfaceChange={handleSetSecondarySurface}
                  />
                ) : null}
              </PaneRuntimeFrame>
            </div>
          ))}
        </div>
        {layoutMode === "desktop" && edges.atStart ? (
          <div
            className={styles.edgeFade}
            data-side="start"
            data-testid="workspace-edge-fade-start"
          />
        ) : null}
        {layoutMode === "desktop" && edges.atEnd ? (
          <div
            className={styles.edgeFade}
            data-side="end"
            data-testid="workspace-edge-fade-end"
          />
        ) : null}
      </div>
    </section>
  );
}

// Not memo()'d: MobileChromeProvider owns the volatile chrome state and receives
// this whole subtree as stable `children`, so its scroll/publish re-renders never
// reconcile through here — only its context consumers (AppNav, PaneShell) re-render.
// Wrapping a zero-prop component in memo() would also turn rerender() into a no-op.
export default WorkspaceHost;
