"use client";

import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedPaneRoute } from "@/lib/panes/paneRouteRegistry";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  PaneRuntimeProvider,
  type PaneRuntimeLayoutPublication,
} from "@/lib/panes/paneRuntime";
import {
  PaneSecondaryContext,
  type PaneSecondaryPublication,
} from "@/components/workspace/PaneSecondary";
import {
  PaneFixedChromeContext,
  type PaneFixedChromePublication,
} from "@/components/workspace/PaneFixedChrome";
import PaneShell from "@/components/workspace/PaneShell";
import MobileSecondaryPaneHost from "@/components/workspace/MobileSecondaryPaneHost";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { loadKeybindings, matchesKeyEvent } from "@/lib/keybindings";
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
  secondarySurfaceBelongsToGroup,
  type WorkspaceSecondarySizing,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import { emitWorkspaceTelemetry } from "@/lib/workspace/telemetry";
import {
  resolveWorkspacePaneTitle,
  useWorkspaceHostStore,
  type WorkspacePaneTitleDescriptor,
} from "@/lib/workspace/store";
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
  resourceKey: string;
  title: string;
  titleState: "resolved" | "pending";
  subtitle?: React.ReactNode;
  toolbar?: React.ReactNode;
  actions?: React.ReactNode;
  options?: ActionMenuOption[];
  navigation: SurfaceHeaderNavigation;
  bodyMode: PaneBodyMode;
  sizing: EffectivePaneSizing;
  secondaryPane: WorkspaceAttachedSecondaryPaneState | null;
  secondarySizing: WorkspaceSecondarySizing | null;
  secondaryPublication: PaneSecondaryPublication | null;
  fixedChromePublication: PaneFixedChromePublication | null;
  isActive: boolean;
  visibility: "visible" | "minimized";
  content: React.ReactNode;
}

interface RuntimePaneLayoutRecord {
  resourceKey: string;
  layout: PaneRuntimeLayout;
}

interface PaneSecondaryPublicationRecord {
  resourceKey: string;
  publication: PaneSecondaryPublication;
}

interface PaneFixedChromePublicationRecord {
  resourceKey: string;
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
  if (route.render) {
    return route.render();
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
  href,
  route,
  resourceKey,
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
  href: string;
  route: ResolvedPaneRoute;
  resourceKey: string;
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
    resourceKey: string;
    title: string | null;
  }) => void;
  publishPaneLayout: (input: PaneRuntimeLayoutPublication) => void;
  publishPaneSecondary: (input: {
    paneId: string;
    resourceKey: string;
    publication: PaneSecondaryPublication | null;
  }) => void;
  publishPaneFixedChrome: (input: {
    paneId: string;
    resourceKey: string;
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
      publishPaneSecondary({ paneId, resourceKey, publication });
    },
    [paneId, publishPaneSecondary, resourceKey],
  );
  const handlePaneFixedChromePublication = useCallback(
    (publication: PaneFixedChromePublication | null) => {
      publishPaneFixedChrome({ paneId, resourceKey, publication });
    },
    [paneId, publishPaneFixedChrome, resourceKey],
  );

  return (
    <PaneRuntimeProvider
      paneId={paneId}
      href={href}
      routeId={route.id}
      resourceRef={route.resourceRef}
      resourceKey={resourceKey}
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
  route,
  resourceKey,
}: {
  route: ResolvedPaneRoute;
  resourceKey: string;
}) {
  return (
    <div className={styles.routeShell}>
      <PaneRouteErrorBoundary resetKey={resourceKey}>
        <ResolvedPaneRouteView key={resourceKey} route={route} />
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
    if (!existing || existing.resourceKey !== input.resourceKey) return current;
    const next = new Map(current);
    next.delete(input.paneId);
    return next;
  }
  if (
    existing?.resourceKey === input.resourceKey &&
    existing.layout.primaryWidth.kind === layout.primaryWidth.kind &&
    (layout.primaryWidth.kind === "workspace" ||
      existing.layout.primaryWidth.kind === "intrinsic" &&
        existing.layout.primaryWidth.widthPx === layout.primaryWidth.widthPx)
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(input.paneId, { resourceKey: input.resourceKey, layout });
  return next;
}

function normalizePaneSecondaryPublication(
  publication: PaneSecondaryPublication,
): PaneSecondaryPublication {
  if (publication.surfaces.length === 0) {
    throw new Error("Pane secondary publication requires at least one surface.");
  }
  const surfaceIds = new Set<WorkspaceSecondarySurfaceId>();
  for (const surface of publication.surfaces) {
    if (!secondarySurfaceBelongsToGroup(surface.id, publication.groupId)) {
      throw new Error(
        `Secondary surface ${surface.id} does not belong to group ${publication.groupId}.`,
      );
    }
    if (surfaceIds.has(surface.id)) {
      throw new Error(`Duplicate secondary surface publication: ${surface.id}.`);
    }
    surfaceIds.add(surface.id);
  }
  if (!surfaceIds.has(publication.defaultSurfaceId)) {
    throw new Error(
      `Default secondary surface ${publication.defaultSurfaceId} is not published.`,
    );
  }
  return {
    ...publication,
    surfaces: publication.surfaces.map((surface) => ({ ...surface })),
  };
}

function arePaneSecondaryPublicationsEqual(
  left: PaneSecondaryPublication,
  right: PaneSecondaryPublication,
): boolean {
  if (
    left.groupId !== right.groupId ||
    left.defaultSurfaceId !== right.defaultSurfaceId ||
    left.surfaces.length !== right.surfaces.length
  ) {
    return false;
  }
  return left.surfaces.every((surface, index) => {
    const other = right.surfaces[index];
    return (
      other?.id === surface.id &&
      other.body === surface.body &&
      other.mobileBody === surface.mobileBody
    );
  });
}

function normalizePaneFixedChromePublication(
  publication: PaneFixedChromePublication,
): PaneFixedChromePublication {
  if (!Number.isFinite(publication.widthPx) || publication.widthPx < 0) {
    throw new Error("Pane fixed chrome width must be non-negative.");
  }
  return { ...publication, widthPx: Math.ceil(publication.widthPx) };
}

function upsertOrDeletePaneSecondaryPublicationRecord(
  current: Map<string, PaneSecondaryPublicationRecord>,
  input: {
    paneId: string;
    resourceKey: string;
    publication: PaneSecondaryPublication | null;
  },
): Map<string, PaneSecondaryPublicationRecord> {
  const existing = current.get(input.paneId);
  if (!input.publication) {
    if (!existing || existing.resourceKey !== input.resourceKey) return current;
    const next = new Map(current);
    next.delete(input.paneId);
    return next;
  }
  const publication = normalizePaneSecondaryPublication(input.publication);
  if (
    existing?.resourceKey === input.resourceKey &&
    arePaneSecondaryPublicationsEqual(existing.publication, publication)
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(input.paneId, { resourceKey: input.resourceKey, publication });
  return next;
}

function upsertOrDeletePaneFixedChromePublicationRecord(
  current: Map<string, PaneFixedChromePublicationRecord>,
  input: {
    paneId: string;
    resourceKey: string;
    publication: PaneFixedChromePublication | null;
  },
): Map<string, PaneFixedChromePublicationRecord> {
  const existing = current.get(input.paneId);
  if (!input.publication) {
    if (!existing || existing.resourceKey !== input.resourceKey) return current;
    const next = new Map(current);
    next.delete(input.paneId);
    return next;
  }
  const publication = normalizePaneFixedChromePublication(input.publication);
  if (
    existing?.resourceKey === input.resourceKey &&
    existing.publication.id === publication.id &&
    existing.publication.widthPx === publication.widthPx &&
    existing.publication.body === publication.body
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(input.paneId, { resourceKey: input.resourceKey, publication });
  return next;
}

function getRuntimePaneLayout(
  records: Map<string, RuntimePaneLayoutRecord>,
  paneId: string,
  resourceKey: string,
): PaneRuntimeLayout {
  const record = records.get(paneId);
  return record?.resourceKey === resourceKey
    ? record.layout
    : DEFAULT_PANE_RUNTIME_LAYOUT;
}

function getPaneSecondaryPublication(
  records: Map<string, PaneSecondaryPublicationRecord>,
  paneId: string,
  resourceKey: string,
): PaneSecondaryPublication | null {
  const record = records.get(paneId);
  return record?.resourceKey === resourceKey ? record.publication : null;
}

function getPaneFixedChromePublication(
  records: Map<string, PaneFixedChromePublicationRecord>,
  paneId: string,
  resourceKey: string,
): PaneFixedChromePublication | null {
  const record = records.get(paneId);
  return record?.resourceKey === resourceKey ? record.publication : null;
}

function pruneRuntimePaneLayoutRecords(
  current: Map<string, RuntimePaneLayoutRecord>,
  currentResourceKeyByPaneId: Map<string, string>,
): Map<string, RuntimePaneLayoutRecord> {
  let next: Map<string, RuntimePaneLayoutRecord> | null = null;
  for (const [paneId, record] of current) {
    if (currentResourceKeyByPaneId.get(paneId) === record.resourceKey) {
      continue;
    }
    next ??= new Map(current);
    next.delete(paneId);
  }
  return next ?? current;
}

function prunePaneSecondaryPublicationRecords(
  current: Map<string, PaneSecondaryPublicationRecord>,
  currentResourceKeyByPaneId: Map<string, string>,
): Map<string, PaneSecondaryPublicationRecord> {
  let next: Map<string, PaneSecondaryPublicationRecord> | null = null;
  for (const [paneId, record] of current) {
    if (currentResourceKeyByPaneId.get(paneId) === record.resourceKey) {
      continue;
    }
    next ??= new Map(current);
    next.delete(paneId);
  }
  return next ?? current;
}

function prunePaneFixedChromePublicationRecords(
  current: Map<string, PaneFixedChromePublicationRecord>,
  currentResourceKeyByPaneId: Map<string, string>,
): Map<string, PaneFixedChromePublicationRecord> {
  let next: Map<string, PaneFixedChromePublicationRecord> | null = null;
  for (const [paneId, record] of current) {
    if (currentResourceKeyByPaneId.get(paneId) === record.resourceKey) {
      continue;
    }
    next ??= new Map(current);
    next.delete(paneId);
  }
  return next ?? current;
}

function secondaryPublicationIncludesSurface(
  publication: PaneSecondaryPublication | null,
  surfaceId: WorkspaceSecondarySurfaceId,
): boolean {
  return Boolean(publication?.surfaces.some((surface) => surface.id === surfaceId));
}

function buildHostPane(input: {
  pane: WorkspacePrimaryPaneState;
  secondaryPane: WorkspaceAttachedSecondaryPaneState | null;
  descriptor: WorkspacePaneTitleDescriptor;
  goBackPane: (paneId: string) => void;
  goForwardPane: (paneId: string) => void;
  isActive: boolean;
  runtimeLayout: PaneRuntimeLayout;
  secondaryPublication: PaneSecondaryPublication | null;
  fixedChromePublication: PaneFixedChromePublication | null;
  isMobile: boolean;
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
}): WorkspaceHostPane {
  const { chrome, resourceKey, route, title, titleState } = input.descriptor;

  const routeWidth = route.definition ?? resolvePaneRouteWidthContract(input.pane.href);
  const visibleSecondaryPane =
    input.secondaryPane?.visibility === "visible" &&
    (!input.secondaryPublication ||
      input.secondaryPane.groupId !== input.secondaryPublication.groupId ||
      !secondaryPublicationIncludesSurface(
        input.secondaryPublication,
        input.secondaryPane.activeSurfaceId,
      ))
      ? null
      : input.secondaryPane;

  return {
    paneId: input.pane.id,
    href: input.pane.href,
    route,
    resourceKey,
    title,
    titleState,
    subtitle: chrome?.subtitle,
    toolbar: chrome?.toolbar,
    actions: chrome?.actions,
    navigation: {
      canGoBack: input.pane.history.back.length > 0,
      canGoForward: input.pane.history.forward.length > 0,
      onBack: () => input.goBackPane(input.pane.id),
      onForward: () => input.goForwardPane(input.pane.id),
    },
    bodyMode: route.definition?.bodyMode ?? "standard",
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
    content: <PaneContent route={route} resourceKey={resourceKey} />,
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

  // --- Mobile viewport and pane chrome focus state ---
  const isMobile = useIsMobileViewport();
  const paneWrapRefById = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingPaneChromeFocusPaneIdRef = useRef<string | null>(null);
  const pendingSecondarySurfaceByResourceKeyRef = useRef<
    Map<string, PendingSecondarySurfaceRequest>
  >(new Map());
  const primaryPanes = useMemo(() => getWorkspacePrimaryPanes(state), [state]);
  const paneDescriptors = useMemo(
    () =>
      primaryPanes.map((pane) => ({
        pane,
        descriptor: resolveWorkspacePaneTitle(pane, runtimeTitleByPaneId),
      })),
    [primaryPanes, runtimeTitleByPaneId]
  );
  const currentResourceKeyByPaneId = useMemo(
    () =>
      new Map(
        paneDescriptors.map(({ pane, descriptor }) => [
          pane.id,
          descriptor.resourceKey,
        ]),
      ),
    [paneDescriptors],
  );
  const currentResourceKeyByPaneIdRef = useRef(currentResourceKeyByPaneId);
  currentResourceKeyByPaneIdRef.current = currentResourceKeyByPaneId;
  const secondaryPublicationByPaneIdRef = useRef(secondaryPublicationByPaneId);
  secondaryPublicationByPaneIdRef.current = secondaryPublicationByPaneId;

  const publishPaneLayout = useCallback((input: PaneRuntimeLayoutPublication) => {
    if (currentResourceKeyByPaneIdRef.current.get(input.paneId) !== input.resourceKey) {
      return;
    }
    setRuntimeLayoutByPaneId((current) =>
      upsertOrDeletePaneLayoutRecord(current, input),
    );
  }, []);

  const publishPaneSecondary = useCallback(
    (input: {
      paneId: string;
      resourceKey: string;
      publication: PaneSecondaryPublication | null;
    }) => {
      if (currentResourceKeyByPaneIdRef.current.get(input.paneId) !== input.resourceKey) {
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
      resourceKey: string;
      publication: PaneFixedChromePublication | null;
    }) => {
      if (currentResourceKeyByPaneIdRef.current.get(input.paneId) !== input.resourceKey) {
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
        const resourceKey = resolvePaneRouteIdentity(href).resourceKey;
        pendingSecondarySurfaceByResourceKeyRef.current.set(
          resourceKey,
          {
            surfaceId: input.secondarySurfaceId,
            targetPaneId:
              [...currentResourceKeyByPaneIdRef.current].find(
                ([, currentResourceKey]) => currentResourceKey === resourceKey,
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
      pruneRuntimePaneLayoutRecords(current, currentResourceKeyByPaneId),
    );
    setSecondaryPublicationByPaneId((current) =>
      prunePaneSecondaryPublicationRecords(current, currentResourceKeyByPaneId),
    );
    setFixedChromePublicationByPaneId((current) =>
      prunePaneFixedChromePublicationRecords(current, currentResourceKeyByPaneId),
    );
  }, [currentResourceKeyByPaneId]);

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
          goBackPane,
          goForwardPane,
          isActive: pane.id === state.activePrimaryPaneId,
          runtimeLayout: getRuntimePaneLayout(
            runtimeLayoutByPaneId,
            pane.id,
            descriptor.resourceKey,
          ),
          secondaryPublication: getPaneSecondaryPublication(
            secondaryPublicationByPaneId,
            pane.id,
            descriptor.resourceKey,
          ),
          fixedChromePublication: getPaneFixedChromePublication(
            fixedChromePublicationByPaneId,
            pane.id,
            descriptor.resourceKey,
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
    usePaneCanvas({ enabled: !isMobile, paneIds: panes.map((pane) => pane.paneId) });

  useEffect(() => {
    const pending = pendingSecondarySurfaceByResourceKeyRef.current;
    if (pending.size === 0) {
      return;
    }
    for (const [resourceKey, request] of pending) {
      const pane = request.targetPaneId
        ? panes.find(
            (item) =>
              item.paneId === request.targetPaneId && item.resourceKey === resourceKey,
          )
        : panes.find((item) => item.resourceKey === resourceKey);
      if (!pane) {
        if (request.targetPaneId) {
          pending.delete(resourceKey);
        }
        continue;
      }
      if (!paneRouteAllowsSecondarySurface(pane.href, request.surfaceId)) {
        pending.delete(resourceKey);
        continue;
      }
      if (!request.targetPaneId) {
        pending.set(resourceKey, { ...request, targetPaneId: pane.paneId });
      }
      if (!pane.secondaryPublication) {
        continue;
      }
      pending.delete(resourceKey);
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
      const resourceKey = currentResourceKeyByPaneId.get(primaryPane.id);
      const publication = resourceKey
        ? getPaneSecondaryPublication(
            secondaryPublicationByPaneId,
            primaryPane.id,
            resourceKey,
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
    currentResourceKeyByPaneId,
    dropSecondaryPane,
    primaryPanes,
    secondaryPublicationByPaneId,
    setSecondarySurface,
    state.secondaryPanesById,
  ]);

  const canUsePublishedSecondarySurface = useCallback(
    (paneId: string, surfaceId: WorkspaceSecondarySurfaceId): boolean => {
      const resourceKey = currentResourceKeyByPaneIdRef.current.get(paneId);
      if (!resourceKey) {
        return false;
      }
      const publication = getPaneSecondaryPublication(
        secondaryPublicationByPaneIdRef.current,
        paneId,
        resourceKey,
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
  useEffect(() => {
    const targetPaneId =
      pendingPaneChromeFocusPaneIdRef.current ??
      (isMobile ? state.activePrimaryPaneId : null);
    if (!targetPaneId) {
      return;
    }
    const paneWrap = paneWrapRefById.current.get(targetPaneId);
    if (!paneWrap) {
      return;
    }
    const chrome = paneWrap.querySelector<HTMLElement>(
      '[data-pane-chrome-focus="true"]'
    );
    if (!chrome) {
      return;
    }
    chrome.focus({ preventScroll: true });
    pendingPaneChromeFocusPaneIdRef.current = null;
  }, [state.activePrimaryPaneId, isMobile]);

  useEffect(() => {
    scrollPaneIntoView(state.activePrimaryPaneId);
  }, [state.activePrimaryPaneId, scrollPaneIntoView]);

  const handleActivatePane = (
    paneId: string,
    options?: { focusPaneChrome?: boolean }
  ) => {
    const shouldFocusPaneChrome = options?.focusPaneChrome !== false;
    activatePane(paneId);
    const paneWrap = paneWrapRefById.current.get(paneId);
    if (!shouldFocusPaneChrome) {
      return;
    }
    if (!paneWrap) {
      pendingPaneChromeFocusPaneIdRef.current = paneId;
      return;
    }
    const chrome = paneWrap.querySelector<HTMLElement>(
      '[data-pane-chrome-focus="true"]'
    );
    if (!chrome) {
      pendingPaneChromeFocusPaneIdRef.current = paneId;
      return;
    }
    chrome.focus({ preventScroll: true });
    pendingPaneChromeFocusPaneIdRef.current = null;
  };

  useEffect(() => {
    const keybindings = loadKeybindings();
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
      activatePane(visible[targetIndex].id);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [primaryPanes, state.activePrimaryPaneId, activatePane]);

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
                href={pane.href}
                route={pane.route}
                resourceKey={pane.resourceKey}
                secondaryPane={pane.secondaryPane}
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
                  subtitle={pane.subtitle}
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
        {edges.atStart && <div className={styles.edgeFade} data-side="start" />}
        {edges.atEnd && <div className={styles.edgeFade} data-side="end" />}
      </div>
    </section>
  );
}

// Memoized (no props) so the lifted MobileChromeProvider re-rendering on scroll
// or pane-chrome publish never cascades back into the pane tree.
export default memo(WorkspaceHost);
