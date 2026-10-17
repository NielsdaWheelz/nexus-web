"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PaneRouteErrorBoundary } from "@/components/workspace/PaneRouteErrorBoundary";
import PaneShell from "@/components/workspace/PaneShell";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";
import { usePaneCanvas } from "@/components/workspace/usePaneCanvas";
import { renderPane } from "@/lib/panes/paneRenderRegistry";
import { paneMountKey, type PaneRouteId } from "@/lib/panes/paneRouteModel";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useAdjacentPaneKeybindings } from "@/lib/workspace/adjacentPaneKeybindings";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { primaryWidth } from "@/lib/workspace/paneSizing";
import {
  resolveWorkspacePaneLabel,
  useLatestWorkspace,
  useWorkspaceStore,
} from "@/lib/workspace/store";
import styles from "./WorkspaceHost.module.css";

/** The body a visit mounts; primitive props, so unrelated host renders skip it. */
const PaneContent = memo(function PaneContent(props: {
  readonly routeId: PaneRouteId | "unsupported";
  readonly pathname: string;
}) {
  if (props.routeId !== "unsupported") return renderPane(props.routeId);
  return (
    <div className={styles.unsupported}>
      This route is not yet supported in side-by-side pane mode: `
      {props.pathname}`
    </div>
  );
});

/**
 * The workspace's layout: the strip and the horizontal canvas on desktop, the
 * one active pane on mobile; the browser title; and which pane holds focus
 * when activation or the layout changes. It knows nothing of pane chrome.
 */
export default function WorkspaceHost() {
  const store = useWorkspaceStore();
  const { state, columnWidthPx, runtimeLabelByPaneId } = store;
  const activeId = state.active_primary_pane_id;
  const isMobile = useIsMobileViewport();
  const latestWorkspace = useLatestWorkspace();
  const [isMaximized, setIsMaximized] = useState(false);
  const maximized = isMaximized && !isMobile;
  const panes = useMemo(
    () =>
      state.panes.map((pane) => ({
        pane,
        ...resolveWorkspacePaneLabel(pane, runtimeLabelByPaneId),
      })),
    [state.panes, runtimeLabelByPaneId],
  );
  const active = panes.find(({ pane }) => pane.id === activeId)!;
  const rendered = isMobile ? [active] : panes;
  const canvas = usePaneCanvas({
    mode: isMobile ? "Disabled" : maximized ? "Maximized" : "Canvas",
    paneIds: panes.map(({ pane }) => pane.id),
  });

  // ---- focus follows activation; a layout flip only repairs lost focus ----
  const pendingFocus = useRef<string | null>(null);
  const contentActivation = useRef<string | null>(null);
  const focusPane = useCallback(
    (paneId: string) => {
      if (hasActiveInteractionOwner() || latestWorkspace().state.active_primary_pane_id !== paneId) {
        pendingFocus.current = null;
        return;
      }
      const target = isMobile
        ? findPaneLandmarkFocusTarget(paneId)
        : findPaneChromeFocusTarget(paneId);
      if (!target) return;
      target.focus({ preventScroll: true });
      pendingFocus.current = null;
    },
    [isMobile, latestWorkspace],
  );
  const requestPaneFocus = useCallback(
    (paneId: string) => {
      contentActivation.current = null;
      pendingFocus.current = paneId;
      requestAnimationFrame(() => {
        if (pendingFocus.current === paneId) focusPane(paneId);
      });
    },
    [focusPane],
  );
  const wasMobile = useRef(isMobile);
  // null: a mobile first mount moves focus into its pane, as a switch does.
  const wasActive = useRef<string | null>(null);
  useLayoutEffect(() => {
    const flipped = wasMobile.current !== isMobile;
    const switched = wasActive.current !== activeId;
    wasMobile.current = isMobile;
    wasActive.current = activeId;
    const workspace = latestWorkspace();
    if (contentActivation.current === activeId || hasActiveInteractionOwner()) {
      pendingFocus.current = null;
      return;
    }
    const delivery = workspace.pendingPaneEntryDeliveryByPaneId.get(activeId);
    // a note entry on mobile keeps its editor's focus.
    const entry = delivery?.entry.kind;
    if (
      isMobile &&
      (entry === "AppendNote" || entry === "FocusNote") &&
      delivery?.visitId === workspace.state.panes.find((pane) => pane.id === activeId)?.current_visit.id
    ) {
      pendingFocus.current = null;
      return;
    }
    if (pendingFocus.current) return focusPane(pendingFocus.current);
    // mobile mounts a newly active pane: focus moves into it.
    if (isMobile && switched) return focusPane(activeId);
    // a flip moves focus only when the focused element went away.
    const lost =
      document.activeElement === null ||
      document.activeElement === document.body;
    if (flipped && lost) focusPane(activeId);
  }, [activeId, isMobile, focusPane, latestWorkspace]);
  const { scrollPaneIntoView } = canvas;
  useLayoutEffect(() => {
    const contentOrigin = contentActivation.current === activeId;
    contentActivation.current = null;
    if (!contentOrigin) scrollPaneIntoView(activeId);
  }, [activeId, scrollPaneIntoView]);
  useEffect(() => {
    const cancelFocus = () => {
      pendingFocus.current = null;
    };
    document.addEventListener("focusin", cancelFocus);
    document.addEventListener("pointerdown", cancelFocus);
    return () => {
      cancelFocus();
      document.removeEventListener("focusin", cancelFocus);
      document.removeEventListener("pointerdown", cancelFocus);
    };
  }, []);
  useAdjacentPaneKeybindings({ onActivated: requestPaneFocus });

  const activateFromContent = (paneId: string) => {
    pendingFocus.current = null;
    const workspace = latestWorkspace();
    if (workspace.state.active_primary_pane_id === paneId) return;
    contentActivation.current = paneId;
    canvas.releaseHeldTarget();
    workspace.activatePane(paneId);
  };

  return (
    <section className={styles.host} aria-label="Workspace host">
      {/* the only writer of the browser title: inactive panes never race it. */}
      <title>{`${active.label} · Nexus`}</title>
      {isMobile ? null : (
        <WorkspacePaneStrip
          state={state}
          isMaximized={isMaximized}
          items={panes.map(({ pane, label, labelState }) => ({
            paneId: pane.id,
            href: pane.current_visit.href,
            label,
            pending: labelState === "pending",
            isActive: pane.id === activeId,
            isInView: maximized ? pane.id === activeId : canvas.inViewPaneIds.has(pane.id),
            minimized: pane.visibility === "minimized",
          }))}
          onActivate={(paneId) => {
            contentActivation.current = null;
            store.activatePane(paneId);
            scrollPaneIntoView(paneId);
            requestPaneFocus(paneId);
          }}
          onToggleMaximize={(paneId) => {
            contentActivation.current = null;
            const restoring = isMaximized && latestWorkspace().state.active_primary_pane_id === paneId;
            store.activatePane(paneId);
            setIsMaximized(!restoring);
          }}
          onMove={store.movePane}
          onRestore={store.restorePane}
          onMinimize={store.minimizePane}
          onClose={store.closePane}
        />
      )}
      <div className={styles.canvasViewport}>
        <div
          ref={canvas.ref}
          className={styles.paneCanvas}
          data-maximized={maximized || undefined}
          onWheel={canvas.onWheel}
        >
          {rendered.map(({ pane, route, label, labelState }) => {
            const isVisible = pane.visibility === "visible" && (!maximized || pane.id === activeId);
            const bodyKey = paneMountKey(route, pane.current_visit.id);
            const slot = primaryWidth({
              storedPx: pane.primary_width_px,
              columnPx: columnWidthPx,
              routeMaxPx: route.width.maxWidthPx,
              intrinsicPx: null,
            });
            return (
              <div
                key={pane.id}
                className={styles.paneWrap}
                data-pane-id={pane.id}
                data-mobile={isMobile}
                data-maximized={maximized || undefined}
                hidden={!isVisible}
                inert={!isVisible || undefined}
                onPointerDown={(event) => {
                  if (event.button === 0 && event.currentTarget.contains(event.target as Node)) {
                    canvas.releaseHeldTarget();
                    activateFromContent(pane.id);
                  }
                }}
                onFocusCapture={(event) => {
                  if (event.currentTarget.contains(event.target as Node))
                    activateFromContent(pane.id);
                }}
              >
                <PaneRouteErrorBoundary
                  paneId={pane.id}
                  visitId={pane.current_visit.id}
                  isActive={pane.id === activeId}
                  resetKey={`${pane.id}:${route.routeKey}`}
                  slotMinWidth={isMobile || maximized ? "100%" : `${slot.widthPx}px`}
                >
                  <PaneShell
                    pane={pane}
                    bodyKey={bodyKey}
                    route={route}
                    label={label}
                    labelPending={labelState === "pending"}
                    isActive={pane.id === activeId}
                    isMobile={isMobile}
                    isVisible={isVisible}
                    isMaximized={maximized}
                    availableWidthPx={canvas.availableWidthPx}
                    columnWidthPx={columnWidthPx}
                    onChromeMouseDown={canvas.onChromeMouseDown}
                  >
                    <PaneContent
                      key={bodyKey}
                      routeId={route.id}
                      pathname={route.pathname}
                    />
                  </PaneShell>
                </PaneRouteErrorBoundary>
              </div>
            );
          })}
        </div>
        {canvas.edges.start ? (
          <div className={styles.edgeFade} data-side="start" />
        ) : null}
        {canvas.edges.end ? (
          <div className={styles.edgeFade} data-side="end" />
        ) : null}
      </div>
    </section>
  );
}
