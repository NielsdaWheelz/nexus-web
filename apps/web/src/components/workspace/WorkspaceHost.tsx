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
import WorkspacePaneCanvas from "@/components/workspace/WorkspacePaneCanvas";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";
import { usePaneCanvas } from "@/components/workspace/usePaneCanvas";
import { useWritingState } from "@/lib/notes/readiness";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { FeedbackState } from "@/components/feedback/Feedback";
import { checkSession } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { renderPane } from "@/lib/panes/paneRenderRegistry";
import { paneMountKey, resolvePaneRouteModel, type PaneRouteId } from "@/lib/panes/paneRouteModel";
import { getInteractionGeneration, hasActiveInteractionOwner, useInteractionOwner } from "@/lib/ui/overlay";
import { isNavigationAttention, NAVIGATION_ATTENTION_EVENTS } from "@/lib/ui/eventTarget";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useAdjacentPaneKeybindings } from "@/lib/workspace/adjacentPaneKeybindings";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { primaryWidth } from "@/lib/workspace/paneSizing";
import { useWorkspacePresentations } from "@/lib/workspace/presentations";
import {
  useLatestWorkspace,
  useWorkspaceStore,
  type WorkspaceSelection,
} from "@/lib/workspace/store";
import styles from "./WorkspaceHost.module.css";

/** cold bodies wait for presentation; admitted bodies retain their mounted work.
 * the existing body key owns replacement, and primitive props avoid unrelated renders. */
const PaneContent = memo(function PaneContent(props: {
  readonly routeId: PaneRouteId | "unsupported";
  readonly pathname: string;
  readonly isPresented: boolean;
}) {
  const admission = useRemoteAdmission();
  const writingState = useWritingState();
  const writingReady = writingState === "ready";
  const local = props.routeId === "unsupported" || ["settings", "settingsAppearance", "settingsReader", "settingsKeybindings"].includes(props.routeId);
  const canAdmit = writingReady && (local || admission === "Ready");
  const [admitted, setAdmitted] = useState(props.isPresented && canAdmit);
  if (!admitted && props.isPresented && canAdmit) setAdmitted(true);
  if (!admitted && !props.isPresented) return null;
  if (!admitted && writingState === "failed") return <FeedbackState content={{ tone: "Warning", title: "writing couldn’t start" }} announcement="Polite" />;
  if (!admitted && !writingReady) return <PaneLoadingState label="opening writing…" announcement="Polite" />;
  if (!admitted && !canAdmit) return <FeedbackState content={{ tone: "Neutral", title: "this view needs a connection" }} announcement="Polite" actions={[{ label: "try again", onClick: checkSession }]} />;
  if (props.routeId !== "unsupported") return renderPane(props.routeId);
  return <FeedbackState content={{ tone: "Neutral", title: "this destination is unavailable" }} announcement="Polite" />;
});

/**
 * The workspace's layout: the strip and the horizontal canvas on desktop, the
 * one active pane on mobile; the browser title; and which pane holds focus
 * when activation or the layout changes. It knows nothing of pane chrome.
 */
export default function WorkspaceHost() {
  const store = useWorkspaceStore();
  const { state, columnWidthPx } = store;
  const presentations = useWorkspacePresentations();
  const activeId = state.active_primary_pane_id;
  const isMobile = useIsMobileViewport();
  const latestWorkspace = useLatestWorkspace();
  const interactionOwner = useInteractionOwner();
  const [isMaximized, setIsMaximized] = useState(false);
  const maximized = isMaximized && !isMobile;
  const panes = useMemo(
    () =>
      state.panes.map((pane) => ({
        pane,
        route: resolvePaneRouteModel(pane.current_visit.href),
        label: presentations.forVisit(pane.current_visit).title,
      })),
    [state.panes, presentations],
  );
  const active = panes.find(({ pane }) => pane.id === activeId)!;
  const rendered = (isMobile ? [active] : panes).map((item) => ({
    ...item,
    bodyKey: paneMountKey(item.route, item.pane.current_visit.id),
    isVisible: item.pane.visibility === "visible" && (!maximized || item.pane.id === activeId),
  }));
  const canvas = usePaneCanvas({
    mode: isMobile ? "Disabled" : maximized ? "Maximized" : "Canvas",
    paneIds: panes.map(({ pane }) => pane.id),
  });

  // ---- focus follows activation; a layout flip only repairs lost focus ----
  const pendingFocus = useRef<string | null>(null);
  const contentActivation = useRef<string | null>(null);
  const destinationFocus = useRef<{ request: WorkspaceSelection; overlayGeneration: number } | null>(null);
  const requestedFocus = store.pendingPaneFocus;
  useLayoutEffect(() => {
    if (!requestedFocus) {
      destinationFocus.current = null;
      return;
    }
    if (destinationFocus.current?.request !== requestedFocus) {
      // This baseline follows the activation's own commit, not its former foreground.
      destinationFocus.current = { request: requestedFocus, overlayGeneration: getInteractionGeneration() };
      contentActivation.current = null;
      pendingFocus.current = null;
    }
    if (destinationFocus.current.overlayGeneration !== getInteractionGeneration()) {
      latestWorkspace().claimPaneFocus(requestedFocus);
      return;
    }
    if (interactionOwner) return;
    const frame = requestAnimationFrame(() => {
      const workspace = latestWorkspace();
      if (workspace.pendingPaneFocus !== requestedFocus || hasActiveInteractionOwner()) return;
      const landmark = findPaneLandmarkFocusTarget(requestedFocus.paneId);
      if (landmark?.contains(document.activeElement)) {
        workspace.claimPaneFocus(requestedFocus);
        return;
      }
      const target = isMobile ? landmark : findPaneChromeFocusTarget(requestedFocus.paneId);
      if (target && workspace.claimPaneFocus(requestedFocus)) target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedFocus, interactionOwner, isMobile, latestWorkspace]);
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
    if (workspace.pendingPaneFocus) return;
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
  useEffect(() => {
    const cancelDestinationFocus = (event: Event) => {
      if (!isNavigationAttention(event)) return;
      const workspace = latestWorkspace();
      if (workspace.pendingPaneFocus) workspace.claimPaneFocus(workspace.pendingPaneFocus);
    };
    // Before React's document capture: the gesture creating a request cannot revoke it.
    for (const event of NAVIGATION_ATTENTION_EVENTS) window.addEventListener(event, cancelDestinationFocus, { capture: true, passive: true });
    return () => {
      for (const event of NAVIGATION_ATTENTION_EVENTS) window.removeEventListener(event, cancelDestinationFocus, true);
    };
  }, [latestWorkspace]);
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
          items={panes.map(({ pane, label }) => ({
            paneId: pane.id,
            href: pane.current_visit.href,
            label,
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
          onRestore={store.activatePane}
          onMinimize={store.minimizePane}
          onClose={store.closePane}
        />
      )}
      <div className={styles.canvasViewport}>
        <WorkspacePaneCanvas
          canvasRef={canvas.ref}
          panes={rendered.map(({ pane, bodyKey, isVisible }) => ({
            paneId: pane.id,
            visitId: pane.current_visit.id,
            bodyKey,
            isVisible,
          }))}
          maximized={maximized}
          onWheel={canvas.onWheel}
        >
          {rendered.map(({ pane, route, label, bodyKey, isVisible }) => {
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
                  resetKey={`${pane.id}:${pane.current_visit.id}:${route.routeKey}`}
                  slotMinWidth={isMobile || maximized ? "100%" : `${slot.widthPx}px`}
                  onBack={pane.history.back.length ? () => {
                    if (store.goBackPane(pane.id) === "committed") requestPaneFocus(pane.id);
                  } : null}
                >
                  <PaneShell
                    pane={pane}
                    bodyKey={bodyKey}
                    route={route}
                    label={label}
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
                      isPresented={isVisible && (pane.id === activeId || canvas.inViewPaneIds.has(pane.id))}
                    />
                  </PaneShell>
                </PaneRouteErrorBoundary>
              </div>
            );
          })}
        </WorkspacePaneCanvas>
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
