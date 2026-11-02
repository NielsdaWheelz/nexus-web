"use client";

// The Nexus session: open/closed, the page state machine, the list (list.ts holds its bands and
// arming), the most-recently-active pane order, the rail state, and the one activation core every
// row, verb, keybinding, open request and workflow goes through.
import { useRecent } from "@/lib/recent/store";
import { recentTargetKey } from "@/lib/recent/model";
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
import { arrive, EMPTY, fireTarget, keystroke, remove, select } from "@/lib/nexus/list";
import {
  PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
  type MaterializedOpenDailyPageTarget,
  type ChoiceReturn,
  type NexusAction,
  type NexusImportOrigin,
  type NexusOpenIntent,
  type NexusPage,
  type NexusPane,
  type NexusRootMode,
  type NexusRootOrigin,
  type NexusRow,
  type NexusTarget,
  type NexusTargetActivation,
  type Rail,
  type UsageMap,
} from "@/lib/nexus/model";
import { NEXUS_COMMANDS, parseNexusQuery } from "@/lib/nexus/query";
import { canonicalHref, latchedHref, normalizeQuery } from "@/lib/nexus/rank";
import { arrivalRows, blankRows, choiceRows, continuations, learnedHref, nexusGroups, OPEN_CAP, playbackRow, syncRows } from "@/lib/nexus/rows";
import { TRANSPORT_CODES, useNexusFind } from "@/lib/nexus/useNexusFind";
import { getWritingRuntime, LocalCommitError } from "@/lib/notes/runtime";
import { captureToday, dailyDateFor } from "@/lib/notes/api";
import { playingEpisode, usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import { useRenderEnvironment, useViewportState } from "@/lib/renderEnvironment/provider";
import { activateResource } from "@/lib/resources/activation";
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
const NO_USAGE: UsageMap = {};
const RETIRED = "selection no longer available";

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
  const recent = useRecent();
  const readRecent = recent.read;

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
  const [focusRevision, setFocusRevision] = useState(0);
  const [list, setList] = useState(EMPTY);
  const latestList = useRef(list);
  latestList.current = list;
  const [rail, setRail] = useState<Rail>(null);
  /** A reader selection read at open; `use this text…` is pre-armed with it until the first keystroke. */
  const [useText, setUseText] = useState<string | null>(null);
  /** The armed row was removed; enter announces until a new query. */
  const retired = useRef(false);
  const pendingFire = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const rootScroll = useRef({ Blank: 0, Typed: 0 });
  const shell = useRef(viewport.isMobile);
  const transferFocus = useRef<"Field" | "Heading" | "PaneList" | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) { presentations.retryTitles(); readRecent(); }
    wasOpen.current = open;
  }, [open, presentations, readRecent]);

  const parsed = useMemo(() => parseNexusQuery(query), [query]);
  const rootMode: NexusRootMode = parsed.text ? "Typed" : "Blank";
  const lookupGuidance = parsed.intent.kind === "CommandLookup"
    ? `${parsed.intent.head === "/" ? "" : `unknown command: ${truncateText(parsed.intent.head, 32)}. `}choose a command to start empty, or search this text`
    : null;
  const retainedLocalTargets = list.rows.flatMap(row => row.localMatch
    ? [{ref: row.localMatch.resource.ref, field: row.localMatch.matchedField === "annotation" ? "annotation" as const : null}] : []);
  const find = useNexusFind({ open: open && !composing, query: parsed, retainedLocalTargets });
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
  const currentPane = panes.find(pane => pane.current) ?? null;

  // Most recently active first, session-local, seeded from layout order (owner decision 5).
  const [activated, setActivated] = useState<readonly string[]>([]);
  useEffect(() => {
    const active = state.active_primary_pane_id;
    setActivated(current => current[0] === active ? current : [active, ...current.filter(id => id !== active)]);
  }, [state.active_primary_pane_id]);
  const mru = useMemo(() => {
    const known = activated.filter(id => panes.some(pane => pane.id === id));
    return [...known, ...panes.filter(pane => !known.includes(pane.id)).map(pane => pane.id)];
  }, [activated, panes]);
  const previousPaneId = mru.find(id => id !== state.active_primary_pane_id) ?? null;

  const recentItems = useMemo(() => {
    const seen = new Set<string>();
    return (recent.snapshot?.entries ?? []).map(entry => ({
      entry, presentation: presentations.forRecent(entry),
      resourceRef: presentations.resourceRefForVisit({ id: "", href: entry.href, title_hint: entry.title_hint }),
    })).filter(item => {
      if (presentations.isRecentRemoved(item.entry)) return false;
      const key = item.resourceRef ?? recentTargetKey(item.entry.target);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [recent.snapshot, presentations]);

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
  const playbackItem = useMemo(() => playback && playbackRow(playback.title, playback.subtitle !== null ? playback.subtitle : undefined), [playback]);
  function requestPaneFocus(key: string | null) {
    if (key?.startsWith("Pane:")) arm(key);
    setPaneFocus((current) => ({ key, revision: current.revision + 1 }));
  }
  const paneListPresented = open && page.kind === "Root" && rootMode === "Blank";
  // `here` and the tabs together: every pane has its row once the preview is uncapped, whatever the order.
  const paneRows = list.rows.filter(row => row.key.startsWith("Pane:"));
  const paneListComplete = paneListPresented && panes.every(pane => paneRows.some(row => row.key === `Pane:${pane.id}`));
  const panePreviewCount = Math.min(OPEN_CAP + 1, panes.length);
  const reorder = useNexusPaneReorder({
    open, eligible: paneListComplete && panes.length >= 2, isMobile: viewport.isMobile,
    panes, interactionLayer, announce: setAnnouncement, focus: requestPaneFocus,
  });
  const reordering = reorder.placement !== null || reorder.draggingPaneId !== null;
  const latched = parsed.text && find.usage ? latchedHref(normalizeQuery(parsed.text), find.usage) : null;
  const shape = JSON.stringify([parsed.text, reordering, panesExpanded, viewport.isMobile, useText]);
  const lastShape = useRef<string | null>(null);
  const continuationRows = useMemo(() => continuations(parsed), [parsed]);
  useLayoutEffect(() => {
    if (!open || page.kind !== "Root") { lastShape.current = null; return; }
    const fresh = lastShape.current !== shape;
    lastShape.current = shape;
    const now = performance.now();
    const usage = find.usage ?? NO_USAGE;
    const blank = { panes, mru, recent: recentItems, playback: playbackItem, useText, layoutOrder: reordering, panesExpanded };
    const sync = { query: parsed, panes, mru, recent: recentItems, usage, latched,
      reference: find.reference, referenceFailed: find.referenceFailed, localReference: find.localReference, localReferenceMissing: find.localReferenceMissing };
    if (fresh) { retired.current = false; clearTimeout(pendingFire.current ?? undefined); }
    setList(previous => {
      let next = previous;
      if (fresh || previous === EMPTY) {
        if (!parsed.text) {
          const rows = blankRows(blank);
          // Open arms where you were (law 7); a rebuild the user caused keeps what they armed.
          const kept = previous.armed !== null && rows.some(row => row.key === previous.armed) ? previous.armed : null;
          const armed = kept ?? (useText ? "Continuation:UseText" : previousPaneId !== null && !reordering ? `Pane:${previousPaneId}` : null);
          next = { identity: "", rows, held: rows.length, armed, armedAt: now, deliberate: true, previous: null, paintedAt: now };
        } else {
          // The blank list is law 7's context, not a query: the first keystroke holds nothing from it.
          const from = previous.identity === "" ? EMPTY : previous;
          const latchedKey = latched === null ? null : from.rows.find(row => row.href !== null && canonicalHref(row.href) === latched)?.key ?? null;
          next = keystroke(from, parsed.text, syncRows(sync), latchedKey, now);
          // Lookup arms nothing until the user does (target behaviour, `/`).
          if (parsed.intent.kind === "CommandLookup") next = { ...next, armed: null, previous: null };
        }
      } else if (!parsed.text) next = arrive(previous, blankRows(blank), now);
      if (parsed.text) next = arrive(next, arrivalRows({ ...sync, preview: find.preview, local: find.local, missingLocal: find.missingLocal, shown: next.rows }), now);
      const gone = new Set<string>();
      for (const row of next.rows) {
        if (row.action.kind === "Available" && row.action.target.kind === "PaneOpen" && !panes.some(pane => row.action.kind === "Available" && row.action.target.kind === "PaneOpen" && pane.id === row.action.target.paneId)) gone.add(row.key);
        if (row.localMatch && find.missingLocal.has(row.localMatch.resource.ref)) gone.add(row.key);
        if (row.recentEntry && presentations.isRecentRemoved(row.recentEntry)) gone.add(row.key);
        if (row.action.kind === "Available" && row.action.target.kind === "ResumeCurrentPlayback" && playbackItem === null) gone.add(row.key);
      }
      if (next.armed !== null && gone.has(next.armed)) retired.current = true;
      return remove(next, gone);
    });
  }, [open, page.kind, shape, parsed, panes, mru, recentItems, playbackItem, useText, reordering, panesExpanded, latched, find.usage, find.reference, find.referenceFailed, find.localReference, find.localReferenceMissing, find.preview, find.local, find.missingLocal, presentations, previousPaneId]);
  const hereKey = currentPane && !reordering ? `Pane:${currentPane.id}` : null;
  const groups = useMemo(() => nexusGroups({ blank: rootMode === "Blank", rows: list.rows, hereKey, paneCount: panes.length, continuations: continuationRows }),
    [rootMode, list.rows, hereKey, panes.length, continuationRows]);
  const allRows = rootMode === "Blank" ? list.rows : [...list.rows, ...continuationRows];
  // Zero principals, or nothing armed for a typed query, lands on `search all results`.
  const fallbackKey = rootMode === "Typed" && !retired.current && parsed.intent.kind !== "CommandLookup" ? continuationRows[0]?.key ?? null : null;
  const armed = list.armed ?? fallbackKey;
  // Capture focus before the retiring shell disappears. The desktop query also
  // owns pane browsing; arranging panes does not imply mobile text entry.
  if (shell.current !== viewport.isMobile) {
    if (open) {
      if (page.kind === "Root" && reordering) {
        transferFocus.current = "PaneList";
        rootFocus.current = `Pane:${reorder.placement?.kind === "ChoosePosition" ? reorder.placement.paneId : reorder.draggingPaneId ?? state.active_primary_pane_id}`;
      } else transferFocus.current = document.activeElement?.matches("input, textarea, [contenteditable=true]") ? "Field" : "Heading";
    }
    shell.current = viewport.isMobile;
  }

  function activate(action: NexusAction, activation: NexusTargetActivation, row?: NexusRow): WorkspaceTargetActivationResult | null {
    if (reorder.placement !== null && action.kind === "Available" && action.target.kind === "PaneOpen") {
      if (activation.disposition.kind === "Fork") return null;
      if (reorder.placement.kind === "ChoosePane") reorder.choosePane(action.target.paneId);
      else reorder.place(reorder.placement.paneIds.indexOf(action.target.paneId) + 1);
      return null;
    }
    if (action.kind === "Unavailable") { setAnnouncement(action.reason); return null; }
    if (row?.localMatch && (find.missingLocal.has(row.localMatch.resource.ref)
      || !find.local.some(match => match.resource.ref === row.localMatch?.resource.ref
        && (match.matchedField === "annotation") === (row.localMatch?.matchedField === "annotation")) && !find.localValidationReady)) {
      setAnnouncement(find.missingLocal.has(row.localMatch.resource.ref) ? RETIRED : "checking availability…");
      return null;
    }
    const current = currentPage.current;
    if ((current.kind === "UseText" || current.kind === "ChooseCreate" || current.kind === "ChooseBrowse") && current.activation.disposition.kind === "Fork") {
      activation = current.activation;
    }
    return run(action.target, activation, row);
  }

  function sourceOwnerIds(target: NexusTarget | null = null): readonly string[] {
    const current = currentPage.current;
    if (current.kind === "Add") return addSession.workOwnerIds;
    if (current.kind === "Root" || current.kind === "ChooseBrowse" || current.kind === "UseText") return [];
    if (current.kind === "ChooseCreate" && target !== null) {
      const transferred = target.kind === "CreateLibrary" ? target.nameDraft
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
    setRail(null);
    setOpen(false);
  }

  function rootOrigin(row: NexusRow | undefined): NexusImportOrigin {
    return { mode: open ? rootMode : "Blank", control: row?.key ?? "Search", query: open ? query : "" };
  }

  function choiceReturn(row: NexusRow | undefined, activation: NexusTargetActivation, origin: NexusRootOrigin | undefined): ChoiceReturn {
    return origin ? { kind: "Root", origin } : page.kind === "UseText" ? { ...page, activation } : { kind: "Root", origin: rootOrigin(row) };
  }

  /** The one activation core. */
  function run(target: NexusTarget, activation: NexusTargetActivation, row?: NexusRow, origin?: NexusImportOrigin): WorkspaceTargetActivationResult | null {
    reorder.cancel({ silent: true });
    setRail(null);
    if (target.kind !== "InternalHref" && target.kind !== "PaneOpen" && target.kind !== "OpenDailyPage" &&
      target.kind !== "Resource" && target.kind !== "OpenAcceptedSource" &&
      !guard.confirmLoss({ scopes: [], ownerIds: sourceOwnerIds(target) })) return { kind: "Cancelled" };
    switch (target.kind) {
      case "Resource": {
        let result: WorkspaceTargetActivationResult | null = null;
        activateResource(target.activation, {
          labelHint: target.label, disposition: activation.disposition,
          activateTarget: ({ target: resource, disposition }) => result = run({ kind: "InternalHref", ...resource }, { disposition }, row, origin),
        });
        return result;
      }
      case "OpenAcceptedSource":
        openAcceptedSource(target, activation);
        return null;
      case "OpenAdd":
        setPage({ kind: "Add", sessionId: addSession.start(target.seed), origin: origin ?? rootOrigin(row) });
        setOpen(true);
        return null;
      case "CreateLibrary":
        setPage({ kind: "CreateLibrary", libraryId: crypto.randomUUID(), name: target.nameDraft, activation, submit: { kind: "Ready" }, returnTo: !origin && page.kind === "ChooseCreate" ? page : choiceReturn(row, activation, origin) });
        setOpen(true);
        return null;
      case "UseText":
        setPage({ kind: "UseText", text: target.text, origin: origin ?? rootOrigin(row), activation });
        setOpen(true);
        return null;
      case "ChooseCreate":
        setPage({ kind: "ChooseCreate", draft: target.initialDraft, returnTo: choiceReturn(row, activation, origin), activation });
        setOpen(true);
        return null;
      case "ChooseBrowse":
        setPage({ kind: "ChooseBrowse", query: target.query, returnTo: choiceReturn(row, activation, origin), activation });
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
      // Keep the root origin and query for a guarded return.
      capture({ kind: "CaptureToday", text, noteId: crypto.randomUUID(), localDate, origin: origin ?? rootOrigin(row), activation, submit: { kind: "Running", unconfirmed: false } });
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
    if (!row?.learns_selection) return result;
    const href = target.kind === "PaneOpen" ? panes.find((candidate) => candidate.id === target.paneId)?.href ?? null : learnedHref(target);
    if (href) find.remember({ query: parsed.text || null, target_href: href });
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
          const retryable: Extract<NexusPage, {kind: "CaptureToday"}> = {...running,submit:{kind:"Retryable",content:{tone:"Warning",title:"couldn’t confirm saving on this device",message:"keep nexus open. retry saving."},unconfirmed:false}};
          setPage(retryable);
          void error.completion.then(() => {
            if (!visible.current || currentPage.current !== retryable || ctx.sessionSignal().aborted || captureAttempt.current?.noteId !== running.noteId) return;
            captureAttempt.current.promise = Promise.resolve("");
            captureAttempt.current.retry = null;
            capture({...retryable, submit: {kind: "Running", unconfirmed: false}});
          }, () => {});
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
    setRail(null);
    if (exit.kind === "Replace") { openIntent(exit.intent, exit.opener); return null; }
    addSession.discard();
    setPage({ kind: "Root" });
    if (exit.kind === "Close") { visible.current = false; setUseText(null); setOpen(false); }
    return null;
  }

  function requestExit(exit: Exit): boolean {
    if (guardExit(exit) !== "accepted") return false;
    return performExit(exit)?.kind !== "Cancelled";
  }

  /** An open request resets to Root or Add; a nonempty document selection pre-arms `use this text…` (law 7). */
  function openIntent(intent: NexusOpenIntent, trigger: HTMLElement | null) {
    reorder.cancel({ silent: true });
    setPanesExpanded(false);
    setRecentlyClosedExpanded(false);
    if (!open) {
      opener.current = trigger ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
      rootScroll.current = { Blank: 0, Typed: 0 };
      suppressReturnFocus.current = false;
      transferFocus.current = null;
      addSession.beginVisit();
    }
    rootFocus.current = null;
    const selection = open ? null : document.getSelection();
    const selected = selection !== null && !selection.isCollapsed ? selection.toString().trim() : "";
    setUseText(intent.kind === "Root" && selected ? selected : null);
    const nextPage: NexusPage = intent.kind === "Add"
      ? { kind: "Add", sessionId: addSession.start(intent.seed), origin: null }
      : { kind: "Root" };
    if (intent.kind !== "Add") addSession.discard();
    setQueryState("");
    setList(EMPTY);
    setRail(null);
    setPage(nextPage);
    setOpen(true);
    if (intent.kind === "QuickAction") {
      const action = NEXUS_COMMANDS[intent.actionId].action("");
      if (action.kind === "Available") run(action.target, PROGRAMMATIC_NEXUS_TARGET_ACTIVATION, undefined, { mode: "Blank", control: "Search", query: "" });
      else setAnnouncement(action.reason);
    }
  }

  function setQuery(next: string) {
    reorder.cancel({ restoreFocus: false });
    if (!reordering) setAnnouncement("");
    setRail(null);
    setUseText(null);
    setQueryState(next);
    if (next !== query) rootScroll.current.Typed = 0;
  }

  /** Deliberate arming (law 3): arrows, tab, pointer travel, focus on a row's control. */
  function arm(key: string) {
    if (reorder.placement !== null && !paneRows.some((row) => row.key === key)) return;
    clearTimeout(pendingFire.current ?? undefined);
    retired.current = false;
    setList(current => current.armed === key && current.deliberate ? current : select(current, key, performance.now()));
  }

  function armedRow(): NexusRow | null {
    return allRows.find(row => row.key === armed) ?? null;
  }

  function fire(key: string | null, activation: NexusTargetActivation) {
    const row = key === null ? null : allRows.find(candidate => candidate.key === key);
    if (!row) { if (key !== null || retired.current) setAnnouncement(RETIRED); return; }
    activate(row.action, activation, row);
  }

  /** Enter (law 2): what the user has seen for PERCEIVED_MS, or the row it replaced, or wait for the window once. */
  function submit(activation: NexusTargetActivation) {
    if (rail !== null) return;
    if (rootMode === "Blank") { const row = armedRow(); if (row) activate(row.action, activation, row); return; }
    if (lookupGuidance !== null && !list.deliberate) { setAnnouncement(lookupGuidance); return; }
    const now = performance.now();
    const target = fireTarget(list, now);
    clearTimeout(pendingFire.current ?? undefined);
    if (target.kind === "Fire") { fire(target.key, activation); return; }
    if (target.kind === "None") { fire(retired.current ? null : fallbackKey, activation); return; }
    pendingFire.current = setTimeout(() => {
      pendingFire.current = null;
      if (!visible.current) return;
      const later = fireTarget(latestList.current, performance.now());
      fire(later.kind === "Fire" ? later.key : retired.current ? null : fallbackKey, activation);
    }, Math.max(0, target.until - now));
  }

  /** Esc, the scrim and android back step back only to a palette that opened the page and has sent nothing this visit. */
  const dismissClosesAdd = page.kind === "Add" && (page.origin === null || addSession.state.sent);

  function back() {
    if (reorder.cancel()) return;
    if (rail !== null) { setRail(null); return; }
    const exit: Exit = { kind: "Root" };
    if (guardExit(exit) !== "accepted") return;
    setAnnouncement("");
    if (page.kind === "Add" && page.origin !== null) {
      const { mode, control, query: text } = page.origin;
      const { sent } = addSession.state;
      setQuery(sent ? "" : text);
      // Search on a phone rests in its input. Otherwise the row: the one that opened
      // this page, or the import row if that row left with the query or never existed.
      rootFocus.current = viewport.isMobile && mode === "Typed" ? "Search"
        : sent || control === "Search" ? "QuickAction:Nexus.Quick.Import" : control;
    }
    if (page.kind === "CreateLibrary" && page.returnTo.kind === "ChooseCreate") {
      rootFocus.current = "Choice:library";
      return setPage(page.returnTo);
    }
    const destination = page.kind === "ChooseCreate" || page.kind === "ChooseBrowse" || page.kind === "CreateLibrary" ? page.returnTo
      : page.kind === "UseText" || page.kind === "CaptureToday" ? { kind: "Root" as const, origin: page.origin } : null;
    if (destination?.kind === "UseText") {
      rootFocus.current = page.kind === "ChooseBrowse" ? "Choice:browse…" : "Choice:create…";
      setPage(destination);
      return;
    }
    if (destination?.kind === "Root") {
      rootFocus.current = destination.origin.control;
      if (destination.origin.control === "Continuation:UseText") arm("Continuation:UseText");
    }
    performExit(exit);
  }

  /** Escape: the rail first, then a child page, then (phone) the text, then the palette. */
  function escape() {
    if (reorder.cancel()) return;
    if (rail !== null) { setRail(null); return; }
    if (dismissClosesAdd) requestExit({ kind: "Close" });
    else if (page.kind !== "Root") back();
    else if (viewport.isMobile && query) setQuery("");
    else requestExit({ kind: "Close" });
  }

  function restoreClosed(paneId: string) {
    reorder.cancel({ silent: true });
    if (workspace.restoreClosedPane(paneId) === "cancelled") return;
    finishNavigation(paneId);
  }

  function closePane(paneId: string) {
    reorder.cancel({ silent: true });
    setRail(null);
    if (!latestWorkspace().state.panes.some((pane) => pane.id === paneId)) return null;
    const keys = allRows.filter((row) => !paneListPresented || row.key.startsWith("Pane:")).map((row) => row.key);
    const row = allRows.find((row) => row.secondary?.kind === "ClosePane" ? row.secondary.paneId === paneId
      : row.secondary?.kind === "TargetMenu" && row.secondary.closePanes.some((pane) => pane.id === paneId));
    const index = keys.indexOf(row?.key ?? `Pane:${paneId}`);
    const following = [...(row?.secondary?.kind === "TargetMenu" && row.key !== `Pane:${paneId}` ? [row.key] : []), ...keys.slice(index + 1), ...keys.slice(0, index).reverse()];
    const selection = workspace.closePane(paneId);
    if (selection === null) return null;
    const selected = keepWorkspaceSelection(selection);
    const live = latestWorkspace().state.panes.map((pane) => `Pane:${pane.id}`);
    const next = following.find((key) => !key.startsWith("Pane:") || live.includes(key)) ?? null;
    if (next !== null) arm(next);
    requestPaneFocus(next);
    return selected;
  }

  const keydown = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keydown.current = (event) => {
    if (!matchesShortcut(SHORTCUTS["Nexus.Open"], event, platform)) return;
    if (hasActiveInteractionOwner() && !isTopmostInteractionOwner("Nexus")) return;
    event.preventDefault();
    if (event.repeat) return;
    if (!open) requestExit({ kind: "Replace", intent: { kind: "Root" }, opener: null });
    else if (page.kind === "Root" && viewport.isMobile) {
      rootFocus.current = "Search";
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
  useEffect(() => () => clearTimeout(pendingFire.current ?? undefined), []);

  if (defect) throw defect.error;
  const noticeText = [find.progress.kind === "Notice" ? find.progress.text : null,
    !parsed.text && recent.readFailure ? recent.snapshot ? "couldn’t refresh recent. showing the last loaded list." : "couldn’t load recent." : !parsed.text && recent.snapshot === null ? "loading recent…" : !parsed.text && recent.snapshot?.entries.length === 0 ? "resources you open will appear here." : null, !parsed.text && recent.writeFailure ? recent.writeFailure === "failed" ? "couldn’t update recent." : "recent update wasn’t confirmed." : null, lookupGuidance].filter(Boolean).join(" ") || null;
  return {
    interactionLayer,
    open,
    isMobile: viewport.isMobile,
    hydrated: viewport.hydrated,
    query,
    page,
    rootMode,
    rootScroll,
    /** The list's bands: rows[0..held) held, the rest arriving. */
    list,
    groups,
    continuations: continuationRows,
    /** Every row enter or an arrow may reach, in presentation order. */
    rows: allRows,
    armed,
    hereKey,
    mru,
    useText,
    rail,
    openRail(key: string | null = armed) { if (key !== null && allRows.some(row => row.key === key)) setRail({ key, focus: null, filter: "" }); },
    closeRail() { setRail(null); },
    focusRail(focus: string | null) { setRail(current => current && { ...current, focus }); },
    filterRail(filter: string) { setRail(current => current && { ...current, filter }); },
    choices: choiceRows(page),
    explicitIntent: parsed.intent.kind !== "Search",
    lookupGuidance,
    failures: find.failures,
    recentStatus: { blank: !parsed.text, snapshot: recent.snapshot, readFailure: recent.readFailure, writeFailure: recent.writeFailure, read: recent.read },
    searchProgress: find.progress,
    searchFailures: find.readFailures,
    localSearchFailures: find.localFailures,
    searchIdentity: find.queryIdentity,
    noticeText,
    searchUnavailable: find.searchUnavailable,
    setComposing(value: boolean) {
      if (value) reorder.cancel({ restoreFocus: false });
      setComposing(value);
    },
    retrySearch: find.retrySearch,
    retryRelated: find.retryRelated,
    retrying: find.retrying,
    busy: find.busy,
    pending: find.pending,
    announcement,
    dialogLabel: page.kind === "Add" ? "Add content" : viewport.isMobile && page.kind !== "Root" ? "workspace task" : "Nexus",
    focusKey: page.kind === "Add" ? addSession.state.sessionId : `${page.kind}:${focusRevision}`,
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
    closedPanes: workspace.recentlyClosedPanes.map((snapshot) => ({
      id: snapshot.pane.id,
      presentation: presentations.forVisit(snapshot.pane.current_visit),
    })),
    setQuery,
    destinationHref(row: NexusRow): string | null {
      if (row.action.kind !== "Available") return null;
      const target = row.action.target;
      if (target.kind === "InternalHref") return target.href;
      if (target.kind === "Resource") return target.activation.kind === "route" ? target.activation.href : null;
      if (target.kind === "OpenDailyPage") return `/daily/${dailyDateFor(target.date, calendarTimeZone)}`;
      return null;
    },
    submit,
    arm,
    retry: find.retry,
    activate,
    /** Explicit destination controls capture their own gesture, through the Add guard. */
    openTarget: (target: NexusTarget, activation: NexusTargetActivation = PROGRAMMATIC_NEXUS_TARGET_ACTIVATION) => requestExit({ kind: "Navigate", target, activation }),
    openAddTarget: (target: NexusTarget, intent: OpenIntent) => requestExit({ kind: "Navigate", target, activation: intent === "new_pane" ? { disposition: { kind: "Fork" } } : PROGRAMMATIC_NEXUS_TARGET_ACTIVATION }),
    back,
    escape,
    close: () => requestExit({ kind: "Close" }),
    openRoot: () => requestExit({ kind: "Replace", intent: { kind: "Root" }, opener: null }),
    /** Native dismissal (phone back): ime, the rail, a child page, then the text, then the palette. */
    guardClose(): DismissDecision {
      if (reorder.cancel()) return "blocked";
      if (dismissClosesAdd) return guardExit({ kind: "Close" });
      if (rail !== null) { setRail(null); return "blocked"; }
      if (page.kind !== "Root") { back(); return "blocked"; }
      if (viewport.isMobile && query) { setQuery(""); return "blocked"; }
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
      const control = (key: string | null) => key === null ? null
        : [...container.querySelectorAll<HTMLElement>("[data-nexus-control]")].find((node) => node.dataset.nexusControl === key) ?? null;
      if (transfer === "PaneList") {
        const key = rootFocus.current;
        rootFocus.current = null;
        if (key !== null) arm(key);
        if (!viewport.isMobile) return container.querySelector<HTMLElement>('[role="combobox"]');
        return control(key) ?? container.querySelector<HTMLElement>("[data-mobile-nexus-search]");
      }
      if (transfer === "Heading") return container.querySelector<HTMLElement>("[data-switchboard-heading], [data-add-heading], [data-mobile-nexus-search]");
      if (page.kind === "Add") {
        return resolveAddPanelInitialFocus(container, transfer === "Field" ? false : viewport.isMobile);
      }
      const requested = rootFocus.current;
      rootFocus.current = null;
      if (requested && !viewport.isMobile && page.kind === "Root") {
        if (allRows.some(row => row.key === requested)) arm(requested);
      } else if (requested) {
        const target = control(requested);
        if (target) return target;
      }
      if (page.kind === "CreateLibrary") return container.querySelector<HTMLElement>("[data-switchboard-library-name]");
      if (page.kind !== "Root") return container.querySelector<HTMLElement>("[data-switchboard-heading]");
      // The sheet opens keyboard-down: the armed row takes focus, never the field (owner decision 6).
      if (viewport.isMobile) return control(armed) ?? container.querySelector<HTMLElement>("[data-mobile-nexus-search]");
      return container.querySelector<HTMLElement>('[role="combobox"]');
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
