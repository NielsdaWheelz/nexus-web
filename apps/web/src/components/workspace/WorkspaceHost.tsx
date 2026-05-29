"use client";

import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedPaneRoute } from "@/lib/panes/paneRouteRegistry";
import { handlePaneInternalAnchorClick } from "@/lib/panes/paneLinkNavigation";
import {
  PaneRuntimeProvider,
  usePaneRuntime,
  type PaneRuntimeLayoutPublication,
} from "@/lib/panes/paneRuntime";
import PaneShell from "@/components/workspace/PaneShell";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { loadKeybindings, matchesKeyEvent } from "@/lib/keybindings";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import type {
  SurfaceHeaderNavigation,
  SurfaceHeaderOption,
} from "@/components/ui/SurfaceHeader";
import type { PaneBodyMode } from "@/lib/panes/paneRouteModel";
import { resolvePaneRouteWidthContract } from "@/lib/panes/paneRouteModel";
import type { WorkspacePaneState } from "@/lib/workspace/schema";
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
  getSidecarWidthPolicy,
  resolveEffectiveSidecarSizing,
  type WorkspaceSidecarSizing,
  type WorkspaceSidecarSurfaceId,
} from "@/lib/workspace/sidecarSizing";
import { emitWorkspaceTelemetry } from "@/lib/workspace/telemetry";
import {
  resolveWorkspacePaneTitle,
  useWorkspaceStore,
  type WorkspacePaneTitleDescriptor,
} from "@/lib/workspace/store";
import { usePaneCanvas } from "./usePaneCanvas";
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
  options?: SurfaceHeaderOption[];
  navigation: SurfaceHeaderNavigation;
  bodyMode: PaneBodyMode;
  sizing: EffectivePaneSizing;
  sidecar: WorkspacePaneState["sidecar"];
  sidecarSizing: WorkspaceSidecarSizing | null;
  isActive: boolean;
  visibility: "visible" | "minimized";
  content: React.ReactNode;
}

interface RuntimePaneLayoutRecord {
  resourceKey: string;
  layout: PaneRuntimeLayout;
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
// PaneRouteBoundary - intercepts supported internal links anywhere in the pane
// shell and routes them through the pane runtime router.
// ---------------------------------------------------------------------------

function PaneRouteBoundary({ children }: { children: React.ReactNode }) {
  const paneRuntime = usePaneRuntime();

  const handleClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }

      handlePaneInternalAnchorClick(event, paneRuntime, anchor);
    },
    [paneRuntime]
  );

  return (
    <div className={styles.paneRouteBoundaryShell} onClickCapture={handleClickCapture}>
      {children}
    </div>
  );
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
  sidecar,
  navigatePane,
  openPane,
  canGoBack,
  canGoForward,
  goBackPane,
  goForwardPane,
  publishPaneTitle,
  publishPaneLayout,
  openSidecar,
  closeSidecar,
  setActiveSidecarSurface,
  children,
}: {
  paneId: string;
  href: string;
  route: ResolvedPaneRoute;
  resourceKey: string;
  sidecar: WorkspacePaneState["sidecar"];
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
    sidecarSurfaceId?: WorkspaceSidecarSurfaceId;
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
  openSidecar: (paneId: string, surfaceId: WorkspaceSidecarSurfaceId) => void;
  closeSidecar: (paneId: string) => void;
  setActiveSidecarSurface: (
    paneId: string,
    surfaceId: WorkspaceSidecarSurfaceId,
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
      sidecarSurfaceId?: WorkspaceSidecarSurfaceId,
    ) =>
      openPane({
        href: h,
        openerPaneId: paneId,
        activate: true,
        titleHint,
        sidecarSurfaceId,
      }),
    [openPane, paneId]
  );

  return (
    <PaneRuntimeProvider
      paneId={paneId}
      href={href}
      routeId={route.id}
      resourceRef={route.resourceRef}
      resourceKey={resourceKey}
      sidecar={sidecar}
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
      onOpenSidecar={openSidecar}
      onCloseSidecar={closeSidecar}
      onSetActiveSidecarSurface={setActiveSidecarSurface}
    >
      <PaneRouteBoundary>{children}</PaneRouteBoundary>
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
        existing.layout.primaryWidth.widthPx === layout.primaryWidth.widthPx) &&
    existing.layout.fixedPrimaryChromeWidthPx === layout.fixedPrimaryChromeWidthPx
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(input.paneId, { resourceKey: input.resourceKey, layout });
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

function buildHostPane(input: {
  pane: WorkspacePaneState;
  descriptor: WorkspacePaneTitleDescriptor;
  goBackPane: (paneId: string) => void;
  goForwardPane: (paneId: string) => void;
  isActive: boolean;
  runtimeLayout: PaneRuntimeLayout;
  isMobile: boolean;
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
}): WorkspaceHostPane {
  const { chrome, resourceKey, route, title, titleState } = input.descriptor;

  const routeWidth = route.definition ?? resolvePaneRouteWidthContract(input.pane.href);

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
    sidecar: input.pane.sidecar,
    sizing: resolveEffectivePaneSizing({
      storedWidthPx: input.pane.primaryWidthPx,
      workspacePrimaryMetrics: input.workspacePrimaryMetrics,
      routeWidth,
      runtimeLayout: input.runtimeLayout,
      isMobile: input.isMobile,
    }),
    sidecarSizing:
      !input.isMobile && input.pane.sidecar
        ? resolveEffectiveSidecarSizing({
            storedWidthPx: input.pane.sidecar.widthPx,
            policy: getSidecarWidthPolicy(input.pane.sidecar.groupId),
          })
        : null,
    isActive: input.isActive,
    visibility: input.pane.visibility,
    content: <PaneContent route={route} resourceKey={resourceKey} />,
  };
}

// ---------------------------------------------------------------------------
// WorkspaceHost — the top-level pane orchestrator. Reads workspace state,
// builds pane descriptors, and renders the shell layout with pane strip.
// ---------------------------------------------------------------------------

export default function WorkspaceHost() {
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
    openSidecar,
    closeSidecar,
    setActiveSidecarSurface,
    resizeSidecarPane,
    minimizePane,
    restorePane,
    publishPaneTitle,
    workspacePrimaryMetrics,
  } = useWorkspaceStore();
  const titleTelemetryByPaneIdRef = useRef<Map<string, string>>(new Map());
  const [runtimeLayoutByPaneId, setRuntimeLayoutByPaneId] = useState<
    Map<string, RuntimePaneLayoutRecord>
  >(() => new Map());

  // --- Mobile viewport and pane chrome focus state ---
  const isMobile = useIsMobileViewport();
  const paneWrapRefById = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingPaneChromeFocusPaneIdRef = useRef<string | null>(null);
  const paneDescriptors = useMemo(
    () =>
      state.panes.map((pane) => ({
        pane,
        descriptor: resolveWorkspacePaneTitle(pane, runtimeTitleByPaneId),
      })),
    [runtimeTitleByPaneId, state.panes]
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

  const publishPaneLayout = useCallback((input: PaneRuntimeLayoutPublication) => {
    if (currentResourceKeyByPaneId.get(input.paneId) !== input.resourceKey) {
      return;
    }
    setRuntimeLayoutByPaneId((current) =>
      upsertOrDeletePaneLayoutRecord(current, input),
    );
  }, [currentResourceKeyByPaneId]);

  useEffect(() => {
    setRuntimeLayoutByPaneId((current) =>
      pruneRuntimePaneLayoutRecords(current, currentResourceKeyByPaneId),
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
          descriptor,
          goBackPane,
          goForwardPane,
          isActive: pane.id === state.activePaneId,
          runtimeLayout: getRuntimePaneLayout(
            runtimeLayoutByPaneId,
            pane.id,
            descriptor.resourceKey,
          ),
          isMobile,
          workspacePrimaryMetrics,
        })
      ),
    [
      paneDescriptors,
      state.activePaneId,
      goBackPane,
      goForwardPane,
      runtimeLayoutByPaneId,
      isMobile,
      workspacePrimaryMetrics,
    ]
  );

  const { canvasRef, onWheel, edges, inViewPaneIds, handleChromeMouseDown, scrollPaneIntoView } =
    usePaneCanvas({ enabled: !isMobile, paneIds: panes.map((pane) => pane.paneId) });

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
      const correctionPx = pane.sidecarSizing?.storedWidthCorrectionPx ?? null;
      if (correctionPx !== null) {
        resizeSidecarPane(pane.paneId, correctionPx);
      }
    }
  }, [isMobile, panes, resizeSidecarPane]);

  const visiblePaneCount = state.panes.filter((pane) => pane.visibility === "visible").length;
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
      (pane) => pane.paneId === state.activePaneId && pane.visibility === "visible"
    ) ??
    panes.find((pane) => pane.visibility === "visible") ??
    null;
  const renderedPanes = isMobile ? (activePane ? [activePane] : []) : panes;

  // --- Pane chrome focus management ---
  useEffect(() => {
    const targetPaneId =
      pendingPaneChromeFocusPaneIdRef.current ?? (isMobile ? state.activePaneId : null);
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
  }, [state.activePaneId, isMobile]);

  useEffect(() => {
    scrollPaneIntoView(state.activePaneId);
  }, [state.activePaneId, scrollPaneIntoView]);

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
      const visible = state.panes.filter((pane) => pane.visibility === "visible");
      if (visible.length < 2) {
        return;
      }
      const index = visible.findIndex((pane) => pane.id === state.activePaneId);
      const targetIndex = (index + (isNext ? 1 : -1) + visible.length) % visible.length;
      activatePane(visible[targetIndex].id);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [state.panes, state.activePaneId, activatePane]);

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
                sidecar={pane.sidecar}
                navigatePane={navigatePane}
                openPane={openPane}
                canGoBack={pane.navigation.canGoBack}
                canGoForward={pane.navigation.canGoForward}
                goBackPane={goBackPane}
                goForwardPane={goForwardPane}
                publishPaneTitle={publishPaneTitle}
                publishPaneLayout={publishPaneLayout}
                openSidecar={openSidecar}
                closeSidecar={closeSidecar}
                setActiveSidecarSurface={setActiveSidecarSurface}
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
                  sidecar={pane.sidecar}
                  sidecarSizing={pane.sidecarSizing}
                  bodyMode={pane.bodyMode}
                  onResizePrimaryPane={resizePrimaryPane}
                  onResizeSidecarPane={resizeSidecarPane}
                  onCloseSidecar={closeSidecar}
                  onSetActiveSidecarSurface={setActiveSidecarSurface}
                  onChromeMouseDown={handleChromeMouseDown}
                  isActive={pane.isActive}
                  isMobile={isMobile}
                  mobileCommandPalettePaneCount={state.panes.length}
                >
                  {pane.content}
                </PaneShell>
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
