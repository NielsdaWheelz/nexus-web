"use client";

// The Nexus session: open/closed, the page state machine, the stable result list, and the
// one activation core every row, choice, keybinding, open request and workflow goes through.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { truncateText } from "@/lib/display/format";
import { chatDraftOwnerId } from "@/lib/chat/drafts";
import { resourceDraftOwnerId } from "@/lib/resourceGraph/useResourceDraft";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { useWorkGuard, type WorkOwner } from "@/lib/unsavedWork";
import { planWorkspaceTarget, type WorkspaceTargetActivationRequest, type WorkspaceTargetActivationResult } from "@/lib/workspace/targetActivation";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { openAsyncResult, type OpenResult } from "@/lib/panes/openResult";
import { apiTransportFeedback, isApiError, outcomeUnknown } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { modeledApiError } from "@/lib/api/serverState";
import { savedSourceReadFailure } from "@/lib/imports/copy";
import { fetchAcceptedSource } from "@/lib/imports/ingest";
import { encodeImportsUrl } from "@/lib/imports/query";
import { createLibrary } from "@/lib/libraries/api";
import { useNexusOpenRequests } from "@/lib/nexus/events";
import {
  PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
  type MaterializedOpenDailyPageTarget,
  type ChoiceReturn,
  type NexusAction,
  type NexusOpenIntent,
  type NexusPage,
  type NexusPane,
  type NexusRow,
  type NexusRootMode,
  type NexusRootOrigin,
  type NexusTarget,
  type NexusTargetActivation,
} from "@/lib/nexus/model";
import { NEXUS_COMMANDS, nexusQueryAction, parseNexusQuery } from "@/lib/nexus/query";
import { candidateRows, choiceRows, EMPTY_LIST, mergeResults, nexusGroups, nexusPanePreview, playbackRow, resourceAction } from "@/lib/nexus/rows";
import { TRANSPORT_CODES, useNexusFind } from "@/lib/nexus/useNexusFind";
import { getWritingRuntime, LocalCommitError } from "@/lib/notes/runtime";
import { captureToday, dailyDateFor } from "@/lib/notes/api";
import { playingEpisode, usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import { useRenderEnvironment, useViewportState } from "@/lib/renderEnvironment/provider";
import { activateResource } from "@/lib/resources/activation";
import { searchQueryToParams } from "@/lib/search/searchParams";
import { matchesShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { getInteractionGeneration, hasActiveInteractionOwner, isTopmostInteractionOwner } from "@/lib/ui/overlay";
import type { DismissDecision, Layer } from "@/lib/ui/overlay";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useLatestWorkspace, useSubscribeWorkspace, useWorkspaceStore, type WorkspaceSelection } from "@/lib/workspace/store";
import { useWorkspacePresentations } from "@/lib/workspace/presentations";
import { resolveAddPanelInitialFocus } from "./AddPanel";
import { useAddContentSession } from "./useAddContentSession";
import { useNexusPaneReorder } from "./useNexusPaneReorder";

const CREATE_CODES = [...TRANSPORT_CODES, "E_FORBIDDEN", "E_LIBRARY_FORBIDDEN", "E_INVALID_REQUEST", "E_RESOURCE_CONFLICT"];
const FORBIDDEN = "This account can’t make that change.";
const CREATE_FAILURE_COPY: Record<string, string | undefined> = {
  E_FORBIDDEN: FORBIDDEN,
  E_LIBRARY_FORBIDDEN: FORBIDDEN,
  E_INVALID_REQUEST: "Review the request and retry.",
  E_NAME_INVALID: "Enter a non-reserved library name between 1 and 100 characters.",
  E_RESOURCE_CONFLICT: "This create request conflicts with another resource.",
  E_NOTE_CONFLICT: "This note was saved before and has since left that day, so it wasn’t added again.",
};

type Dispatchable = Extract<NexusTarget, { kind: "InternalHref" | "PaneOpen" }> | MaterializedOpenDailyPageTarget;
/** What leaving the current page means; leaving Add may first need the user's confirmation. */
type Exit =
  | { readonly kind: "Close" }
  | { readonly kind: "Root" }
  | { readonly kind: "Replace"; readonly intent: NexusOpenIntent; readonly opener: HTMLElement | null }
  | { readonly kind: "Navigate"; readonly target: NexusTarget; readonly activation: NexusTargetActivation };

export type NexusController = ReturnType<typeof useNexusController>;

export function useNexusController() {
  const { ctx } = useActionRuntime();
  const interactionLayer = useRef<Layer | null>(null);
  const [openingSources, setOpeningSources] = useState<ReadonlySet<string>>(() => new Set());
  const { accountId, calendarTimeZone } = useAuthenticatedAccount();
  const captureAttempt = useRef<{ noteId: string; promise: Promise<string>; retry: (() => Promise<unknown>) | null } | null>(null);
  const guard = useWorkGuard();
  const viewport = useViewportState();
  const { platform } = useRenderEnvironment();
  const player = usePlayerSession();
  const playerCommands = usePlayerCommands();
  const addSession = useAddContentSession();
  const workspace = useWorkspaceStore();
  const latestWorkspace = useLatestWorkspace();
  const subscribeWorkspace = useSubscribeWorkspace();
  const { state } = workspace;
  const presentations = useWorkspacePresentations();

  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [composing, setComposing] = useState(false);
  const [page, writePage] = useState<NexusPage>({ kind: "Root" });
  const currentPage = useRef(page);
  const [pageListeners] = useState(() => new Set<() => void>());
  function setPage(change: NexusPage | ((current: NexusPage) => NexusPage)) {
    const next = typeof change === "function" ? change(currentPage.current) : change;
    currentPage.current = next;
    writePage(next);
    for (const listener of pageListeners) listener();
  }
  const pageOwner = useMemo<WorkOwner>(() => ({
    id: "nexus-authoring", scope: { kind: "surface", id: "nexus-authoring" },
    read() {
      const current = currentPage.current;
      const submitted = current.kind === "CreateLibrary" || current.kind === "CaptureToday" ? current.submit : null;
      const text = current.kind === "ChooseCreate" ? current.draft
        : current.kind === "CreateLibrary" ? current.name : current.kind === "CaptureToday" ? current.text : "";
      return { changed: text !== "" && submitted?.kind !== "Acknowledged",
        unconfirmed: submitted?.kind === "Running" || (submitted?.kind === "Retryable" && submitted.unconfirmed), stopsBrowserWork: false };
    },
    subscribe(listener) { pageListeners.add(listener); return () => { pageListeners.delete(listener); }; },
  }), [pageListeners]);
  useLayoutEffect(() => guard.register(pageOwner), [guard, pageOwner]);
  const visible = useRef(open);
  visible.current = open;
  const [rootMode, setRootMode] = useState<NexusRootMode>("Overview");
  const [focusRevision, setFocusRevision] = useState(0);
  const [searchRefreshRevision, setSearchRefreshRevision] = useState(0);
  const [list, setList] = useState(EMPTY_LIST);
  const [announcement, setAnnouncement] = useState("");
  const [panesExpanded, setPanesExpanded] = useState(false);
  const [recentlyClosedExpanded, setRecentlyClosedExpanded] = useState(false);
  const [paneFocus, setPaneFocus] = useState<{ key: string | null; revision: number }>({ key: null, revision: 0 });
  const latestRequestExit = useRef(requestExit);
  latestRequestExit.current = requestExit;
  const [addDefect, setAddDefect] = useState<{ readonly sessionId: string; readonly error: unknown } | null>(null);
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);
  const suppressReturnFocus = useRef(false);
  const handoffPaneId = useRef<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const rootFocus = useRef<string | null>(null);
  const rootScroll = useRef({ Overview: 0, Search: 0 });
  const shell = useRef(viewport.isMobile);
  const transferFocus = useRef<"Field" | "Heading" | "PaneList" | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) presentations.retryTitles();
    wasOpen.current = open;
  }, [open, presentations]);

  const parsed = useMemo(() => parseNexusQuery(query), [query]);
  const lookupGuidance = parsed.intent.kind === "CommandLookup"
    ? `${parsed.intent.head === "/" ? "" : `unknown command: ${truncateText(parsed.intent.head, 32)}. `}choose a command to start empty, or search this text`
    : null;
  const listIdentity = JSON.stringify([accountId, rootMode, viewport.isMobile, query, searchQueryToParams(parsed.searchQuery).toString(), parsed.intent]);
  const finding = open && (!viewport.isMobile || rootMode === "Search");
  const retainedLocalRefs = list.identity === listIdentity ? list.groups.flatMap(group => group.rows).flatMap(row => row.localMatch ? [row.localMatch.resource.ref] : []) : [];
  const find = useNexusFind({ open: finding && !composing, query: parsed, retainedLocalRefs });
  const panes = useMemo<NexusPane[]>(
    () =>
      state.panes.map((pane) => ({
        id: pane.id,
        href: pane.current_visit.href,
        resourceRef: presentations.resourceRefForVisit(pane.current_visit),
        visibility: pane.visibility,
        presentation: presentations.forVisit(pane.current_visit),
        current: pane.id === state.active_primary_pane_id,
      })),
    [presentations, state],
  );

  // Navigation from outside the launcher's own pane commands (such as a resource
  // menu's Open or Chat) closes it so focus can follow the new pane.
  const activePane = state.panes.find((pane) => pane.id === state.active_primary_pane_id);
  const navigationToken = `${state.active_primary_pane_id}\0${activePane?.current_visit.id ?? ""}`;
  const navigationBaseline = useRef(navigationToken);
  useEffect(() => {
    if (open && navigationToken !== navigationBaseline.current) {
      handoffPaneId.current = null;
      suppressReturnFocus.current = true;
      setOpen(false);
    }
    navigationBaseline.current = navigationToken;
  }, [navigationToken, open]);

  // Canonical activation can open the current target without changing its visit.
  // Observe its exact focus request before the destination claims it.
  useLayoutEffect(() => {
    if (!open) return;
    let previous = latestWorkspace().pendingPaneFocus;
    return subscribeWorkspace(() => {
      const current = latestWorkspace();
      const paneId = current.state.active_primary_pane_id;
      const request = current.pendingPaneFocus;
      const prior = previous;
      previous = request;
      if (!request || request === prior || request.paneId !== paneId ||
        request.visitId !== current.state.panes.find((pane) => pane.id === paneId)?.current_visit.id) return;
      handoffPaneId.current = null;
      suppressReturnFocus.current = true;
      setOpen(false);
    });
  }, [latestWorkspace, open, subscribeWorkspace]);

  function keepWorkspaceSelection(selection: WorkspaceSelection): WorkspaceSelection {
    navigationBaseline.current = `${selection.paneId}\0${selection.visitId}`;
    return selection;
  }

  // Reopening a closed pane is management, with its local focus handoff after closure.
  useEffect(() => {
    if (open || handoffPaneId.current === null) return;
    const paneId = handoffPaneId.current;
    handoffPaneId.current = null;
    const focused = document.activeElement;
    const generation = getInteractionGeneration();
    const frame = requestAnimationFrame(() => {
      if (getInteractionGeneration() !== generation || hasActiveInteractionOwner() || latestWorkspace().state.active_primary_pane_id !== paneId) return;
      const current = document.activeElement;
      if (current !== focused && current instanceof HTMLElement &&
        current !== document.body && current.isConnected && !current.closest("[hidden], [inert]")) return;
      const target = viewport.isMobile
        ? findPaneLandmarkFocusTarget(paneId)
        : findPaneChromeFocusTarget(paneId);
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [latestWorkspace, open, viewport.isMobile]);

  const playback = useMemo(() => player.state.kind === "Loaded" && player.state.phase === "Paused" ? playingEpisode(player.state) : null, [player.state]);
  useLayoutEffect(() => {
    if (!open || page.kind !== "Root") return;
    setList(previous => {
      const retained = previous.identity === listIdentity ? previous.groups.flatMap(group => group.rows) : [];
      const composed = candidateRows({
        query: parsed, panes, frecency: find.frecency, preview: find.preview,
        reference: find.reference, referenceFailed: find.referenceFailed,
        local: find.local, localReference: find.localReference, localReferenceMissing: find.localReferenceMissing,
        retained, missingLocal: find.missingLocal,
      });
      const incoming = nexusGroups({ desktop: !viewport.isMobile, mobileMode: rootMode, query: parsed,
        results: composed.rows, panes, panesExpanded,
        playback: playback && playbackRow(playback.title, playback.subtitle !== null ? playback.subtitle : undefined),
        recent: find.recent, frecency: find.frecency,
      });
      const removed = new Set([...find.missingLocal].map(ref => `Resource:${ref}`));
      for (const row of retained) {
        if (row.action.kind === "Available" && row.action.target.kind === "PaneOpen"
          && !panes.some(pane => row.action.kind === "Available" && row.action.target.kind === "PaneOpen" && pane.id === row.action.target.paneId)) removed.add(row.key);
        if (row.action.kind === "Available" && row.action.target.kind === "ResumeCurrentPlayback" && playback === null) removed.add(row.key);
      }
      return mergeResults(previous, listIdentity, incoming, composed.updates, removed);
    });
  }, [open, page.kind, listIdentity, parsed, panes, panesExpanded, viewport.isMobile, rootMode, playback, find.frecency, find.preview, find.reference, find.referenceFailed, find.local, find.localReference, find.localReferenceMissing, find.missingLocal, find.recent, searchRefreshRevision]);
  const groups = list.identity === listIdentity ? list.groups : [];
  const rows = groups.flatMap((group) => group.rows);
  const paneRows = groups.find((group) => group.id === "Open")?.rows ?? [];
  const paneListPresented = open && page.kind === "Root" && (viewport.isMobile ? rootMode === "Overview" : parsed.text.length === 0);
  const paneListComplete = paneListPresented && paneRows.length === panes.length && paneRows.every((row, index) => row.key === `Pane:${panes[index]!.id}`);
  const panePreviewCount = nexusPanePreview(panes, viewport.isMobile).length;
  const searchContext = JSON.stringify([accountId, query, rootMode]);
  function requestPaneFocus(key: string | null) {
    if (key?.startsWith("Pane:")) setActive(key);
    setPaneFocus((current) => ({ key, revision: current.revision + 1 }));
  }
  const reorder = useNexusPaneReorder({
    open, eligible: paneListComplete && panes.length >= 2, isMobile: viewport.isMobile,
    panes, interactionLayer, announce: setAnnouncement, focus: requestPaneFocus,
  });
  // Capture focus before the retiring shell disappears. The desktop query also
  // owns pane browsing; arranging panes does not imply mobile text entry.
  if (shell.current !== viewport.isMobile) {
    if (open) {
      if (page.kind === "Root" && (reorder.placement !== null || reorder.draggingPaneId !== null)) {
        transferFocus.current = "PaneList";
        rootFocus.current = `Pane:${reorder.placement?.kind === "ChoosePosition" ? reorder.placement.paneId : reorder.draggingPaneId ?? state.active_primary_pane_id}`;
      } else transferFocus.current = document.activeElement?.matches("input, textarea, [contenteditable=true]") ? "Field" : "Heading";
    }
    shell.current = viewport.isMobile;
  }
  useLayoutEffect(() => {
    if (!transferFocus.current || page.kind !== "Root") return;
    if (viewport.isMobile) setRootMode(transferFocus.current === "PaneList" ? "Overview" : "Search");
  }, [viewport.isMobile, page.kind]);
  const candidates = reorder.placement === null ? rows : paneRows;
  const admitted = paneListPresented || finding && list.identity === listIdentity;
  const previousActive = list.active?.context === searchContext ? list.active : null;
  const explicit = candidates.find(row => row.rank.tier === "ExplicitIntent");
  const initialKey = parsed.intent.kind === "CommandLookup" ? null : explicit?.key
    ?? candidates.find(row => row.action.kind === "Available" && !row.key.startsWith("Continuation:"))?.key
    ?? candidates.find(row => row.key === "Continuation:SeeAll" && row.action.kind === "Available")?.key ?? null;
  const desiredKey = !admitted ? null : !list.moved ? initialKey
    : previousActive?.key !== null && candidates.some(row => row.key === previousActive?.key) ? previousActive?.key ?? null : null;
  const currentActive = !admitted ? null : previousActive?.key === desiredKey ? previousActive : { context: searchContext, key: desiredKey };
  if (currentActive !== list.active) setList({ ...list, active: currentActive });
  const activeKey = currentActive?.key ?? null;

  function activate(action: NexusAction, activation: NexusTargetActivation, row?: NexusRow) {
    if (reorder.placement !== null && action.kind === "Available" && action.target.kind === "PaneOpen") {
      if (activation.disposition.kind === "Fork") return;
      if (reorder.placement.kind === "ChoosePane") reorder.choosePane(action.target.paneId);
      else reorder.place(reorder.placement.paneIds.indexOf(action.target.paneId) + 1);
      return;
    }
    if (action.kind === "Unavailable") { setAnnouncement(action.reason); return; }
    if (row?.localMatch && (find.missingLocal.has(row.localMatch.resource.ref)
      || !find.local.some(match => match.resource.ref === row.localMatch?.resource.ref) && !find.localValidationReady)) {
      setAnnouncement(find.missingLocal.has(row.localMatch.resource.ref) ? "selection no longer available" : "checking availability…");
      return;
    }
    const current = currentPage.current;
    run(action.target, (current.kind === "UseText" || current.kind === "ChooseCreate" || current.kind === "ChooseBrowse") && current.activation.disposition.kind === "Fork" ? current.activation : activation, row);
  }

  function sourceOwnerIds(target: NexusTarget | null = null): readonly string[] {
    const current = currentPage.current;
    if (current.kind === "Add") return addSession.workOwnerIds;
    if (current.kind === "Root" || current.kind === "ChooseBrowse" || current.kind === "UseText") return [];
    if (current.kind === "ChooseCreate" && target !== null) {
      const transferred = target.kind === "CreatePage" ? target.titleDraft
        : target.kind === "CreateLibrary" ? target.nameDraft
          : target.kind === "InternalHref" && target.entry?.kind === "ComposeChat" ? target.entry.text
            : target.kind === "InternalHref" && target.entry?.kind === "ComposePage" ? target.entry.title
              : target.kind === "OpenDailyPage" && target.entry.kind === "AppendNote" ? target.entry.initialText : null;
      if (transferred === current.draft) return [];
    }
    return [pageOwner.id];
  }

  function dispatch(target: Dispatchable, activation: NexusTargetActivation, discardOwnerIds: readonly string[]): WorkspaceTargetActivationResult | null {
    if (target.kind === "PaneOpen") {
      return workspace.activateWorkspacePane({ paneId: target.paneId, disposition: activation.disposition, discardOwnerIds });
    }
    const request: WorkspaceTargetActivationRequest = target.kind === "OpenDailyPage" ? {
      originPaneId: state.active_primary_pane_id, target: { href: `/daily/${target.date.value}` },
      disposition: activation.disposition,
      ...(target.entry.kind === "View" ? {} : { entry: target.entry }),
    } : {
      originPaneId: state.active_primary_pane_id,
      target: { href: target.href, labelHint: target.labelHint, secondaryActivation: target.secondaryActivation },
      disposition: activation.disposition, entry: target.entry,
    };
    const ownerIds = [...discardOwnerIds];
    if (request.entry?.kind === "ComposeChat" || request.entry?.kind === "ComposePage") {
      const plan = planWorkspaceTarget(state, workspace.dailyPageByPaneId, request);
      if (plan.kind !== "CreatedPane") {
        if (request.entry.kind === "ComposeChat") ownerIds.push(chatDraftOwnerId(accountId, plan.paneId, "new"));
        else if (plan.kind === "Unchanged" || plan.kind === "ActivatedExisting") {
          const visit = state.panes.find(pane => pane.id === plan.paneId)!.current_visit;
          ownerIds.push(resourceDraftOwnerId(JSON.stringify([visit.id, resolvePaneRouteModel(visit.href).routeKey]), "Notes.NewPage"));
        }
      }
    }
    return workspace.activateWorkspaceTarget({ ...request, discardOwnerIds: ownerIds });
  }

  function finishNavigation(focusPaneId: string | null): void {
    visible.current = false;
    handoffPaneId.current = focusPaneId;
    suppressReturnFocus.current = true;
    addSession.discard();
    setPage({ kind: "Root" });
    setOpen(false);
  }

  function rootOrigin(row: NexusRow | undefined): NexusRootOrigin {
    const control = row?.key === "QuickAction:New" ? "New"
      : row?.key === "Continuation:UseText" ? "Continuation:UseText"
        : row?.key ?? "Search";
    return { mode: !open ? "Overview" : rootMode, control };
  }

  function choiceReturn(row: NexusRow | undefined, activation: NexusTargetActivation): ChoiceReturn {
    return page.kind === "UseText" ? { ...page, activation } : { kind: "Root", origin: rootOrigin(row) };
  }

  /** The one activation core. */
  function run(target: NexusTarget, activation: NexusTargetActivation, row?: NexusRow): WorkspaceTargetActivationResult | null {
    reorder.cancel({ silent: true });
    if (target.kind !== "InternalHref" && target.kind !== "PaneOpen" && target.kind !== "OpenDailyPage" &&
      target.kind !== "Resource" && target.kind !== "OpenAcceptedSource" && target.kind !== "CreatePage" &&
      !guard.confirmLoss({ scopes: [], ownerIds: sourceOwnerIds(target) })) return { kind: "Cancelled" };
    switch (target.kind) {
      case "Resource": {
        let result: WorkspaceTargetActivationResult | null = null;
        activateResource(target.activation, {
          labelHint: target.label, disposition: activation.disposition,
          activateTarget: ({ target: resource, disposition }) => result = run({ kind: "InternalHref", ...resource }, { disposition }, row),
        });
        return result;
      }
      case "OpenAcceptedSource":
        openAcceptedSource(target, activation);
        return null;
      case "OpenAdd":
        setPage({ kind: "Add", sessionId: addSession.start(target.seed) });
        setOpen(true);
        return null;
      case "CreatePage":
        return run({ kind: "InternalHref", href: "/pages/new", ...(target.titleDraft ? { entry: { kind: "ComposePage", title: target.titleDraft } as const } : {}) }, activation, row);
      case "CreateLibrary":
        setPage({ kind: "CreateLibrary", libraryId: crypto.randomUUID(), name: target.nameDraft, activation, submit: { kind: "Ready" }, returnTo: page.kind === "ChooseCreate" ? page : choiceReturn(row, activation) });
        setOpen(true);
        return null;
      case "UseText":
        setPage({ kind: "UseText", text: target.text, origin: rootOrigin(row), activation });
        setOpen(true);
        return null;
      case "ChooseCreate":
        setPage({ kind: "ChooseCreate", draft: target.initialDraft, returnTo: choiceReturn(row, activation), activation });
        setOpen(true);
        return null;
      case "ChooseBrowse":
        setPage({ kind: "ChooseBrowse", query: target.query, returnTo: choiceReturn(row, activation), activation });
        setOpen(true);
        return null;
      case "ResumeCurrentPlayback":
        playerCommands.resume();
        finishNavigation(null);
        return null;
    }
    const text = target.kind === "OpenDailyPage" && target.entry.kind === "AppendNote" ? target.entry.initialText.trim() : "";
    if (target.kind === "OpenDailyPage" && text) {
      if (!guard.confirmLoss({ scopes: [], ownerIds: sourceOwnerIds(target) })) return { kind: "Cancelled" };
      const localDate = dailyDateFor(target.date, calendarTimeZone);
      // the launcher waits on the capture; the query and its search are done with.
      setQueryState("");
      setList(EMPTY_LIST);
      capture({ kind: "CaptureToday", text, noteId: crypto.randomUUID(), localDate, activation, submit: { kind: "Running", unconfirmed: false } });
      setOpen(true);
      return null;
    }
    const materialized: Dispatchable =
      target.kind === "OpenDailyPage"
        ? {
            kind: "OpenDailyPage",
            date: { kind: "LocalDate", value: dailyDateFor(target.date, calendarTimeZone) },
            entry: target.entry.kind === "View" ? target.entry : { kind: "AppendNote" },
          }
        : target;
    const result = dispatch(materialized, activation, sourceOwnerIds(target));
    if (!result || result.kind === "Cancelled") return result;
    setAnnouncement("");
    finishNavigation(null);
    if (!row?.source) return result;
    const pane = materialized.kind === "PaneOpen" ? panes.find((pane) => pane.id === materialized.paneId)! : null;
    const href = materialized.kind === "InternalHref" ? materialized.href : pane?.href ?? null;
    let settledLabel: string | null = row.label;
    if (pane) {
      const visit = state.panes.find((candidate) => candidate.id === pane.id)!.current_visit;
      settledLabel = visit.title_hint ?? (pane.presentation.status === "Ready" ? pane.presentation.title : null);
    }
    if (href && settledLabel !== null) find.remember({ query: parsed.text || null, target_href: href, label_snapshot: settledLabel, source: row.source });
    return result;
  }

  function openAcceptedSource(target: Extract<NexusTarget, { kind: "OpenAcceptedSource" }>, activation: NexusTargetActivation) {
    if (openingSources.has(target.sourceAttemptId)) return;
    setOpeningSources(current => new Set(current).add(target.sourceAttemptId));
    const originPaneId = latestWorkspace().state.active_primary_pane_id;
    const initiatingPage = currentPage.current;
    const fromLauncher = visible.current;
    const signal = ctx.sessionSignal();
    void openAsyncResult({
      ctx, originPaneId, intent: activation.disposition.kind === "Fork" ? "new_pane" : "default",
      subject: target.label,
      mayOpen: () => !fromLauncher || (visible.current && currentPage.current === initiatingPage),
      discardOwnerIds: fromLauncher ? sourceOwnerIds() : [],
      onOpened: () => { if (fromLauncher && currentPage.current === initiatingPage) finishNavigation(null); },
      create: async () => {
        const source = await fetchAcceptedSource(target.sourceAttemptId, signal);
        if (target.destination === "media") return {
          target: { href: source.settled ? `/media/${source.media_id}`
            : `/media/${source.media_id}?source_attempt_id=${encodeURIComponent(target.sourceAttemptId)}` },
          title: "item available", openLabel: "open",
        };
        return { target: source.settled
          ? { href: `/imports?${encodeImportsUrl({ selected: source.import_ref })}`, secondaryActivation: { surfaceId: "import-detail" } }
          : { href: `/imports?${encodeImportsUrl({ view: "InProgress" })}` },
        title: "import ready to open", openLabel: "view import" };
      },
    }).catch(error => {
      if (signal.aborted) return;
      const failure = modeledApiError(error, ctx.reportDefect);
      if (failure === null) return;
      ctx.feedback.receipt(savedSourceReadFailure(failure), { label: "retry", onClick: intent => {
        if (!signal.aborted) latestRequestExit.current({ kind: "Navigate", target, activation: intent === "new_pane" ? { disposition: { kind: "Fork" } } : activation });
      } });
    }).catch(error => ctx.reportDefect({ error })).finally(() => setOpeningSources(current => {
      const next = new Set(current);
      next.delete(target.sourceAttemptId);
      return next;
    }));
  }

  /** Quick note with text: one append to the day, then the day at that note (the
   * launcher keeps the text with Retry, under the same note id, when it fails). */
  function capture(running: Extract<NexusPage, { kind: "CaptureToday" }>) {
    void openCreated(running, async () => {
      if (captureAttempt.current?.noteId !== running.noteId) captureAttempt.current = {noteId:running.noteId,promise:captureToday(getWritingRuntime(accountId),running.localDate,running.noteId,running.text),retry:null};
      else if (captureAttempt.current.retry) { captureAttempt.current.promise=captureAttempt.current.retry().then(()=>"");captureAttempt.current.retry=null; }
      await captureAttempt.current.promise;
      return { target: { href: `/daily/${running.localDate}` }, title: "note saved on this device", openLabel: "open today",
        entry: { kind: "FocusNote", noteBlockId: running.noteId } };
    }).catch((error: unknown) => {
        if (currentPage.current !== running || ctx.sessionSignal().aborted) return;
        if (error instanceof LocalCommitError) {
          if(captureAttempt.current?.noteId===running.noteId)captureAttempt.current.retry=error.retry;
          setPage({...running,submit:{kind:"Retryable",content:{tone:"Warning",title:"couldn’t save on this device",message:"keep this page open. retry saving."},unconfirmed:false}});
          return;
        }
        const content = createFailure(error, "Note wasn’t added to Today", [...CREATE_CODES, "E_NOTE_CONFLICT"], running.submit.kind === "Running" && running.submit.unconfirmed);
        if (content) setPage({ ...running, submit: { kind: "Retryable", content, unconfirmed: (running.submit.kind === "Running" && running.submit.unconfirmed) || outcomeUnknown(error) } });
      });
  }

  function openCreated(
    running: Extract<NexusPage, { kind: "CreateLibrary" | "CaptureToday" }>,
    create: () => Promise<OpenResult>,
  ) {
    let livePage: NexusPage = running;
    visible.current = true;
    setPage(running);
    const originPaneId = latestWorkspace().state.active_primary_pane_id;
    return openAsyncResult({
      ctx, originPaneId, intent: running.activation.disposition.kind === "Fork" ? "new_pane" : "default",
      subject: running.kind === "CreateLibrary" ? running.name : running.text,
      initiatingLayer: interactionLayer.current,
      mayOpen: () => visible.current && currentPage.current === livePage,
      discardOwnerIds: [pageOwner.id],
      onOpened: () => { if (currentPage.current === livePage) finishNavigation(null); },
      create: async () => {
        const result = await create();
        if (currentPage.current === running && !ctx.sessionSignal().aborted) {
          livePage = { ...running, submit: { kind: "Acknowledged", content: { tone: "Success", title: result.title } } };
          setPage(livePage);
        }
        return result;
      },
    });
  }

  /** Nexus copy for an expected create failure; anything else becomes a workspace defect. */
  function createFailure(error: unknown, title: string, codes: readonly string[], unconfirmed: boolean): FeedbackContent | null {
    if (handleUnauthenticatedApiError(error)) return null;
    if (isApiError(error)) {
      const transport = apiTransportFeedback(error, title);
      if (transport !== null) return transport;
    }
    if (isApiError(error) && codes.includes(error.code)) {
      if (unconfirmed || outcomeUnknown(error)) return {
        tone: "Warning", title: "request unconfirmed",
        message: "it may already have started work. retry sends the same request. accepted server work is not cancelled.",
        requestId: error.requestId,
      };
      const message = CREATE_FAILURE_COPY[error.code];
      if (message !== undefined) return { tone: "Danger", title, message, requestId: error.requestId };
    }
    // justify-defect: creation admits only declared outcomes with complete feedback.
    setDefect({ error });
    return null;
  }

  function submitLibrary(intent: OpenIntent) {
    if (page.kind !== "CreateLibrary" || page.submit.kind === "Running" || !page.name.trim()) return;
    const running = { ...page, name: page.name.trim(), activation: intent === "new_pane" ? { disposition: { kind: "Fork" } } as const : page.activation,
      submit: { kind: "Running", content: page.submit.kind === "Retryable" ? page.submit.content : undefined,
        unconfirmed: page.submit.kind === "Retryable" && page.submit.unconfirmed } } as const;
    void openCreated(running, async () => {
      const library = await createLibrary({ id: running.libraryId, name: running.name, initial_items: [], expected_removal_revision: null });
      return { target: { href: `/libraries/${library.id}`, labelHint: library.name }, title: "library created", openLabel: "open library" };
    }).catch((error: unknown) => {
        if (currentPage.current !== running || ctx.sessionSignal().aborted) return;
        const content = createFailure(error, "Library couldn’t be created", [...CREATE_CODES, "E_NAME_INVALID"], running.submit.unconfirmed);
        if (content) setPage({ ...running, submit: { kind: "Retryable", content, unconfirmed: (running.submit.kind === "Running" && running.submit.unconfirmed) || outcomeUnknown(error) } });
      });
  }

  function guardExit(exit: Exit): DismissDecision {
    return exit.kind === "Navigate" || guard.confirmLoss({ scopes: [], ownerIds: sourceOwnerIds() }) ? "accepted" : "blocked";
  }

  function performExit(exit: Exit): WorkspaceTargetActivationResult | null {
    if (exit.kind === "Navigate") return run(exit.target, exit.activation);
    reorder.cancel({ silent: true });
    setAnnouncement("");
    if (exit.kind === "Replace") { openIntent(exit.intent, exit.opener); return null; }
    addSession.discard();
    setPage({ kind: "Root" });
    if (exit.kind === "Close") { visible.current = false; setOpen(false); }
    return null;
  }

  function requestExit(exit: Exit): boolean {
    if (guardExit(exit) !== "accepted") return false;
    return performExit(exit)?.kind !== "Cancelled";
  }

  /** An open request resets to Root or Add. */
  function openIntent(intent: NexusOpenIntent, trigger: HTMLElement | null) {
    reorder.cancel({ silent: true });
    setPanesExpanded(false);
    setRecentlyClosedExpanded(false);
    if (!open) {
      opener.current = trigger ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
      rootScroll.current = { Overview: 0, Search: 0 };
      suppressReturnFocus.current = false;
      transferFocus.current = null;
    }
    rootFocus.current = null;
    setRootMode("Overview");
    const nextPage: NexusPage = intent.kind === "Add"
      ? { kind: "Add", sessionId: addSession.start(intent.seed) }
      : { kind: "Root" };
    if (intent.kind !== "Add") addSession.discard();
    setQueryState("");
    setList(EMPTY_LIST);
    setPage(nextPage);
    setOpen(true);
    if (intent.kind === "QuickAction") activate(NEXUS_COMMANDS[intent.actionId].action(""), PROGRAMMATIC_NEXUS_TARGET_ACTIVATION);
  }

  function setQuery(next: string) {
    reorder.cancel({ restoreFocus: false });
    if (reorder.placement === null && reorder.draggingPaneId === null) setAnnouncement("");
    setQueryState(next);
    if (viewport.isMobile) setRootMode("Search");
    if (next !== query) rootScroll.current.Search = 0;
  }

  function setActive(key: string) {
    if (reorder.placement !== null && !paneRows.some((row) => row.key === key)) return;

    setList((current) => current.active?.context === searchContext && current.active.key === key && current.moved
      ? current : { ...current, active: { context: searchContext, key }, moved: true });

  }

  function back() {
    if (reorder.cancel()) return;
    const exit: Exit = { kind: page.kind === "Add" ? "Close" : "Root" };
    if (guardExit(exit) !== "accepted") return;
    setAnnouncement("");
    if (page.kind === "Add") { performExit(exit); return; }
    if (page.kind === "CreateLibrary" && page.returnTo.kind === "ChooseCreate") {
      rootFocus.current = "Choice:library";
      return setPage(page.returnTo);
    }
    const destination = page.kind === "ChooseCreate" || page.kind === "ChooseBrowse" || page.kind === "CreateLibrary" ? page.returnTo
      : page.kind === "UseText" ? { kind: "Root" as const, origin: page.origin } : null;
    if (destination?.kind === "UseText") {
      rootFocus.current = page.kind === "ChooseBrowse" ? "Choice:browse…" : "Choice:create…";
      setPage(destination);
      return;
    }
    if (destination?.kind === "Root") {
      setRootMode(destination.origin.mode);
      rootFocus.current = destination.origin.control;
      if (destination.origin.control === "Continuation:UseText") setActive("Continuation:UseText");
    }
    performExit(exit);
  }

  function escape() {
    if (reorder.cancel()) return;
    if (page.kind !== "Root") back();
    else if (viewport.isMobile && rootMode === "Search") {
      rootFocus.current = null;
      setRootMode("Overview");
    }
    else if (viewport.isMobile) requestExit({ kind: "Close" });
    else requestExit({ kind: "Close" });
  }

  function restoreClosed(paneId: string) {
    reorder.cancel({ silent: true });
    if (workspace.restoreClosedPane(paneId) === "cancelled") return;
    finishNavigation(paneId);
  }

  function closePane(paneId: string) {
    reorder.cancel({ silent: true });
    if (!latestWorkspace().state.panes.some((pane) => pane.id === paneId)) return null;
    const keys = rows.filter((row) => !paneListPresented || row.key.startsWith("Pane:")).map((row) => row.key);
    const row = rows.find((row) => row.secondary?.kind === "ClosePane" ? row.secondary.paneId === paneId
      : row.secondary?.kind === "ResourceMenu" && row.secondary.closePanes.some((pane) => pane.id === paneId));
    const index = keys.indexOf(row?.key ?? `Pane:${paneId}`);
    const following = [...(row?.secondary?.kind === "ResourceMenu" ? [row.key] : []), ...keys.slice(index + 1), ...keys.slice(0, index).reverse()];
    const selection = workspace.closePane(paneId);
    if (selection === null) return null;
    const selected = keepWorkspaceSelection(selection);
    const live = latestWorkspace().state.panes;
    const displayed = (panesExpanded ? live : nexusPanePreview(live.map((pane) => ({
      id: pane.id, visibility: pane.visibility, current: pane.id === selected.paneId,
    })), viewport.isMobile)).map((pane) => `Pane:${pane.id}`);
    const next = following.find((key) => paneListPresented ? displayed.includes(key)
      : !key.startsWith("Pane:") || live.some((pane) => `Pane:${pane.id}` === key))
      ?? (paneListPresented ? displayed[0] ?? null : null);
    if (next !== null) setActive(next);
    requestPaneFocus(next);
    return selected;
  }

  const keydown = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keydown.current = (event) => {
    if (!matchesShortcut(SHORTCUTS["Nexus.Open"], event, platform)) return;
    if (hasActiveInteractionOwner() && !isTopmostInteractionOwner("Nexus")) return;
    event.preventDefault();
    if (event.repeat) return;
    if (!open) {
      requestExit({ kind: "Replace", intent: { kind: "Root" }, opener: null });
      if (viewport.isMobile) {
        rootFocus.current = "Search";
        setRootMode("Search");
      }
    } else if (page.kind === "Root" && viewport.isMobile) {
      rootFocus.current = "Search";
      setRootMode("Search");
      setFocusRevision((value) => value + 1);
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keydown.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  useNexusOpenRequests((intent, opener) => requestExit({ kind: "Replace", intent, opener }), viewport.hydrated);
  useEffect(() => {
    if (open) suppressReturnFocus.current = false;
  }, [open]);

  if (defect) throw defect.error;
  const resultsHeld = list.identity === listIdentity && list.pending;
  const titlesFailed = panes.some(pane => pane.presentation.status === "Failed");
  const noticeText = [find.progress.kind === "Notice" ? find.progress.text : null, resultsHeld ? "search update ready" : null,
    find.recentRead.error !== null ? "couldn’t load recent picks" : null, titlesFailed ? "pane titles unavailable" : null, lookupGuidance].filter(Boolean).join(" ") || null;
  return {
    interactionLayer,
    open,
    isMobile: viewport.isMobile,
    hydrated: viewport.hydrated,
    query,
    page,
    rootMode,
    rootScroll,
    groups,
    activeKey,
    choices: choiceRows(page),
    explicitIntent: parsed.intent.kind !== "Search",
    lookupGuidance,
    failures: find.failures,
    recentRead: find.recentRead,
    searchProgress: find.progress,
    resultsHeld,
    noticeText,
    searchUnavailable: find.searchUnavailable,
    searchRefreshRevision,
    interact: () => setList(current => current.identity === listIdentity && !current.moved ? { ...current, moved: true } : current),
    setComposing(value: boolean) {
      if (value) reorder.cancel({ restoreFocus: false });
      setComposing(value);
    },
    refreshResults: () => {
      setSearchRefreshRevision(current => current + 1);
      setList(EMPTY_LIST);
      setFocusRevision(current => current + 1);
      rootScroll.current.Search = 0;
    },
    retrySearch: find.retrySearch,
    retryRelated: find.retryRelated,
    retrying: find.retrying,
    busy: find.busy,
    pending: find.pending,
    announcement,
    dialogLabel: page.kind === "Add" ? "Add content" : viewport.isMobile ? page.kind === "Root" ? rootMode === "Overview" ? "workspace" : "search" : "workspace task" : "Nexus",
    focusKey: page.kind === "Add" ? addSession.state.sessionId : `${page.kind}:${rootMode}:${focusRevision}`,
    addSession,
    openingSources,
    addDefect: addDefect?.sessionId === addSession.state.sessionId,
    panes,
    panesExpanded,
    recentlyClosedExpanded,
    paneListPresented,
    paneListComplete,
    panePreviewCount,
    paneFocusKey: paneFocus.key,
    paneFocusRevision: paneFocus.revision,
    reorder,
    togglePanesExpanded() {
      reorder.cancel();
      if (panesExpanded) requestPaneFocus("PanesDisclosure");
      setPanesExpanded((expanded) => !expanded);
    },
    toggleRecentlyClosed() {
      reorder.cancel({ silent: true });
      if (recentlyClosedExpanded) requestPaneFocus("RecentlyClosedDisclosure");
      setRecentlyClosedExpanded((expanded) => !expanded);
    },
    titlesFailed,
    retryTitles: presentations.retryTitles,
    closedPanes: workspace.recentlyClosedPanes.map((snapshot) => ({
      id: snapshot.pane.id,
      presentation: presentations.forVisit(snapshot.pane.current_visit),
    })),
    setQuery,
    enterSearch: () => { reorder.cancel({ restoreFocus: false }); setRootMode("Search"); },
    submitInput(activation: NexusTargetActivation) {
      if (!viewport.isMobile) {
        if (currentActive?.key == null) { setAnnouncement("selection no longer available"); return; }
        if (!admitted) return;
        const selected = rows.find(row => row.key === currentActive.key);
        if (selected) activate(selected.action, activation, selected);
        return;
      }
      if (lookupGuidance !== null) { setAnnouncement(lookupGuidance); return; }
      if (parsed.intent.kind === "Resource") {
        const local = find.localReference;
        if (local !== null) {
          if (local.href === null) setAnnouncement("source unavailable");
          else run({ kind: "InternalHref", href: local.href, labelHint: local.label }, activation);
          return;
        }
        if (find.reference === null) return;
        activate(resourceAction(find.reference), activation);
        return;
      }
      const action = nexusQueryAction(parsed);
      if (action !== null) activate(action, activation);
    },
    setActive,
    retry: find.retry,
    activate,
    /** Explicit destination controls capture their own gesture, through the Add guard. */
    openTarget: (target: NexusTarget, activation: NexusTargetActivation = PROGRAMMATIC_NEXUS_TARGET_ACTIVATION) => requestExit({ kind: "Navigate", target, activation }),
    openAddTarget: (target: NexusTarget, intent: OpenIntent) => requestExit({ kind: "Navigate", target, activation: intent === "new_pane" ? { disposition: { kind: "Fork" } } : PROGRAMMATIC_NEXUS_TARGET_ACTIVATION }),
    back,
    escape,
    close: () => requestExit({ kind: "Close" }),
    openRoot: () => requestExit({ kind: "Replace", intent: { kind: "Root" }, opener: null }),
    /** Native keyboard dismissal precedes this task-owned Back transition. */
    guardClose(): DismissDecision {
      if (reorder.cancel()) return "blocked";
      if (page.kind === "Add") return guardExit({ kind: "Close" });
      if (viewport.isMobile && page.kind === "Root" && rootMode === "Search") {
        escape();
        return "blocked";
      }
      if (page.kind !== "Root") {
        back();
        return "blocked";
      }
      return guardExit({ kind: "Close" });
    },
    dismissAccepted: () => performExit({ kind: "Close" }),
    stopAddForReview(): boolean {
      if (!guard.confirmLoss({ scopes: [], ownerIds: addSession.workOwnerIds })) return false;
      addSession.stop();
      return true;
    },
    suppressReturnFocus: () => suppressReturnFocus.current || shell.current !== viewport.isMobile,
    returnFocusTo: () => opener.current,
    returnFocusFallback: () => findPaneLandmarkFocusTarget(state.active_primary_pane_id),
    initialFocus(container: HTMLElement): HTMLElement | null {
      const transfer = transferFocus.current;
      transferFocus.current = null;
      if (transfer === "PaneList") {
        const key = rootFocus.current;
        rootFocus.current = null;
        if (key !== null) setActive(key);
        if (!viewport.isMobile) return container.querySelector<HTMLElement>('[role="combobox"]');
        return [...container.querySelectorAll<HTMLElement>("[data-nexus-control]")].find((node) => node.dataset.nexusControl === key)
          ?? container.querySelector<HTMLElement>("[data-switchboard-heading]");
      }
      if (transfer === "Heading") return container.querySelector<HTMLElement>("[data-switchboard-heading], [data-add-heading]");
      if (page.kind === "Add") {
        return resolveAddPanelInitialFocus(container, transfer === "Field" ? false : viewport.isMobile);
      }
      const control = rootFocus.current;
      rootFocus.current = null;
      if (control && (viewport.isMobile || page.kind !== "Root")) {
        const target = [...container.querySelectorAll<HTMLElement>("[data-nexus-control]")].find((node) => node.dataset.nexusControl === control);
        if (target) return target;
      }
      return container.querySelector<HTMLElement>(
        page.kind === "CreateLibrary"
          ? "[data-switchboard-library-name]"
          : page.kind !== "Root"
            ? "[data-switchboard-heading]"
            : viewport.isMobile
              ? rootMode === "Search" ? "[data-mobile-nexus-search]" : "[data-switchboard-heading]"
              : '[role="combobox"]',
      );
    },
    setLibraryName(name: string) {
      const current = currentPage.current;
      if (current.kind !== "CreateLibrary" || current.submit.kind === "Running" || name === current.name) return;
      if (current.submit.kind === "Retryable" && current.submit.unconfirmed &&
        !guard.confirmLoss({ scopes: [], ownerIds: [pageOwner.id] })) return;
      setPage({
        ...current,
        name,
        libraryId: current.submit.kind === "Retryable" || current.submit.kind === "Acknowledged" ? crypto.randomUUID() : current.libraryId,
        submit: { kind: "Ready" },
      });
    },
    submitLibrary,
    retryCapture: (intent: OpenIntent) => page.kind === "CaptureToday" && page.submit.kind === "Retryable" && capture({ ...page, activation: intent === "new_pane" ? { disposition: { kind: "Fork" } } : page.activation, submit: { kind: "Running", content: page.submit.content, unconfirmed: page.submit.unconfirmed } }),
    reportAddDefect(error: unknown) {
      console.error("Add content contract failed:", error);
      setAddDefect({ sessionId: addSession.state.sessionId, error });
    },
    clearAddDefect: () => setAddDefect(null),
    closePane,
    restoreClosedPane: restoreClosed,
    activateAdjacentPane(input: Parameters<typeof workspace.activateAdjacentPane>[0]) {
      reorder.cancel({ silent: true });
      return workspace.activateAdjacentPane(input);
    },
  };
}
