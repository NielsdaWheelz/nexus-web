"use client";

import {
  RotateCcw,
  Search,
} from "lucide-react";
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
  RESOURCE_ACTION_CATALOG,
  composeResourceMenu,
  resolveResourceCoreActions,
  resolveUniversalResourceRelationshipActions,
} from "@/lib/actions/resourceActions";
import {
  arePanePrimaryChromePublicationsEqual,
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
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import {
  executeResourceChat,
  executeResourceLibraryPlacement,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import { useShareController } from "@/lib/sharing/controller";
import { present } from "@/lib/api/presence";
import { usePaneSearchRequested } from "@/lib/panes/paneSearchEvents";
import type { PaneSearchPublication } from "@/lib/panes/paneSearch";
import type {
  ActionDescriptor,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import {
  useMobileChrome,
  useMobileChromeSurface,
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
  findPaneChromeFocusTarget,
  findPaneSearchFocusTarget,
} from "@/lib/workspace/paneDom";
import { SwitchboardPanePerformanceContext } from "@/lib/switchboard/performance";
import { NexusDesktopPanePerformanceContext } from "@/lib/nexus/performance";
import styles from "./PaneShell.module.css";

const noopResizeSecondaryPane = () => {};
const noopCloseSecondary = () => {};
const noopSetActiveSecondarySurface = () => {};
const EMPTY_HEADER_ACTIONS: readonly PaneHeaderAction[] = [];
const EMPTY_OPTIONS: readonly ActionDescriptor[] = [];

type PaneShellStyle = CSSProperties & {
  "--mobile-pane-chrome-height"?: string;
};

type ExpandedPaneSearchIdentity =
  | {
      readonly kind: "FilterRows";
      readonly continuityKey: string;
    }
  | {
      readonly kind: "Route";
      readonly routeKey: string;
    };

interface PaneShellProps {
  paneId: string;
  routeKey: string;
  routeHeader: PaneRouteHeaderContract;
  routeShareIdentity?: PaneRouteShareIdentity | null;
  label: string;
  labelPending?: boolean;
  returnMementoEnabled: boolean;
  queryNavigation?: "in-place";
  sizing: EffectivePaneSizing;
  bodyMode: PaneBodyMode;
  secondaryPane?: WorkspaceAttachedSecondaryPaneState | null;
  secondarySizing?: WorkspaceSecondarySizing | null;
  secondaryPublication?: PaneSecondaryPublication | null;
  fixedChromePublication?: PaneFixedChromePublication | null;
  onResizePrimaryPane: (paneId: string, widthPx: number) => void;
  onResizeSecondaryPane?: (secondaryPaneId: string, widthPx: number) => void;
  onCloseSecondaryPane?: (secondaryPaneId: string) => void;
  onSetSecondarySurface?: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  onChromeMouseDown?: (event: React.MouseEvent<HTMLElement>) => void;
  isActive?: boolean;
  isMobile?: boolean;
  children: React.ReactNode;
}

export default function PaneShell({
  paneId,
  routeKey,
  routeHeader,
  routeShareIdentity = null,
  label,
  labelPending = false,
  returnMementoEnabled,
  queryNavigation,
  sizing,
  bodyMode,
  secondaryPane = null,
  secondarySizing = null,
  secondaryPublication = null,
  fixedChromePublication = null,
  onResizePrimaryPane,
  onResizeSecondaryPane = noopResizeSecondaryPane,
  onCloseSecondaryPane = noopCloseSecondary,
  onSetSecondarySurface = noopSetActiveSecondarySurface,
  onChromeMouseDown,
  isActive = false,
  isMobile = false,
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
  const feedback = useFeedback();
  const panePerformance = useMemo(
    () => ({
      activationRouteId: resolveWorkspaceActivationRouteId(paneRuntime.href),
      isActive,
    }),
    [isActive, paneRuntime.href],
  );
  const recordNavigationModality = useRecordPaneNavigationModality();
  const activateTarget = paneRuntime.activateTarget;
  const activateIdentityAnchor = useCallback(
    (event: TargetLinkMouseEvent, anchor: HTMLAnchorElement) => {
      recordNavigationModality(event.detail === 0 ? "Keyboard" : "Pointer");
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
  const filterRowsContinuityKey = `${paneRuntime.visitId}:${paneRuntime.routeId}:${paneRuntime.pathname}`;
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
  const { openLibraryPlacement } = useLibraryPlacementController();
  const currentRouteKeyRef = useRef(routeKey);
  currentRouteKeyRef.current = routeKey;
  const currentFilterRowsContinuityKeyRef = useRef(filterRowsContinuityKey);
  currentFilterRowsContinuityKeyRef.current = filterRowsContinuityKey;
  const [mobileChromeHeight, setMobileChromeHeight] = useState(0);
  const [primaryChromeRecord, setPrimaryChromeRecord] = useState<{
    readonly routeKey: string;
    readonly publication: PanePrimaryChromePublication;
  } | null>(null);
  const { motionPhase, setPaneChrome } = useMobileChrome();
  const identityId = useId();
  const landmarkLabelId = useId();

  const publishPrimaryChrome = useCallback(
    (update: PanePrimaryChromePublicationUpdate) => {
      setPrimaryChromeRecord((current) => {
        if (update.routeKey !== currentRouteKeyRef.current) return current;
        if (!update.publication) {
          return current?.routeKey === update.routeKey ? null : current;
        }
        if (
          current?.routeKey === update.routeKey &&
          arePanePrimaryChromePublicationsEqual(
            current.publication,
            update.publication,
          )
        ) {
          return current;
        }
        return { routeKey: update.routeKey, publication: update.publication };
      });
    },
    [],
  );

  const [expandedSearchIdentity, setExpandedSearchIdentity] =
    useState<ExpandedPaneSearchIdentity | null>(null);
  const acceptedPrimaryChrome =
    primaryChromeRecord !== null && primaryChromeRecord.routeKey === routeKey
      ? primaryChromeRecord.publication
      : null;
  const retainedFilterRowsSearch = primaryChromeRecord?.publication.search;
  const acceptedSearch =
    acceptedPrimaryChrome?.search ??
    (expandedSearchIdentity?.kind === "FilterRows" &&
    expandedSearchIdentity.continuityKey === filterRowsContinuityKey &&
    retainedFilterRowsSearch?.kind === "FilterRows"
      ? retainedFilterRowsSearch
      : undefined);
  const acceptedSearchRef = useRef<PaneSearchPublication | undefined>(
    acceptedSearch,
  );
  const isActiveRef = useRef(isActive);
  acceptedSearchRef.current = acceptedSearch;
  isActiveRef.current = isActive;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRowId = `${paneId}-pane-search`;
  const searchExpanded =
    acceptedSearch !== undefined &&
    (acceptedSearch.kind === "FilterRows"
      ? expandedSearchIdentity?.kind === "FilterRows" &&
        expandedSearchIdentity.continuityKey === filterRowsContinuityKey
      : expandedSearchIdentity?.kind === "Route" &&
        expandedSearchIdentity.routeKey === routeKey);
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
    const publication = acceptedSearchRef.current;
    if (!isActiveRef.current || !publication) return false;
    if (!searchExpandedRef.current) {
      if (publication.kind === "FindOccurrences") publication.onOpen();
      searchExpandedRef.current = true;
      setExpandedSearchIdentity(
        publication.kind === "FilterRows"
          ? {
              kind: "FilterRows",
              continuityKey: currentFilterRowsContinuityKeyRef.current,
            }
          : { kind: "Route", routeKey: currentRouteKeyRef.current },
      );
    }
    focusSearchInput();
    return true;
  }, [focusSearchInput]);
  usePaneSearchRequested(openSearch);
  const closeSearch = useCallback(() => {
    searchExpandedRef.current = false;
    setExpandedSearchIdentity(null);
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
  }, [paneId]);
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
  const effectiveToolbar = acceptedPrimaryChrome?.toolbar;
  useMobileChromeSurface(
    chromeRef,
    "PaneToolbar",
    isMobile && isActive && Boolean(effectiveToolbar || searchExpanded),
  );
  const effectiveActions =
    acceptedPrimaryChrome?.actions ?? EMPTY_HEADER_ACTIONS;
  const effectiveMenu = acceptedPrimaryChrome?.menu;
  const toolbarHidden =
    Boolean(effectiveToolbar) && motionPhase.kind === "Hidden";
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
  const actionsWithSearch = useMemo<readonly PaneHeaderAction[]>(() => {
    if (!acceptedSearch) return effectiveActions;
    const activeDomainControlCount =
      acceptedSearch.kind === "FilterRows"
        ? acceptedSearch.activeDomainControlCount
        : 0;
    const searchLabel =
      acceptedSearch.kind === "FilterRows" ? "Filter" : "Find";
    const collapsedSearchLabel =
      !searchExpanded && activeDomainControlCount > 0
        ? `${searchLabel}, ${activeDomainControlCount} controls active`
        : searchLabel;
    const actions: PaneHeaderAction[] = [
      ...effectiveActions,
      {
        kind: "command",
        id: "Pane.Search",
        label: collapsedSearchLabel,
        indicator:
          !searchExpanded && activeDomainControlCount > 0
            ? { kind: "Status" }
            : undefined,
        icon: (
          <span className={styles.searchActionIcon}>
            <Search size={16} aria-hidden="true" />
            {!searchExpanded && activeDomainControlCount > 0 ? (
              <span
                className={styles.searchActionMarker}
                data-testid="pane-filter-active-marker"
                aria-hidden="true"
              />
            ) : null}
          </span>
        ),
        state: searchExpanded
          ? {
              kind: "disclosure",
              expanded: true,
              controls: searchRowId,
              menuLabels: {
                collapsed: collapsedSearchLabel,
                expanded: `Close ${searchLabel.toLowerCase()}`,
              },
            }
          : {
              kind: "disclosure",
              expanded: false,
              menuLabels: {
                collapsed: collapsedSearchLabel,
                expanded: `Close ${searchLabel.toLowerCase()}`,
              },
            },
        onSelect: ({ triggerEl }) => {
          searchTriggerRef.current = triggerEl;
          if (searchExpanded) {
            acceptedSearch.onDismiss();
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
    effectiveActions,
    openSearch,
    searchExpanded,
    searchRowId,
  ]);
  const reconciledActions = useMemo(
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
  }, [effectiveToolbar, isMobile, searchExpanded]);

  const chatBusyRefs = useRef(new Set<string>());
  const [chatBusySubjects, setChatBusySubjects] = useState<
    ReadonlySet<string>
  >(new Set());
  const paneMenuOptions = useMemo<readonly ActionDescriptor[]>(() => {
    const routeShareOption: ActionDescriptor[] = routeShareIdentity
      ? [
          {
            kind: "command",
            id: "RouteAction.Share",
            label: "Share…",
            restoreFocusOnClose: false,
            onSelect: ({ triggerEl }) =>
              openShare(routeShareIdentity, {
                returnFocusTo: () => triggerEl,
                returnFocusFallback: present(() =>
                  findPaneChromeFocusTarget(paneId),
                ),
              }),
          },
        ]
      : [];
    if (!effectiveMenu) {
      return routeShareOption.length > 0 ? routeShareOption : EMPTY_OPTIONS;
    }
    if (effectiveMenu.kind === "FlatMenu") {
      const contextualOptions = effectiveMenu.actions.map((option, index) =>
        routeShareOption.length > 0 &&
        index === 0 &&
        option.separatorBefore === undefined
          ? { ...option, separatorBefore: true }
          : option,
      );
      return [...routeShareOption, ...contextualOptions];
    }
    if (routeShareIdentity) {
      // justify-defect: a resource pane must not retain the route-share path.
      throw new Error("Resource pane received a route Share identity");
    }
    if (effectiveMenu.target.kind !== "Resource") {
      // justify-defect: external targets are representations, never current panes.
      throw new Error("Pane ResourceMenu target must be Resource");
    }
    if (effectiveMenu.groups.core.length > 0) {
      // justify-defect: PaneShell is the sole owner of current-pane core policy.
      throw new Error("Pane ResourceMenu must publish an empty core group");
    }
    const target = effectiveMenu.target;
    const busyIds = chatBusySubjects.has(target.ref)
      ? new Set([RESOURCE_ACTION_CATALOG.Chat.id])
      : new Set<never>();
    const core = resolveResourceCoreActions({
      target,
      projection: "CurrentPane",
      busyIds,
      executors: {
        share: (subject, detail) => {
          executeResourceShare({
            subject,
            openShare,
            options: {
              returnFocusTo: () => detail.triggerEl,
              returnFocusFallback: present(() =>
                findPaneChromeFocusTarget(paneId),
              ),
            },
          });
        },
        chat: async (subject) => {
          if (chatBusyRefs.current.has(subject.ref)) return;
          chatBusyRefs.current.add(subject.ref);
          setChatBusySubjects(new Set(chatBusyRefs.current));
          try {
            await executeResourceChat({
              ref: subject.ref,
              openConversation: (conversationId) => {
                void activateTarget({
                  target: {
                    href: `/conversations/${conversationId}`,
                    labelHint: "Chat",
                  },
                  disposition: { kind: "Adopt" },
                });
              },
            });
          } catch (error: unknown) {
            if (handleUnauthenticatedApiError(error)) return;
            if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
            feedback.show(
              toFeedback(error, {
                fallback: "A conversation about this resource could not begin.",
              }),
            );
          } finally {
            chatBusyRefs.current.delete(subject.ref);
            setChatBusySubjects(new Set(chatBusyRefs.current));
          }
        },
      },
    }).core;
    const universalRelationships =
      resolveUniversalResourceRelationshipActions({
        target,
        executors: {
          libraryPlacement: (subject, detail) => {
            executeResourceLibraryPlacement({
              subject,
              openLibraryPlacement,
              options: {
                anchor: () => detail.triggerEl,
                returnFocusFallback: present(() =>
                  findPaneChromeFocusTarget(paneId),
                ),
              },
            });
          },
        },
      }).relationships;
    return composeResourceMenu({
      ...effectiveMenu.groups,
      core,
      relationships: [
        ...universalRelationships,
        ...effectiveMenu.groups.relationships,
      ],
    });
  }, [
    chatBusySubjects,
    effectiveMenu,
    feedback,
    openLibraryPlacement,
    openShare,
    paneId,
    activateTarget,
    routeShareIdentity,
  ]);
  useLayoutEffect(() => {
    if (!isMobile) return;
    // Direct header actions (e.g. the Companion toggle) travel on their own
    // channel so the mobile top bar renders them beside — never folded into —
    // the Options menu.
    setPaneChrome({
      paneId,
      routeKey,
      identityId,
      header,
      activateIdentityAnchor,
      navigation,
      actions: reconciledActions,
      options: paneMenuOptions,
    });
    return () => setPaneChrome(null);
  }, [
    activateIdentityAnchor,
    header,
    identityId,
    isMobile,
    navigation,
    paneId,
    routeKey,
    reconciledActions,
    paneMenuOptions,
    setPaneChrome,
  ]);

  const bodyId = `${paneId}-body`;
  const expandedActionRetainsSecondary = reconciledActions.some(
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

  return (
    <section
      className={styles.paneShell}
      aria-labelledby={landmarkLabelId}
      data-testid="pane-shell-root"
      data-pane-shell="true"
      data-header-kind={header.kind}
      data-active={isActive ? "true" : "false"}
      data-mobile={isMobile ? "true" : "false"}
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
          data-testid="pane-shell-chrome"
          data-pane-chrome-focus={
            !isMobile || effectiveToolbar || searchExpanded
              ? "true"
              : undefined
          }
          data-mobile-chrome-phase={motionPhase.kind}
          tabIndex={-1}
          onMouseDown={onChromeMouseDown}
        >
          {!isMobile ? (
            <SurfaceHeader
              header={header}
              identityId={identityId}
              options={paneMenuOptions}
              actions={reconciledActions}
              navigation={navigation}
            />
          ) : null}
          {searchExpanded && acceptedSearch ? (
            <div
              id={searchRowId}
              className={styles.toolbar}
              data-testid="pane-search-toolbar"
            >
              <PaneSearchBar
                ref={searchInputRef}
                publication={acceptedSearch}
                onClose={closeSearch}
              />
            </div>
          ) : null}
          {effectiveToolbar ? (
            <div
              className={styles.toolbar}
              data-testid="pane-shell-toolbar"
              aria-hidden={toolbarHidden || undefined}
              inert={toolbarHidden || undefined}
            >
              {effectiveToolbar}
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
            data-testid="pane-shell-body"
            data-body-mode={bodyMode}
            data-pane-content="true"
            style={bodyStyle}
          >
            <SwitchboardPanePerformanceContext.Provider
              value={panePerformance}
            >
              <NexusDesktopPanePerformanceContext.Provider value={panePerformance}>
                <PanePrimaryChromeProvider publish={publishPrimaryChrome}>
                  {children}
                </PanePrimaryChromeProvider>
              </NexusDesktopPanePerformanceContext.Provider>
            </SwitchboardPanePerformanceContext.Provider>
          </div>
          {visibleFixedChrome ? (
            <div className={styles.fixedChrome} data-testid="pane-fixed-chrome">
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
