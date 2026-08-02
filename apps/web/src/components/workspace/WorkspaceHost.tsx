"use client";

import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ResolvedPaneRoute } from "@/lib/panes/paneRouteTable";
import { renderPane } from "@/lib/panes/paneRenderRegistry";
import {
  PaneRuntimeProvider,
  type PaneNavigationCommandOptions,
  type PaneNavigationModality,
  type PaneResourceStatus,
  type PaneRuntimeLayoutPublication,
} from "@/lib/panes/paneRuntime";
import {
  resolvePaneResourceLocator,
  resolvePaneRouteShareIdentity,
  type PaneResourceLocator,
  type PaneRouteShareIdentity,
} from "@/lib/panes/paneResourceLocator";
import { PaneSecondaryContext } from "@/components/workspace/PaneSecondary";
import { PaneFixedChromeContext } from "@/components/workspace/PaneFixedChrome";
import PaneShell from "@/components/workspace/PaneShell";
import MobileSecondaryPaneHost from "@/components/workspace/MobileSecondaryPaneHost";
import SecondaryPaneShell from "@/components/workspace/SecondaryPaneShell";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { getBrowserViewportKind } from "@/lib/renderEnvironment/provider";
import { matchesKeyEvent } from "@/lib/keybindings";
import { dispatchPaneSearchRequest } from "@/lib/panes/paneSearchEvents";
import { useKeybindings } from "@/lib/keybindingsProvider";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import type { PaneBodyMode } from "@/lib/panes/paneRouteModel";
import {
  paneRouteAllowsSecondarySurface,
  resolvePaneRouteWidthContract,
} from "@/lib/panes/paneRouteModel";
import {
  getWorkspacePrimaryPanes,
  type PaneVisitId,
  type WorkspaceAttachedSecondaryPaneState,
  type WorkspacePrimaryPaneState,
} from "@/lib/workspace/schema";
import {
  DEFAULT_PANE_RUNTIME_LAYOUT,
  normalizePaneRuntimeLayout,
  resolveEffectivePaneSizing,
  type EffectivePaneSizing,
  type PaneRuntimeLayout,
  type WorkspacePrimaryMetrics,
} from "@/lib/workspace/paneSizing";
import {
  getSecondaryWidthPolicy,
  resolveEffectiveSecondarySizing,
  type PaneTransientSecondarySurfaceId,
  type WorkspaceDossierActivation,
  type WorkspaceSecondarySizing,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import {
  arePaneFixedChromePublicationsEqual,
  arePaneSecondaryPublicationsEqual,
  getPublishedTransientSecondarySurface,
  normalizePaneFixedChromePublication,
  normalizePaneSecondaryPublication,
  secondaryPublicationIncludesSurface,
  secondaryPublicationIncludesTransientSurface,
  type PaneFixedChromePublication,
  type PaneSecondaryPublication,
  type PaneTransientSecondarySurfacePublication,
} from "@/lib/panes/panePublications";
import { emitWorkspaceTelemetry } from "@/lib/workspace/telemetry";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import {
  paneResourceLocatorKey,
  resolvePaneRouteIdentity,
} from "@/lib/panes/paneIdentity";
import {
  resolveWorkspacePaneLabel,
  useWorkspaceHostStore,
  type WorkspacePaneLabelDescriptor,
} from "@/lib/workspace/store";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import { resolveResourceLocators } from "@/lib/resources/resourceLocators";
import type {
  PaneEntryDelivery,
  WorkspaceTargetActivationRequest,
  WorkspaceTargetActivationResult,
} from "@/lib/workspace/targetActivation";
import { usePaneCanvas } from "./usePaneCanvas";
import PaneRouteBoundary from "./PaneRouteBoundary";
import styles from "./WorkspaceHost.module.css";

// ---------------------------------------------------------------------------
// WorkspaceHostPane - host-owned pane render model.
// ---------------------------------------------------------------------------

interface WorkspaceHostPane {
  paneId: string;
  visitId: PaneVisitId;
  href: string;
  route: ResolvedPaneRoute;
  routeKey: string;
  routeShareIdentity: PaneRouteShareIdentity | null;
  resourceItem: ResourceItem | null;
  resourceStatus: PaneResourceStatus;
  label: string;
  labelState: "resolved" | "pending";
  canGoBack: boolean;
  canGoForward: boolean;
  bodyMode: PaneBodyMode;
  sizing: EffectivePaneSizing;
  runtimeSecondaryPane: WorkspaceAttachedSecondaryPaneState | null;
  secondaryPane: WorkspaceAttachedSecondaryPaneState | null;
  secondarySizing: WorkspaceSecondarySizing | null;
  secondaryPublication: PaneSecondaryPublication | null;
  transientSecondarySurface: PaneTransientSecondarySurfacePublication | null;
  transientSecondaryExpanded: boolean;
  transientSecondarySizing: WorkspaceSecondarySizing | null;
  transientSecondaryPaneId: string;
  fixedChromePublication: PaneFixedChromePublication | null;
  isActive: boolean;
  visibility: "visible" | "minimized";
  content: React.ReactNode;
}

interface PendingResponsivePaneSearchDelivery {
  readonly id: number;
  readonly paneId: string;
  readonly routeKey: string;
  readonly targetIsMobile: boolean;
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

interface SecondaryActivationDelivery {
  routeKey: string;
  activation: WorkspaceDossierActivation;
}

interface PaneTransientSecondaryActivationRecord {
  routeKey: string;
  surfaceId: PaneTransientSecondarySurfaceId;
  expanded: boolean;
  widthPx: number;
}

// ---------------------------------------------------------------------------
// PaneRouteErrorBoundary — class component (must remain a class component
// because getDerivedStateFromError requires it).
// ---------------------------------------------------------------------------

interface PaneRouteErrorBoundaryProps {
  children: React.ReactNode;
  paneId: string;
  resetKey: string;
  slotMinWidth: string;
}

class PaneRouteErrorBoundary extends Component<
  PaneRouteErrorBoundaryProps,
  { hasError: boolean; resetKey: string }
> {
  constructor(props: PaneRouteErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromProps(
    props: PaneRouteErrorBoundaryProps,
    state: { hasError: boolean; resetKey: string },
  ): { hasError: false; resetKey: string } | null {
    return props.resetKey === state.resetKey
      ? null
      : { hasError: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): { hasError: true } {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // Keep the pane host stable, but never make a routed-pane defect
    // operationally invisible.
    console.error(
      `Workspace pane ${this.props.paneId} failed to render:`,
      error,
    );
  }

  render() {
    return (
      <div
        className={styles.paneErrorBoundaryShell}
        data-pane-error-boundary-shell="true"
        data-testid={`pane-error-boundary-${this.props.paneId}`}
        style={{ minWidth: this.props.slotMinWidth }}
      >
        {this.state.hasError ? (
          <section
            className={styles.unsupported}
            aria-label="Pane failed to render"
          >
            This pane failed to render. Close it and retry.
          </section>
        ) : (
          this.props.children
        )}
      </div>
    );
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
      This route is not yet supported in side-by-side pane mode: `
      {route.pathname}`
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaneRuntimeFrame - owns pane-scoped runtime capabilities for the whole pane
// shell, including chrome and routed body content.
// ---------------------------------------------------------------------------

const PaneRuntimeFrame = memo(function PaneRuntimeFrame({
  paneId,
  visitId,
  isActive,
  href,
  route,
  routeKey,
  resourceItem,
  resourceStatus,
  secondaryPane,
  secondaryActivation,
  paneEntryDelivery,
  transientSecondarySurface,
  navigatePane,
  activateWorkspaceTarget,
  canGoBack,
  canGoForward,
  goBackPane,
  goForwardPane,
  publishPaneLabel,
  publishPaneLayout,
  publishPaneSecondary,
  publishPaneFixedChrome,
  requestSecondarySurface,
  closeSecondaryPane,
  setSecondarySurface,
  requestTransientSecondarySurface,
  closeTransientSecondarySurface,
  previewTransientSecondaryResult,
  acknowledgeSecondaryActivation,
  acknowledgePaneEntryDelivery,
  publishPaneAliases,
  children,
}: {
  paneId: string;
  visitId: PaneVisitId;
  isActive: boolean;
  href: string;
  route: ResolvedPaneRoute;
  routeKey: string;
  resourceItem: ResourceItem | null;
  resourceStatus: PaneResourceStatus;
  secondaryPane: WorkspaceAttachedSecondaryPaneState | null;
  secondaryActivation: WorkspaceDossierActivation | null;
  paneEntryDelivery: PaneEntryDelivery | null;
  transientSecondarySurface: {
    readonly id: PaneTransientSecondarySurfaceId;
    readonly expanded: boolean;
  } | null;
  navigatePane: (
    paneId: string,
    href: string,
    options?: {
      replace?: boolean;
      activate?: boolean;
      labelHint?: string;
      modality?: PaneNavigationModality;
    },
  ) => void;
  activateWorkspaceTarget: (
    request: WorkspaceTargetActivationRequest,
  ) => WorkspaceTargetActivationResult;
  canGoBack: boolean;
  canGoForward: boolean;
  goBackPane: (paneId: string, modality?: PaneNavigationModality) => void;
  goForwardPane: (paneId: string, modality?: PaneNavigationModality) => void;
  publishPaneLabel: (input: {
    paneId: string;
    routeKey: string;
    label: string | null;
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
    returnFocusTo?: HTMLElement | null,
  ) => void;
  closeSecondaryPane: (secondaryPaneId: string) => void;
  setSecondarySurface: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  requestTransientSecondarySurface: (
    paneId: string,
    routeKey: string,
    surfaceId: PaneTransientSecondarySurfaceId,
    returnFocusTo?: HTMLElement | null,
  ) => void;
  closeTransientSecondarySurface: (paneId: string, routeKey: string) => void;
  previewTransientSecondaryResult: (
    paneId: string,
    routeKey: string,
  ) => void;
  acknowledgeSecondaryActivation: (
    paneId: string,
    routeKey: string,
    activation: WorkspaceDossierActivation,
  ) => void;
  acknowledgePaneEntryDelivery: (delivery: PaneEntryDelivery) => void;
  publishPaneAliases: (input: {
    paneId: string;
    visitId: string;
    aliases: readonly string[];
  }) => void;
  children: React.ReactNode;
}) {
  const handleReplacePane = useCallback(
    (pid: string, h: string, options: PaneNavigationCommandOptions) =>
      navigatePane(pid, h, {
        replace: true,
        labelHint: options.labelHint,
        modality: options.modality,
      }),
    [navigatePane],
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
      visitId={visitId}
      isActive={isActive}
      href={href}
      routeId={route.id}
      routeKey={routeKey}
      resourceItem={resourceItem}
      resourceStatus={resourceStatus}
      secondaryPane={secondaryPane}
      secondaryActivation={secondaryActivation}
      paneEntryDelivery={paneEntryDelivery}
      transientSecondarySurface={transientSecondarySurface}
      pathParams={route.params}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onNavigatePane={navigatePane}
      onReplacePane={handleReplacePane}
      onActivateWorkspaceTarget={activateWorkspaceTarget}
      onGoBackPane={goBackPane}
      onGoForwardPane={goForwardPane}
      onSetPaneLabel={publishPaneLabel}
      onSetPaneLayout={publishPaneLayout}
      onRequestSecondarySurface={requestSecondarySurface}
      onCloseSecondaryPane={closeSecondaryPane}
      onSetSecondarySurface={setSecondarySurface}
      onRequestTransientSecondarySurface={requestTransientSecondarySurface}
      onCloseTransientSecondarySurface={closeTransientSecondarySurface}
      onPreviewTransientSecondaryResult={previewTransientSecondaryResult}
      onAcknowledgeSecondaryActivation={acknowledgeSecondaryActivation}
      onAcknowledgePaneEntryDelivery={acknowledgePaneEntryDelivery}
      onSetPaneAliases={publishPaneAliases}
    >
      <PaneSecondaryContext.Provider value={handlePaneSecondaryPublication}>
        <PaneFixedChromeContext.Provider
          value={handlePaneFixedChromePublication}
        >
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
  visitId,
  route,
  routeKey,
}: {
  href: string;
  visitId: PaneVisitId;
  route: ResolvedPaneRoute;
  routeKey: string;
}) {
  const routeMountKey = useMemo(() => {
    const identity = resolvePaneRouteIdentity(href);
    const resourceKey = paneResourceLocatorKey(identity.resourceLocator);
    return resourceKey ? `${identity.routeId}:${resourceKey}` : routeKey;
  }, [href, routeKey]);

  const contentMountKey =
    route.definition?.queryNavigation === "in-place"
      ? `${visitId}:${route.id}:${route.pathname}`
      : route.definition?.returnMemento.kind === "ShellScroll"
        ? `${visitId}:${routeKey}`
        : routeMountKey;

  return (
    <div className={styles.routeShell}>
      <ResolvedPaneRouteView key={contentMountKey} route={route} />
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
  const layout = input.layout;
  const existing = current.get(input.paneId);
  if (layout === null) {
    if (!existing || existing.routeKey !== input.routeKey) return current;
    const next = new Map(current);
    next.delete(input.paneId);
    return next;
  }
  if (
    existing?.routeKey === input.routeKey &&
    existing.layout.primaryWidth.kind === layout.primaryWidth.kind &&
    (layout.primaryWidth.kind === "workspace" ||
      (existing.layout.primaryWidth.kind === "intrinsic" &&
        existing.layout.primaryWidth.widthPx === layout.primaryWidth.widthPx))
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
  const publication = input.publication;
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
  const publication = input.publication;
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

function getRuntimePaneLayoutRecord(
  records: Map<string, RuntimePaneLayoutRecord>,
  paneId: string,
  routeKey: string,
): RuntimePaneLayoutRecord | null {
  const record = records.get(paneId);
  return record?.routeKey === routeKey ? record : null;
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
  descriptor: WorkspacePaneLabelDescriptor;
  resourceItem: ResourceItem | null;
  resourceStatus: PaneResourceStatus;
  isActive: boolean;
  runtimeLayout: PaneRuntimeLayout;
  runtimeLayoutResolved: boolean;
  secondaryPublication: PaneSecondaryPublication | null;
  transientSecondaryActivation: PaneTransientSecondaryActivationRecord | null;
  fixedChromePublication: PaneFixedChromePublication | null;
  isMobile: boolean;
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
}): WorkspaceHostPane {
  const { routeKey, route, label, labelState } = input.descriptor;

  const href = input.pane.currentVisit.href;
  const routeWidth = route.definition ?? resolvePaneRouteWidthContract(href);
  const hasVisibleSecondaryGroupMismatch =
    input.secondaryPane?.visibility === "visible" &&
    input.secondaryPublication &&
    input.secondaryPane.groupId !== input.secondaryPublication.groupId;
  const hasVisibleStaleSurface =
    input.secondaryPane?.visibility === "visible" &&
    input.secondaryPublication &&
    !hasVisibleSecondaryGroupMismatch &&
    !secondaryPublicationIncludesSurface(
      input.secondaryPublication,
      input.secondaryPane.activeSurfaceId,
    );
  const durableDefaultSurfaceId =
    input.secondaryPublication?.defaultSurfaceId ?? null;
  const renderSecondaryPane =
    hasVisibleStaleSurface &&
    input.secondaryPane &&
    durableDefaultSurfaceId !== null
      ? {
          ...input.secondaryPane,
          activeSurfaceId: durableDefaultSurfaceId,
        }
      : input.secondaryPane;
  const runtimeSecondaryPane = hasVisibleSecondaryGroupMismatch
    ? null
    : renderSecondaryPane;
  const visibleSecondaryPane =
    renderSecondaryPane?.visibility === "visible" &&
    input.secondaryPublication &&
    !hasVisibleSecondaryGroupMismatch
      ? renderSecondaryPane
      : renderSecondaryPane?.visibility === "collapsed"
        ? renderSecondaryPane
        : null;
  const transientSecondarySurface =
    input.transientSecondaryActivation &&
    input.transientSecondaryActivation.routeKey === routeKey
      ? getPublishedTransientSecondarySurface(
          input.secondaryPublication,
          input.transientSecondaryActivation.surfaceId,
        )
      : null;
  const transientSecondaryExpanded = Boolean(
    transientSecondarySurface && input.transientSecondaryActivation?.expanded,
  );
  const transientSecondarySizing =
    !input.isMobile &&
    transientSecondarySurface &&
    input.secondaryPublication
      ? resolveEffectiveSecondarySizing({
          storedWidthPx:
            visibleSecondaryPane?.widthPx ??
            input.transientSecondaryActivation?.widthPx ??
            getSecondaryWidthPolicy(input.secondaryPublication.groupId)
              .defaultWidthPx,
          policy: getSecondaryWidthPolicy(input.secondaryPublication.groupId),
        })
      : null;

  return {
    paneId: input.pane.id,
    visitId: input.pane.currentVisit.id,
    href,
    route,
    routeKey,
    routeShareIdentity: resolvePaneRouteShareIdentity(route, label),
    resourceItem: input.resourceItem,
    resourceStatus: input.resourceItem?.missing
      ? "missing"
      : input.resourceItem
        ? "ready"
        : input.resourceStatus,
    label,
    labelState,
    canGoBack: input.pane.history.back.length > 0,
    canGoForward: input.pane.history.forward.length > 0,
    bodyMode: route.definition?.bodyMode ?? "standard",
    runtimeSecondaryPane,
    secondaryPane: transientSecondarySurface ? null : visibleSecondaryPane,
    sizing: resolveEffectivePaneSizing({
      storedWidthPx: input.pane.primaryWidthPx,
      workspacePrimaryMetrics: input.workspacePrimaryMetrics,
      routeWidth,
      runtimeLayout: input.runtimeLayout,
      runtimeLayoutResolved: input.runtimeLayoutResolved,
      fixedChromeWidthPx: input.fixedChromePublication?.widthPx ?? 0,
      isMobile: input.isMobile,
    }),
    secondarySizing:
      !input.isMobile && visibleSecondaryPane && !transientSecondarySurface
        ? resolveEffectiveSecondarySizing({
            storedWidthPx: visibleSecondaryPane.widthPx,
            policy: getSecondaryWidthPolicy(visibleSecondaryPane.groupId),
          })
        : null,
    secondaryPublication: input.secondaryPublication,
    transientSecondarySurface,
    transientSecondaryExpanded,
    transientSecondarySizing,
    transientSecondaryPaneId:
      visibleSecondaryPane?.id ??
      `pane-${input.pane.id}-transient-resource-inspector`,
    fixedChromePublication: input.isMobile
      ? null
      : input.fixedChromePublication,
    isActive: input.isActive,
    visibility: input.pane.visibility,
    content: (
      <PaneContent
        href={href}
        visitId={input.pane.currentVisit.id}
        route={route}
        routeKey={routeKey}
      />
    ),
  };
}

// ---------------------------------------------------------------------------
// WorkspaceHost — the top-level pane orchestrator. Reads workspace state,
// builds pane descriptors, and renders the shell layout with pane strip.
// ---------------------------------------------------------------------------

function WorkspaceHost() {
  const {
    state,
    runtimeLabelByPaneId,
    pendingSecondaryActivationByPaneId,
    pendingPaneEntryDeliveryByPaneId,
    activatePane,
    activateWorkspaceTarget,
    acknowledgePendingSecondaryActivation,
    acknowledgePaneEntryDelivery,
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
    publishPaneLabel,
    publishPaneAliases,
    workspacePrimaryMetrics,
  } = useWorkspaceHostStore();
  const labelTelemetryByPaneIdRef = useRef<Map<string, string>>(new Map());
  const [runtimeLayoutByPaneId, setRuntimeLayoutByPaneId] = useState<
    Map<string, RuntimePaneLayoutRecord>
  >(() => new Map());
  const [secondaryPublicationByPaneId, setSecondaryPublicationByPaneId] =
    useState<Map<string, PaneSecondaryPublicationRecord>>(() => new Map());
  const [
    transientSecondaryActivationByPaneId,
    setTransientSecondaryActivationByPaneId,
  ] = useState<Map<string, PaneTransientSecondaryActivationRecord>>(
    () => new Map(),
  );
  const [fixedChromePublicationByPaneId, setFixedChromePublicationByPaneId] =
    useState<Map<string, PaneFixedChromePublicationRecord>>(() => new Map());
  const [secondaryActivationByPaneId, setSecondaryActivationByPaneId] =
    useState<Map<string, SecondaryActivationDelivery>>(() => new Map());
  const [resourceItemByLocatorKey, setResourceItemByLocatorKey] = useState<
    Map<string, ResourceItem>
  >(() => new Map());
  const [resourceStatusByLocatorKey, setResourceStatusByLocatorKey] = useState<
    Map<string, PaneResourceStatus>
  >(() => new Map());
  const keybindings = useKeybindings();

  // --- Mobile viewport and pane focus state ---
  const isMobile = useIsMobileViewport();
  const layoutMode = isMobile ? "mobile" : "desktop";
  const paneWrapRefById = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingPaneFocusPaneIdRef = useRef<string | null>(null);
  const activePaneVisitIdRef = useRef<string | null>(null);
  activePaneVisitIdRef.current =
    state.primaryPanesById[state.activePrimaryPaneId]?.currentVisit.id ?? null;
  const pendingPaneEntryDeliveryByPaneIdRef = useRef(
    pendingPaneEntryDeliveryByPaneId,
  );
  pendingPaneEntryDeliveryByPaneIdRef.current =
    pendingPaneEntryDeliveryByPaneId;
  const previousIsMobileRef = useRef(isMobile);
  const nextResponsivePaneSearchDeliveryIdRef = useRef(0);
  const [
    pendingResponsivePaneSearchDelivery,
    setPendingResponsivePaneSearchDelivery,
  ] = useState<PendingResponsivePaneSearchDelivery | null>(null);
  const secondaryReturnFocusByPaneIdRef = useRef<Map<string, HTMLElement>>(
    new Map(),
  );
  const { primaryPaneOrder, primaryPanesById } = state;
  const primaryPanes = useMemo(
    () => getWorkspacePrimaryPanes({ primaryPaneOrder, primaryPanesById }),
    [primaryPaneOrder, primaryPanesById],
  );
  const paneDescriptors = useMemo(
    () =>
      primaryPanes.map((pane) => ({
        pane,
        descriptor: resolveWorkspacePaneLabel(pane, runtimeLabelByPaneId),
      })),
    [primaryPanes, runtimeLabelByPaneId],
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
  const transientSecondaryActivationByPaneIdRef = useRef(
    transientSecondaryActivationByPaneId,
  );
  transientSecondaryActivationByPaneIdRef.current =
    transientSecondaryActivationByPaneId;
  const resourceStatusByLocatorKeyRef = useRef(resourceStatusByLocatorKey);
  resourceStatusByLocatorKeyRef.current = resourceStatusByLocatorKey;
  const resourceLocatorsByKey = useMemo(() => {
    const next = new Map<string, PaneResourceLocator>();
    for (const { descriptor } of paneDescriptors) {
      const locator = resolvePaneResourceLocator(descriptor.route);
      const locatorKey = paneResourceLocatorKey(locator);
      if (locator && locatorKey) {
        next.set(locatorKey, locator);
      }
    }
    return next;
  }, [paneDescriptors]);
  const liveResourceLocatorKeysRef = useRef(
    new Set(resourceLocatorsByKey.keys()),
  );
  liveResourceLocatorKeysRef.current = new Set(resourceLocatorsByKey.keys());

  useEffect(() => {
    const unresolved = Array.from(resourceLocatorsByKey).filter(
      ([locatorKey]) =>
        !resourceItemByLocatorKey.has(locatorKey) &&
        !resourceStatusByLocatorKeyRef.current.has(locatorKey),
    );
    if (unresolved.length === 0) {
      return;
    }

    setResourceStatusByLocatorKey((current) => {
      const next = new Map(current);
      for (const [locatorKey] of unresolved) next.set(locatorKey, "pending");
      return next;
    });

    resolveResourceLocators(unresolved.map(([, locator]) => locator))
      .then((resolutions) => {
        setResourceItemByLocatorKey((current) => {
          const next = new Map(current);
          for (const resolution of resolutions) {
            const locatorKey = paneResourceLocatorKey(resolution.locator);
            if (
              locatorKey &&
              liveResourceLocatorKeysRef.current.has(locatorKey)
            ) {
              next.set(locatorKey, resolution.resourceItem);
            }
          }
          return next;
        });
        setResourceStatusByLocatorKey((current) => {
          const next = new Map(current);
          for (const [locatorKey] of unresolved) {
            if (liveResourceLocatorKeysRef.current.has(locatorKey)) {
              next.set(locatorKey, "ready");
            }
          }
          return next;
        });
      })
      .catch(() => {
        setResourceStatusByLocatorKey((current) => {
          const next = new Map(current);
          for (const [locatorKey] of unresolved) {
            if (liveResourceLocatorKeysRef.current.has(locatorKey)) {
              next.set(locatorKey, "error");
            }
          }
          return next;
        });
      });
  }, [resourceItemByLocatorKey, resourceLocatorsByKey]);

  const publishPaneLayout = useCallback(
    (input: PaneRuntimeLayoutPublication) => {
      if (
        currentRouteKeyByPaneIdRef.current.get(input.paneId) !== input.routeKey
      ) {
        return;
      }
      const normalizedInput = {
        ...input,
        layout: input.layout ? normalizePaneRuntimeLayout(input.layout) : null,
      };
      setRuntimeLayoutByPaneId((current) =>
        upsertOrDeletePaneLayoutRecord(current, normalizedInput),
      );
    },
    [],
  );

  const publishPaneSecondary = useCallback(
    (input: {
      paneId: string;
      routeKey: string;
      publication: PaneSecondaryPublication | null;
    }) => {
      if (
        currentRouteKeyByPaneIdRef.current.get(input.paneId) !== input.routeKey
      ) {
        return;
      }
      const normalizedInput = {
        ...input,
        publication: input.publication
          ? normalizePaneSecondaryPublication(input.publication)
          : null,
      };
      // The primary action and its secondary publication commit through
      // different owners (PaneShell and WorkspaceHost). Accept the publication
      // in the command guard synchronously so a newly visible Companion action
      // cannot lose its first valid click before the host render catches up.
      const next = upsertOrDeletePaneSecondaryPublicationRecord(
        secondaryPublicationByPaneIdRef.current,
        normalizedInput,
      );
      secondaryPublicationByPaneIdRef.current = next;
      setSecondaryPublicationByPaneId(next);
    },
    [],
  );

  const publishPaneFixedChrome = useCallback(
    (input: {
      paneId: string;
      routeKey: string;
      publication: PaneFixedChromePublication | null;
    }) => {
      if (
        currentRouteKeyByPaneIdRef.current.get(input.paneId) !== input.routeKey
      ) {
        return;
      }
      const normalizedInput = {
        ...input,
        publication: input.publication
          ? normalizePaneFixedChromePublication(input.publication)
          : null,
      };
      setFixedChromePublicationByPaneId((current) =>
        upsertOrDeletePaneFixedChromePublicationRecord(
          current,
          normalizedInput,
        ),
      );
    },
    [],
  );

  useEffect(() => {
    setRuntimeLayoutByPaneId((current) =>
      pruneRuntimePaneLayoutRecords(current, currentRouteKeyByPaneId),
    );
    setSecondaryPublicationByPaneId((current) =>
      prunePaneSecondaryPublicationRecords(current, currentRouteKeyByPaneId),
    );
    setTransientSecondaryActivationByPaneId((current) => {
      let next: Map<string, PaneTransientSecondaryActivationRecord> | null =
        null;
      for (const [paneId, activation] of current) {
        const routeKey = currentRouteKeyByPaneId.get(paneId);
        const publication = routeKey
          ? getPaneSecondaryPublication(
              secondaryPublicationByPaneId,
              paneId,
              routeKey,
            )
          : null;
        if (
          routeKey === activation.routeKey &&
          secondaryPublicationIncludesTransientSurface(
            publication,
            activation.surfaceId,
          )
        ) {
          continue;
        }
        next ??= new Map(current);
        next.delete(paneId);
      }
      return next ?? current;
    });
    setFixedChromePublicationByPaneId((current) =>
      prunePaneFixedChromePublicationRecords(current, currentRouteKeyByPaneId),
    );
    setSecondaryActivationByPaneId((current) => {
      let next: Map<string, SecondaryActivationDelivery> | null = null;
      for (const [paneId, delivery] of current) {
        if (currentRouteKeyByPaneId.get(paneId) === delivery.routeKey) {
          continue;
        }
        next ??= new Map(current);
        next.delete(paneId);
      }
      return next ?? current;
    });
    const liveLocatorKeys = new Set(resourceLocatorsByKey.keys());
    setResourceItemByLocatorKey((current) => {
      let next: Map<string, ResourceItem> | null = null;
      for (const locatorKey of current.keys()) {
        if (liveLocatorKeys.has(locatorKey)) continue;
        next ??= new Map(current);
        next.delete(locatorKey);
      }
      return next ?? current;
    });
    setResourceStatusByLocatorKey((current) => {
      let next: Map<string, PaneResourceStatus> | null = null;
      for (const locatorKey of current.keys()) {
        if (liveLocatorKeys.has(locatorKey)) continue;
        next ??= new Map(current);
        next.delete(locatorKey);
      }
      return next ?? current;
    });
  }, [
    currentRouteKeyByPaneId,
    resourceLocatorsByKey,
    secondaryPublicationByPaneId,
  ]);

  useEffect(() => {
    const nextTelemetryByPaneId = new Map<string, string>();

    for (const { pane, descriptor } of paneDescriptors) {
      const telemetryKey = [
        descriptor.label,
        descriptor.labelState,
        descriptor.route.id,
      ].join("|");
      nextTelemetryByPaneId.set(pane.id, telemetryKey);
      if (labelTelemetryByPaneIdRef.current.get(pane.id) === telemetryKey) {
        continue;
      }
      emitWorkspaceTelemetry({
        type: "label",
        status: "ok",
        errorCode: null,
        labelState: descriptor.labelState,
        routeId: descriptor.route.id,
      });
    }

    labelTelemetryByPaneIdRef.current = nextTelemetryByPaneId;
  }, [paneDescriptors]);

  const panes = useMemo(
    () =>
      paneDescriptors.map(({ pane, descriptor }) => {
        const resourceLocatorKey = paneResourceLocatorKey(
          resolvePaneResourceLocator(descriptor.route),
        );
        const runtimeLayoutRecord = getRuntimePaneLayoutRecord(
          runtimeLayoutByPaneId,
          pane.id,
          descriptor.routeKey,
        );
        return buildHostPane({
          pane,
          secondaryPane: pane.attachedSecondaryPaneId
            ? (state.secondaryPanesById[pane.attachedSecondaryPaneId] ?? null)
            : null,
          descriptor,
          resourceItem: resourceLocatorKey
            ? (resourceItemByLocatorKey.get(resourceLocatorKey) ?? null)
            : null,
          resourceStatus: resourceLocatorKey
            ? (resourceStatusByLocatorKey.get(resourceLocatorKey) ?? "pending")
            : "none",
          isActive: pane.id === state.activePrimaryPaneId,
          runtimeLayout:
            runtimeLayoutRecord?.layout ?? DEFAULT_PANE_RUNTIME_LAYOUT,
          runtimeLayoutResolved: runtimeLayoutRecord !== null,
          secondaryPublication: getPaneSecondaryPublication(
            secondaryPublicationByPaneId,
            pane.id,
            descriptor.routeKey,
          ),
          transientSecondaryActivation:
            transientSecondaryActivationByPaneId.get(pane.id) ?? null,
          fixedChromePublication: getPaneFixedChromePublication(
            fixedChromePublicationByPaneId,
            pane.id,
            descriptor.routeKey,
          ),
          isMobile,
          workspacePrimaryMetrics,
        });
      }),
    [
      paneDescriptors,
      state.activePrimaryPaneId,
      state.secondaryPanesById,
      resourceItemByLocatorKey,
      resourceStatusByLocatorKey,
      runtimeLayoutByPaneId,
      secondaryPublicationByPaneId,
      transientSecondaryActivationByPaneId,
      fixedChromePublicationByPaneId,
      isMobile,
      workspacePrimaryMetrics,
    ],
  );
  const panesRef = useRef(panes);
  panesRef.current = panes;

  const {
    canvasRef,
    onWheel,
    edges,
    inViewPaneIds,
    handleChromeMouseDown,
    scrollPaneIntoView,
  } = usePaneCanvas({
    mode: layoutMode === "desktop" ? "desktop" : "disabled",
    paneIds: panes.map((pane) => pane.paneId),
  });

  useEffect(() => {
    if (pendingSecondaryActivationByPaneId.size === 0) {
      return;
    }
    for (const [paneId, request] of pendingSecondaryActivationByPaneId) {
      const pane = panes.find(
        (item) => item.paneId === paneId && item.routeKey === request.routeKey,
      );
      if (!pane) {
        acknowledgePendingSecondaryActivation(
          paneId,
          request.routeKey,
          request.activation,
        );
        continue;
      }
      if (
        !paneRouteAllowsSecondarySurface(
          pane.href,
          request.activation.surfaceId,
        )
      ) {
        acknowledgePendingSecondaryActivation(
          paneId,
          request.routeKey,
          request.activation,
        );
        continue;
      }
      if (!pane.secondaryPublication) {
        continue;
      }
      if (
        secondaryPublicationIncludesSurface(
          pane.secondaryPublication,
          request.activation.surfaceId,
        )
      ) {
        if (request.activation.kind !== "Surface") {
          const activation = request.activation;
          setSecondaryActivationByPaneId((current) => {
            const next = new Map(current);
            next.set(pane.paneId, {
              routeKey: request.routeKey,
              activation,
            });
            return next;
          });
        }
        requestSecondarySurface(pane.paneId, request.activation.surfaceId);
      }
      acknowledgePendingSecondaryActivation(
        paneId,
        request.routeKey,
        request.activation,
      );
    }
  }, [
    acknowledgePendingSecondaryActivation,
    panes,
    pendingSecondaryActivationByPaneId,
    requestSecondarySurface,
  ]);

  const acknowledgeSecondaryActivation = useCallback(
    (
      paneId: string,
      routeKey: string,
      activation: WorkspaceDossierActivation,
    ) => {
      setSecondaryActivationByPaneId((current) => {
        const delivered = current.get(paneId);
        if (
          delivered?.routeKey !== routeKey ||
          delivered.activation.kind !== activation.kind ||
          (delivered.activation.kind === "DossierRevision" &&
            activation.kind === "DossierRevision" &&
            delivered.activation.revisionRef !== activation.revisionRef)
        ) {
          return current;
        }
        const next = new Map(current);
        next.delete(paneId);
        return next;
      });
    },
    [],
  );

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
      const correctionPx =
        pane.secondarySizing?.storedWidthCorrectionPx ?? null;
      if (correctionPx !== null && pane.secondaryPane) {
        resizeSecondaryPane(pane.secondaryPane.id, correctionPx);
      }
    }
  }, [isMobile, panes, resizeSecondaryPane]);

  useEffect(() => {
    for (const primaryPane of primaryPanes) {
      const secondaryPane = primaryPane.attachedSecondaryPaneId
        ? (state.secondaryPanesById[primaryPane.attachedSecondaryPaneId] ??
          null)
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
      if (
        !secondaryPublicationIncludesSurface(
          publication,
          secondaryPane.activeSurfaceId,
        ) &&
        publication.defaultSurfaceId !== null
      ) {
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

  const canUsePublishedTransientSecondarySurface = useCallback(
    (
      paneId: string,
      routeKey: string,
      surfaceId: PaneTransientSecondarySurfaceId,
    ): boolean => {
      if (currentRouteKeyByPaneIdRef.current.get(paneId) !== routeKey) {
        return false;
      }
      return secondaryPublicationIncludesTransientSurface(
        getPaneSecondaryPublication(
          secondaryPublicationByPaneIdRef.current,
          paneId,
          routeKey,
        ),
        surfaceId,
      );
    },
    [],
  );

  const handleRequestTransientSecondarySurface = useCallback(
    (
      paneId: string,
      routeKey: string,
      surfaceId: PaneTransientSecondarySurfaceId,
      returnFocusTo?: HTMLElement | null,
    ) => {
      if (
        !canUsePublishedTransientSecondarySurface(
          paneId,
          routeKey,
          surfaceId,
        )
      ) {
        return;
      }
      if (returnFocusTo?.isConnected) {
        secondaryReturnFocusByPaneIdRef.current.set(paneId, returnFocusTo);
      }
      const pane = panesRef.current.find((candidate) => candidate.paneId === paneId);
      const defaultWidthPx = getSecondaryWidthPolicy("resource-inspector")
        .defaultWidthPx;
      setTransientSecondaryActivationByPaneId((current) => {
        const existing = current.get(paneId);
        const next = new Map(current);
        next.set(paneId, {
          routeKey,
          surfaceId,
          expanded: true,
          widthPx:
            pane?.runtimeSecondaryPane?.widthPx ??
            existing?.widthPx ??
            defaultWidthPx,
        });
        return next;
      });
    },
    [canUsePublishedTransientSecondarySurface],
  );

  const handleCloseTransientSecondarySurface = useCallback(
    (paneId: string, routeKey: string) => {
      const opener =
        secondaryReturnFocusByPaneIdRef.current.get(paneId) ?? null;
      setTransientSecondaryActivationByPaneId((current) => {
        if (current.get(paneId)?.routeKey !== routeKey) {
          return current;
        }
        const next = new Map(current);
        next.delete(paneId);
        return next;
      });
      secondaryReturnFocusByPaneIdRef.current.delete(paneId);
      if (!isMobile && opener?.isConnected) {
        window.requestAnimationFrame(() => {
          opener.focus({ preventScroll: true });
        });
      }
    },
    [isMobile],
  );

  const handlePreviewTransientSecondaryResult = useCallback(
    (paneId: string, routeKey: string) => {
      if (!isMobile) {
        return;
      }
      setTransientSecondaryActivationByPaneId((current) => {
        const existing = current.get(paneId);
        if (!existing || existing.routeKey !== routeKey || !existing.expanded) {
          return current;
        }
        const next = new Map(current);
        next.set(paneId, { ...existing, expanded: false });
        return next;
      });
    },
    [isMobile],
  );

  const handleRequestSecondarySurface = useCallback(
    (
      paneId: string,
      surfaceId: WorkspaceSecondarySurfaceId,
      returnFocusTo?: HTMLElement | null,
    ) => {
      if (!canUsePublishedSecondarySurface(paneId, surfaceId)) {
        return;
      }
      setTransientSecondaryActivationByPaneId((current) => {
        if (!current.has(paneId)) return current;
        const next = new Map(current);
        next.delete(paneId);
        return next;
      });
      if (returnFocusTo?.isConnected) {
        secondaryReturnFocusByPaneIdRef.current.set(paneId, returnFocusTo);
      } else {
        secondaryReturnFocusByPaneIdRef.current.delete(paneId);
      }
      requestSecondarySurface(paneId, surfaceId);
    },
    [canUsePublishedSecondarySurface, requestSecondarySurface],
  );

  const handleCloseSecondaryPane = useCallback(
    (secondaryPaneId: string) => {
      const pane = panesRef.current.find(
        (item) => item.secondaryPane?.id === secondaryPaneId,
      );
      // Desktop opener-refocus (§159/§3h): capture the opener BEFORE clearing the
      // map, collapse, then refocus. A disconnected opener falls back to the
      // pane's chrome focus target (computed while the map entry still exists, so
      // the fallback is never starved). Mobile return-focus is owned by the
      // MobileSheet, so this only drives desktop.
      const opener = pane
        ? (secondaryReturnFocusByPaneIdRef.current.get(pane.paneId) ?? null)
        : null;
      const focusTarget =
        !isMobile && pane
          ? opener?.isConnected
            ? opener
            : findPaneChromeFocusTarget(pane.paneId)
          : null;
      closeSecondaryPane(secondaryPaneId);
      if (pane) {
        secondaryReturnFocusByPaneIdRef.current.delete(pane.paneId);
      }
      if (focusTarget) {
        window.requestAnimationFrame(() => {
          focusTarget.focus({ preventScroll: true });
        });
      }
    },
    [closeSecondaryPane, isMobile],
  );

  const handleSetSecondarySurface = useCallback(
    (secondaryPaneId: string, surfaceId: WorkspaceSecondarySurfaceId) => {
      const pane = panesRef.current.find(
        (item) => item.runtimeSecondaryPane?.id === secondaryPaneId,
      );
      if (!pane || !canUsePublishedSecondarySurface(pane.paneId, surfaceId)) {
        return;
      }
      setSecondarySurface(secondaryPaneId, surfaceId);
    },
    [canUsePublishedSecondarySurface, setSecondarySurface],
  );

  const handleSelectDurableFromTransient = useCallback(
    (secondaryPaneId: string, surfaceId: WorkspaceSecondarySurfaceId) => {
      const pane = panesRef.current.find(
        (candidate) =>
          candidate.transientSecondaryPaneId === secondaryPaneId,
      );
      if (
        !pane ||
        !canUsePublishedSecondarySurface(pane.paneId, surfaceId) ||
        transientSecondaryActivationByPaneIdRef.current.get(pane.paneId)
          ?.routeKey !== pane.routeKey
      ) {
        return;
      }
      setTransientSecondaryActivationByPaneId((current) => {
        const next = new Map(current);
        next.delete(pane.paneId);
        return next;
      });
      requestSecondarySurface(pane.paneId, surfaceId);
    },
    [canUsePublishedSecondarySurface, requestSecondarySurface],
  );

  const handleResizeTransientSecondary = useCallback(
    (secondaryPaneId: string, widthPx: number) => {
      const pane = panesRef.current.find(
        (candidate) => candidate.transientSecondaryPaneId === secondaryPaneId,
      );
      if (!pane) return;
      if (pane.runtimeSecondaryPane) {
        resizeSecondaryPane(pane.runtimeSecondaryPane.id, widthPx);
        return;
      }
      setTransientSecondaryActivationByPaneId((current) => {
        const existing = current.get(pane.paneId);
        if (!existing) return current;
        const next = new Map(current);
        next.set(pane.paneId, { ...existing, widthPx });
        return next;
      });
    },
    [resizeSecondaryPane],
  );

  const visiblePaneCount = primaryPanes.filter(
    (pane) => pane.visibility === "visible",
  ).length;
  const stripItems = useMemo(
    () =>
      panes.map((pane) => ({
        paneId: pane.paneId,
        href: pane.href,
        label: pane.label,
        labelState: pane.labelState,
        isActive: pane.isActive,
        visibility: pane.visibility,
        canMinimize: pane.visibility === "visible" && visiblePaneCount > 1,
        isInView: inViewPaneIds.has(pane.paneId),
      })),
    [panes, visiblePaneCount, inViewPaneIds],
  );

  const activePane =
    panes.find(
      (pane) =>
        pane.paneId === state.activePrimaryPaneId &&
        pane.visibility === "visible",
    ) ??
    panes.find((pane) => pane.visibility === "visible") ??
    null;
  const renderedPanes = isMobile ? (activePane ? [activePane] : []) : panes;

  // --- Pane focus management ---
  const focusPane = useCallback(
    (targetPaneId: string) => {
      if (!paneWrapRefById.current.has(targetPaneId)) {
        return false;
      }
      const target = isMobile
        ? findPaneLandmarkFocusTarget(targetPaneId)
        : findPaneChromeFocusTarget(targetPaneId);
      if (!target) {
        return false;
      }
      target.focus({ preventScroll: true });
      pendingPaneFocusPaneIdRef.current = null;
      return true;
    },
    [isMobile],
  );

  useLayoutEffect(() => {
    const previousIsMobile = previousIsMobileRef.current;
    previousIsMobileRef.current = isMobile;
    const targetPaneId =
      pendingPaneFocusPaneIdRef.current ??
      (isMobile || previousIsMobile ? state.activePrimaryPaneId : null);
    if (!targetPaneId) {
      return;
    }
    const entryDelivery =
      pendingPaneEntryDeliveryByPaneIdRef.current.get(targetPaneId);
    if (
      isMobile &&
      entryDelivery?.visitId === activePaneVisitIdRef.current &&
      entryDelivery.entry.kind === "AppendNote"
    ) {
      pendingPaneFocusPaneIdRef.current = null;
      return;
    }
    focusPane(targetPaneId);
  }, [state.activePrimaryPaneId, isMobile, focusPane]);

  useEffect(() => {
    scrollPaneIntoView(state.activePrimaryPaneId);
  }, [state.activePrimaryPaneId, scrollPaneIntoView]);

  const acknowledgeResponsivePaneSearchDelivery = useCallback((id: number) => {
    setPendingResponsivePaneSearchDelivery((current) =>
      current?.id === id ? null : current,
    );
  }, []);

  const handleActivatePane = useCallback(
    (paneId: string, options?: { focusPane?: boolean }) => {
      const shouldFocusPane = options?.focusPane !== false;
      activatePane(paneId);
      if (!shouldFocusPane) {
        return;
      }
      pendingPaneFocusPaneIdRef.current = paneId;
      window.requestAnimationFrame(() => {
        if (pendingPaneFocusPaneIdRef.current === paneId) {
          focusPane(paneId);
        }
      });
    },
    [activatePane, focusPane],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const searchCombo = keybindings["Pane.Search"];
      if (
        searchCombo &&
        matchesKeyEvent(searchCombo, event)
      ) {
        const consumed = dispatchPaneSearchRequest();
        if (consumed) {
          const targetIsMobile = getBrowserViewportKind() === "mobile";
          const routeKey = currentRouteKeyByPaneIdRef.current.get(
            state.activePrimaryPaneId,
          );
          // The outgoing projection established capability synchronously, but a
          // live responsive transition will replace its shell. Carry one exact
          // delivery to the incoming route instead of losing the command.
          setPendingResponsivePaneSearchDelivery(
            targetIsMobile === isMobile || !routeKey
              ? null
              : {
                  id: ++nextResponsivePaneSearchDeliveryIdRef.current,
                  paneId: state.activePrimaryPaneId,
                  routeKey,
                  targetIsMobile,
                },
          );
          event.preventDefault();
        }
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      const nextCombo = keybindings["pane-next"];
      const prevCombo = keybindings["pane-previous"];
      const isNext = Boolean(nextCombo) && matchesKeyEvent(nextCombo, event);
      const isPrevious =
        Boolean(prevCombo) && matchesKeyEvent(prevCombo, event);
      if (!isNext && !isPrevious) {
        return;
      }
      event.preventDefault();
      const visible = primaryPanes.filter(
        (pane) => pane.visibility === "visible",
      );
      if (visible.length < 2) {
        return;
      }
      const index = visible.findIndex(
        (pane) => pane.id === state.activePrimaryPaneId,
      );
      const targetIndex =
        (index + (isNext ? 1 : -1) + visible.length) % visible.length;
      handleActivatePane(visible[targetIndex].id);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    primaryPanes,
    state.activePrimaryPaneId,
    keybindings,
    handleActivatePane,
    isMobile,
  ]);

  // --- Close handler ---
  const handleClosePane = useCallback(
    (paneId: string) => {
      closePane(paneId);
    },
    [closePane],
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
              key={isMobile ? "mobile-active-pane" : pane.paneId}
              className={styles.paneWrap}
              data-pane-id={pane.paneId}
              data-active={pane.isActive ? "true" : "false"}
              data-mobile={isMobile ? "true" : "false"}
              data-minimized={
                pane.visibility === "minimized" ? "true" : "false"
              }
              hidden={pane.visibility === "minimized"}
              inert={pane.visibility === "minimized" ? true : undefined}
              ref={(element) => {
                if (element) {
                  paneWrapRefById.current.set(pane.paneId, element);
                } else {
                  paneWrapRefById.current.delete(pane.paneId);
                }
              }}
              onMouseDown={() =>
                handleActivatePane(pane.paneId, { focusPane: false })
              }
            >
              <PaneRouteErrorBoundary
                paneId={pane.paneId}
                resetKey={`${pane.paneId}:${pane.routeKey}`}
                slotMinWidth={
                  isMobile
                    ? "100%"
                    : `${
                        pane.sizing.renderedPrimarySlotWidthPx +
                        (pane.transientSecondaryExpanded
                          ? (pane.transientSecondarySizing?.widthPx ?? 0)
                          : pane.secondaryPane?.visibility === "visible"
                            ? (pane.secondarySizing?.widthPx ?? 0)
                            : 0)
                      }px`
                }
              >
                <PaneRuntimeFrame
                  paneId={pane.paneId}
                  visitId={pane.visitId}
                  isActive={pane.isActive}
                  href={pane.href}
                  route={pane.route}
                  routeKey={pane.routeKey}
                  resourceItem={pane.resourceItem}
                  resourceStatus={pane.resourceStatus}
                  secondaryPane={pane.runtimeSecondaryPane}
                  secondaryActivation={
                    secondaryActivationByPaneId.get(pane.paneId)?.routeKey ===
                    pane.routeKey
                      ? (secondaryActivationByPaneId.get(pane.paneId)
                          ?.activation ?? null)
                      : null
                  }
                  paneEntryDelivery={
                    pendingPaneEntryDeliveryByPaneId.get(pane.paneId)
                      ?.visitId === pane.visitId
                      ? (pendingPaneEntryDeliveryByPaneId.get(pane.paneId) ??
                        null)
                      : null
                  }
                  transientSecondarySurface={
                    pane.transientSecondarySurface
                      ? {
                          id: pane.transientSecondarySurface.id,
                          expanded: pane.transientSecondaryExpanded,
                        }
                      : null
                  }
                  navigatePane={navigatePane}
                  activateWorkspaceTarget={activateWorkspaceTarget}
                  canGoBack={pane.canGoBack}
                  canGoForward={pane.canGoForward}
                  goBackPane={goBackPane}
                  goForwardPane={goForwardPane}
                  publishPaneLabel={publishPaneLabel}
                  publishPaneLayout={publishPaneLayout}
                  publishPaneSecondary={publishPaneSecondary}
                  publishPaneFixedChrome={publishPaneFixedChrome}
                  requestSecondarySurface={handleRequestSecondarySurface}
                  closeSecondaryPane={handleCloseSecondaryPane}
                  setSecondarySurface={handleSetSecondarySurface}
                  requestTransientSecondarySurface={
                    handleRequestTransientSecondarySurface
                  }
                  closeTransientSecondarySurface={
                    handleCloseTransientSecondarySurface
                  }
                  previewTransientSecondaryResult={
                    handlePreviewTransientSecondaryResult
                  }
                  acknowledgeSecondaryActivation={
                    acknowledgeSecondaryActivation
                  }
                  acknowledgePaneEntryDelivery={acknowledgePaneEntryDelivery}
                  publishPaneAliases={publishPaneAliases}
                >
                  {pane.route.id !== "unsupported" ? (
                    <PaneShell
                      paneId={pane.paneId}
                      routeKey={pane.routeKey}
                      routeHeader={pane.route.header}
                      routeShareIdentity={pane.routeShareIdentity}
                      label={pane.label}
                      labelPending={pane.labelState === "pending"}
                      queryNavigation={pane.route.definition.queryNavigation}
                      returnMementoEnabled={
                        pane.route.definition.returnMemento.kind ===
                        "ShellScroll"
                      }
                      sizing={pane.sizing}
                      secondaryPane={pane.secondaryPane}
                      secondarySizing={pane.secondarySizing}
                      secondaryPublication={pane.secondaryPublication}
                      fixedChromePublication={pane.fixedChromePublication}
                      bodyMode={pane.bodyMode}
                      onResizePrimaryPane={resizePrimaryPane}
                      onResizeSecondaryPane={resizeSecondaryPane}
                      onCloseSecondaryPane={handleCloseSecondaryPane}
                      onSetSecondarySurface={handleSetSecondarySurface}
                      onChromeMouseDown={handleChromeMouseDown}
                      isActive={pane.isActive}
                      isMobile={isMobile}
                      responsiveSearchHandoff={
                        pendingResponsivePaneSearchDelivery?.paneId ===
                          pane.paneId &&
                        pendingResponsivePaneSearchDelivery.routeKey ===
                          pane.routeKey &&
                        pendingResponsivePaneSearchDelivery.targetIsMobile ===
                          isMobile
                          ? {
                              id: pendingResponsivePaneSearchDelivery.id,
                              onConsumed:
                                acknowledgeResponsivePaneSearchDelivery,
                            }
                          : null
                      }
                    >
                      {pane.content}
                    </PaneShell>
                  ) : (
                    pane.content
                  )}
                  {!isMobile &&
                  pane.transientSecondarySurface &&
                  pane.transientSecondaryExpanded &&
                  pane.transientSecondarySizing &&
                  pane.secondaryPublication ? (
                    <SecondaryPaneShell
                      primaryPaneId={pane.paneId}
                      secondaryPaneId={pane.transientSecondaryPaneId}
                      publication={pane.secondaryPublication}
                      state={pane.runtimeSecondaryPane}
                      transientSurface={pane.transientSecondarySurface}
                      sizing={pane.transientSecondarySizing}
                      onActiveSurfaceChange={handleSetSecondarySurface}
                      onSelectDurableFromTransient={
                        handleSelectDurableFromTransient
                      }
                      onClose={handleCloseSecondaryPane}
                      onCloseTransient={() =>
                        handleCloseTransientSecondarySurface(
                          pane.paneId,
                          pane.routeKey,
                        )
                      }
                      onResize={handleResizeTransientSecondary}
                    />
                  ) : null}
                  {isMobile &&
                  (pane.runtimeSecondaryPane ||
                    pane.transientSecondarySurface) ? (
                    <MobileSecondaryPaneHost
                      primaryPaneId={pane.paneId}
                      secondaryPaneId={pane.transientSecondaryPaneId}
                      secondary={pane.runtimeSecondaryPane}
                      publication={pane.secondaryPublication}
                      transientSurface={pane.transientSecondarySurface}
                      transientExpanded={pane.transientSecondaryExpanded}
                      returnFocusTo={() =>
                        secondaryReturnFocusByPaneIdRef.current.get(
                          pane.paneId,
                        ) ?? null
                      }
                      onClose={handleCloseSecondaryPane}
                      onCloseTransient={() =>
                        handleCloseTransientSecondarySurface(
                          pane.paneId,
                          pane.routeKey,
                        )
                      }
                      onActiveSurfaceChange={handleSetSecondarySurface}
                      onSelectDurableFromTransient={
                        handleSelectDurableFromTransient
                      }
                    />
                  ) : null}
                </PaneRuntimeFrame>
              </PaneRouteErrorBoundary>
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
