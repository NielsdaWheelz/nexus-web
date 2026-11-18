"use client";

import * as Icon from "@/lib/ui/icons";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type MouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { admissionReason } from "@/lib/actions/catalog";
import OutlineCommands from "@/components/notes/OutlineCommands";
import FindBar from "@/components/find/FindBar";
import CollationLine from "@/components/workspace/CollationLine";
import QueryField from "@/components/workspace/QueryField";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import { litWords } from "@/lib/panes/collation";
import { publishPaneScroll } from "@/lib/panes/paneScroll";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import { useOutcome } from "@/components/feedback/Feedback";
import { StageAnchor } from "@/components/feedback/Slips";
import SurfaceHeader from "@/components/ui/SurfaceHeader";
import { TabList, TabLinks } from "@/components/ui/Tabs";
import compact from "@/components/ui/CompactChrome.module.css";
import Companion, {
  companionAction,
  companionExpanded,
  createCompanionController,
  type CompanionController,
} from "@/components/workspace/Companion";
import { CompanionPresentationContext, type CompanionPresentation } from "@/components/workspace/companionPresentation";
import ResizeHandle from "@/components/workspace/ResizeHandle";
import { useCatalogState } from "@/lib/catalog/provider";
import { installedApp } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { usePaneRefresh } from "@/components/workspace/usePaneRefresh";
import {
  useMobileChrome,
  useMobileChromeHold,
  useMobileChromeSurface,
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
import { activateTargetAnchor, activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useRenderEnvironment, useTouchCapable } from "@/lib/renderEnvironment/provider";
import { useSourceArrival } from "@/lib/reader/sourceArrival";
import { useShareController } from "@/lib/sharing/controller";
import { formatShortcut, matchesShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { prepareActionSelect, type ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { hasActiveInteractionOwner, isTopmostInteractionOwner, useInteractionBlocked } from "@/lib/ui/overlay";
import { useKeyboardInset } from "@/lib/ui/useKeyboardInset";
import type { PaneVisit, WorkspacePane } from "@/lib/workspace/model";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { usePaneReturnScrollport } from "@/lib/workspace/paneReturnMemento";
import { primaryWidth } from "@/lib/workspace/paneSizing";
import { useWorkspacePresentations } from "@/lib/workspace/presentations";
import { useWorkspaceStore, type PaneHistoryOptions } from "@/lib/workspace/store";
import styles from "./PaneShell.module.css";

/** One route-owned composition, derived by the workspace before its body mounts. */
export const MobileReaderCompositionContext = createContext(false);

interface PaneShellProps {
  readonly pane: WorkspacePane;
  /** The mounted body's identity (`paneMountKey`): its chrome store lives as long as it does. */
  readonly bodyKey: string;
  readonly route: ResolvedPaneRouteModel;
  readonly label: string;
  readonly isActive: boolean;
  readonly isMobile: boolean;
  readonly isVisible: boolean;
  readonly isPresented: boolean;
  readonly isMaximized: boolean;
  readonly availableWidthPx: number | null;
  readonly columnWidthPx: number;
  readonly onChromeMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  readonly children: ReactNode;
}

/**
 * One pane: its runtime, the store its body's chrome lands in (fresh with each
 * mounted body, so a suspending body never shows its predecessor's chrome), its
 * Companion commands, and the shell every pane shares around the body.
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
  const [presentation, setPresentation] = useState<CompanionPresentation>(isMobile ? "FullScreen" : "Column");
  const measured = !props.isMaximized || props.availableWidthPx !== null;
  const desiredPresentation = isMobile ? "FullScreen" : (
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
  const latest = useRef({ secondary: pane.secondary, presentation, isVisible: props.isVisible });
  latest.current = { secondary: pane.secondary, presentation, isVisible: props.isVisible };
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
    <PaneRuntimeProvider pane={pane} isActive={isActive} isVisible={props.isVisible} isPresented={props.isPresented} host={controller}>

        <PaneChromeContext value={chrome}>
          <CompanionPresentationContext value={presentation}>
            <PaneView {...props} chrome={chrome} state={state} controller={controller} presentation={presentation} companionMaxWidthPx={companionMaxWidthPx} />
          </CompanionPresentationContext>
        </PaneChromeContext>

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
  const activateHistory = (back: boolean, event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    const options: PaneHistoryOptions = { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } };
    if (back) router.back(options);
    else router.forward(options);
  };
  const body = state.chrome;
  const views = body?.views;
  if (views && route.sections.length) throw new Error("a sectioned route cannot publish pane views");
  const currentView = views?.items.findIndex(item => item.value === views.value) ?? -1;
  const primary = body?.primaryAction;
  const principal = primary?.kind === "link" && !primary.onActivate
    ? { ...primary, onActivate: (event: TargetActivationEvent) => activateTargetLink({ event, runtime, target: primary.href === null ? null : { href: primary.href } }) }
    : primary;
  const menuActions = body?.menuActions?.map((action) => action.kind === "link" && !action.onActivate
    ? { ...action, onActivate: (event: TargetActivationEvent) => activateTargetLink({ event, runtime, target: action.href === null ? null : { href: action.href } }) }
    : action);
  const activatePrincipal = (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement> | ReactKeyboardEvent<HTMLButtonElement | HTMLAnchorElement>) => {
    if (!principal) return;
    if (principal.disabled) {
      if (!("key" in event) || event.key === "Enter" || event.key === " ") event.preventDefault();
      return;
    }
    if (principal.kind === "link") {
      if (principal.onActivate) principal.onActivate(event);
      else activateTargetLink({ event, runtime, target: { href: principal.href } });
      return;
    }
    const detail = prepareActionSelect(event, event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null);
    if (detail) principal.onSelect(detail);
  };
  // Every in-app link inside the pane, its chrome included, goes through the workspace.
  const activateAnchor = (event: MouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (anchor instanceof HTMLAnchorElement) activateTargetAnchor({ event, runtime, anchor });
  };
  const mobileChrome = useMobileChrome();
  const mobileViewport = useMobileViewport();
  const readerComposition = useContext(MobileReaderCompositionContext);
  useLayoutEffect(() => mobileViewport.refreshGeometry(), [mobileViewport, readerComposition, isMobile, isActive]);
  const { keyboardBottomInsetPx } = useKeyboardInset();
  const { openShare } = useShareController();
  const { platform } = useRenderEnvironment();
  const touchCapable = useTouchCapable();
  const [commandsBottom, setCommandsBottom] = useState(0);
  const outlineCommands = touchCapable && isActive && !hasActiveInteractionOwner() && state.outlineCommands?.touchVisible ? state.outlineCommands : null;
  useLayoutEffect(() => {
    if (!outlineCommands) {setCommandsBottom(0); return;}
    const measure = () => {
      const consumed = Math.max(0, window.innerHeight - (paneRef.current?.getBoundingClientRect().bottom ?? window.innerHeight));
      setCommandsBottom(Math.max(0, Math.max(keyboardBottomInsetPx,
        readMobileCssLength("var(--mobile-content-bottom-clearance)")) - consumed));
    };
    measure();
    return mobileViewport.subscribeContentBottomClearance(measure);
  }, [outlineCommands, keyboardBottomInsetPx, mobileViewport]);
  const identityId = useId();
  const landmarkLabelId = useId();
  const paneRef = useRef<HTMLElement>(null);
  const headerFrameRef = useRef<HTMLDivElement>(null);
  const controlsFrameRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const scrollportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusFrame = useRef(0);
  const source = paneSourceKey(runtime);
  const bodyId = `${paneId}-body`;
  const viewRowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = viewRowRef.current;
    if (document.activeElement instanceof Element && row?.querySelector('[role="tablist"]')?.contains(document.activeElement))
      row.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, [views?.value]);

  // The shell owns disclosure; the find session survives source readiness changes.
  const query = body?.query;
  const find = query?.kind === "Find" ? query.session.controller : null;
  const collation = query?.kind === "Collation" ? query.collation : null;
  const words = collation?.words ?? null;
  const [fieldFor, setFieldFor] = useState<string | null>(null);
  const [unfoldedFor, setUnfoldedFor] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const statusId = useId();
  const fieldVisible = words !== null && (words.standing || words.requestOpen || fieldFor === source || !!words.value || !!words.applied || isMobile && unfoldedFor === source);
  const setQueryInput = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    const ref = words?.input;
    if (typeof ref === "function") ref(node); else if (ref) ref.current = node;
  }, [words?.input]);
  const unfolded = isMobile && unfoldedFor === source;
  const hasLine = !!(views || route.sections.length || collation?.dimensions.length || collation?.order);
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const findVisible = query?.kind === "Find" && expandedFor === source;
  const clearFind = () => {
    if (query?.kind === "Find") query.session.clear();
    chrome.set({ results: null });
  };
  useLayoutEffect(
    () => () => {
      setExpandedFor(null);
      setFieldFor(null);
      setUnfoldedFor(null);
      opener.current = null;
      cancelAnimationFrame(focusFrame.current);
      focusFrame.current = 0;
      chrome.set({ results: null });
    },
    [chrome, source],
  );
  useLayoutEffect(() => {
    if (words?.requestOpen) setFieldFor(source);
  }, [source, words?.requestOpen]);
  const openQuery = (from?: HTMLElement | null): boolean => {
    if (query?.kind === "Collation") {
      if (!words) return false;
      setFieldFor(source);
    } else {
      if (!find) return false;
      setExpandedFor(source);
    }
    if (from) opener.current = from;
    else if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body &&
      !inputRef.current?.closest("[data-pane-query-field]")?.contains(document.activeElement)) opener.current = document.activeElement;
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
  const clearField = () => {
    setFieldFor(source);
    words?.onClear("Clear");
  };
  const returnToOpener = () => {
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
    if (!target || document.activeElement !== target) mobileChrome.focusPaneChrome(paneId);
  };
  const closeField = () => {
    words?.onClear("Close");
    setFieldFor(null);
    if (isMobile) setUnfoldedFor(null);
    returnToOpener();
  };
  const closeFind = () => {
    clearFind();
    setExpandedFor(null);
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = 0;
    returnToOpener();
  };
  // Pane.Search belongs to the active pane, never under an open overlay, and
  // suppresses the browser's find only when a pane search took it.
  const openQueryRef = useRef(openQuery);
  openQueryRef.current = openQuery;
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented || hasActiveInteractionOwner() ||
        !(matchesShortcut(SHORTCUTS["Pane.Search"], event, platform) ||
          event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target))
      )
        return;
      if (openQueryRef.current()) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isActive, platform]);

  // ---- refresh, header, actions ------------------------------------------
  const catalog = useCatalogState();
  const admission = useRemoteAdmission();
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
  const pointerTitle = body?.titleRole === "Pointer" ? pane.current_visit.title_hint : null;
  const header = resolvePaneHeaderModel({
    route: route.header,
    title: pointerTitle ?? body?.displayTitle ?? (body?.resourceActions?.kind === "Media" && body.resourceActions.subject.kind === "Stored" ? body.resourceActions.subject.summary.title
      : route.id === "media" && body?.header?.kind === "Resource" && body.header.resource.status === "Unavailable" ? "unavailable" : label),
    titleRole: pointerTitle === null ? "Title" : "Pointer",
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
  if (isMobile && words && !words.standing) paneActions.push({
    kind: "command", id: "Pane.Search", label: `${words.label}…`, icon: <Icon.Search aria-hidden="true" />,
    restoreFocusOnClose: false, onSelect: ({ triggerEl }) => { openQuery(triggerEl); },
  });
  if (isMobile && query?.kind === "Find") {
    const resolving = find === null;
    paneActions.push({
      kind: "command",
      id: "Pane.Search",
      label: "find in document…",
      icon: <Icon.Search aria-hidden="true" />,
      disabled: resolving || undefined,
      disabledReason: resolving ? PANE_COMMAND_RESOLVING_REASON : undefined,
      waiting: resolving || undefined,
      restoreFocusOnClose: false,
      onSelect: ({ triggerEl }) => { openQuery(triggerEl); },
    });
  }
  if (refresh.command) paneActions.push(refresh.command);
  if (installedApp) paneActions.push({
    kind: "command", id: "Catalog.Save", label: "Save catalog for offline",
    icon: <Icon.Download aria-hidden="true" />,
    disabled: admission !== "Ready" || catalog.accepting || catalog.status?.refreshing === true,
    disabledReason: admission !== "Ready" ? admissionReason() : catalog.accepting || catalog.status?.refreshing ? "the catalog is updating." : undefined,
    waiting: admission === "Ready" && (catalog.accepting || catalog.status?.refreshing === true) || undefined,
    onSelect: () => { void catalog.refresh(); },
  });
  const share = resolvePaneRouteShareIdentity(route, header.title);
  if (share && !body?.resourceRef) {
    paneActions.push({
      kind: "command",
      id: "RouteAction.Share",
      label: "Share…",
      icon: <Icon.Share aria-hidden="true" />,
      onSelect: ({ triggerEl }) =>
        openShare(share, {
          returnFocusTo: () => triggerEl,
          returnFocusFallback: (() =>
            findPaneLandmarkFocusTarget(paneId)),
        }),
    });
  }
  const presentations = useWorkspacePresentations();
  const adjacent = (visit: PaneVisit | undefined) => visit ? { title: presentations.forVisit(visit).name } : null;
  const statementWords = [...(views && currentView > 0 ? [views.items[currentView]!.label] : []), ...(collation ? litWords(collation) : [])];
  if (statementWords.length === 0 && views && header.kind === "Section" && header.meta.kind !== "Count") statementWords.push(views.items[currentView]?.label ?? views.items[0]!.label);
  const canFold = !!(views || collation?.dimensions.length || collation?.order);
  const searchLabel = words && !words.standing ? words.label : query?.kind === "Find" ? find?.label ?? "find in document" : null;
  const FieldRow = words?.onSubmit ? "form" : "div";
  const surfaceHeader = (
    <SurfaceHeader
      projection={isMobile ? "Mobile" : "Desktop"}
      search={searchLabel ? { label: searchLabel, onActivate: openQuery, reason: query?.kind === "Find" && !find ? PANE_COMMAND_RESOLVING_REASON : undefined, hint: `${searchLabel} (${formatShortcut(SHORTCUTS["Pane.Search"], platform)}, /)` } : undefined}
      statement={isMobile && canFold ? { words: statementWords, expanded: unfolded, controls: `${paneId}-collation`, onToggle: element => { if (!unfolded) opener.current = element; setUnfoldedFor(unfolded ? null : source); } } : undefined}
      header={header}
      titleYielded={state.titleYielded}
      titleYieldReady={state.titleYieldReady}
      identityId={identityId}
      frameRef={headerFrameRef}
      resourceActions={body?.resourceActions}
      drawing={body?.drawing}
      podcastMetadata={body?.podcastMetadata}
      primaryAction={principal ? { action: principal, onActivate: activatePrincipal } : undefined}
      companionAction={inspector}
      paneActions={paneActions}
      menuActions={menuActions}
      resourceRef={body?.resourceRef}
      navigation={{
        back: adjacent(pane.history.back.at(-1)),
        forward: adjacent(pane.history.forward[0]),
        onBack: event => activateHistory(true, event),
        onForward: event => activateHistory(false, event),
      }}
      onMouseDown={isMobile ? undefined : onChromeMouseDown}
    />
  );

  // The whole control stack retreats with the mobile bar; visible Find holds it.
  const hasVisibleControls = Boolean(
    (hasLine && (!isMobile || unfolded || route.sections.length > 0)) || body?.navigation || findVisible || fieldVisible,
  );
  useMobileChromeSurface(chromeRef, isActive && isMobile && hasVisibleControls);
  useMobileChromeHold(isActive && isMobile && findVisible);
  useLayoutEffect(() => {
    const frame = controlsFrameRef.current;
    const surface = chromeRef.current;
    if (!isActive || !isMobile || !frame || !surface) return;
    return mobileViewport.registerTopSurface("Controls", frame, surface);
  }, [isActive, isMobile, mobileViewport]);
  // the active mobile body is the surface readers and lists take clearance from.
  useLayoutEffect(() => {
    const element = scrollportRef.current;
    if (!isMobile || !isActive || !element) return;
    return mobileViewport.registerContentSurface(element);
  }, [isActive, isMobile, mobileViewport]);
  // the standard body is its own scroll port; reader and librarian routes publish theirs.
  useLayoutEffect(() => {
    const element = scrollportRef.current;
    if (route.bodyMode !== "standard" || !element) return;
    return publishPaneScroll(element);
  }, [route.bodyMode]);
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
      data-reader-composition={readerComposition || undefined}
      data-controls-shown={hasVisibleControls || undefined}
      data-maximized={isMaximized || undefined}
      tabIndex={-1}
      onClickCapture={activateAnchor}
      onKeyDownCapture={activateAnchor}
    >
      <span id={landmarkLabelId} className="sr-only">
        {paneHeaderAccessibleName(header)}
      </span>
      <div
        className={styles.primaryPane}
        style={isMobile || isMaximized ? undefined : { width: width.widthPx + railPx }}
      >
        <div className={styles.chromeFrame}
          data-pane-chrome-focus={isMobile ? undefined : "true"} tabIndex={-1}>
          {surfaceHeader}
          <div ref={controlsFrameRef} id={`${paneId}-collation`} className={styles.controlsFrame}>
            <div
              ref={chromeRef}
              className={styles.chrome}
            >
              {hasLine ? (
                <div ref={viewRowRef} data-collation-row="true" hidden={isMobile && !unfolded && route.sections.length === 0} className={`${styles.controlRow} ${styles.viewRow} ${compact.compact}`}>
                  {views && (!isMobile || unfolded) ? <TabList value={views.value} items={views.items.map((item, index) => ({
                    ...item, id: `${paneId}-view-${index}`, panelId: bodyId,
                  }))} onSelect={views.onSelect} aria-label={views.label} /> : route.sections.length ? <TabLinks
                    current={route.id} items={route.sections.map(section => ({ ...section, value: section.id }))}
                    aria-label="settings sections" /> : null}
                  {collation ? <CollationLine collation={collation} /> : null}
                </div>
              ) : null}
              {body?.navigation ? (
                <div
                  className={`${styles.controlRow} ${compact.compact}`}
                  role="group"
                  aria-label={body.navigation.label}
                >
                  {body.navigation.content}
                </div>
              ) : null}
              {query?.kind === "Collation" && words && fieldVisible ? <FieldRow key={source} className={`${styles.controlRow} ${compact.compact}`}
                role={words.onSubmit ? "search" : undefined} aria-label={words.onSubmit ? words.label : undefined}
                onSubmit={words.onSubmit ? event => { event.preventDefault(); words.onSubmit?.(); } : undefined}>
                <QueryField inputRef={setQueryInput} applied={words.applied} onClear={clearField} notice={words.notice}
                  onClose={words.standing ? null : closeField}
                  input={{ ...words.field, type: "search", value: words.value, "aria-label": words.label, placeholder: words.label,
                    "aria-describedby": words.rows ? statusId : undefined, enterKeyHint: words.onSubmit ? "search" : undefined,
                    autoComplete: "off", autoCapitalize: "none", spellCheck: false,
                    onChange: event => words.onChange(event.currentTarget.value),
                    onKeyDown: event => { words.field?.onKeyDown?.(event); if (event.defaultPrevented || event.nativeEvent.isComposing) return;
                      if (event.key === "Escape") {
                        if (words.value || words.applied) { event.preventDefault(); event.stopPropagation(); clearField(); }
                        else if (!words.standing) { event.preventDefault(); event.stopPropagation(); closeField(); }
                      } } }}
                  parts={<>{words.onSubmit && words.value !== words.applied ? <span className={styles.enterHint}>enter</span> : null}
                    {words.verbs.map(action => action.kind === "command" ? <Button key={action.id} disabled={action.disabled} onClick={event => {
                      const detail = prepareActionSelect(event, event.currentTarget); if (detail) action.onSelect(detail); }}>{action.label}</Button>
                      : action.kind === "link" && action.href !== null ? <ButtonLink key={action.id} href={action.href}>{action.label}</ButtonLink> : null)}</>} />
                {words.rows ? <div className="sr-only"><PaneFilterRowsStatus id={statusId} status={words.rows.status} query={words.value} announceQueryChanges={words.rows.announce} /></div> : null}
              </FieldRow> : null}
              {query?.kind === "Find" ? (
                <div
                  key={source}
                  className={`${styles.controlRow} ${compact.compact}`}
                  hidden={!findVisible}
                >
                  <FindBar
                      ref={inputRef}
                      find={find}
                      onClear={clearFind}
                      onClose={closeFind}
                      resultsExpanded={state.results?.expanded ?? false}
                      onShowResults={controller.showResults}
                    />
                </div>
              ) : null}
            </div>
          </div>
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
            role={views ? "tabpanel" : undefined}
            aria-labelledby={views && currentView >= 0 && (!isMobile || unfolded) ? `${paneId}-view-${currentView}` : undefined}
            aria-label={views && (currentView < 0 || isMobile && !unfolded) ? views.items[currentView]?.label ?? views.label : undefined}
            className={styles.body}
            data-body-mode={route.bodyMode}
            data-pane-content="true"
            data-pane-refresh-eligible={pull || undefined}
          >
            <div ref={contentRef} className={styles.routeContent}>
              {route.locator !== null && route.id !== "media" && route.id !== "note" && route.id !== "highlight" ? <WholeSourceArrival resourceRef={body?.resourceRef ?? null} paneRef={paneRef} /> : null}
              {children}
            </div>
            {refresh.indicator}
          </div>
          {rail ? <div className={styles.rail}>{rail.body}</div> : null}
          <StageAnchor kind="Pane" paneId={paneId} floor />
        </div>
        {outlineCommands ? <div className={styles.outlineAccessory} style={{marginBottom: commandsBottom}}>
          <OutlineCommands publication={outlineCommands} current={() => {
            const current = chrome.get().outlineCommands;
            return touchCapable && isActive && !hasActiveInteractionOwner() && current?.touchVisible ? current : null;
          }}/>
        </div> : null}
      </div>
      {isMobile || isMaximized ? null : (
        <div className={styles.primaryResizeHandle}>
          <ResizeHandle
            label={`Resize pane ${label}`}
            controls={bodyId}
            widthPx={width.widthPx}
            minWidthPx={width.minWidthPx}
            maxWidthPx={width.maxWidthPx}
            onResize={(widthPx) => resizePrimaryPane(paneId, widthPx)}
          />
        </div>
      )}
      <Companion
        resourceTitle={header.title}
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
      if (target.kind !== "source" || target.source.location.kind !== "resource") return "Unavailable";
      if (context.mayFocus()) paneRef.current?.focus({ preventScroll: true });
      return "Applied";
    },
  });
  const { say, fail } = useOutcome();
  const failure = arrival.failure;
  useEffect(() => {
    if (failure === null) return;
    return failure.error === null ? say({ fact: failure.title }) : fail(failure.error, failure.title);
  }, [failure, say, fail]);
  return null;
}
