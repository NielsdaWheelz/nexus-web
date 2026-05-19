"use client";

import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getParentHref,
  resolvePaneRoute,
  type ResolvedPaneRoute,
} from "@/lib/panes/paneRouteRegistry";
import { PaneRuntimeProvider, usePaneRuntime } from "@/lib/panes/paneRuntime";
import PaneShell, { type PaneBodyMode } from "@/components/workspace/PaneShell";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { loadKeybindings, matchesKeyEvent } from "@/lib/keybindings";
import type { SurfaceHeaderOption } from "@/components/ui/SurfaceHeader";
import {
  MAX_STANDARD_PANE_WIDTH_PX,
  MIN_PANE_WIDTH_PX,
  normalizeWorkspaceHref,
  type WorkspacePaneStateV4,
} from "@/lib/workspace/schema";
import { emitWorkspaceTelemetry } from "@/lib/workspace/telemetry";
import {
  resolveWorkspacePaneTitle,
  useWorkspaceStore,
  type WorkspacePaneTitleDescriptor,
} from "@/lib/workspace/store";
import { usePaneCanvas } from "./usePaneCanvas";
import styles from "./WorkspaceHost.module.css";

// ---------------------------------------------------------------------------
// WorkspaceShellPane — local type, previously exported from WorkspaceShell.
// ---------------------------------------------------------------------------

interface WorkspaceShellPane {
  paneId: string;
  href: string;
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
  extraWidthPx: number;
  isActive: boolean;
  visibility: "visible" | "minimized";
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
      if (resolvePaneRoute(normalizedHref).id === "unsupported") {
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
  publishPaneMinWidth,
  publishPaneExtraWidth,
}: {
  paneId: string;
  href: string;
  navigatePane: (
    paneId: string,
    href: string,
    options?: { replace?: boolean; activate?: boolean },
  ) => void;
  openPane: (input: { href: string; openerPaneId?: string | null; activate?: boolean }) => void;
  publishPaneTitle: (paneId: string, title: string | null) => void;
  publishPaneMinWidth: (paneId: string, widthPx: number | null) => void;
  publishPaneExtraWidth: (paneId: string, widthPx: number) => void;
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
    (pid: string, title: string | null) => {
      publishPaneTitle(pid, title);
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
        onSetPaneMinWidth={publishPaneMinWidth}
        onSetPaneExtraWidth={publishPaneExtraWidth}
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
  pane: WorkspacePaneStateV4;
  descriptor: WorkspacePaneTitleDescriptor;
  onNavigatePane: (
    paneId: string,
    href: string,
    options?: { replace?: boolean; activate?: boolean },
  ) => void;
  onOpenPane: (input: { href: string; openerPaneId?: string | null; activate?: boolean }) => void;
  onPublishPaneTitle: (paneId: string, title: string | null) => void;
  onPublishPaneMinWidth: (paneId: string, widthPx: number | null) => void;
  onPublishPaneExtraWidth: (paneId: string, widthPx: number) => void;
  isActive: boolean;
  runtimeMinWidthPx: number | null;
  runtimeExtraWidthPx: number;
}): WorkspaceShellPane {
  const { chrome, route, title } = input.descriptor;
  const parentHref = getParentHref(route);
  const onBack = parentHref
    ? () => input.onNavigatePane(input.pane.id, parentHref)
    : () => window.history.back();

  const maxWidthPx = route.definition?.maxWidthPx ?? MAX_STANDARD_PANE_WIDTH_PX;
  const routeMinWidthPx = route.definition?.minWidthPx ?? MIN_PANE_WIDTH_PX;
  const minWidthPx = Math.min(
    maxWidthPx,
    Math.max(routeMinWidthPx, input.runtimeMinWidthPx ?? routeMinWidthPx)
  );

  return {
    paneId: input.pane.id,
    href: input.pane.href,
    title,
    subtitle: chrome?.subtitle,
    toolbar: chrome?.toolbar,
    actions: chrome?.actions,
    onBack,
    bodyMode: route.definition?.bodyMode ?? "standard",
    widthPx: input.pane.widthPx,
    minWidthPx,
    maxWidthPx,
    extraWidthPx: input.runtimeExtraWidthPx,
    isActive: input.isActive,
    visibility: input.pane.visibility,
    content: (
      <PaneContent
        paneId={input.pane.id}
        href={input.pane.href}
        navigatePane={input.onNavigatePane}
        openPane={input.onOpenPane}
        publishPaneTitle={input.onPublishPaneTitle}
        publishPaneMinWidth={input.onPublishPaneMinWidth}
        publishPaneExtraWidth={input.onPublishPaneExtraWidth}
      />
    ),
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
    closePane,
    resizePane,
    minimizePane,
    restorePane,
    publishPaneTitle,
  } = useWorkspaceStore();
  const titleTelemetryByPaneIdRef = useRef<Map<string, string>>(new Map());
  const [runtimeMinWidthByPaneId, setRuntimeMinWidthByPaneId] = useState<Map<string, number>>(
    () => new Map()
  );
  const [runtimeExtraWidthByPaneId, setRuntimeExtraWidthByPaneId] = useState<
    Map<string, number>
  >(() => new Map());

  // --- Mobile / focus management (inlined from WorkspaceShell) ---
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

  const publishPaneMinWidth = useCallback((paneId: string, widthPx: number | null) => {
    setRuntimeMinWidthByPaneId((current) => {
      if (widthPx === null || !Number.isFinite(widthPx) || widthPx <= 0) {
        if (!current.has(paneId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(paneId);
        return next;
      }

      const roundedWidthPx = Math.ceil(widthPx);
      if (current.get(paneId) === roundedWidthPx) {
        return current;
      }
      const next = new Map(current);
      next.set(paneId, roundedWidthPx);
      return next;
    });
  }, []);

  const publishPaneExtraWidth = useCallback((paneId: string, widthPx: number) => {
    setRuntimeExtraWidthByPaneId((current) => {
      if (widthPx <= 0) {
        if (!current.has(paneId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(paneId);
        return next;
      }
      if (current.get(paneId) === widthPx) {
        return current;
      }
      const next = new Map(current);
      next.set(paneId, widthPx);
      return next;
    });
  }, []);

  useEffect(() => {
    const nextTelemetryByPaneId = new Map<string, string>();

    for (const { pane, descriptor } of paneDescriptors) {
      const telemetryKey = [
        descriptor.title,
        descriptor.titleSource,
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
        titleSource: descriptor.titleSource,
        routeId: descriptor.route.id,
      });
    }

    titleTelemetryByPaneIdRef.current = nextTelemetryByPaneId;
  }, [paneDescriptors]);

  const panes = useMemo(
    () =>
      paneDescriptors.map(({ pane, descriptor }) =>
        buildShellPane({
          pane,
          descriptor,
          onNavigatePane: navigatePane,
          onOpenPane: openPane,
          onPublishPaneTitle: publishPaneTitle,
          onPublishPaneMinWidth: publishPaneMinWidth,
          onPublishPaneExtraWidth: publishPaneExtraWidth,
          isActive: pane.id === state.activePaneId,
          runtimeMinWidthPx: runtimeMinWidthByPaneId.get(pane.id) ?? null,
          runtimeExtraWidthPx: runtimeExtraWidthByPaneId.get(pane.id) ?? 0,
        })
      ),
    [
      paneDescriptors,
      state.activePaneId,
      navigatePane,
      openPane,
      publishPaneTitle,
      publishPaneMinWidth,
      publishPaneExtraWidth,
      runtimeMinWidthByPaneId,
      runtimeExtraWidthByPaneId,
    ]
  );

  const { canvasRef, onWheel, edges, inViewPaneIds, handleChromeMouseDown, scrollPaneIntoView } =
    usePaneCanvas({ enabled: !isMobile, paneIds: panes.map((pane) => pane.paneId) });

  useEffect(() => {
    if (isMobile) {
      return;
    }
    for (const pane of panes) {
      if (pane.visibility === "visible" && pane.widthPx < pane.minWidthPx) {
        resizePane(pane.paneId, pane.minWidthPx);
      }
    }
  }, [isMobile, panes, resizePane]);

  const visiblePaneCount = state.panes.filter((pane) => pane.visibility === "visible").length;
  const stripItems = useMemo(
    () =>
      panes.map((pane) => ({
        paneId: pane.paneId,
        title: pane.title,
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
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
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
              <PaneShell
                paneId={pane.paneId}
                href={pane.href}
                title={pane.title}
                subtitle={pane.subtitle}
                toolbar={pane.toolbar}
                actions={pane.actions}
                options={pane.options}
                onBack={pane.onBack}
                widthPx={pane.widthPx}
                minWidthPx={pane.minWidthPx}
                maxWidthPx={pane.maxWidthPx}
                extraWidthPx={pane.extraWidthPx}
                bodyMode={pane.bodyMode}
                onResizePane={resizePane}
                onChromeMouseDown={handleChromeMouseDown}
                isActive={pane.isActive}
                isMobile={isMobile}
              >
                {pane.content}
              </PaneShell>
            </div>
          ))}
        </div>
        {edges.atStart && <div className={styles.edgeFade} data-side="start" />}
        {edges.atEnd && <div className={styles.edgeFade} data-side="end" />}
      </div>
    </section>
  );
}
