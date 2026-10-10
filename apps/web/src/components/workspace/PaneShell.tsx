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
  type CSSProperties,
  type ReactNode,
} from "react";
import FindBar from "@/components/find/FindBar";
import SurfaceHeader from "@/components/ui/SurfaceHeader";
import Companion, {
  companionAction,
  companionExpanded,
  createCompanionController,
  type CompanionController,
} from "@/components/workspace/Companion";
import PaneRouteBoundary from "@/components/workspace/PaneRouteBoundary";
import PaneSearchBar from "@/components/workspace/PaneSearchBar";
import ResizeHandle from "@/components/workspace/ResizeHandle";
import { usePaneRefresh } from "@/components/workspace/usePaneRefresh";
import { present } from "@/lib/api/presence";
import { matchesKeyEvent } from "@/lib/keybindings";
import { useKeybindings } from "@/lib/keybindingsProvider";
import {
  useMobileChrome,
  useMobileChromeSurface,
  usePublishMobilePaneChrome,
} from "@/lib/mobileShell/chrome";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import {
  createPaneChromeStore,
  PANE_COMMAND_RESOLVING_REASON,
  PaneChromeContext,
  usePaneChromeState,
  type PaneChromeStore,
  type PaneSearch,
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
  requirePaneRuntime,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { activateTargetAnchor } from "@/lib/panes/targetLinkActivation";
import { useShareController } from "@/lib/sharing/controller";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { hasActiveInteractionOwner } from "@/lib/ui/useEscapeKey";
import type { WorkspacePane } from "@/lib/workspace/model";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
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
  readonly labelPending: boolean;
  readonly isActive: boolean;
  readonly isMobile: boolean;
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
  const latest = useRef({ secondary: pane.secondary, isMobile });
  latest.current = { secondary: pane.secondary, isMobile };
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
  return (
    <PaneRuntimeProvider pane={pane} isActive={isActive} host={controller}>
      <PaneChromeContext value={chrome}>
        <PaneRouteBoundary>
          <PaneView {...props} chrome={chrome} controller={controller} />
        </PaneRouteBoundary>
      </PaneChromeContext>
    </PaneRuntimeProvider>
  );
}

/** The shell's presentation; the body is `children` and never re-renders with it. */
function PaneView({
  pane,
  route,
  label,
  labelPending,
  isActive,
  isMobile,
  columnWidthPx,
  onChromeMouseDown,
  chrome,
  controller,
  children,
}: PaneShellProps & {
  readonly chrome: PaneChromeStore;
  readonly controller: CompanionController;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "PaneShell");
  const { paneId, router } = runtime;
  const { resizePrimaryPane } = useWorkspaceStore();
  const state = usePaneChromeState(chrome);
  const body = state.chrome;
  const mobileChrome = useMobileChrome();
  const mobileViewport = useMobileViewport();
  const { openShare } = useShareController();
  const searchCombo = useKeybindings()["Pane.Search"];
  const identityId = useId();
  const landmarkLabelId = useId();
  const chromeRef = useRef<HTMLDivElement>(null);
  const scrollportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const source = `${runtime.visitId}:${runtime.routeId}:${runtime.pathname}`;
  const rowId = `${paneId}-pane-search`;
  const bodyId = `${paneId}-body`;

  // ---- search: one expansion per source (visit, route, path) ---------------
  const search = body?.search;
  const ready = search?.kind === "Resolving" ? undefined : search;
  const find = ready?.kind === "Find" ? ready.find : null;
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const searchOpen = ready !== undefined && expandedFor === source;
  // a query refinement keeps the row; every end dismisses what it expanded.
  const expanded = useRef<PaneSearch | undefined>(undefined);
  if (searchOpen) expanded.current = ready;
  const dismissSearch = useCallback(() => {
    const ended = expanded.current;
    expanded.current = undefined;
    setExpandedFor(null);
    if (ended?.kind === "Find") ended.find.close();
    else if (ended?.kind === "FilterRows") ended.onDismiss();
    chrome.set({ results: null });
  }, [chrome]);
  useLayoutEffect(() => dismissSearch, [dismissSearch, source]);
  const focusInputSoon = useCallback(
    () =>
      requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.select();
      }),
    [],
  );
  // the row can commit after the request's frame during a viewport reflow.
  useLayoutEffect(() => {
    if (searchOpen) focusInputSoon();
  }, [focusInputSoon, searchOpen]);
  const openSearch = (): boolean => {
    if (body?.collection) return body.collection.focusInput();
    if (!ready) return false;
    if (searchOpen) focusInputSoon();
    else {
      if (ready.kind === "Find") ready.find.open();
      setExpandedFor(source);
    }
    return true;
  };
  const closeSearch = () => {
    dismissSearch();
    if (isMobile) return mobileChrome.focusPaneChrome(paneId);
    const trigger = triggerRef.current;
    requestAnimationFrame(() => {
      const usable = trigger?.isConnected && !trigger.closest("[inert]");
      const target = usable ? trigger : findPaneChromeFocusTarget(paneId);
      target?.focus({ preventScroll: true });
    });
  };
  // Pane.Search belongs to the active pane, never under an open overlay, and
  // suppresses the browser's find only when a pane search took it.
  const openSearchRef = useRef(openSearch);
  openSearchRef.current = openSearch;
  useEffect(() => {
    if (!isActive || !searchCombo) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !matchesKeyEvent(searchCombo, event) ||
        hasActiveInteractionOwner()
      )
        return;
      if (openSearchRef.current()) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isActive, searchCombo]);

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
    titlePending: labelPending,
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
  if (search) {
    // a resolving pane names the control it will become, so More keeps its verb.
    const verb =
      search.kind === "Resolving"
        ? search.control
        : search.kind === "FilterRows"
          ? "Filter"
          : "Find";
    const menuLabels = {
      collapsed: verb,
      expanded: `Close ${verb.toLowerCase()}`,
    };
    paneActions.push({
      kind: "command",
      id: "Pane.Search",
      label: verb,
      icon: <Search size={16} aria-hidden="true" />,
      disabled: search.kind === "Resolving" || undefined,
      disabledReason:
        search.kind === "Resolving" ? PANE_COMMAND_RESOLVING_REASON : undefined,
      state: searchOpen
        ? { kind: "disclosure", expanded: true, controls: rowId, menuLabels }
        : { kind: "disclosure", expanded: false, menuLabels },
      onSelect: ({ triggerEl }) => {
        triggerRef.current = triggerEl;
        if (searchOpen) closeSearch();
        else openSearch();
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
  if (share && !body?.actionSubject) {
    paneActions.push({
      kind: "command",
      id: "RouteAction.Share",
      label: "Share…",
      icon: <Share2 size={16} aria-hidden="true" />,
      onSelect: ({ triggerEl }) =>
        openShare(share, {
          returnFocusTo: () => triggerEl,
          returnFocusFallback: present(() =>
            findPaneLandmarkFocusTarget(paneId),
          ),
        }),
    });
  }
  const navigation = {
    canGoBack: router.canGoBack,
    canGoForward: router.canGoForward,
    onBack: router.back,
    onForward: router.forward,
  };

  // ---- mobile: the top bar shows this pane; its row rides under the bar ----
  const row = searchOpen ? "Search" : body?.instrument ? "Instrument" : null;
  usePublishMobilePaneChrome(
    isMobile
      ? {
          paneId,
          identityId,
          header,
          activateChromeAnchor: (event, anchor) =>
            activateTargetAnchor({ event, runtime, anchor }),
          navigation,
          companionAction: inspector,
          paneActions,
          menuActions: body?.menuActions ?? [],
          actionSubject: body?.actionSubject,
        }
      : null,
  );
  useMobileChromeSurface(chromeRef, isActive && isMobile && row !== null);
  // the active mobile body is the surface readers and lists take clearance from.
  useLayoutEffect(() => {
    const element = scrollportRef.current;
    if (!isMobile || !isActive || !element) return;
    return mobileViewport.registerContentSurface(element);
  }, [isActive, isMobile, mobileViewport]);
  const [rowHeight, setRowHeight] = useState(0);
  useLayoutEffect(() => {
    const node = chromeRef.current;
    if (!isMobile || !node) return setRowHeight(0);
    const measure = () => setRowHeight(node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isMobile, row]);
  usePaneReturnScrollport({
    enabled: route.returnKind === "ShellScroll",
    scrollportRef,
    contentRef,
    continuityKey: route.queryNavigation === "in-place" ? source : null,
  });

  // ---- geometry: desktop only; clamping is render-only ---------------------
  const layout = isMobile ? null : state.layout;
  const width = primaryWidth({
    storedPx: pane.primaryWidthPx,
    columnPx: columnWidthPx,
    routeMaxPx: route.width.maxWidthPx,
    intrinsicPx: route.width.allowsIntrinsicPrimaryWidth
      ? (layout?.intrinsicWidthPx ?? null)
      : null,
  });
  const rail = layout?.rail ?? null;
  const railPx = rail ? Math.ceil(rail.widthPx) : 0;
  const instrument = row === "Instrument" ? body?.instrument : undefined;

  return (
    <section
      className={styles.paneShell}
      aria-labelledby={landmarkLabelId}
      data-pane-shell="true"
      data-pane-focus-landmark="true"
      data-active={isActive}
      data-mobile={isMobile}
      tabIndex={-1}
      style={
        rowHeight > 0
          ? ({
              "--mobile-pane-chrome-height": `${rowHeight}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <span id={landmarkLabelId} className="sr-only">
        {paneHeaderAccessibleName(header)}
      </span>
      <div
        className={styles.primaryPane}
        style={isMobile ? undefined : { width: width.widthPx + railPx }}
      >
        <div
          ref={chromeRef}
          className={styles.chrome}
          data-pane-chrome-focus={isMobile ? undefined : "true"}
          tabIndex={-1}
          onMouseDown={onChromeMouseDown}
        >
          {isMobile ? null : (
            <SurfaceHeader
              header={header}
              identityId={identityId}
              companionAction={inspector}
              paneActions={paneActions}
              menuActions={body?.menuActions}
              actionSubject={body?.actionSubject}
              navigation={navigation}
            />
          )}
          {row ? (
            <div
              id={row === "Search" ? rowId : undefined}
              className={styles.contextualRow}
              data-contextual-row-variant={
                row === "Search" && ready?.kind === "FilterRows"
                  ? "Refinement"
                  : "Instrument"
              }
              role={instrument ? "group" : undefined}
              aria-label={instrument?.label}
            >
              {instrument ? (
                instrument.content
              ) : find ? (
                <FindBar
                  ref={inputRef}
                  find={find}
                  onClose={closeSearch}
                  resultsExpanded={state.results?.expanded ?? false}
                  onShowResults={controller.showResults}
                />
              ) : ready?.kind === "FilterRows" ? (
                <PaneSearchBar
                  ref={inputRef}
                  search={ready}
                  onClose={closeSearch}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          className={styles.primaryContentRow}
          style={{
            gridTemplateColumns: isMobile
              ? "minmax(0, 1fr)"
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
            {body?.collection ? (
              <div
                className={styles.collectionRow}
                role="group"
                aria-label={body.collection.label}
                data-pane-collection-controls="true"
              >
                {body.collection.content}
              </div>
            ) : null}
            <div ref={contentRef} className={styles.routeContent}>
              {children}
            </div>
            {refresh.indicator}
          </div>
          {rail ? <div className={styles.rail}>{rail.body}</div> : null}
        </div>
        {isMobile ? null : (
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
        isMobile={isMobile}
        chrome={chrome}
        controller={controller}
        secondary={pane.secondary}
        find={find}
        actionSubject={body?.actionSubject}
      />
    </section>
  );
}
