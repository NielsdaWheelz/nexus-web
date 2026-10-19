"use client";

// The Nexus session: open/closed, the page state machine, the stable result list, and the
// one activation core every row, choice, keybinding, open request and workflow goes through.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { openAsyncResult, type OpenResult } from "@/lib/panes/openResult";
import { apiTransportFeedback, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createLibrary } from "@/lib/libraries/api";
import { useNexusOpenRequests } from "@/lib/nexus/events";
import {
  type MaterializedOpenDailyPageTarget,
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
import { NEXUS_COMMANDS, nexusQueryTarget, parseNexusQuery } from "@/lib/nexus/query";
import { candidateRows, choiceRows, EMPTY_LIST, mergeResults, nexusGroups, playbackRow, queryActions } from "@/lib/nexus/rows";
import { TRANSPORT_CODES, useNexusFind } from "@/lib/nexus/useNexusFind";
import { captureToday, createPage as createNotePage, dailyDateFor } from "@/lib/notes/api";
import { playingEpisode, usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import { useRenderEnvironment, useViewportState } from "@/lib/renderEnvironment/provider";
import { formatShortcut, matchesShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { getInteractionGeneration, hasActiveInteractionOwner, isTopmostInteractionOwner } from "@/lib/ui/overlay";
import type { DismissDecision, Layer } from "@/lib/ui/overlay";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useLatestWorkspace, useSubscribeWorkspace, useWorkspaceStore, type WorkspaceSelection } from "@/lib/workspace/store";
import { useWorkspacePresentations } from "@/lib/workspace/presentations";
import { resolveAddPanelInitialFocus, type AddDismissalConfirmation } from "./AddPanel";
import { useAddContentSession } from "./useAddContentSession";

const ADOPT: NexusTargetActivation = { disposition: { kind: "Adopt" } };
const CREATE_CODES = [...TRANSPORT_CODES, "E_FORBIDDEN", "E_LIBRARY_FORBIDDEN", "E_INVALID_REQUEST", "E_RESOURCE_CONFLICT"];
const FORBIDDEN = "This account can’t make that change.";
const CREATE_FAILURE_COPY: Record<string, string | undefined> = {
  E_FORBIDDEN: FORBIDDEN,
  E_LIBRARY_FORBIDDEN: FORBIDDEN,
  E_INVALID_REQUEST: "Review the request and retry.",
  E_NAME_INVALID: "Enter a non-reserved library name between 1 and 100 characters.",
  E_RESOURCE_CONFLICT: "The saved create request conflicts with another resource.",
};

type Dispatchable = Extract<NexusTarget, { kind: "InternalHref" | "PaneOpen" }> | MaterializedOpenDailyPageTarget;
/** What leaving the current page means; leaving Add may first need the user's confirmation. */
type Exit =
  | { readonly kind: "Close" }
  | { readonly kind: "Root" }
  | { readonly kind: "Replace"; readonly intent: NexusOpenIntent }
  | { readonly kind: "Navigate"; readonly target: NexusTarget; readonly activation: NexusTargetActivation };

export type NexusController = ReturnType<typeof useNexusController>;

export function useNexusController() {
  const { ctx } = useActionRuntime();
  const interactionLayer = useRef<Layer | null>(null);
  const { calendarTimeZone } = useAuthenticatedAccount();
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
  const [page, setPage] = useState<NexusPage>({ kind: "Root" });
  const currentPage = useRef(page);
  currentPage.current = page;
  const visible = useRef(open);
  visible.current = open;
  const [rootMode, setRootMode] = useState<NexusRootMode>("Overview");
  const [focusRevision, setFocusRevision] = useState(0);
  const [list, setList] = useState(EMPTY_LIST);
  const [menuRequest, setMenuRequest] = useState<{ readonly seq: number; readonly key: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pendingExit, setPendingExit] = useState<{ readonly confirmation: NonNullable<AddDismissalConfirmation>["kind"]; readonly exit: Exit } | null>(null);
  const [addDefect, setAddDefect] = useState<{ readonly sessionId: string; readonly error: unknown } | null>(null);
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);
  const suppressReturnFocus = useRef(false);
  const pendingPaneFocus = useRef<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const rootFocus = useRef<string | null>(null);
  const rootScroll = useRef({ Overview: 0, Search: 0 });
  const shell = useRef(viewport.isMobile);
  const transferFocus = useRef<"Field" | "Heading" | null>(null);
  // Capture editing before the retiring shell's DOM disappears. Its return-focus
  // callback retains its old viewport value and yields to the replacement shell.
  if (shell.current !== viewport.isMobile) {
    if (open) transferFocus.current = document.activeElement?.matches("input, textarea, [contenteditable=true]") ? "Field" : "Heading";
    shell.current = viewport.isMobile;
  }
  useLayoutEffect(() => {
    if (transferFocus.current && viewport.isMobile && page.kind === "Root") setRootMode("Search");
  }, [viewport.isMobile, page.kind]);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) presentations.retryTitles();
    wasOpen.current = open;
  }, [open, presentations]);

  const parsed = useMemo(() => parseNexusQuery(query), [query]);
  const listIdentity = parsed.norm ? `${parsed.intent.kind}:${viewport.isMobile ? query : parsed.norm}` : "";
  const finding = open && page.kind === "Root" && (!viewport.isMobile || rootMode === "Search");
  const find = useNexusFind({ open: finding, query: parsed });
  const panes = useMemo<NexusPane[]>(
    () =>
      state.panes.map((pane) => ({
        id: pane.id,
        href: pane.current_visit.href,
        visibility: pane.visibility,
        presentation: presentations.forVisit(pane.current_visit),
        current: pane.id === state.active_primary_pane_id,
      })),
    [presentations, state],
  );
  useLayoutEffect(() => {
    if (!finding) return;
    setList((previous) => mergeResults(previous, listIdentity, candidateRows({
      query: parsed, panes, frecency: find.frecency, openables: find.openables, search: find.search,
      retained: viewport.isMobile && previous.identity === listIdentity
        ? previous.rows.filter((row) => (row.source === "Oracle" && !find.openablesReady) || (row.source === "Search" && !find.ownedReady))
        : [],
    })));
  }, [finding, listIdentity, parsed, panes, find.frecency, find.openables, find.search, find.openablesReady, find.ownedReady, viewport.isMobile]);

  // Navigation from outside the launcher's own tab commands (such as a resource
  // menu's Open or Chat) closes it so focus can follow the new pane.
  const activePane = state.panes.find((pane) => pane.id === state.active_primary_pane_id);
  const navigationToken = `${state.active_primary_pane_id}\0${activePane?.current_visit.id ?? ""}`;
  const navigationHasEntry = workspace.pendingPaneEntryDeliveryByPaneId.get(state.active_primary_pane_id)?.visitId === activePane?.current_visit.id;
  const navigationBaseline = useRef(navigationToken);
  useEffect(() => {
    if (open && navigationToken !== navigationBaseline.current) {
      pendingPaneFocus.current = navigationHasEntry ? null : state.active_primary_pane_id;
      suppressReturnFocus.current = true;
      setOpen(false);
    }
    navigationBaseline.current = navigationToken;
  }, [navigationToken, navigationHasEntry, open, state.active_primary_pane_id]);

  // A resource action can deliver a new arrival without changing the visit.
  // Observe the commit before the destination claims it in its layout effect.
  useLayoutEffect(() => {
    if (!open) return;
    let previous = latestWorkspace().pendingPaneEntryDeliveryByPaneId;
    return subscribeWorkspace(() => {
      const current = latestWorkspace();
      const paneId = current.state.active_primary_pane_id;
      const delivery = current.pendingPaneEntryDeliveryByPaneId.get(paneId);
      const prior = previous.get(paneId);
      previous = current.pendingPaneEntryDeliveryByPaneId;
      if (!delivery || delivery.activationId === prior?.activationId ||
        delivery.visitId !== current.state.panes.find((pane) => pane.id === paneId)?.current_visit.id) return;
      pendingPaneFocus.current = null;
      suppressReturnFocus.current = true;
      setOpen(false);
    });
  }, [latestWorkspace, open, subscribeWorkspace]);

  function keepWorkspaceSelection(selection: WorkspaceSelection): WorkspaceSelection {
    navigationBaseline.current = `${selection.paneId}\0${selection.visitId}`;
    return selection;
  }

  // Explicit Open also leaves the launcher when the pane was already active.
  // Let its close and a destination companion's admission finish before focus.
  useEffect(() => {
    if (open || pendingPaneFocus.current === null) return;
    const paneId = pendingPaneFocus.current;
    pendingPaneFocus.current = null;
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

  const playback = player.state.kind === "Loaded" && player.state.phase === "Paused" ? playingEpisode(player.state) : null;
  const groups = nexusGroups({
    desktop: !viewport.isMobile,
    mobileMode: rootMode,
    query: parsed,
    list,
    panes,
    playback: playback && playbackRow(playback.title, playback.subtitle !== null ? playback.subtitle : undefined),
    recent: find.recent,
    frecency: find.frecency,
  });
  const rows = groups.flatMap((group) => group.rows);
  const activeKey = rows.some((row) => row.key === list.active) ? list.active : (rows[0]?.key ?? null);

  function dispatch(target: Dispatchable, activation: NexusTargetActivation): string {
    if (target.kind === "OpenDailyPage") {
      const { entry } = target;
      return workspace.activateWorkspaceTarget({
        originPaneId: state.active_primary_pane_id,
        target: { href: `/daily/${target.date.value}` },
        disposition: activation.disposition,
        ...(entry.kind === "View" ? {} : { entry }),
      }).paneId;
    }
    if (target.kind === "PaneOpen") {
      const pane = panes.find((candidate) => candidate.id === target.paneId)!;
      if (activation.disposition.kind === "Fork") {
        const visit = state.panes.find((candidate) => candidate.id === pane.id)!.current_visit;
        return dispatch({ kind: "InternalHref", href: pane.href, labelHint: visit.title_hint ?? undefined }, activation);
      }
      workspace.activatePane(pane.id);
      return pane.id;
    }
    return workspace.activateWorkspaceTarget({
      originPaneId: state.active_primary_pane_id,
      target: { href: target.href, labelHint: target.labelHint, secondaryActivation: target.secondaryActivation },
      disposition: activation.disposition,
      entry: target.entry,
    }).paneId;
  }

  function finishNavigation(paneId: string, editorEntry: boolean): void {
    visible.current = false;
    pendingPaneFocus.current = editorEntry ? null : paneId;
    suppressReturnFocus.current = true;
    addSession.discard();
    setPage({ kind: "Root" });
    setOpen(false);
  }

  function rootOrigin(row: NexusRow | undefined): NexusRootOrigin {
    const control = row?.key === "QuickAction:New" ? "New"
      : row?.key.startsWith("Continuation:") ? "UseText"
        : row?.key ?? "Search";
    return { mode: !open ? "Overview" : viewport.isMobile ? rootMode : "Search", control };
  }

  /** The one activation core. */
  function run(target: NexusTarget, activation: NexusTargetActivation, row?: NexusRow) {
    setAnnouncement("");
    switch (target.kind) {
      case "OpenAdd":
        setPage({ kind: "Add", sessionId: addSession.start(target.seed), activation });
        return setOpen(true);
      case "CreatePage":
        createPage(crypto.randomUUID(), target.titleDraft, activation);
        return setOpen(true);
      case "CreateLibrary":
        setPage({ kind: "CreateLibrary", libraryId: crypto.randomUUID(), name: target.nameDraft, activation, submit: { kind: "Ready" }, returnTo: page.kind === "ChooseCreate" ? page : { kind: "Root", origin: rootOrigin(row) } });
        return setOpen(true);
      case "ChooseCreate":
        setPage({ kind: "ChooseCreate", draft: target.initialDraft, origin: rootOrigin(row), activation });
        return setOpen(true);
      case "ChooseBrowse":
        setPage({ kind: "ChooseBrowse", query: target.query, origin: rootOrigin(row) });
        return setOpen(true);
      case "ManageTabs":
        setPage({ kind: "ManageTabs" });
        return setOpen(true);
      case "ResumeCurrentPlayback":
        playerCommands.resume();
        return setOpen(false);
    }
    const text = target.kind === "OpenDailyPage" && target.entry.kind === "AppendNote" ? target.entry.initialText.trim() : "";
    if (target.kind === "OpenDailyPage" && text) {
      const localDate = dailyDateFor(target.date, calendarTimeZone);
      // the launcher waits on the capture; the query and its search are done with.
      setQueryState("");
      setList(EMPTY_LIST);
      capture({ kind: "CaptureToday", text, noteId: crypto.randomUUID(), localDate, activation, submit: { kind: "Running" } });
      return setOpen(true);
    }
    const materialized: Dispatchable =
      target.kind === "OpenDailyPage"
        ? {
            kind: "OpenDailyPage",
            date: { kind: "LocalDate", value: dailyDateFor(target.date, calendarTimeZone) },
            entry: target.entry.kind === "View" ? target.entry : { kind: "AppendNote" },
          }
        : target;
    const paneId = dispatch(materialized, activation);
    finishNavigation(paneId, materialized.kind === "OpenDailyPage" ? materialized.entry.kind !== "View" : materialized.kind === "InternalHref" && materialized.entry !== undefined);
    if (!row?.source) return;
    const pane = materialized.kind === "PaneOpen" ? panes.find((pane) => pane.id === materialized.paneId)! : null;
    const href = materialized.kind === "InternalHref" ? materialized.href : pane?.href ?? null;
    let settledLabel: string | null = row.label;
    if (pane) {
      const visit = state.panes.find((candidate) => candidate.id === pane.id)!.current_visit;
      settledLabel = visit.title_hint ?? (pane.presentation.status === "Ready" ? pane.presentation.title : null);
    }
    if (href && settledLabel !== null) find.remember({ query: parsed.text || null, target_href: href, label_snapshot: settledLabel, source: row.source });
  }

  /** Quick note with text: one append to the day, then the day at that note (the
   * launcher keeps the text with Retry, under the same note id, when it fails). */
  function capture(running: Extract<NexusPage, { kind: "CaptureToday" }>) {
    void openCreated(running, async () => {
      await captureToday(running.localDate, running.noteId, running.text);
      return { target: { href: `/daily/${running.localDate}` }, title: "note added to today", openLabel: "open today",
        entry: { kind: "FocusNote", noteBlockId: running.noteId } };
    }).catch((error: unknown) => {
        if (currentPage.current !== running || ctx.sessionSignal().aborted) return;
        const content = createFailure(error, "Note wasn’t added to Today", CREATE_CODES);
        if (content) setPage({ ...running, submit: { kind: "Retryable", content } });
      });
  }

  function openCreated(
    running: Extract<NexusPage, { kind: "CreatePage" | "CreateLibrary" | "CaptureToday" }>,
    create: () => Promise<OpenResult>,
  ) {
    currentPage.current = running;
    visible.current = true;
    setPage(running);
    const originPaneId = latestWorkspace().state.active_primary_pane_id;
    return openAsyncResult({
      ctx, originPaneId, intent: running.activation.disposition.kind === "Fork" ? "new_pane" : "default",
      disposition: running.activation.disposition.kind === "Adopt" ? "Adopt" : "Follow",
      subject: running.kind === "CreatePage" ? running.title : running.kind === "CreateLibrary" ? running.name : running.text,
      initiatingLayer: interactionLayer.current,
      mayOpen: () => visible.current && currentPage.current === running,
      beforeOpen: () => {
        suppressReturnFocus.current = true;
        addSession.discard();
        setPage({ kind: "Root" });
        setOpen(false);
      },
      onDefault: result => {
        const landed = latestWorkspace().activateWorkspaceTarget({
          originPaneId, target: result.target, entry: result.entry, disposition: running.activation.disposition,
        });
        finishNavigation(landed.paneId, result.entry !== undefined);
      },
      create,
    });
  }

  /** Nexus copy for an expected create failure; anything else becomes a workspace defect. */
  function createFailure(error: unknown, title: string, codes: readonly string[]): FeedbackContent | null {
    if (handleUnauthenticatedApiError(error)) return null;
    if (isApiError(error) && codes.includes(error.code)) {
      const content = apiTransportFeedback(error, title);
      if (content !== null) return content;
      const message = CREATE_FAILURE_COPY[error.code];
      if (message !== undefined) return { tone: "Danger", title, message, requestId: error.requestId };
    }
    // justify-defect: creation admits only declared outcomes with complete feedback.
    setDefect({ error });
    return null;
  }

  function createPage(pageId: string, titleDraft: string, activation: NexusTargetActivation, content?: FeedbackContent) {
    const title = titleDraft.trim() || "Untitled";
    const running = { kind: "CreatePage", pageId, title, activation, submit: { kind: "Running", content } } as const;
    void openCreated(running, async () => {
      const created = await createNotePage(pageId, title);
      return { target: { href: `/pages/${created.id}`, labelHint: created.title }, title: "page created", openLabel: "open page",
        entry: { kind: "EditPageTitle", pageId: created.id } };
    }).catch((error: unknown) => {
        if (currentPage.current !== running || ctx.sessionSignal().aborted) return;
        const content = createFailure(error, "Page couldn’t be created", CREATE_CODES);
        if (content) setPage({ kind: "CreatePage", pageId, title, activation, submit: { kind: "Retryable", content } });
      });
  }

  function submitLibrary(intent: OpenIntent) {
    if (page.kind !== "CreateLibrary" || page.submit.kind === "Running" || !page.name.trim()) return;
    const running = { ...page, name: page.name.trim(), activation: intent === "new_pane" ? { disposition: { kind: "Fork" } } as const : page.activation,
      submit: { kind: "Running", content: page.submit.kind === "Retryable" ? page.submit.content : undefined } } as const;
    void openCreated(running, async () => {
      const library = await createLibrary({ id: running.libraryId, name: running.name });
      return { target: { href: `/libraries/${library.id}`, labelHint: library.name }, title: "library created", openLabel: "open library" };
    }).catch((error: unknown) => {
        if (currentPage.current !== running || ctx.sessionSignal().aborted) return;
        const content = createFailure(error, "Library couldn’t be created", [...CREATE_CODES, "E_NAME_INVALID"]);
        if (content) setPage({ ...running, submit: { kind: "Retryable", content } });
      });
  }

  function guardExit(exit: Exit): DismissDecision {
    if (pendingExit) return "blocked";
    if (page.kind !== "Add") return "accepted";
    const confirmation = addSession.leaveReason;
    if (confirmation === null) return "accepted";
    setPendingExit({ confirmation, exit });
    return "blocked";
  }

  function performExit(exit: Exit) {
    setPendingExit(null);
    setAnnouncement("");
    if (exit.kind === "Navigate") return run(exit.target, exit.activation);
    if (exit.kind === "Replace") return openIntent(exit.intent);
    addSession.discard();
    if (exit.kind === "Root") {
      currentPage.current = { kind: "Root" };
      setPage(currentPage.current);
    } else { visible.current = false; setOpen(false); }
  }

  function requestExit(exit: Exit) {
    if (guardExit(exit) === "accepted") performExit(exit);
  }

  /** An open request resets to Root or Add. */
  function openIntent(intent: NexusOpenIntent) {
    if (!open) {
      opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      rootScroll.current = { Overview: 0, Search: 0 };
      suppressReturnFocus.current = false;
      transferFocus.current = null;
    }
    rootFocus.current = null;
    setRootMode("Overview");
    const nextPage: NexusPage = intent.kind === "Add"
      ? { kind: "Add", sessionId: addSession.start(intent.seed), activation: ADOPT }
      : { kind: "Root" };
    if (intent.kind !== "Add") addSession.discard();
    setQueryState("");
    setList(EMPTY_LIST);
    setPage(nextPage);
    setOpen(true);
    if (intent.kind === "QuickAction") run(NEXUS_COMMANDS[intent.actionId].target(""), ADOPT);
  }

  function setQuery(next: string) {
    setAnnouncement("");
    setQueryState(next);
    if (viewport.isMobile) setRootMode("Search");
    if (next !== query) rootScroll.current.Search = 0;
    setList((current) => (current.moved ? { ...current, moved: false } : current));
  }

  function setActive(key: string) {
    setList((current) => (current.active === key && current.moved ? current : { ...current, active: key, moved: true }));
  }

  function openMenu(key: string) {
    if (!rows.some((row) => row.key === key && row.secondary?.kind === "ResourceMenu")) return;
    setMenuRequest((current) => ({ seq: (current?.seq ?? 0) + 1, key }));
  }

  function back() {
    setAnnouncement("");
    if (page.kind === "Add") return requestExit({ kind: "Close" });
    if (page.kind === "CreateLibrary" && page.returnTo.kind === "ChooseCreate") {
      rootFocus.current = "Choice:library";
      return setPage(page.returnTo);
    }
    const origin = page.kind === "ChooseCreate" || page.kind === "ChooseBrowse" ? page.origin
      : page.kind === "CreateLibrary" && page.returnTo.kind === "Root" ? page.returnTo.origin
        : page.kind === "ManageTabs" ? { mode: "Overview", control: "AllTabs" } as const : null;
    if (origin) {
      setRootMode(origin.mode);
      rootFocus.current = origin.control;
    }
    requestExit({ kind: "Root" });
  }

  function escape() {
    if (page.kind !== "Root") back();
    else if (viewport.isMobile && rootMode === "Search") {
      rootFocus.current = null;
      setRootMode("Overview");
    }
    else if (viewport.isMobile) requestExit({ kind: "Close" });
    else if (query.trim()) setQuery("");
    else requestExit({ kind: "Close" });
  }

  function restoreClosed(paneId: string) {
    workspace.restoreClosedPane(paneId);
    finishNavigation(paneId, false);
  }

  function closePane(paneId: string) {
    const keys = rows.filter((row) => rootMode === "Search" || row.key.startsWith("Pane:")).map((row) => row.key);
    const index = keys.indexOf(`Pane:${paneId}`);
    const following = [...keys.slice(index + 1), ...keys.slice(0, index).reverse()];
    const selected = keepWorkspaceSelection(workspace.closePane(paneId));
    if (!viewport.isMobile || page.kind !== "Root") return selected;
    const generation = getInteractionGeneration();
    requestAnimationFrame(() => {
      if (generation !== getInteractionGeneration() || !isTopmostInteractionOwner("Nexus")) return;
      const controls = document.querySelectorAll<HTMLElement>("[data-nexus-control]");
      const control = (key: string) => [...controls].find((node) => node.dataset.nexusControl === key && !node.closest("[hidden], [inert]"));
      const target = following.map(control).find(Boolean)
        ?? control(rootMode === "Search" ? "Search" : "AllTabs");
      target?.focus({ preventScroll: true });
    });
    return selected;
  }

  const keydown = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keydown.current = (event) => {
    if (!matchesShortcut(SHORTCUTS["Nexus.Open"], event, platform)) return;
    if (hasActiveInteractionOwner() && !isTopmostInteractionOwner("Nexus")) return;
    event.preventDefault();
    if (event.repeat) return;
    const activeRow = rows.find((row) => row.key === activeKey);
    if (!open) {
      requestExit({ kind: "Replace", intent: { kind: "Root" } });
      if (viewport.isMobile) {
        rootFocus.current = "Search";
        setRootMode("Search");
      }
    } else if (page.kind === "Root" && viewport.isMobile) {
      rootFocus.current = "Search";
      setRootMode("Search");
      setFocusRevision((value) => value + 1);
    } else if (page.kind === "Root" && activeRow?.secondary?.kind === "ResourceMenu") openMenu(activeRow.key);
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keydown.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  useNexusOpenRequests((intent) => requestExit({ kind: "Replace", intent }), viewport.hydrated);
  useEffect(() => {
    if (open) suppressReturnFocus.current = false;
  }, [open]);

  if (defect) throw defect.error;
  const addActivation = page.kind === "Add" ? page.activation : ADOPT;
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
    menuRequest,
    choices: choiceRows(page, viewport.isMobile),
    textActions: queryActions(parsed, false).slice(0, 4),
    explicitIntent: parsed.intent.kind !== "Search",
    failures: find.failures,
    retrying: find.retrying,
    busy: find.busy,
    pending: find.pending,
    announcement,
    dialogLabel: page.kind === "Add" ? "Add content" : viewport.isMobile ? page.kind === "Root" ? rootMode === "Overview" ? "workspace" : "search" : "workspace task" : "Nexus",
    focusKey: page.kind === "Add" ? addSession.state.sessionId : `${page.kind}:${rootMode}:${focusRevision}`,
    openShortcut: formatShortcut(SHORTCUTS["Nexus.Open"], platform),
    addSession,
    addDefect: addDefect?.sessionId === addSession.state.sessionId,
    dismissalConfirmation: (pendingExit && {
      kind: pendingExit.confirmation,
      actionLabel:
        pendingExit.confirmation === "Discard"
          ? "discard"
          : pendingExit.confirmation === "Unconfirmed"
            ? "leave"
            : pendingExit.exit.kind === "Close" || pendingExit.exit.kind === "Navigate"
              ? "stop and close"
              : pendingExit.exit.kind === "Replace"
                ? "stop and continue"
                : "stop and go back",
    }) satisfies AddDismissalConfirmation,
    panes,
    workspaceState: state,
    titlesFailed: panes.some((pane) => pane.presentation.status === "Failed"),
    retryTitles: presentations.retryTitles,
    closedPanes: workspace.recentlyClosedPanes.map((snapshot) => ({
      id: snapshot.pane.id,
      presentation: presentations.forVisit(snapshot.pane.current_visit),
    })),
    setQuery,
    enterSearch: () => setRootMode("Search"),
    submitSearch(activation: NexusTargetActivation = { disposition: { kind: "Follow" } }) {
      const target = nexusQueryTarget(parsed);
      if (target) run(target, activation);
    },
    setActive,
    openMenu,
    retry: find.retry,
    activate(action: NexusAction, activation: NexusTargetActivation, row?: NexusRow) {
      if (action.kind === "Unavailable") setAnnouncement(action.reason);
      else run(action.target, page.kind === "ChooseCreate" && page.activation.disposition.kind === "Fork" ? page.activation : activation, row);
    },
    /** The mobile account menu: adopt a destination, through the Add guard. */
    openTarget: (target: NexusTarget, activation: NexusTargetActivation = addActivation) => requestExit({ kind: "Navigate", target, activation }),
    openAddTarget: (target: NexusTarget, intent: OpenIntent) => requestExit({ kind: "Navigate", target, activation: intent === "new_pane" ? { disposition: { kind: "Fork" } } : ADOPT }),
    back,
    escape,
    close: () => requestExit({ kind: "Close" }),
    openRoot: () => requestExit({ kind: "Replace", intent: { kind: "Root" } }),
    /** Native keyboard dismissal precedes this task-owned Back transition. */
    guardClose(): DismissDecision {
      setAnnouncement("");
      if (page.kind === "Add") return guardExit({ kind: "Close" });
      if (page.kind === "Root" && rootMode === "Search") {
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
    keepWorking: () => setPendingExit(null),
    confirmDismissal() {
      if (!pendingExit) return;
      if (pendingExit.confirmation === "Stop") addSession.stop();
      performExit(pendingExit.exit);
    },
    suppressReturnFocus: () => suppressReturnFocus.current || shell.current !== viewport.isMobile,
    returnFocusTo: () => opener.current,
    returnFocusFallback: () => findPaneLandmarkFocusTarget(state.active_primary_pane_id),
    initialFocus(container: HTMLElement): HTMLElement | null {
      const transfer = transferFocus.current;
      transferFocus.current = null;
      if (transfer === "Heading") return container.querySelector<HTMLElement>("[data-switchboard-heading], [data-add-heading]");
      if (page.kind === "Add") {
        return resolveAddPanelInitialFocus(container, transfer === "Field" ? false : viewport.isMobile);
      }
      const control = rootFocus.current;
      rootFocus.current = null;
      if (control && viewport.isMobile) {
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
      setPage((current) =>
        current.kind !== "CreateLibrary" || current.submit.kind === "Running"
          ? current
          : {
              ...current,
              name,
              libraryId: current.submit.kind === "Retryable" && name !== current.name ? crypto.randomUUID() : current.libraryId,
              submit: { kind: "Ready" },
            },
      );
    },
    submitLibrary,
    retryPage: (intent: OpenIntent) => page.kind === "CreatePage" && page.submit.kind === "Retryable" && createPage(page.pageId, page.title, intent === "new_pane" ? { disposition: { kind: "Fork" } } : page.activation, page.submit.content),
    retryCapture: (intent: OpenIntent) => page.kind === "CaptureToday" && page.submit.kind === "Retryable" && capture({ ...page, activation: intent === "new_pane" ? { disposition: { kind: "Fork" } } : page.activation, submit: { kind: "Running", content: page.submit.content } }),
    reportAddDefect(error: unknown) {
      console.error("Add content contract failed:", error);
      setAddDefect({ sessionId: addSession.state.sessionId, error });
    },
    clearAddDefect: () => setAddDefect(null),
    manageTabs: () => setPage({ kind: "ManageTabs" }),
    openPane(paneId: string) {
      run({ kind: "PaneOpen", paneId }, { disposition: { kind: "Follow" } });
    },
    closePane,
    minimizePane: (paneId: string) => keepWorkspaceSelection(workspace.minimizePane(paneId)),
    restorePane(paneId: string) {
      workspace.restorePane(paneId);
      const { state } = latestWorkspace();
      const active = state.panes.find((pane) => pane.id === state.active_primary_pane_id)!;
      keepWorkspaceSelection({ paneId: active.id, visitId: active.current_visit.id });
    },
    movePane(input: { paneId: string; beforePaneId: string | null }) {
      if (!workspace.movePane(input)) return;
      const { state } = latestWorkspace();
      const index = state.panes.findIndex((pane) => pane.id === input.paneId);
      const label = presentations.forVisit(state.panes[index]!.current_visit).title;
      setAnnouncement(`Moved ${label} to position ${index + 1} of ${state.panes.length}.`);
    },
    restoreClosedPane: restoreClosed,
    activateAdjacentPane: workspace.activateAdjacentPane,
  };
}
