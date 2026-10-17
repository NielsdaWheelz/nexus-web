"use client";

import { RotateCcw, Search, Share2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import FindBar from "@/components/find/FindBar";
import { FeedbackNotice, FeedbackScope } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import SurfaceHeader from "@/components/ui/SurfaceHeader";
import Companion, {
  companionAction,
  companionExpanded,
  createCompanionController,
  type CompanionController,
  type CompanionPresentation,
} from "@/components/workspace/Companion";
import PaneRouteBoundary from "@/components/workspace/PaneRouteBoundary";
import ResizeHandle from "@/components/workspace/ResizeHandle";
import { usePaneRefresh } from "@/components/workspace/usePaneRefresh";
import { useThrowLater } from "@/lib/api/serverState";
import {
  useMobileChrome,
  useMobileChromeHold,
  useMobileChromeSurface,
  usePublishMobilePaneChrome,
} from "@/lib/mobileShell/chrome";
import {
  readMobileCssLength,
  useMobileViewport,
} from "@/lib/mobileShell/viewport";
import {
  createPaneChromeStore,
  PANE_COMMAND_RESOLVING_REASON,
  PaneChromeContext,
  usePaneChromeState,
  type PaneChromeState,
  type PaneChromeStore,
} from "@/lib/panes/paneChrome";
import {
  paneHeaderAccessibleName,
  resolvePaneHeaderModel,
} from "@/lib/panes/paneHeaderModel";
import {
  resolvePaneRouteShareIdentity,
  type ResolvedPaneRouteModel,
} from "@/lib/panes/paneRouteModel";
import {
  PaneRuntimeProvider,
  paneSourceKey,
  requirePaneRuntime,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { COMPANION_MAX_WIDTH_PX, COMPANION_MIN_WIDTH_PX, paneSecondaryRegionId } from "@/lib/panes/paneSecondaryModel";
import { activateTargetAnchor } from "@/lib/panes/targetLinkActivation";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useSourceArrival } from "@/lib/reader/sourceArrival";
import { useShareController } from "@/lib/sharing/controller";
import { matchesShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { projectActionControlState, type ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import { hasActiveInteractionOwner, isTopmostInteractionOwner, useInteractionBlocked } from "@/lib/ui/overlay";
import { useKeyboardInset } from "@/lib/ui/useKeyboardInset";
import type { WorkspacePane } from "@/lib/workspace/model";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { usePaneReturnScrollport } from "@/lib/workspace/paneReturnMemento";
import { primaryWidth } from "@/lib/workspace/paneSizing";
import { useWorkspaceStore } from "@/lib/workspace/store";
import styles from "./PaneShell.module.css";

interface PaneShellProps {
  readonly pane: WorkspacePane;
  /** The mounted body's identity (`paneMountKey`): its chrome store lives as long as it does. */
  readonly bodyKey: string;
  readonly route: ResolvedPaneRouteModel;
  readonly label: string;
  readonly isActive: boolean;
  readonly isMobile: boolean;
  readonly isVisible: boolean;
  readonly isMaximized: boolean;
  readonly availableWidthPx: number | null;
  readonly columnWidthPx: number;
  readonly onChromeMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  readonly children: ReactNode;
}

/**
 * One pane: its runtime, the store its body's chrome lands in, its Companion
 * commands, and the shell every pane shares around the body. The store belongs
 * to the mounted body: a body that remounts gets a fresh one in the same
 * render, so the shell never shows the previous body's chrome, even while the
 * new body suspends.
 */
export default function PaneShell(props: PaneShellProps) {
  const { pane, bodyKey, isActive, isMobile } = props;
  const { requestSecondarySurface, updateSecondaryPane } = useWorkspaceStore();
  const [body, setBody] = useState(() => ({
    key: bodyKey,
    chrome: createPaneChromeStore(),
  }));
  if (body.key !== bodyKey)
    setBody({ key: bodyKey, chrome: createPaneChromeStore() });
  const { chrome } = body;
  const state = usePaneChromeState(chrome);
  const railPx = isMobile ? 0 : Math.ceil(state.layout?.rail?.widthPx ?? 0);
  const blocked = useInteractionBlocked(paneSecondaryRegionId(pane.id));
  const [presentation, setPresentation] = useState<CompanionPresentation>(isMobile ? "Sheet" : "Column");
  const measured = !props.isMaximized || props.availableWidthPx !== null;
  const desiredPresentation = isMobile || (
    props.isMaximized && props.availableWidthPx !== null &&
    props.availableWidthPx < 320 + railPx + COMPANION_MIN_WIDTH_PX
  ) ? "Sheet" : "Column";
  useLayoutEffect(() => {
    if (!measured || blocked || desiredPresentation === presentation) return;
    if (hasActiveInteractionOwner() && !isTopmostInteractionOwner(paneSecondaryRegionId(pane.id))) return;
    setPresentation(desiredPresentation);
  }, [measured, blocked, desiredPresentation, presentation, pane.id]);
  const companionMaxWidthPx = props.isMaximized && props.availableWidthPx !== null
    ? Math.max(COMPANION_MIN_WIDTH_PX, Math.min(COMPANION_MAX_WIDTH_PX, props.availableWidthPx - 320 - railPx))
    : COMPANION_MAX_WIDTH_PX;
  const latest = useRef({ secondary: pane.secondary, presentation });
  latest.current = { secondary: pane.secondary, presentation };
  const controller = useMemo(
    () =>
      createCompanionController({
        paneId: pane.id,
        chrome,
        latest: () => latest.current,
        requestSecondarySurface,
        updateSecondaryPane,
      }),
    [chrome, pane.id, requestSecondarySurface, updateSecondaryPane],
  );
  const returnFeedbackFocus = useCallback(
    () => findPaneLandmarkFocusTarget(pane.id) ?? findPaneChromeFocusTarget(pane.id),
    [pane.id],
  );
  return (
    <PaneRuntimeProvider pane={pane} isActive={isActive} isVisible={props.isVisible} host={controller}>
      <FeedbackScope active={isActive} returnFocus={returnFeedbackFocus}>
        <PaneChromeContext value={chrome}>
          <PaneRouteBoundary>
            <PaneView {...props} chrome={chrome} state={state} controller={controller} presentation={presentation} companionMaxWidthPx={companionMaxWidthPx} />
          </PaneRouteBoundary>
        </PaneChromeContext>
      </FeedbackScope>
    </PaneRuntimeProvider>
  );
}

/** The shell's presentation; the body is `children` and never re-renders with it. */
function PaneView({
  pane,
  route,
  label,
  isActive,
  isMobile,
  isVisible,
  isMaximized,
  columnWidthPx,
  onChromeMouseDown,
  chrome,
  state,
  controller,
  presentation,
  companionMaxWidthPx,
  children,
}: PaneShellProps & {
  readonly chrome: PaneChromeStore;
  readonly state: PaneChromeState;
  readonly controller: CompanionController;
  readonly presentation: CompanionPresentation;
  readonly companionMaxWidthPx: number;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "PaneShell");
  const { paneId, router } = runtime;
  const { resizePrimaryPane } = useWorkspaceStore();
  const body = state.chrome;
  const principal = body?.primaryAction;
  const principalState = principal?.kind === "command"
    ? projectActionControlState(principal.label, principal.state)
    : null;
  const mobileChrome = useMobileChrome();
  const mobileViewport = useMobileViewport();
  const { keyboardBottomInsetPx } = useKeyboardInset();
  const { openShare } = useShareController();
  const { platform } = useRenderEnvironment();
  const identityId = useId();
  const principalReasonId = useId();
  const landmarkLabelId = useId();
  const paneRef = useRef<HTMLElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const scrollportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusFrame = useRef(0);
  const source = paneSourceKey(runtime);
  const rowId = `${paneId}-pane-search`;
  const bodyId = `${paneId}-body`;

  // Find alone is collapsible on mobile. Its controller owns query lifetime.
  const query = body?.query;
  const find = query?.kind === "Find" ? query.find : null;
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const findVisible =
    query?.kind === "Find" &&
    (!isMobile || expandedFor === source || Boolean(find?.query));
  const clearFind = () => {
    find?.clear();
    chrome.set({ results: null });
  };
  useLayoutEffect(
    () => () => {
      setExpandedFor(null);
      cancelAnimationFrame(focusFrame.current);
      focusFrame.current = 0;
      chrome.set({ results: null });
    },
    [chrome, source],
  );
  const openQuery = (): boolean => {
    if (query?.kind === "Controls") return query.focusInput();
    if (!find) return false;
    setExpandedFor(source);
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = 0;
      const input = inputRef.current;
      if (!input || input.disabled || input.closest("[hidden], [inert]")) return;
      input.focus({ preventScroll: true });
      input.select();
    });
    return true;
  };
  const closeFind = () => {
    clearFind();
    setExpandedFor(null);
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = 0;
    mobileChrome.focusPaneChrome(paneId);
  };
  // Pane.Search belongs to the active pane, never under an open overlay, and
  // suppresses the browser's find only when a pane search took it.
  const openQueryRef = useRef(openQuery);
  openQueryRef.current = openQuery;
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !matchesShortcut(SHORTCUTS["Pane.Search"], event, platform) ||
        hasActiveInteractionOwner()
      )
        return;
      if (openQueryRef.current()) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isActive, platform]);

  // ---- refresh, header, actions ------------------------------------------
  const pull =
    isActive &&
    isMobile &&
    route.bodyMode === "standard" &&
    body?.refresh?.kind === "Refreshable";
  const refresh = usePaneRefresh({
    refresh: body?.refresh,
    routeKey: route.routeKey,
    pull,
    scrollportRef,
  });
  const header = resolvePaneHeaderModel({
    route: route.header,
    title: label,
    publication: body?.header,
  });
  const inspector = state.companion
    ? companionAction(
        controller,
        paneId,
        companionExpanded(state, pane.secondary),
      )
    : undefined;
  const paneActions: ActionDescriptor[] = [];
  if (query) {
    const isFind = query.kind === "Find";
    const verb = isFind ? "Find" : query.label;
    const resolving = isFind && find === null;
    const menuLabels = {
      collapsed: verb,
      expanded: "Close find",
    };
    paneActions.push({
      kind: "command",
      id: "Pane.Search",
      label: verb,
      icon: <Search size={16} aria-hidden="true" />,
      disabled: resolving || undefined,
      disabledReason: resolving ? PANE_COMMAND_RESOLVING_REASON : undefined,
      restoreFocusOnClose: false,
      state:
        isMobile && isFind
          ? findVisible
            ? { kind: "disclosure", expanded: true, controls: rowId, menuLabels }
            : { kind: "disclosure", expanded: false, menuLabels }
          : undefined,
      onSelect: () => {
        if (isMobile && isFind && findVisible) closeFind();
        else openQuery();
      },
    });
  }
  if (find?.returnable) {
    paneActions.push({
      kind: "command",
      id: "Pane.SearchReturn",
      label: "Go back to reading position",
      icon: <RotateCcw size={16} aria-hidden="true" />,
      onSelect: find.goBack,
    });
  }
  if (refresh.command) paneActions.push(refresh.command);
  const share = resolvePaneRouteShareIdentity(route, label);
  if (share && !body?.resourceRef) {
    paneActions.push({
      kind: "command",
      id: "RouteAction.Share",
      label: "Share…",
      icon: <Share2 size={16} aria-hidden="true" />,
      onSelect: ({ triggerEl }) =>
        openShare(share, {
          returnFocusTo: () => triggerEl,
          returnFocusFallback: (() =>
            findPaneLandmarkFocusTarget(paneId)),
        }),
    });
  }
  const historyNavigation = {
    canGoBack: router.canGoBack,
    canGoForward: router.canGoForward,
    onBack: router.back,
    onForward: router.forward,
  };

  // The whole control stack retreats with the mobile bar; visible Find holds it.
  const hasVisibleControls = Boolean(
    body?.navigation || principal || query?.kind === "Controls" || findVisible,
  );
  const onDefect = useThrowLater();
  usePublishMobilePaneChrome(
    isMobile
      ? {
          paneId,
          identityId,
          header,
          activateChromeAnchor: (event, anchor) =>
            activateTargetAnchor({ event, runtime, anchor }),
          navigation: historyNavigation,
          companionAction: inspector,
          paneActions,
          menuActions: body?.menuActions ?? [],
          resourceRef: body?.resourceRef,
          onDefect,
        }
      : null,
  );
  useMobileChromeSurface(chromeRef, isActive && isMobile && hasVisibleControls);
  useMobileChromeHold(isActive && isMobile && findVisible);
  // the active mobile body is the surface readers and lists take clearance from.
  useLayoutEffect(() => {
    const element = scrollportRef.current;
    if (!isMobile || !isActive || !element) return;
    return mobileViewport.registerContentSurface(element);
  }, [isActive, isMobile, mobileViewport]);
  // The declared refinement slot absorbs crowding; neither the pane nor the
  // primary controls acquire another scrollport. Subtracting its current size
  // makes this cap independent of the height the cap itself produces.
  const measureControls = useCallback(() => {
    const pane = paneRef.current;
    const controls = chromeRef.current;
    if (!pane || !controls) return;
    const paneBox = pane.getBoundingClientRect();
    const controlsHeight = controls.getBoundingClientRect().height;
    const refinements = controls.querySelector<HTMLElement>(
      "[data-pane-query-refinements]",
    );
    const baseHeight =
      controlsHeight - (refinements?.getBoundingClientRect().height ?? 0);
    const topClearance = isMobile
      ? readMobileCssLength(
          "var(--viewport-safe-top) + var(--pane-chrome-header-height) + var(--space-2)",
        )
      : 0;
    const bottomClearance = isMobile
      ? Math.max(
          0,
          Math.max(
            readMobileCssLength("var(--mobile-content-bottom-clearance)"),
            keyboardBottomInsetPx,
          ) - Math.max(0, window.innerHeight - paneBox.bottom),
        )
      : 0;
    const room = Math.max(
      0,
      paneBox.height - topClearance - bottomClearance - baseHeight,
    );
    pane.style.setProperty(
      "--pane-query-refinements-max-height",
      `min(16rem, ${room / 2}px)`,
    );
    pane.style.setProperty(
      "--mobile-pane-chrome-height",
      `${isMobile ? controlsHeight : 0}px`,
    );
  }, [isMobile, keyboardBottomInsetPx]);
  useLayoutEffect(measureControls);
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const controls = chromeRef.current;
    if (!pane || !controls) return;
    const observer = new ResizeObserver(measureControls);
    observer.observe(pane);
    observer.observe(controls);
    const unsubscribe =
      mobileViewport.subscribeContentBottomClearance(measureControls);
    return () => {
      observer.disconnect();
      unsubscribe();
    };
  }, [measureControls, mobileViewport]);
  usePaneReturnScrollport({
    enabled: route.returnKind === "ShellScroll",
    scrollportRef,
    contentRef,
    continuityKey: route.queryNavigation === "in-place" ? source : null,
  });

  // ---- geometry: desktop only; clamping is render-only ---------------------
  const layout = isMobile ? null : state.layout;
  const width = primaryWidth({
    storedPx: pane.primary_width_px,
    columnPx: columnWidthPx,
    routeMaxPx: route.width.maxWidthPx,
    intrinsicPx: route.width.allowsIntrinsicPrimaryWidth
      ? (layout?.intrinsicWidthPx ?? null)
      : null,
  });
  const rail = layout?.rail ?? null;
  const railPx = rail ? Math.ceil(rail.widthPx) : 0;

  return (
    <section
      ref={paneRef}
      className={styles.paneShell}
      aria-labelledby={landmarkLabelId}
      data-pane-shell="true"
      data-pane-focus-landmark="true"
      data-active={isActive}
      data-mobile={isMobile}
      data-maximized={isMaximized || undefined}
      tabIndex={-1}
    >
      <span id={landmarkLabelId} className="sr-only">
        {paneHeaderAccessibleName(header)}
      </span>
      <div
        className={styles.primaryPane}
        style={isMobile || isMaximized ? undefined : { width: width.widthPx + railPx }}
      >
        <div
          ref={chromeRef}
          className={styles.chrome}
          data-pane-chrome-focus={isMobile ? undefined : "true"}
          tabIndex={-1}
        >
          {isMobile ? null : (
            <SurfaceHeader
              header={header}
              identityId={identityId}
              companionAction={inspector}
              paneActions={paneActions}
              menuActions={body?.menuActions}
              resourceRef={body?.resourceRef}
              navigation={historyNavigation}
              onMouseDown={onChromeMouseDown}
            />
          )}
          {body?.navigation ? (
            <div
              className={styles.controlRow}
              role="group"
              aria-label={body.navigation.label}
            >
              {body.navigation.content}
            </div>
          ) : null}
          {principal || query ? (
            <div
              className={cx(styles.controlRow, styles.taskRow)}
              hidden={!principal && query?.kind === "Find" && !findVisible}
            >
              {principal ? (
                <div className={styles.primaryTask}>
                  {principal.kind === "link" ? (
                    <Button asChild variant="secondary" size="sm">
                      <a
                        href={principal.href}
                        data-action-id={principal.id}
                        aria-disabled={principal.disabled || undefined}
                        aria-describedby={principal.disabledReason ? principalReasonId : undefined}
                        onClick={(event) => {
                          if (event.defaultPrevented) return;
                          if (principal.disabled) {
                            event.preventDefault();
                            return;
                          }
                          if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey)
                            principal.onSelect?.({ triggerEl: null });
                          activateTargetAnchor({ event, runtime, anchor: event.currentTarget });
                        }}
                        onAuxClick={(event) => { if (principal.disabled) event.preventDefault(); }}
                      >
                        {principal.icon}{principal.label}
                      </a>
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      leadingIcon={principal.icon}
                      data-action-id={principal.id}
                      aria-disabled={principal.disabled || undefined}
                      aria-describedby={principal.disabledReason ? principalReasonId : undefined}
                      aria-pressed={principalState?.barPressed}
                      aria-expanded={principalState?.barExpanded}
                      aria-controls={principalState?.barControls}
                      onClick={(event) => {
                        if (!principal.disabled) principal.onSelect({ triggerEl: event.currentTarget });
                      }}
                    >
                      {principal.label}
                    </Button>
                  )}
                  {principal.disabledReason ? <span id={principalReasonId} className={styles.actionReason}>{principal.disabledReason}</span> : null}
                </div>
              ) : null}
              {query ? (
                <div
                  key={source}
                  id={rowId}
                  className={styles.queryControls}
                  hidden={query.kind === "Find" && !findVisible}
                  onFocusCapture={query.kind === "Find" ? () => setExpandedFor(source) : undefined}
                  onClickCapture={query.kind === "Find" ? () => setExpandedFor(source) : undefined}
                >
                  {query.kind === "Find" ? (
                    <FindBar
                      ref={inputRef}
                      find={find}
                      onClear={clearFind}
                      onClose={isMobile ? closeFind : undefined}
                      resultsExpanded={state.results?.expanded ?? false}
                      onShowResults={controller.showResults}
                    />
                  ) : query.content}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          className={styles.primaryContentRow}
          style={{
            gridTemplateColumns: isMobile || isMaximized
              ? `minmax(0, 1fr)${rail ? ` ${railPx}px` : ""}`
              : `${width.widthPx}px${rail ? ` ${railPx}px` : ""}`,
          }}
        >
          <div
            ref={scrollportRef}
            id={bodyId}
            className={styles.body}
            data-body-mode={route.bodyMode}
            data-pane-content="true"
            data-pane-refresh-eligible={pull || undefined}
          >
            <div ref={contentRef} className={styles.routeContent}>
              {route.locator !== null && route.id !== "media" && route.id !== "note" && route.id !== "conversation" ? <WholeSourceArrival resourceRef={body?.resourceRef ?? null} paneRef={paneRef} /> : null}
              {children}
            </div>
            {refresh.indicator}
          </div>
          {rail ? <div className={styles.rail}>{rail.body}</div> : null}
        </div>
        {isMobile || isMaximized ? null : (
          <ResizeHandle
            label={`Resize pane ${label}`}
            controls={bodyId}
            widthPx={width.widthPx}
            minWidthPx={width.minWidthPx}
            maxWidthPx={width.maxWidthPx}
            onResize={(widthPx) => resizePrimaryPane(paneId, widthPx)}
          />
        )}
      </div>
      {refresh.announcement}
      <Companion
        paneId={paneId}
        presentation={presentation}
        isVisible={isVisible}
        maxWidthPx={companionMaxWidthPx}
        chrome={chrome}
        controller={controller}
        secondary={pane.secondary}
        find={find}
        resourceRef={body?.resourceRef}
      />
    </section>
  );
}

/** Media, notes and chats own located paint; other resource panes accept only the whole source. */
function WholeSourceArrival({ resourceRef, paneRef }: {
  resourceRef: string | null;
  paneRef: RefObject<HTMLElement | null>;
}) {
  const arrival = useSourceArrival({
    ready: resourceRef !== null,
    sourceIdentity: resourceRef,
    apply: async (target, context) => {
      if (target.location.kind !== "resource") return false;
      if (context.mayFocus()) paneRef.current?.focus({ preventScroll: true });
      return true;
    },
  });
  return arrival.failure ? <FeedbackNotice content={{ tone: "Warning", title: arrival.failure }} announcement="Polite" /> : null;
}
