"use client";

// The Nexus session: open/closed, the page state machine, the list (list.ts holds its bands and
// arming), the most-recently-active pane order, the rail state, and the one activation core every
// row, verb, keybinding, open request and workflow goes through.
import { useRecent } from "@/lib/recent/store";
import { recentTargetKey } from "@/lib/recent/model";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useOutcome } from "@/components/feedback/Feedback";
import { sentence, type Line } from "@/components/feedback/stage";
import type { DismissRequestReason } from "@/components/ui/ModalFrame";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { truncateText } from "@/lib/display/format";
import { chatDraftOwnerId } from "@/lib/chat/drafts";
import { resourceDraftOwnerId } from "@/lib/resourceGraph/useResourceDraft";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { useWorkGuard, type WorkOwner } from "@/lib/unsavedWork";
import { planWorkspaceTarget, type WorkspaceTargetActivationRequest, type WorkspaceTargetActivationResult } from "@/lib/workspace/targetActivation";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { openAsyncResult, type OpenResult } from "@/lib/panes/openResult";
import { isApiError, isSameSystemApiDefect, outcomeUnknown } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useImportIntake, useImportPresentation, type Admission } from "@/lib/imports/intake";
import { batchSlip, colophon, spokenCount } from "@/lib/imports/lineView";
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
  type ReplayableSubmitState,
  type SubmitFailure,
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
import { useNexusFind } from "@/lib/nexus/useNexusFind";
import { getWritingRuntime, LocalCommitError } from "@/lib/notes/runtime";
import { captureToday, dailyDateFor } from "@/lib/notes/api";
import { playingEpisode, usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import { useRenderEnvironment, useViewportState } from "@/lib/renderEnvironment/provider";
import { activateResource } from "@/lib/resources/activation";
import { matchesShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { getInteractionGeneration, hasActiveInteractionOwner, hasWorkspaceNavigationBlocker, isTopmostInteractionOwner } from "@/lib/ui/overlay";
import type { DismissDecision, Layer } from "@/lib/ui/overlay";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useLatestWorkspace, useSubscribeWorkspace, useWorkspaceStore, type WorkspaceSelection } from "@/lib/workspace/store";
import { useWorkspacePresentations } from "@/lib/workspace/presentations";
import { useNexusPaneReorder } from "./useNexusPaneReorder";

const CREATED = "couldn’t create the library.";
/** What the library form tells of a refused create, by the server's code; transport has its own line. */
const CREATE_REFUSALS: Readonly<Record<string, Line>> = {
  E_FORBIDDEN: { fact: CREATED, reason: "this account doesn’t have permission." },
  E_LIBRARY_FORBIDDEN: { fact: CREATED, reason: "this account doesn’t have permission." },
  E_NAME_INVALID: { fact: "this name can’t be used.", reason: "use 1 to 100 characters, other than “all”." },
  E_INVALID_REQUEST: { fact: CREATED },
  E_RESOURCE_CONFLICT: { fact: CREATED },
};
const NO_USAGE: UsageMap = {};
const RETIRED = "that result is gone.";

type Dispatchable = Extract<NexusTarget, { kind: "InternalHref" | "PaneOpen" }> | MaterializedOpenDailyPageTarget;
/** What leaving the current page means; leaving a draft may first need the user's confirmation. */
type Exit =
  | { readonly kind: "Close" }
  | { readonly kind: "Root" }
  | { readonly kind: "Replace"; readonly intent: NexusOpenIntent; readonly opener: HTMLElement | null }
  | { readonly kind: "Navigate"; readonly target: NexusTarget; readonly activation: NexusTargetActivation };

export type NexusController = ReturnType<typeof useNexusController>;

export function useNexusController() {
  const { ctx } = useActionRuntime();
  const { say } = useOutcome();
  const interactionLayer = useRef<Layer | null>(null);
  const { accountId, calendarTimeZone } = useAuthenticatedAccount();
  const captureAttempt = useRef<{ noteId: string; promise: Promise<string>; retry: (() => Promise<unknown>) | null } | null>(null);
  const guard = useWorkGuard();
  const viewport = useViewportState();
  const { platform, displayTimeZone } = useRenderEnvironment();
  const player = usePlayerSession();
  const playerCommands = usePlayerCommands();
  const intake = useImportIntake();
  const { beginVisit } = intake;
  const workspace = useWorkspaceStore();
  const latestWorkspace = useLatestWorkspace();
  const subscribeWorkspace = useSubscribeWorkspace();
  const { state } = workspace;
  const presentations = useWorkspacePresentations();
  const recent = useRecent();
  const readRecent = recent.read;

  const [open, writeOpen] = useState(false);
  const visible = useRef(open);
  const [query, setQueryState] = useState("");
  const [composing, setComposing] = useState(false);
  const [page, writePage] = useState<NexusPage>({ kind: "Root" });
  const currentPage = useRef(page);
  const [pageListeners] = useState(() => new Set<() => void>());
  function setPage(change: NexusPage | ((current: NexusPage) => NexusPage)) {
    const next = typeof change === "function" ? change(currentPage.current) : change;
    const before = currentPage.current;
    currentPage.current = next;
    setShown(visible.current && next.kind === "Import");
    if (before.kind === "Import" && next.kind !== "Import") {
      intake.disarmExcept(null);
      setAnnouncement("");
    }
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
  const [announcementOccurrence, writeAnnouncement] = useState({ text: "" });
  const pendingImportSpeech = useRef<{ readonly text: string } | null>(null);
  const deliveredAnnouncement = useRef<object | null>(null);
  const setAnnouncement = useCallback((text: string) => {
    pendingImportSpeech.current = null;
    writeAnnouncement({ text });
  }, []);
  // Carry unpublished import sentences in event order, including equal sentences.
  const announceImport = useCallback((text: string) => {
    const pending = pendingImportSpeech.current;
    const next = { text: pending === null ? text : `${pending.text} ${text}` };
    pendingImportSpeech.current = next;
    writeAnnouncement(next);
  }, []);
  const publishedAnnouncement = useCallback((occurrence: object) => {
    deliveredAnnouncement.current = occurrence;
    if (pendingImportSpeech.current === occurrence) pendingImportSpeech.current = null;
  }, []);
  const announcement = announcementOccurrence.text;
  const setShown = useImportPresentation(() => visible.current && currentPage.current.kind === "Import", (batch, at) => {
    const slip = batch.length === 1 ? batchSlip(batch) : null;
    const said = batch.length > 1 ? colophon(batch, at, displayTimeZone) : slip === null ? null : sentence(slip.line);
    if (said !== null) announceImport(said);
  });
  const setOpen = useCallback((next: boolean) => {
    if (next && !visible.current) beginVisit();
    visible.current = next;
    setShown(next && currentPage.current.kind === "Import");
    writeOpen(next);
  }, [setShown, beginVisit]);
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
  const announce = useCallback((fact: string) => { say({ fact }); }, [say]);
  const [reorderSpeech, setReorderSpeech] = useState("");
  const [panesExpanded, setPanesExpanded] = useState(false);
  const [recentlyClosedExpanded, setRecentlyClosedExpanded] = useState(false);
  const [paneFocus, setPaneFocus] = useState<{ key: string | null; revision: number }>({ key: null, revision: 0 });
  /** The enter wait fires through the latest render: the row it names may have arrived after submit. */
  const latestFire = useRef(fire);
  latestFire.current = fire;
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);
  const suppressReturnFocus = useRef(false);
  const handoffPaneId = useRef<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const rootFocus = useRef<string | null>(null);
  const rootScroll = useRef({ Blank: 0, Typed: 0 });
  const shell = useRef(viewport.isMobile);
  const transferFocus = useRef<"Field" | "Heading" | "PaneList" | null>(null);
  const wasOpen = useRef(false);
  const endVisit = useRef(() => {});
  endVisit.current = intake.endVisit;
  // Every close path ends the visit here, since navigation closes without an exit.
  useEffect(() => {
    if (open && !wasOpen.current) { presentations.retryTitles(); readRecent(); }
    if (!open && wasOpen.current) { endVisit.current(); setAnnouncement(""); }
    wasOpen.current = open;
  }, [open, presentations, readRecent, setAnnouncement]);

  const parsed = useMemo(() => parseNexusQuery(query), [query]);
  const rootMode: NexusRootMode = parsed.text ? "Typed" : "Blank";
  const lookupGuidance = parsed.intent.kind === "CommandLookup"
    ? parsed.intent.head === "/" ? "choose a command, or search for this text."
      : `no command named “${truncateText(parsed.intent.head, 32)}”. choose one, or search for this text.`
    : null;
  const retainedLocalTargets = list.rows.flatMap(row => row.localMatch
    ? [{ref: row.localMatch.resource.ref, field: row.localMatch.matchedField === "annotation" ? "annotation" as const : null}] : []);
  const find = useNexusFind({ open, composing, query: parsed, retainedLocalTargets });
  const panes = useMemo<NexusPane[]>(
    () =>
      state.panes.map((pane, index) => ({
        id: pane.id,
        position: index + 1,
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
  const [mru, setMru] = useState<readonly string[]>(() => [state.active_primary_pane_id,
    ...state.panes.filter(pane => pane.id !== state.active_primary_pane_id).map(pane => pane.id)]);
  useLayoutEffect(() => {
    setMru(current => {
      const active = state.active_primary_pane_id;
      const present = new Set(state.panes.map(pane => pane.id));
      const kept = current.filter(id => present.has(id));
      const added = state.panes.filter(pane => !kept.includes(pane.id)).map(pane => pane.id);
      const next = [active, ...kept.filter(id => id !== active), ...added.filter(id => id !== active)];
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [state.active_primary_pane_id, state.panes]);
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
  }, [navigationToken, open, setOpen]);

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
  }, [latestWorkspace, open, setOpen, subscribeWorkspace]);

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
    panes, interactionLayer, announce: setReorderSpeech, focus: requestPaneFocus,
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
    if (fresh) clearTimeout(pendingFire.current ?? undefined);
    const previous = latestList.current;
    let next = previous;
    if (fresh || previous === EMPTY) {
      if (!parsed.text) {
        const rows = blankRows(blank);
        // Open arms where you were (law 7); a rebuild the user caused keeps what they armed.
        const kept = previous.armed !== null && rows.some(row => row.key === previous.armed) ? previous.armed : null;
        const armed = kept ?? (useText ? "Continuation:UseText" : previousPaneId !== null && !reordering ? `Pane:${previousPaneId}` : null);
        next = { identity: "", rows, held: rows.map(row => row.key), armed, armedAt: now, deliberate: true, previous: null, paintedAt: now };
      } else {
        const latchedKey = latched === null ? null : previous.rows.find(row => row.href !== null && canonicalHref(row.href) === latched)?.key ?? null;
        next = keystroke(previous, parsed.text, syncRows(sync), latchedKey, now);
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
    latestList.current = remove(next, gone);
    setList(latestList.current);
  }, [open, page.kind, shape, parsed, panes, mru, recentItems, playbackItem, useText, reordering, panesExpanded, latched, find.usage, find.reference, find.referenceFailed, find.localReference, find.localReferenceMissing, find.preview, find.local, find.missingLocal, presentations, previousPaneId]);
  const hereKey = currentPane && !reordering ? `Pane:${currentPane.id}` : null;
  const groups = useMemo(() => nexusGroups({ blank: rootMode === "Blank", rows: list.rows, hereKey, paneCount: panes.length, continuations: continuationRows }),
    [rootMode, list.rows, hereKey, panes.length, continuationRows]);
  const allRows = rootMode === "Blank" ? list.rows : [...list.rows, ...continuationRows];
  useLayoutEffect(() => {
    if (rail !== null && !list.rows.some(row => row.key === rail.key)) {
      setRail(null);
      announce(RETIRED);
    }
  }, [rail, list.rows, announce]);
  // Zero principals, or nothing armed for a typed query, lands on `search all results`.
  const fallbackKey = rootMode === "Typed" && !retired.current && parsed.intent.kind !== "CommandLookup" ? continuationRows[0]?.key ?? null : null;
  const armed = list.armed ?? fallbackKey;
  // Capture focus before the retiring shell disappears. The desktop query also
  // owns pane browsing; arranging panes does not imply mobile text entry.
  if (shell.current !== viewport.isMobile) {
    if (deliveredAnnouncement.current === announcementOccurrence) setAnnouncement("");
    if (open) {
      if (page.kind === "Root" && reordering) {
        transferFocus.current = "PaneList";
        rootFocus.current = `Pane:${reorder.placement?.kind === "ChoosePosition" ? reorder.placement.paneId : reorder.draggingPaneId ?? state.active_primary_pane_id}`;
      } else transferFocus.current = document.activeElement?.matches("input, textarea, [contenteditable=true]") ? "Field" : "Heading";
    }
    shell.current = viewport.isMobile;
  }

  function activate(action: NexusAction, activation: NexusTargetActivation, row?: NexusRow): WorkspaceTargetActivationResult | null {
    // An explicit activation supersedes a waiting enter; selecting a different row does not.
    clearTimeout(pendingFire.current ?? undefined);
    pendingFire.current = null;
    if (reorder.placement !== null && action.kind === "Available" && action.target.kind === "PaneOpen") {
      if (activation.disposition.kind === "Fork") return null;
      if (reorder.placement.kind === "ChoosePane") reorder.choosePane(action.target.paneId);
      else reorder.place(reorder.placement.paneIds.indexOf(action.target.paneId) + 1);
      return null;
    }
    if (action.kind === "Unavailable") { say({ fact: /[….?!]$/.test(action.reason) ? action.reason : `${action.reason}.` }); return null; }
    if (row?.localMatch && (find.missingLocal.has(row.localMatch.resource.ref)
      || !find.local.some(match => match.resource.ref === row.localMatch?.resource.ref
        && (match.matchedField === "annotation") === (row.localMatch?.matchedField === "annotation")) && !find.localValidationReady)) {
      say({ fact: find.missingLocal.has(row.localMatch.resource.ref) ? "that result is gone." : "still checking that result." });
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
    if (current.kind === "Root" || current.kind === "ChooseBrowse" || current.kind === "UseText" || current.kind === "Import") return [];
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
      const plan = planWorkspaceTarget(state, request);
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
    setOpen(false);
    handoffPaneId.current = focusPaneId;
    suppressReturnFocus.current = true;
    setPage({ kind: "Root" });
    setRail(null);
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
      target.kind !== "Resource" &&
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
      case "OpenImport":
        if (target.text !== "") intake.setField(target.text);
        setPage({ kind: "Import", origin: origin ?? rootOrigin(row), select: null });
        setOpen(true);
        return null;
      case "ImportLinks":
        setPage({ kind: "Import", origin: origin ?? rootOrigin(row), select: target.links[0]! });
        setOpen(true);
        admitImport({ links: target.links, files: [], ...(activation.disposition.kind === "Fork" ? { open: "Fork" } as const : {}) });
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
      capture({ kind: "CaptureToday", text, noteId: crypto.randomUUID(), localDate, origin: origin ?? rootOrigin(row), activation, submit: { kind: "Running", unconfirmed: false, failures: 0 } });
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
    finishNavigation(null);
    if (!row?.learns_selection) return result;
    const href = target.kind === "PaneOpen" ? panes.find((candidate) => candidate.id === target.paneId)?.href ?? null : learnedHref(target);
    if (href) find.remember({ query: parsed.text || null, target_href: href });
    return result;
  }

  /** Quick note with text: one append to the day, then the day at that note (the
   * launcher keeps the text with Retry, under the same note id, when it fails). */
  function capture(running: Extract<NexusPage, { kind: "CaptureToday" }> & { readonly submit: Extract<ReplayableSubmitState, { kind: "Running" }> }) {
    void openCreated(running, async () => {
      if (captureAttempt.current?.noteId !== running.noteId) captureAttempt.current = {noteId:running.noteId,promise:captureToday(getWritingRuntime(accountId),running.localDate,running.noteId,running.text),retry:null};
      else if (captureAttempt.current.retry) { captureAttempt.current.promise=captureAttempt.current.retry().then(()=>"");captureAttempt.current.retry=null; }
      await captureAttempt.current.promise;
      return { target: { href: `/daily/${running.localDate}` }, title: "added to today", openLabel: "open",
        entry: { kind: "FocusNote", noteBlockId: running.noteId } };
    }).catch((error: unknown) => {
        if (currentPage.current !== running || ctx.sessionSignal().aborted) return;
        if (error instanceof LocalCommitError) {
          if(captureAttempt.current?.noteId===running.noteId)captureAttempt.current.retry=error.retry;
          const failures = running.submit.failures + 1;
          const retryable: Extract<NexusPage, {kind: "CaptureToday"}> = {...running,submit:{kind:"Retryable",failure:{kind:"AtRisk"},unconfirmed:false,failures}};
          setPage(retryable);
          void error.completion.then(() => {
            if (!visible.current || currentPage.current !== retryable || ctx.sessionSignal().aborted || captureAttempt.current?.noteId !== running.noteId) return;
            captureAttempt.current.promise = Promise.resolve("");
            captureAttempt.current.retry = null;
            capture({...retryable, submit: {kind: "Running", unconfirmed: false, failures}});
          }, () => {});
          return;
        }
        // a capture is a local commit: any other failure is a defect.
        setDefect({ error });
      });
  }

  function openCreated(
    running: Extract<NexusPage, { kind: "CreateLibrary" | "CaptureToday" }>,
    create: () => Promise<OpenResult>,
  ) {
    let livePage: NexusPage = running;
    setOpen(true);
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
          livePage = { ...running, submit: { kind: "Acknowledged" } };
          setPage(livePage);
        }
        return result;
      },
    });
  }

  /** What the form tells of a failed create; anything undeclared becomes a workspace defect.
   * An unknown outcome holds: `create` replays the same id, which the server answers idempotently. */
  function createFailure(error: unknown, unconfirmed: boolean): SubmitFailure | null {
    if (handleUnauthenticatedApiError(error)) return null;
    if (isApiError(error) && !isSameSystemApiDefect(error)) {
      if (unconfirmed || outcomeUnknown(error)) return { kind: "Unknown" };
      const refusal = CREATE_REFUSALS[error.code];
      return refusal !== undefined ? { kind: "Refused", line: refusal } : { kind: "Transport", fact: CREATED, error };
    }
    setDefect({ error });
    return null;
  }

  function submitLibrary(intent: OpenIntent) {
    if (page.kind !== "CreateLibrary" || page.submit.kind === "Running" || !page.name.trim()) return;
    const running = { ...page, name: page.name.trim(), activation: intent === "new_pane" ? { disposition: { kind: "Fork" } } as const : page.activation,
      submit: { kind: "Running", failure: page.submit.kind === "Retryable" ? page.submit.failure : undefined,
        unconfirmed: page.submit.kind === "Retryable" && page.submit.unconfirmed,
        failures: page.submit.kind === "Retryable" ? page.submit.failures : 0 } } as const;
    void openCreated(running, async () => {
      const library = await createLibrary({ id: running.libraryId, name: running.name, initial_items: [], expected_removal_revision: null });
      return { target: { href: `/libraries/${library.id}`, labelHint: library.name }, title: "library created", openLabel: "open library" };
    }).catch((error: unknown) => {
        if (currentPage.current !== running || ctx.sessionSignal().aborted) return;
        const failure = createFailure(error, running.submit.unconfirmed);
        if (failure) setPage({ ...running, submit: { kind: "Retryable", failure, unconfirmed: running.submit.unconfirmed || outcomeUnknown(error), failures: running.submit.failures + 1 } });
      });
  }

  function guardExit(exit: Exit): DismissDecision {
    return exit.kind === "Navigate" || guard.confirmLoss({ scopes: [], ownerIds: sourceOwnerIds() }) ? "accepted" : "blocked";
  }

  function performExit(exit: Exit): WorkspaceTargetActivationResult | null {
    if (exit.kind === "Navigate") return run(exit.target, exit.activation);
    reorder.cancel({ silent: true });
    setRail(null);
    setAnnouncement("");
    if (exit.kind === "Replace") { openIntent(exit.intent, exit.opener); return null; }
    setPage({ kind: "Root" });
    if (exit.kind === "Close") { setUseText(null); setOpen(false); }
    return null;
  }

  function requestExit(exit: Exit): boolean {
    if (guardExit(exit) !== "accepted") return false;
    return performExit(exit)?.kind !== "Cancelled";
  }

  /** An open request resets to Root or Import; an empty root query may pre-arm selected text (law 7). */
  function openIntent(intent: NexusOpenIntent, trigger: HTMLElement | null) {
    retired.current = false;
    reorder.cancel({ silent: true });
    setPanesExpanded(false);
    setRecentlyClosedExpanded(false);
    if (!open) {
      opener.current = trigger ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
      rootScroll.current = { Blank: 0, Typed: 0 };
      suppressReturnFocus.current = false;
      transferFocus.current = null;
    }
    rootFocus.current = null;
    const selection = open ? null : document.getSelection();
    const selected = selection !== null && !selection.isCollapsed ? selection.toString().trim() : "";
    const query = intent.kind === "Root" ? intent.query ?? "" : "";
    if (query !== "") rootFocus.current = "Search";
    setUseText(intent.kind === "Root" && query === "" && selected ? selected : null);
    if (intent.kind === "Import" && intent.into.length > 0) intake.setInto(intent.into);
    setQueryState(query);
    setList(EMPTY);
    setRail(null);
    setPage(intent.kind === "Import" ? { kind: "Import", origin: null, select: null } : { kind: "Root" });
    setOpen(true);
    if (intent.kind === "QuickAction") {
      const action = NEXUS_COMMANDS[intent.actionId].action("");
      if (action.kind === "Available") run(action.target, PROGRAMMATIC_NEXUS_TARGET_ACTIVATION, undefined, { mode: "Blank", control: "Search", query: "" });
      else say({ fact: `${action.reason}.` });
    }
  }

  function setQuery(next: string) {
    reorder.cancel({ restoreFocus: false });
    setRail(null);
    setUseText(null);
    if (!reordering) setReorderSpeech("");
    setQueryState(next);
    if (next !== query) {
      retired.current = false;
      rootScroll.current.Typed = 0;
    }
  }

  /** Deliberate arming (law 3): arrows, tab, pointer travel, focus on a row's control. */
  function arm(key: string) {
    if (reorder.placement !== null && !paneRows.some((row) => row.key === key)) return;
    setList(current => current.armed === key && current.deliberate ? current : select(current, key, performance.now()));
  }

  function armedRow(): NexusRow | null {
    return allRows.find(row => row.key === armed) ?? null;
  }

  function fire(key: string | null, activation: NexusTargetActivation) {
    const row = key === null ? null : allRows.find(candidate => candidate.key === key);
    if (!row) { if (key !== null || retired.current) announce(RETIRED); return; }
    activate(row.action, activation, row);
  }

  /** Enter (law 2): what the user has seen for PERCEIVED_MS, or the row it replaced, or wait for the window once. */
  function submit(activation: NexusTargetActivation) {
    if (rail !== null) return;
    clearTimeout(pendingFire.current ?? undefined);
    pendingFire.current = null;
    if (retired.current) { announce(RETIRED); return; }
    if (rootMode === "Blank") { const row = armedRow(); if (row) activate(row.action, activation, row); return; }
    if (lookupGuidance !== null && !list.deliberate) { announce(lookupGuidance); return; }
    const now = performance.now();
    const target = fireTarget(list, now);
    if (target.kind === "Fire") { fire(target.key, activation); return; }
    if (target.kind === "None") { fire(fallbackKey, activation); return; }
    pendingFire.current = setTimeout(() => {
      pendingFire.current = null;
      if (!visible.current) return;
      if (retired.current) { announce(RETIRED); return; }
      // The window has closed: the armed row once, whatever its age; nothing armed lands on the fallback.
      const list = latestList.current;
      latestFire.current(list.armed ?? fallbackKey, activation);
    }, Math.max(0, target.until - now));
  }

  /** Esc, the scrim and android back step back only to a palette that opened the page and has sent nothing this visit. */
  const dismissClosesImport = page.kind === "Import" && (page.origin === null || intake.hasAdmitted);

  /** A batch of two or more admitted through nexus says it has begun. */
  function admitImport(admission: Admission) {
    const listed = new Set(intake.lines.flatMap(line => line.source.kind === "Link" ? [line.source.url] : []));
    const links = admission.links.filter(link => !listed.has(new URL(link).href)).length;
    const files = admission.files.length;
    if (links + files >= 2) announceImport(files === 0 ? `importing ${spokenCount(links)} links.` : links === 0 ? `importing ${spokenCount(files)} files.` : `importing ${spokenCount(links + files)}.`);
    intake.admit(admission);
  }

  function back() {
    if (reorder.cancel()) return;
    if (rail !== null) { setRail(null); return; }
    const exit: Exit = { kind: "Root" };
    if (guardExit(exit) !== "accepted") return;
    setAnnouncement("");
    if (page.kind === "Import" && page.origin !== null) {
      const { mode, control, query: text } = page.origin;
      const sent = intake.hasAdmitted;
      setQuery(sent ? "" : text);
      // Search on a phone rests in its input. Otherwise the row: the one that opened
      // this page, or the import row if that row left with the query or never existed.
      rootFocus.current = viewport.isMobile && !sent && mode === "Typed" ? "Search"
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

  function consumeImportFeedback() {
    if (page.kind !== "Import" || intake.fieldLine === null) return false;
    intake.setFieldLine(null);
    return true;
  }

  /** Escape: the rail first, then a child page, then (phone) the text, then the palette. */
  function escape() {
    if (reorder.cancel()) return;
    if (rail !== null) { setRail(null); return; }
    if (consumeImportFeedback()) return;
    if (dismissClosesImport) requestExit({ kind: "Close" });
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
  // The held list keeps its ranking; the live import count decorates only its presentation.
  const importing = intake.unsettled;
  const counted = importing === 0 ? groups : groups.map(group => ({ ...group, rows: group.rows.map(row =>
    row.key !== "QuickAction:Nexus.Quick.Import" || row.detail != null ? row
      : { ...row, label: `import · ${importing}${viewport.isMobile ? "" : " importing"}`, name: `import, ${importing} importing` }) }));
  return {
    interactionLayer,
    open,
    isMobile: viewport.isMobile,
    hydrated: viewport.hydrated,
    query,
    page,
    rootMode,
    rootScroll,
    /** Held keys retain their band even when a fresh latch arrives before them. */
    list,
    groups: counted,
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
    recentStatus: { blank: !parsed.text, snapshot: recent.snapshot, readFailure: recent.readFailure, read: recent.read },
    searchProgress: find.progress,
    searchFailures: find.readFailures,
    localSearchFailures: find.localFailures,
    setComposing(value: boolean) {
      if (value) reorder.cancel({ restoreFocus: false });
      setComposing(value);
    },
    retrySearch: find.retrySearch,
    retryRelated: find.retryRelated,
    retrying: find.retrying,
    busy: find.busy,
    pending: find.pending,
    reorderSpeech,
    announce,
    announcement,
    announcementOccurrence,
    publishedAnnouncement,
    dialogLabel: page.kind === "Import" ? "import" : viewport.isMobile && page.kind !== "Root" ? "workspace task" : "Nexus",
    focusKey: `${page.kind}:${focusRevision}`,
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
    /** Explicit destination controls capture their own gesture, through the page's guard. */
    openTarget: (target: NexusTarget, activation: NexusTargetActivation = PROGRAMMATIC_NEXUS_TARGET_ACTIVATION) => requestExit({ kind: "Navigate", target, activation }),
    admitImport,
    announceImport,
    back,
    escape,
    close: () => requestExit({ kind: "Close" }),
    openRoot: () => requestExit({ kind: "Replace", intent: { kind: "Root" }, opener: null }),
    /** The sheet's dismissals: the rail, a child page, then the palette; back and escape clear text first (owner decision 7). */
    guardClose(reason: DismissRequestReason): DismissDecision {
      if (reorder.cancel()) return "blocked";
      if (rail !== null) { setRail(null); return "blocked"; }
      if (consumeImportFeedback()) return "blocked";
      if (dismissClosesImport) return guardExit({ kind: "Close" });
      if (page.kind !== "Root") { back(); return "blocked"; }
      if (query && (reason === "back" || reason === "escape")) { setQuery(""); return "blocked"; }
      return guardExit({ kind: "Close" });
    },
    dismissAccepted: () => performExit({ kind: "Close" }),
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
        return control(key) ?? container.querySelector<HTMLElement>("[data-switchboard-heading]");
      }
      if (transfer === "Heading") return container.querySelector<HTMLElement>("[data-switchboard-heading]");
      if (page.kind === "Import") return container.querySelector<HTMLElement>('[role="combobox"]');
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
      // The sheet opens keyboard-down: the armed row takes focus, else the heading, never the field (owner decision 6).
      if (viewport.isMobile) return control(armed) ?? container.querySelector<HTMLElement>("[data-switchboard-heading]");
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
    retryCapture: (intent: OpenIntent) => page.kind === "CaptureToday" && page.submit.kind === "Retryable" && capture({ ...page, activation: intent === "new_pane" ? { disposition: { kind: "Fork" } } : page.activation, submit: { kind: "Running", failure: page.submit.failure, unconfirmed: page.submit.unconfirmed, failures: page.submit.failures } }),
    closePane,
    restoreClosedPane: restoreClosed,
    activateAdjacentPane(input: Parameters<typeof workspace.activateAdjacentPane>[0]) {
      if (hasWorkspaceNavigationBlocker()) return null;
      reorder.cancel({ silent: true });
      return workspace.activateAdjacentPane(input);
    },
  };
}
