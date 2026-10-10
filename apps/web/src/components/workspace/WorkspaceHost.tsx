"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { PaneRouteErrorBoundary } from "@/components/workspace/PaneRouteErrorBoundary";
import PaneShell from "@/components/workspace/PaneShell";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";
import { usePaneCanvas } from "@/components/workspace/usePaneCanvas";
import { renderPane } from "@/lib/panes/paneRenderRegistry";
import { paneMountKey, type PaneRouteId } from "@/lib/panes/paneRouteModel";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useAdjacentPaneKeybindings } from "@/lib/workspace/adjacentPaneKeybindings";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { primaryWidth } from "@/lib/workspace/paneSizing";
import {
  resolveWorkspacePaneLabel,
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
  const activeId = state.activePrimaryPaneId;
  const isMobile = useIsMobileViewport();
  const panes = useMemo(
    () =>
      state.panes.map((pane) => ({
        pane,
        ...resolveWorkspacePaneLabel(pane, runtimeLabelByPaneId),
      })),
    [state.panes, runtimeLabelByPaneId],
  );
  const visibleCount = panes.filter(
    ({ pane }) => pane.visibility === "visible",
  ).length;
  // mobile renders the active visible pane, else the first visible one.
  const active =
    panes.find(
      ({ pane }) => pane.id === activeId && pane.visibility === "visible",
    ) ??
    panes.find(({ pane }) => pane.visibility === "visible") ??
    null;
  const rendered = isMobile ? (active ? [active] : []) : panes;
  const canvas = usePaneCanvas({
    enabled: !isMobile,
    paneIds: panes.map(({ pane }) => pane.id),
  });

  // ---- focus follows activation; a layout flip only repairs lost focus ----
  const pendingFocus = useRef<string | null>(null);
  const focusPane = useCallback(
    (paneId: string) => {
      const target = isMobile
        ? findPaneLandmarkFocusTarget(paneId)
        : findPaneChromeFocusTarget(paneId);
      if (!target) return;
      target.focus({ preventScroll: true });
      pendingFocus.current = null;
    },
    [isMobile],
  );
  const requestPaneFocus = useCallback(
    (paneId: string) => {
      pendingFocus.current = paneId;
      requestAnimationFrame(() => {
        if (pendingFocus.current === paneId) focusPane(paneId);
      });
    },
    [focusPane],
  );
  const latest = useRef({ store, active });
  latest.current = { store, active };
  const wasMobile = useRef(isMobile);
  // null: a mobile first mount moves focus into its pane, as a switch does.
  const wasActive = useRef<string | null>(null);
  useLayoutEffect(() => {
    const flipped = wasMobile.current !== isMobile;
    const switched = wasActive.current !== activeId;
    wasMobile.current = isMobile;
    wasActive.current = activeId;
    const { store, active } = latest.current;
    const delivery = store.pendingPaneEntryDeliveryByPaneId.get(activeId);
    // an appended note on mobile keeps its editor's focus.
    if (
      isMobile &&
      delivery?.entry.kind === "AppendNote" &&
      delivery.visitId === active?.pane.currentVisit.id
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
  }, [activeId, isMobile, focusPane]);
  const { scrollPaneIntoView } = canvas;
  useEffect(() => {
    scrollPaneIntoView(activeId);
  }, [activeId, scrollPaneIntoView]);
  useAdjacentPaneKeybindings({ onActivated: requestPaneFocus });

  return (
    <section className={styles.host} aria-label="Workspace host">
      {/* the only writer of the browser title: inactive panes never race it. */}
      <title>{active ? `${active.label} · Nexus` : "Nexus"}</title>
      {isMobile ? null : (
        <WorkspacePaneStrip
          items={panes.map(({ pane, label, labelState }) => ({
            paneId: pane.id,
            href: pane.currentVisit.href,
            label,
            pending: labelState === "pending",
            isActive: pane.id === activeId,
            isInView: canvas.inViewPaneIds.has(pane.id),
            minimized: pane.visibility === "minimized",
            canMinimize: pane.visibility === "visible" && visibleCount > 1,
          }))}
          onActivate={(paneId) => {
            store.activatePane(paneId);
            requestPaneFocus(paneId);
          }}
          onRestore={store.restorePane}
          onMinimize={store.minimizePane}
          onClose={store.closePane}
        />
      )}
      <div className={styles.canvasViewport}>
        <div
          ref={canvas.ref}
          className={styles.paneCanvas}
          onWheel={canvas.onWheel}
        >
          {rendered.map(({ pane, route, label, labelState }) => {
            const minimized = pane.visibility === "minimized";
            const bodyKey = paneMountKey(route, pane.currentVisit.id);
            const slot = primaryWidth({
              storedPx: pane.primaryWidthPx,
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
                hidden={minimized}
                inert={minimized || undefined}
                onMouseDown={() => store.activatePane(pane.id)}
              >
                <PaneRouteErrorBoundary
                  paneId={pane.id}
                  visitId={pane.currentVisit.id}
                  isActive={pane.id === activeId}
                  resetKey={`${pane.id}:${route.routeKey}`}
                  slotMinWidth={isMobile ? "100%" : `${slot.widthPx}px`}
                >
                  <PaneShell
                    pane={pane}
                    bodyKey={bodyKey}
                    route={route}
                    label={label}
                    labelPending={labelState === "pending"}
                    isActive={pane.id === activeId}
                    isMobile={isMobile}
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
