"use client";

import { RefreshCw, RotateCcw, Search, Share2 } from "lucide-react";
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import PaneSearchBar from "@/components/workspace/PaneSearchBar";
import SurfaceHeader, {
  type SurfaceHeaderNavigation,
} from "@/components/ui/SurfaceHeader";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import SecondaryPaneShell from "@/components/workspace/SecondaryPaneShell";
import { useResizeHandle } from "@/components/workspace/useResizeHandle";
import { usePaneRefresh } from "@/components/workspace/usePaneRefresh";
import {
  paneHeaderAccessibleName,
  resolvePaneHeaderModel,
} from "@/lib/panes/paneHeaderModel";
import {
  usePaneRouter,
  usePaneRuntime,
  useRecordPaneNavigationModality,
} from "@/lib/panes/paneRuntime";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";
import {
  activateTargetAnchor,
  type TargetLinkMouseEvent,
} from "@/lib/panes/targetLinkActivation";
import {
  arePanePrimaryChromePublicationsEqual,
  panePrimaryChromeSourceKey,
  PANE_COMMAND_RESOLVING_REASON,
  secondaryPublicationIncludesSurface,
  type PaneFixedChromePublication,
  type PanePrimaryChromePublication,
  type PanePrimaryChromePublicationUpdate,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";
import type {
  PaneBodyMode,
  PaneRouteHeaderContract,
} from "@/lib/panes/paneRouteModel";
import type { PaneRouteShareIdentity } from "@/lib/panes/paneResourceLocator";
import { useShareController } from "@/lib/sharing/controller";
import { present } from "@/lib/api/presence";
import { usePaneSearchRequested } from "@/lib/panes/paneSearchEvents";
import type { PaneReadySearchPublication } from "@/lib/panes/paneSearch";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  useMobileChrome,
  useMobileChromeSurface,
  usePaneChromeFocusReturn,
} from "@/lib/workspace/mobileChrome";
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";
import { usePaneReturnScrollport } from "@/lib/workspace/paneReturnMemento";
import {
  isPaneSecondaryRegionId,
  paneSecondaryRegionId,
  type WorkspaceSecondarySizing,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import type { WorkspaceAttachedSecondaryPaneState } from "@/lib/workspace/schema";
import {
  findPaneLandmarkFocusTarget,
  findPaneSearchFocusTarget,
} from "@/lib/workspace/paneDom";
import { useActiveMobileViewport } from "@/lib/mobileViewport/MobileViewportProvider";
import { NexusPanePerformanceContext } from "@/lib/nexus/performance";
import styles from "./PaneShell.module.css";
import { pointerModality } from "@/lib/ui/pointerModality";

const EMPTY_ACTIONS: readonly ActionDescriptor[] = [];
type PaneShellStyle = CSSProperties & {
  "--mobile-pane-chrome-height"?: string;
};

type PaneRefreshIndicatorStyle = CSSProperties & {
  "--pane-refresh-offset": string;
};

interface ExpandedPaneSearchIdentity {
  readonly paneId: string;
  readonly routeKey: string;
  readonly sourceKey: string;
}

interface PaneShellProps {
  paneId: string;
  routeKey: string;
  routeHeader: PaneRouteHeaderContract;
  routeShareIdentity: PaneRouteShareIdentity | null;
  label: string;
  labelPending: boolean;
  returnMementoEnabled: boolean;
  queryNavigation?: "in-place";
  sizing: EffectivePaneSizing;
  bodyMode: PaneBodyMode;
  secondaryPane: WorkspaceAttachedSecondaryPaneState | null;
  secondarySizing: WorkspaceSecondarySizing | null;
  secondaryPublication: PaneSecondaryPublication | null;
  fixedChromePublication: PaneFixedChromePublication | null;
  onResizePrimaryPane: (paneId: string, widthPx: number) => void;
  onResizeSecondaryPane: (secondaryPaneId: string, widthPx: number) => void;
  onCloseSecondaryPane: (secondaryPaneId: string) => void;
  onSetSecondarySurface: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  onChromeMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  isActive: boolean;
  isMobile: boolean;
  responsiveSearchHandoff: {
    readonly id: number;
    readonly onConsumed: (id: number) => void;
  } | null;
  children: React.ReactNode;
}

export default function PaneShell({
  paneId,
  routeKey,
  routeHeader,
  routeShareIdentity,
  label,
  labelPending,
  returnMementoEnabled,
  queryNavigation,
  sizing,
  bodyMode,
  secondaryPane,
  secondarySizing,
  secondaryPublication,
  fixedChromePublication,
  onResizePrimaryPane,
  onResizeSecondaryPane,
  onCloseSecondaryPane,
  onSetSecondarySurface,
  onChromeMouseDown,
  isActive,
  isMobile,
  responsiveSearchHandoff,
  children,
}: PaneShellProps) {
  if (returnMementoEnabled && bodyMode !== "standard") {
    throw new Error("ShellScroll PaneShell must use bodyMode standard");
  }
  const paneRouter = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  if (!paneRuntime) {
    // justify-defect: PaneShell execution requires pane-scoped navigation.
    throw new Error("PaneShell must be used inside PaneRuntimeProvider");
  }
  const panePerformance = useMemo(
    () => ({
      activationRouteId: resolveWorkspaceActivationRouteId(paneRuntime.href),
      isActive,
    }),
    [isActive, paneRuntime.href],
  );
  const recordNavigationModality = useRecordPaneNavigationModality();
  const activateTarget = paneRuntime.activateTarget;
  const activateChromeAnchor = useCallback(
    (event: TargetLinkMouseEvent, anchor: HTMLAnchorElement) => {
      recordNavigationModality(pointerModality(event));
      activateTargetAnchor({ event, runtime: { activateTarget }, anchor });
    },
    [activateTarget, recordNavigationModality],
  );
  const canGoBack = paneRouter.canGoBack;
  const canGoForward = paneRouter.canGoForward;
  const navigation = useMemo<SurfaceHeaderNavigation>(
    () => ({
      canGoBack,
      canGoForward,
      onBack: (modality) => {
        recordNavigationModality(modality);
        paneRouter.back();
      },
      onForward: (modality) => {
        recordNavigationModality(modality);
        paneRouter.forward();
      },
    }),
    [
      canGoBack,
      canGoForward,
      paneRouter,
      recordNavigationModality,
    ],
  );
  const { handleResizeMouseDown, handleResizeKeyDown } = useResizeHandle({
    id: paneId,
    widthPx: sizing.primaryWidthPx,
    minWidthPx: sizing.primaryMinWidthPx,
    maxWidthPx: sizing.primaryMaxWidthPx,
    onResize: onResizePrimaryPane,
  });
  const chromeRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentSurfaceActive = isMobile && isActive;
  const mobileViewport = useActiveMobileViewport(contentSurfaceActive);
  const sourceContinuityKey = panePrimaryChromeSourceKey(paneRuntime);
  usePaneReturnScrollport({
    paneId,
    enabled: returnMementoEnabled,
    scrollportRef: bodyRef,
    routeContinuityKey:
      queryNavigation === "in-place"
        ? `${paneRuntime.visitId}:${paneRuntime.routeId}:${paneRuntime.pathname}`
        : null,
  });
  const { openShare } = useShareController();
  const currentRouteKeyRef = useRef(routeKey);
  currentRouteKeyRef.current = routeKey;
  const currentSourceContinuityKeyRef = useRef(sourceContinuityKey);
  currentSourceContinuityKeyRef.current = sourceContinuityKey;
  const [mobileChromeHeight, setMobileChromeHeight] = useState(0);
  const [primaryChromeRecord, setPrimaryChromeRecord] = useState<{
    readonly routeKey: string;
    readonly sourceContinuityKey: string;
    readonly publication: PanePrimaryChromePublication;
  } | null>(null);
  const { motionPhase, setPaneChrome } = useMobileChrome();
  const paneChromeFocusReturn = usePaneChromeFocusReturn();
  const identityId = useId();
  const landmarkLabelId = useId();

  const publishPrimaryChrome = useCallback(
    (update: PanePrimaryChromePublicationUpdate) => {
      setPrimaryChromeRecord((current) => {
        if (
          update.routeKey !== currentRouteKeyRef.current ||
          update.sourceKey !== currentSourceContinuityKeyRef.current
        ) return current;
        if (
          update.publication?.collection &&
          (update.publication.search || update.publication.instrument)
        ) {
          throw new Error(
            "Pane collection cannot coexist with search or instrument chrome.",
          );
        }
        if (!update.publication) {
          return null;
        }
        if (
          current?.routeKey === update.routeKey &&
          current.sourceContinuityKey === update.sourceKey &&
          arePanePrimaryChromePublicationsEqual(
            current.publication,
            update.publication,
          )
        ) {
          return current;
        }
        return {
          routeKey: update.routeKey,
          sourceContinuityKey: update.sourceKey,
          publication: update.publication,
        };
      });
    },
    [],
  );

  const [expandedSearchIdentity, setExpandedSearchIdentity] =
    useState<ExpandedPaneSearchIdentity | null>(null);
  const acceptedPrimaryChrome =
    primaryChromeRecord !== null &&
    primaryChromeRecord.routeKey === routeKey &&
    primaryChromeRecord.sourceContinuityKey === sourceContinuityKey
      ? primaryChromeRecord.publication
      : null;
  const acceptedCollection =
    acceptedPrimaryChrome?.collection ??
    (queryNavigation === "in-place" &&
    primaryChromeRecord?.routeKey !== routeKey &&
    primaryChromeRecord?.sourceContinuityKey === sourceContinuityKey
      ? primaryChromeRecord.publication.collection
      : undefined);
  const acceptedRefresh = acceptedPrimaryChrome?.refresh;
  const pullRefreshEligible =
    isActive &&
    isMobile &&
    bodyMode === "standard" &&
    acceptedRefresh?.kind === "Refreshable";
  const {
    state: refreshState,
    start: startPaneRefresh,
    feedback: refreshFeedback,
    offsetPx: refreshIndicatorOffsetPx,
    announcement: refreshAnnouncement,
  } = usePaneRefresh({
    publication: acceptedRefresh,
    routeKey,
    pullEnabled: pullRefreshEligible,
    scrollportRef: bodyRef,
  });
  const acceptedSearch =
    acceptedCollection !== undefined
      ? undefined
      : acceptedPrimaryChrome?.search;
  // A resolving publication carries no row, no query, and no dismissal, so it
  // reaches the descriptor and nothing else: every expansion, focus, and
  // gesture path below sees only a search that can actually run.
  const readySearch =
    acceptedSearch?.kind === "Resolving" ? undefined : acceptedSearch;
  const acceptedSearchRef = useRef<PaneReadySearchPublication | undefined>(
    readySearch,
  );
  const acceptedCollectionRef = useRef(acceptedCollection);
  const isActiveRef = useRef(isActive);
  acceptedSearchRef.current = readySearch;
  acceptedCollectionRef.current = acceptedCollection;
  isActiveRef.current = isActive;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRowId = `${paneId}-pane-search`;
  const searchExpanded =
    readySearch !== undefined &&
    expandedSearchIdentity?.paneId === paneId &&
    expandedSearchIdentity.routeKey === routeKey &&
    expandedSearchIdentity.sourceKey === sourceContinuityKey;
  const searchExpandedRef = useRef(searchExpanded);
  searchExpandedRef.current = searchExpanded;
  const focusSearchInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    });
  }, []);
  // The request frame can precede the row commit during a viewport reflow.
  useLayoutEffect(() => {
    if (searchExpanded) {
      focusSearchInput();
    }
  }, [focusSearchInput, searchExpanded]);
  const openSearch = useCallback(() => {
    if (!isActiveRef.current) return false;
    const collection = acceptedCollectionRef.current;
    if (collection) return collection.focusInput();
    const publication = acceptedSearchRef.current;
    if (!publication) return false;
    if (!searchExpandedRef.current) {
      if (publication.kind === "FindOccurrences") publication.onOpen();
      searchExpandedRef.current = true;
      setExpandedSearchIdentity({
        paneId,
        routeKey: currentRouteKeyRef.current,
        sourceKey: currentSourceContinuityKeyRef.current,
      });
    }
    focusSearchInput();
    return true;
  }, [focusSearchInput, paneId]);
  usePaneSearchRequested(openSearch);
  const consumedSearchRequestIdRef = useRef<number | null>(null);
  // A browser resize can lead the React projection by one input event. Consume
  // the route-fenced host handoff only after this shell has republished Search.
  useLayoutEffect(() => {
    if (
      responsiveSearchHandoff === null ||
      consumedSearchRequestIdRef.current === responsiveSearchHandoff.id ||
      !openSearch()
    ) {
      return;
    }
    consumedSearchRequestIdRef.current = responsiveSearchHandoff.id;
    responsiveSearchHandoff.onConsumed(responsiveSearchHandoff.id);
  }, [acceptedCollection, acceptedSearch, openSearch, responsiveSearchHandoff]);
  const closeSearch = useCallback(() => {
    searchExpandedRef.current = false;
    setExpandedSearchIdentity(null);
    if (isMobile) {
      void paneChromeFocusReturn.focus(paneId);
      return;
    }
    window.requestAnimationFrame(() => {
      const retainedTrigger = searchTriggerRef.current;
      const mountedAction =
        chromeRef.current?.querySelector<HTMLButtonElement>(
          '[data-action-id="Pane.Search"]',
        ) ?? null;
      const trigger = [retainedTrigger, mountedAction].find(
        (candidate) =>
          candidate?.isConnected && candidate.closest("[inert]") === null,
      );
      const focusTarget = trigger ?? findPaneSearchFocusTarget(paneId);
      focusTarget?.focus({ preventScroll: true });
    });
  }, [isMobile, paneChromeFocusReturn, paneId]);
  // The mobile chrome provider re-renders active PaneShell consumers when a pane
  // publishes. Keep this projection referentially stable across that feedback render;
  // otherwise the publication effect below sees a new header, republishes, and can
  // starve the lazy pane body behind its Suspense fallback.
  const header = useMemo(
    () =>
      resolvePaneHeaderModel({
        currentRouteKey: routeKey,
        routeHeader,
        paneLabel: label,
        paneLabelPending: labelPending,
        publication: primaryChromeRecord
          ? {
              routeKey: primaryChromeRecord.routeKey,
              header: primaryChromeRecord.publication.header,
            }
          : null,
      }),
    [label, labelPending, primaryChromeRecord, routeHeader, routeKey],
  );
  const accessibleName = paneHeaderAccessibleName(header);
  const effectiveInstrument = acceptedPrimaryChrome?.instrument;
  const effectiveContextualRow =
    searchExpanded && readySearch
      ? { kind: "Search" as const, publication: readySearch }
      : effectiveInstrument
        ? { kind: "Instrument" as const, publication: effectiveInstrument }
        : null;
  const hasMobileContextualSurface =
    isMobile && effectiveContextualRow !== null;
  useMobileChromeSurface(
    chromeRef,
    "PaneToolbar",
    isActive && hasMobileContextualSurface,
  );
  const effectiveCompanionAction = acceptedPrimaryChrome?.companionAction;
  const effectiveActionSubject = acceptedPrimaryChrome?.actionSubject;
  const effectiveMenuActions =
    acceptedPrimaryChrome?.menuActions ?? EMPTY_ACTIONS;
  const contextualSurfaceInteractive =
    motionPhase.kind === "Visible" || motionPhase.kind === "Pinned";
  const contextualSurfaceUnavailable =
    hasMobileContextualSurface && !contextualSurfaceInteractive;
  const resolvePaneReturnFocusFallback = useCallback(
    () => findPaneLandmarkFocusTarget(paneId),
    [paneId],
  );
  const secondaryPresentation =
    secondaryPane &&
    secondaryPublication?.groupId === secondaryPane.groupId &&
    secondaryPublicationIncludesSurface(
      secondaryPublication,
      secondaryPane.activeSurfaceId,
    )
      ? { state: secondaryPane, publication: secondaryPublication }
      : null;
  const secondaryRegionId = secondaryPresentation
    ? paneSecondaryRegionId(paneId, secondaryPresentation.publication.groupId)
    : null;
  const actionsWithSearch = useMemo<readonly ActionDescriptor[]>(() => {
    if (!acceptedSearch) return EMPTY_ACTIONS;
    const resolving = acceptedSearch.kind === "Resolving";
    // A resolving pane names the control it will become, so the entry never
    // changes its verb when the source lands.
    const searchLabel =
      acceptedSearch.kind === "Resolving"
        ? acceptedSearch.control
        : acceptedSearch.kind === "FilterRows"
          ? "Filter"
          : "Find";
    const actions: ActionDescriptor[] = [
      {
        kind: "command",
        id: "Pane.Search",
        label: searchLabel,
        disabled: resolving || undefined,
        disabledReason: resolving
          ? PANE_COMMAND_RESOLVING_REASON
          : undefined,
        icon: <Search size={16} aria-hidden="true" />,
        state: searchExpanded
          ? {
              kind: "disclosure",
              expanded: true,
              controls: searchRowId,
              menuLabels: {
                collapsed: searchLabel,
                expanded: `Close ${searchLabel.toLowerCase()}`,
              },
            }
          : {
              kind: "disclosure",
              expanded: false,
              menuLabels: {
                collapsed: searchLabel,
                expanded: `Close ${searchLabel.toLowerCase()}`,
              },
            },
        onSelect: ({ triggerEl }) => {
          searchTriggerRef.current = triggerEl;
          if (searchExpanded && readySearch) {
            readySearch.onDismiss();
            closeSearch();
            return;
          }
          openSearch();
        },
      },
    ];
    if (
      acceptedSearch.kind === "FindOccurrences" &&
      acceptedSearch.returnToReadingPosition.kind === "Available"
    ) {
      actions.push({
        kind: "command",
        id: "Pane.SearchReturn",
        label: "Go back to reading position",
        icon: <RotateCcw size={16} aria-hidden="true" />,
        onSelect: acceptedSearch.returnToReadingPosition.onReturn,
      });
    }
    return actions;
  }, [
    acceptedSearch,
    closeSearch,
    openSearch,
    readySearch,
    searchExpanded,
    searchRowId,
  ]);
  const reconciledPaneActions = useMemo(
    () =>
      actionsWithSearch.filter((action) => {
        if (
          action.kind !== "command" ||
          action.state?.kind !== "disclosure" ||
          !action.state.expanded ||
          !isPaneSecondaryRegionId(paneId, action.state.controls)
        ) {
          return true;
        }
        return action.state.controls === secondaryRegionId;
      }),
    [actionsWithSearch, paneId, secondaryRegionId],
  );

  // The active mobile pane body is the content surface every reader, list, and
  // chat scroll owner inside it inherits its terminal clearance from.
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!contentSurfaceActive || !mobileViewport || !element) return;
    return mobileViewport.registerContentSurface(element);
  }, [contentSurfaceActive, mobileViewport]);

  useLayoutEffect(() => {
    if (!isMobile || !chromeRef.current) {
      setMobileChromeHeight(0);
      return;
    }
    const node = chromeRef.current;
    const update = () => {
      setMobileChromeHeight(Math.max(0, node.getBoundingClientRect().height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [effectiveInstrument, isMobile, searchExpanded]);

  const paneActions = useMemo<readonly ActionDescriptor[]>(() => {
    const actions = [...reconciledPaneActions];
    if (acceptedRefresh) {
      const resolving = acceptedRefresh.kind === "Resolving";
      actions.push({
        kind: "command",
        id: "Pane.Refresh",
        label: "Refresh",
        icon: <RefreshCw size={16} aria-hidden="true" />,
        disabled: resolving || refreshState.kind === "Refreshing",
        disabledReason: resolving
          ? PANE_COMMAND_RESOLVING_REASON
          : undefined,
        onSelect: () => startPaneRefresh(),
      });
    }
    if (routeShareIdentity && !effectiveActionSubject) {
      actions.push({
        kind: "command",
        id: "RouteAction.Share",
        label: "Share…",
        icon: <Share2 size={16} aria-hidden="true" />,
        onSelect: ({ triggerEl }) => {
          openShare(routeShareIdentity, {
            returnFocusTo: () => triggerEl,
            returnFocusFallback: present(resolvePaneReturnFocusFallback),
          });
        },
      });
    }
    return actions;
  }, [
    acceptedRefresh,
    openShare,
    reconciledPaneActions,
    refreshState.kind,
    resolvePaneReturnFocusFallback,
    effectiveActionSubject,
    routeShareIdentity,
    startPaneRefresh,
  ]);
  // Route ownership and chrome publication have different lifecycles. A
  // routine header/action update must not briefly withdraw the active route:
  // doing so rebaselines reader motion while trusted scrolling is in flight.
  useLayoutEffect(() => {
    if (!isMobile) return;
    return () => setPaneChrome(null);
  }, [identityId, isMobile, paneId, routeKey, setPaneChrome]);
  useLayoutEffect(() => {
    if (!isMobile) return;
    setPaneChrome({
      paneId,
      routeKey,
      identityId,
      header,
      activateChromeAnchor,
      navigation,
      companionAction: effectiveCompanionAction,
      paneActions,
      menuActions: effectiveMenuActions,
      actionSubject: effectiveActionSubject,
    });
  }, [
    activateChromeAnchor,
    header,
    identityId,
    isMobile,
    navigation,
    paneId,
    routeKey,
    effectiveCompanionAction,
    paneActions,
    effectiveMenuActions,
    effectiveActionSubject,
    setPaneChrome,
  ]);

  const bodyId = `${paneId}-body`;
  const expandedActionRetainsSecondary = reconciledPaneActions.some(
    (action) =>
      action.kind === "command" &&
      action.state?.kind === "disclosure" &&
      action.state.expanded &&
      action.state.controls === secondaryRegionId,
  );
  const visibleSecondary =
    !isMobile &&
    secondaryPresentation &&
    (secondaryPresentation.state.visibility === "visible" ||
      expandedActionRetainsSecondary) &&
    secondarySizing
      ? {
          state: secondaryPresentation.state,
          sizing: secondarySizing,
          publication: secondaryPresentation.publication,
        }
      : null;
  const visibleSecondaryWidthPx = visibleSecondary?.sizing.widthPx ?? 0;
  const visibleFixedChrome = !isMobile ? fixedChromePublication : null;
  const shellStyle: PaneShellStyle = isMobile
    ? { width: "100%", minWidth: "100%", maxWidth: "100%" }
    : {
        width: `${sizing.renderedPrimarySlotWidthPx + visibleSecondaryWidthPx}px`,
        minWidth: `${sizing.renderedPrimarySlotMinWidthPx + visibleSecondaryWidthPx}px`,
        maxWidth: `${sizing.renderedPrimarySlotMaxWidthPx + visibleSecondaryWidthPx}px`,
      };
  if (isMobile && mobileChromeHeight > 0) {
    shellStyle["--mobile-pane-chrome-height"] = `${mobileChromeHeight}px`;
  }

  let bodyStyle: CSSProperties;
  switch (bodyMode) {
    case "standard":
      bodyStyle = {
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
        ...(isMobile && { overscrollBehavior: "contain" }),
        ...(pullRefreshEligible && {
          touchAction: "pan-x pan-up",
          overscrollBehaviorY: "contain",
        }),
      };
      break;
    case "document":
    case "contained":
      bodyStyle = {
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        ...(isMobile && { overscrollBehavior: "contain" }),
      };
      break;
  }
  const refreshIndicatorStyle: PaneRefreshIndicatorStyle = {
    "--pane-refresh-offset": `${refreshIndicatorOffsetPx}px`,
  };

  return (
    <section
      className={styles.paneShell}
      aria-labelledby={landmarkLabelId}
      data-pane-shell="true"
      data-pane-focus-landmark="true"
      data-active={isActive ? "true" : "false"}
      data-mobile={isMobile ? "true" : "false"}
      tabIndex={-1}
      style={shellStyle}
    >
      <span id={landmarkLabelId} className="sr-only">
        {accessibleName}
      </span>
      <div
        className={styles.primaryPane}
        style={{
          width: isMobile ? "100%" : `${sizing.renderedPrimarySlotWidthPx}px`,
          minWidth: isMobile
            ? "100%"
            : `${sizing.renderedPrimarySlotMinWidthPx}px`,
          maxWidth: isMobile
            ? "100%"
            : `${sizing.renderedPrimarySlotMaxWidthPx}px`,
        }}
      >
        <div
          ref={chromeRef}
          className={styles.chrome}
          data-pane-chrome-focus={!isMobile ? "true" : undefined}
          data-mobile-chrome-phase={motionPhase.kind}
          aria-hidden={contextualSurfaceUnavailable || undefined}
          inert={contextualSurfaceUnavailable || undefined}
          tabIndex={-1}
          style={{
            pointerEvents: contextualSurfaceUnavailable ? "none" : undefined,
          }}
          onMouseDown={onChromeMouseDown}
        >
          {!isMobile ? (
            <SurfaceHeader
              header={header}
              identityId={identityId}
              companionAction={effectiveCompanionAction}
              paneActions={paneActions}
              menuActions={effectiveMenuActions}
              actionSubject={effectiveActionSubject}
              navigation={navigation}
            />
          ) : null}
          {effectiveContextualRow ? (
            <div
              id={
                effectiveContextualRow.kind === "Search"
                  ? searchRowId
                  : undefined
              }
              className={styles.contextualRow}
              data-contextual-row-variant={
                effectiveContextualRow.kind === "Search" &&
                effectiveContextualRow.publication.kind === "FilterRows"
                  ? "Refinement"
                  : "Instrument"
              }
              role={
                effectiveContextualRow.kind === "Instrument"
                  ? "group"
                  : undefined
              }
              aria-label={
                effectiveContextualRow.kind === "Instrument"
                  ? effectiveContextualRow.publication.label
                  : undefined
              }
            >
              {effectiveContextualRow.kind === "Search" ? (
                <PaneSearchBar
                  ref={searchInputRef}
                  publication={effectiveContextualRow.publication}
                  onClose={closeSearch}
                />
              ) : (
                effectiveContextualRow.publication.content
              )}
            </div>
          ) : null}
        </div>
        <div
          className={styles.primaryContentRow}
          style={{
            gridTemplateColumns: isMobile
              ? "minmax(0, 1fr)"
              : visibleFixedChrome
                ? `${sizing.primaryWidthPx}px ${visibleFixedChrome.widthPx}px`
                : `${sizing.primaryWidthPx}px`,
          }}
        >
          <div
            ref={bodyRef}
            className={styles.body}
            id={bodyId}
            data-body-mode={bodyMode}
            data-pane-content="true"
            data-pane-refresh-eligible={
              pullRefreshEligible ? "true" : undefined
            }
            style={bodyStyle}
          >
            <NexusPanePerformanceContext.Provider
              value={panePerformance}
            >
              {acceptedCollection ? (
                <div
                  className={styles.collectionRow}
                  role="group"
                  aria-label={acceptedCollection.label}
                  data-pane-collection-controls="true"
                >
                  {acceptedCollection.content}
                </div>
              ) : null}
              <PanePrimaryChromeProvider publish={publishPrimaryChrome}>
                {children}
              </PanePrimaryChromeProvider>
            </NexusPanePerformanceContext.Provider>
            <div
              className={styles.refreshIndicator}
              data-refresh-state={refreshState.kind}
              style={refreshIndicatorStyle}
              role={refreshState.kind === "Refreshing" ? "progressbar" : undefined}
              aria-label={
                refreshState.kind === "Refreshing"
                  ? (refreshFeedback ?? "Refreshing")
                  : undefined
              }
              aria-hidden={
                refreshState.kind === "Refreshing" ? undefined : "true"
              }
              aria-valuemin={
                refreshState.kind === "Refreshing" &&
                refreshState.progress.kind === "Determinate"
                  ? 0
                  : undefined
              }
              aria-valuemax={
                refreshState.kind === "Refreshing" &&
                refreshState.progress.kind === "Determinate"
                  ? refreshState.progress.requestedCount
                  : undefined
              }
              aria-valuenow={
                refreshState.kind === "Refreshing" &&
                refreshState.progress.kind === "Determinate"
                  ? refreshState.progress.finishedCount
                  : undefined
              }
            >
              <span className={styles.refreshIndicatorContent}>
                <RefreshCw
                  className={styles.refreshIndicatorIcon}
                  size={14}
                  aria-hidden="true"
                />
                {refreshFeedback}
              </span>
            </div>
          </div>
          {visibleFixedChrome ? (
            <div className={styles.fixedChrome}>
              {visibleFixedChrome.body}
            </div>
          ) : null}
        </div>
        {!isMobile ? (
          <div
            className={styles.resizeHandle}
            role="separator"
            aria-label={`Resize pane ${label}`}
            aria-controls={bodyId}
            aria-orientation="vertical"
            aria-valuemin={sizing.primaryMinWidthPx}
            aria-valuemax={sizing.primaryMaxWidthPx}
            aria-valuenow={sizing.primaryWidthPx}
            tabIndex={0}
            onMouseDown={handleResizeMouseDown}
            onKeyDown={handleResizeKeyDown}
          />
        ) : null}
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {refreshAnnouncement}
      </span>
      {visibleSecondary ? (
        <SecondaryPaneShell
          primaryPaneId={paneId}
          secondaryPaneId={visibleSecondary.state.id}
          publication={visibleSecondary.publication}
          state={visibleSecondary.state}
          sizing={visibleSecondary.sizing}
          onActiveSurfaceChange={onSetSecondarySurface}
          onClose={onCloseSecondaryPane}
          onResize={onResizeSecondaryPane}
        />
      ) : null}
    </section>
  );
}
