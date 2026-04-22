"use client";

import { Component, memo, useCallback, useEffect, useMemo, useRef } from "react";
import { resolvePaneRoute, getParentHref, type ResolvedPaneRoute } from "@/lib/panes/paneRouteRegistry";
import { PaneRuntimeProvider, usePaneRuntime } from "@/lib/panes/paneRuntime";
import PaneShell, { type PaneBodyMode } from "@/components/workspace/PaneShell";
import WorkspaceTabsBar from "@/components/workspace/WorkspaceTabsBar";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { SurfaceHeaderOption } from "@/components/ui/SurfaceHeader";
import {
  MAX_STANDARD_PANE_WIDTH_PX,
  MIN_PANE_WIDTH_PX,
  normalizeWorkspaceHref,
  type WorkspacePaneStateV3,
} from "@/lib/workspace/schema";
import { resolvePaneDescriptor } from "@/lib/workspace/paneDescriptor";
import { emitWorkspaceTelemetry } from "@/lib/workspace/telemetry";
import { useWorkspaceStore } from "@/lib/workspace/store";
import styles from "./WorkspaceHost.module.css";

// ---------------------------------------------------------------------------
// WorkspaceShellPane — local type, previously exported from WorkspaceShell.
// ---------------------------------------------------------------------------

interface WorkspaceShellPane {
  paneId: string;
  title: string;
  subtitle?: React.ReactNode;
  toolbar?: React.ReactNode;
  actions?: React.ReactNode;
  options?: SurfaceHeaderOption[];
  onBack?: () => void;
  bodyMode: PaneBodyMode;
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  isActive: boolean;
  content: React.ReactNode;
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
// PaneRouteBoundary — intercepts link clicks inside pane content and routes
// them through the pane runtime router.
// ---------------------------------------------------------------------------

function PaneRouteBoundary({ children }: { children: React.ReactNode }) {
  const paneRuntime = usePaneRuntime();

  const handleClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (
        !paneRuntime ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }
      if (anchor.target && anchor.target !== "_self") {
        return;
      }
      if (anchor.hasAttribute("download")) {
        return;
      }

      const hrefAttr = anchor.getAttribute("href");
      if (!hrefAttr || hrefAttr.startsWith("#")) {
        return;
      }

      const normalizedHref = normalizeWorkspaceHref(hrefAttr);
      if (!normalizedHref) {
        return;
      }

      event.preventDefault();
      if (event.shiftKey) {
        paneRuntime.openInNewPane(normalizedHref);
      } else {
        paneRuntime.router.push(normalizedHref);
      }
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
// PaneContent — renders the pane runtime provider, route boundary, error
// boundary, and resolved route view for a single pane.
// ---------------------------------------------------------------------------

const PaneContent = memo(function PaneContent({
  paneId,
  href,
  navigatePane,
  openPane,
  publishPaneTitle,
}: {
  paneId: string;
  href: string;
  navigatePane: (paneId: string, href: string, options?: { replace?: boolean }) => void;
  openPane: (input: { href: string; openerPaneId?: string | null; activate?: boolean }) => void;
  publishPaneTitle: (
    paneId: string,
    title: string | null,
    options?: { resourceRef?: string | null }
  ) => void;
}) {
  const handleReplacePane = useCallback(
    (pid: string, h: string) => navigatePane(pid, h, { replace: true }),
    [navigatePane]
  );
  const handleOpenInNewPane = useCallback(
    (h: string) => openPane({ href: h, openerPaneId: paneId, activate: true }),
    [openPane, paneId]
  );
  const handleSetPaneTitle = useCallback(
    (
      pid: string,
      title: string | null,
      metadata: { routeId: string; resourceRef: string | null }
    ) => {
      publishPaneTitle(pid, title, { resourceRef: metadata.resourceRef });
    },
    [publishPaneTitle]
  );

  const route = useMemo(() => resolvePaneRoute(href), [href]);
  const pathParams = useMemo<Record<string, string>>(() => ({ ...route.params }), [route.params]);

  return (
    <div className={styles.routeShell}>
      <PaneRuntimeProvider
        paneId={paneId}
        href={href}
        routeId={route.id}
        resourceRef={route.resourceRef}
        pathParams={pathParams}
        onNavigatePane={navigatePane}
        onReplacePane={handleReplacePane}
        onOpenInNewPane={handleOpenInNewPane}
        onSetPaneTitle={handleSetPaneTitle}
      >
        <PaneRouteBoundary>
          <PaneRouteErrorBoundary resetKey={href}>
            <ResolvedPaneRouteView route={route} />
          </PaneRouteErrorBoundary>
        </PaneRouteBoundary>
      </PaneRuntimeProvider>
    </div>
  );
});

// ---------------------------------------------------------------------------
// buildShellPane — builds the descriptor object consumed by the shell layout.
// ---------------------------------------------------------------------------

function buildShellPane(input: {
  pane: WorkspacePaneStateV3;
  nowMs: number;
  runtimeTitleByPaneId: ReadonlyMap<string, string>;
  openHintByPaneId: ReadonlyMap<string, { titleHint?: string; resourceRef?: string | null }>;
  resourceTitleByRef: ReadonlyMap<
    string,
    {
      title: string;
      updatedAtMs: number;
      expiresAtMs: number;
    }
  >;
  onNavigatePane: (paneId: string, href: string, options?: { replace?: boolean }) => void;
  onOpenPane: (input: { href: string; openerPaneId?: string | null; activate?: boolean }) => void;
  onPublishPaneTitle: (
    paneId: string,
    title: string | null,
    options?: { resourceRef?: string | null }
  ) => void;
  isActive: boolean;
}): WorkspaceShellPane {
  const route = resolvePaneRoute(input.pane.href);
  const descriptor = resolvePaneDescriptor(input.pane, {
    nowMs: input.nowMs,
    runtimeTitleByPaneId: input.runtimeTitleByPaneId,
    openHintByPaneId: input.openHintByPaneId,
    resourceTitleByRef: input.resourceTitleByRef,
  });
  const chrome = route.definition?.getChrome?.({
    href: input.pane.href,
    params: route.params,
  });
  const title = descriptor.resolvedTitle || chrome?.title || "Pane";

  const parentHref = getParentHref(route);
  const onBack = parentHref
    ? () => input.onNavigatePane(input.pane.id, parentHref)
    : () => window.history.back();

  return {
    paneId: input.pane.id,
    title,
    subtitle: chrome?.subtitle,
    toolbar: chrome?.toolbar,
    actions: chrome?.actions,
    onBack,
    bodyMode: route.definition?.bodyMode ?? "standard",
    widthPx: input.pane.widthPx,
    minWidthPx: route.definition?.minWidthPx ?? MIN_PANE_WIDTH_PX,
    maxWidthPx: route.definition?.maxWidthPx ?? MAX_STANDARD_PANE_WIDTH_PX,
    isActive: input.isActive,
    content: (
      <PaneContent
        paneId={input.pane.id}
        href={input.pane.href}
        navigatePane={input.onNavigatePane}
        openPane={input.onOpenPane}
        publishPaneTitle={input.onPublishPaneTitle}
      />
    ),
  };
}

// ---------------------------------------------------------------------------
// WorkspaceHost — the top-level pane orchestrator. Reads workspace state,
// builds pane descriptors, and renders the shell layout with tabs + pane strip.
// ---------------------------------------------------------------------------

export default function WorkspaceHost() {
  const {
    state,
    runtimeTitleByPaneId,
    openHintByPaneId,
    resourceTitleByRef,
    activatePane,
    openPane,
    navigatePane,
    closePane,
    resizePane,
    publishPaneTitle,
  } = useWorkspaceStore();
  const titleTelemetryByPaneIdRef = useRef<Map<string, string>>(new Map());

  // --- Mobile / focus management (inlined from WorkspaceShell) ---
  const isMobile = useIsMobileViewport();
  const paneWrapRefById = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingPaneChromeFocusPaneIdRef = useRef<string | null>(null);

  useEffect(() => {
    const nowMs = Date.now();
    const nextTelemetryByPaneId = new Map<string, string>();

    for (const pane of state.panes) {
      const descriptor = resolvePaneDescriptor(pane, {
        nowMs,
        runtimeTitleByPaneId,
        openHintByPaneId,
        resourceTitleByRef,
      });
      const telemetryKey = [
        descriptor.resolvedTitle,
        descriptor.titleSource,
        descriptor.routeId,
      ].join("|");
      nextTelemetryByPaneId.set(pane.id, telemetryKey);
      if (titleTelemetryByPaneIdRef.current.get(pane.id) === telemetryKey) {
        continue;
      }
      emitWorkspaceTelemetry({
        type: "title",
        status: descriptor.titleSource === "safe_fallback" ? "fallback" : "ok",
        errorCode: descriptor.titleSource === "safe_fallback" ? "safe_fallback_title" : null,
        titleSource: descriptor.titleSource,
        routeId: descriptor.routeId,
      });
    }

    titleTelemetryByPaneIdRef.current = nextTelemetryByPaneId;
  }, [openHintByPaneId, resourceTitleByRef, runtimeTitleByPaneId, state.panes]);

  const panes = useMemo(
    () =>
      state.panes.map((pane) =>
        buildShellPane({
          pane,
          nowMs: Date.now(),
          runtimeTitleByPaneId,
          openHintByPaneId,
          resourceTitleByRef,
          onNavigatePane: navigatePane,
          onOpenPane: openPane,
          onPublishPaneTitle: publishPaneTitle,
          isActive: pane.id === state.activePaneId,
        })
      ),
    [
      state.panes,
      state.activePaneId,
      runtimeTitleByPaneId,
      openHintByPaneId,
      resourceTitleByRef,
      navigatePane,
      openPane,
      publishPaneTitle,
    ]
  );

  // --- Tabs for desktop tab bar ---
  const tabs = useMemo(
    () =>
      panes.map((pane) => ({
        paneId: pane.paneId,
        title: pane.title,
        isActive: pane.isActive,
      })),
    [panes]
  );

  const activePane = panes.find((pane) => pane.paneId === state.activePaneId) ?? panes[0] ?? null;
  const visiblePanes = isMobile ? (activePane ? [activePane] : []) : panes;

  // --- Focus management (from WorkspaceShell) ---
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
    paneWrap.scrollIntoView({ block: "nearest", inline: "nearest" });
    const chrome = paneWrap.querySelector<HTMLElement>(
      '[data-pane-chrome-focus="true"]'
    );
    if (!chrome) {
      return;
    }
    chrome.focus({ preventScroll: true });
    pendingPaneChromeFocusPaneIdRef.current = null;
  }, [state.activePaneId, isMobile]);

  const handleActivatePane = (
    paneId: string,
    options?: { focusPaneChrome?: boolean }
  ) => {
    const shouldFocusPaneChrome = options?.focusPaneChrome !== false;
    activatePane(paneId);
    const paneWrap = paneWrapRefById.current.get(paneId);
    paneWrap?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
        <WorkspaceTabsBar
          tabs={tabs}
          onActivatePane={handleActivatePane}
          onClosePane={handleClosePane}
          mobileSwitcherLabel="Open panes"
        />
      )}
      <div
        style={{
          width: "100%",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "row",
          gap: 0,
          overflowX: isMobile ? "hidden" : "auto",
          overflowY: "hidden",
        }}
      >
        {visiblePanes.map((pane) => (
          <div
            key={pane.paneId}
            className={styles.paneWrap}
            id={`workspace-panel-${pane.paneId}`}
            aria-labelledby={`workspace-tab-${pane.paneId}`}
            data-active={pane.isActive ? "true" : "false"}
            data-mobile={isMobile ? "true" : "false"}
            ref={(element) => {
              if (element) {
                paneWrapRefById.current.set(pane.paneId, element);
              } else {
                paneWrapRefById.current.delete(pane.paneId);
              }
            }}
            onMouseDown={() => handleActivatePane(pane.paneId, { focusPaneChrome: false })}
          >
            <PaneShell
              paneId={pane.paneId}
              title={pane.title}
              subtitle={pane.subtitle}
              toolbar={pane.toolbar}
              actions={pane.actions}
              options={pane.options}
              onBack={pane.onBack}
              widthPx={pane.widthPx}
              minWidthPx={pane.minWidthPx}
              maxWidthPx={pane.maxWidthPx}
              bodyMode={pane.bodyMode}
              onResizePane={resizePane}
              isActive={pane.isActive}
              isMobile={isMobile}
            >
              {pane.content}
            </PaneShell>
          </div>
        ))}
      </div>
    </section>
  );
}
