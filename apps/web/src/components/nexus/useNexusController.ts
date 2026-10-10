"use client";

// The Nexus session: open/closed, the page state machine, the stable result list, and the
// one activation core every row, choice, keybinding, open request and workflow goes through.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { MobileQuickNoteHandoffHandle } from "@/components/switchboard/MobileQuickNoteHandoff";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiTransportFeedback, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { matchesKeyEvent } from "@/lib/keybindings";
import { useKeybindings, useKeybindingsController } from "@/lib/keybindingsProvider";
import { createLibrary } from "@/lib/libraries/client";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import { useNexusOpenRequests } from "@/lib/nexus/events";
import {
  PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
  type MaterializedOpenDailyPageTarget,
  type NexusAction,
  type NexusCommandId,
  type NexusDispatchOutcome,
  type NexusOpenIntent,
  type NexusPage,
  type NexusPane,
  type NexusRow,
  type NexusTarget,
  type NexusTargetActivation,
  type Retained,
  type TodayAppend,
} from "@/lib/nexus/model";
import { NEXUS_COMMANDS, parseNexusQuery } from "@/lib/nexus/query";
import { candidateRows, choiceRows, EMPTY_LIST, mergeResults, nexusGroups, playbackRow } from "@/lib/nexus/rows";
import { TRANSPORT_CODES, useNexusFind } from "@/lib/nexus/useNexusFind";
import { createNotePage } from "@/lib/notes/api";
import { DailyDraftStorageError, readDailyDraft, subscribeDailyDraft } from "@/lib/notes/dailyDraftStore";
import { resolveDailyLocalDate, useOpenDailyPage } from "@/lib/notes/openDailyPage";
import { setPendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { playingEpisode, usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import { useViewportState } from "@/lib/renderEnvironment/provider";
import { dailyDraftAcceptsText } from "@/lib/resourceSurface/dailySurfacePersistence";
import type { DismissDecision } from "@/lib/ui/useHistoryDismiss";
import { resolveWorkspacePaneLabel, useWorkspaceStore } from "@/lib/workspace/store";
import { resolveAddPanelInitialFocus, type AddDismissalConfirmation } from "./AddPanel";
import { useAddContentSession } from "./useAddContentSession";

const ADOPT: NexusTargetActivation = { disposition: { kind: "Adopt" } };
const TODAY_DRAFT_OPEN = "Open Today to finish the current embedded draft";
const STORAGE_UNAVAILABLE = "Device storage is unavailable. Open Today to review any unsaved text.";
const CREATE_CODES = [...TRANSPORT_CODES, "E_FORBIDDEN", "E_LIBRARY_FORBIDDEN", "E_INVALID_REQUEST", "E_RESOURCE_CONFLICT"];
const FORBIDDEN = "This account can’t make that change.";
const CREATE_FAILURE_COPY: Record<string, string | undefined> = {
  E_FORBIDDEN: FORBIDDEN,
  E_LIBRARY_FORBIDDEN: FORBIDDEN,
  E_INVALID_REQUEST: "Review the request and retry.",
  E_NAME_INVALID: "Enter a non-reserved library name between 1 and 100 characters.",
  E_RESOURCE_CONFLICT: "The saved create request conflicts with another resource.",
};

type Completion = Retained["completion"];
type Dispatchable = Extract<NexusTarget, { kind: "InternalHref" | "PaneOpen" }> | MaterializedOpenDailyPageTarget;
/** What leaving the current page means; leaving Add may first need the user's confirmation. */
type Exit =
  | { readonly kind: "Close" }
  | { readonly kind: "Root" }
  | { readonly kind: "Replace"; readonly intent: NexusOpenIntent }
  | { readonly kind: "Navigate"; readonly target: NexusTarget; readonly activation: NexusTargetActivation; readonly completion: Completion };

function readToday(accountId: string, localDate: string) {
  try {
    return { draft: readDailyDraft(accountId, localDate), storageUnavailable: false };
  } catch (error) {
    if (!(error instanceof DailyDraftStorageError)) throw error;
    return { draft: null, storageUnavailable: true };
  }
}

export type NexusController = ReturnType<typeof useNexusController>;

export function useNexusController() {
  const { accountId, calendarTimeZone } = useAuthenticatedAccount();
  const viewport = useViewportState();
  const keybindings = useKeybindings();
  const { labelFor } = useKeybindingsController();
  const player = usePlayerSession();
  const playerCommands = usePlayerCommands();
  const openDailyPage = useOpenDailyPage();
  const addSession = useAddContentSession();
  const workspace = useWorkspaceStore();
  const { state, runtimeLabelByPaneId } = workspace;

  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [page, setPage] = useState<NexusPage>({ kind: "Root" });
  const [list, setList] = useState(EMPTY_LIST);
  const [menuRequest, setMenuRequest] = useState<{ readonly seq: number; readonly key: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pendingExit, setPendingExit] = useState<{ readonly confirmation: "Discard" | "Stop"; readonly exit: Exit } | null>(null);
  const [addDefect, setAddDefect] = useState<{ readonly sessionId: string; readonly error: unknown } | null>(null);
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);
  const todayDate = resolveDailyLocalDate({ kind: "Today" }, calendarTimeZone);
  const [today, setToday] = useState(() => readToday(accountId, todayDate));
  const suppressReturnFocus = useRef(false);
  const handoff = useRef<MobileQuickNoteHandoffHandle>(null);

  const parsed = useMemo(() => parseNexusQuery(query), [query]);
  const listIdentity = parsed.norm ? `${parsed.intent.kind}:${parsed.norm}` : "";
  const find = useNexusFind({ open, query: parsed });
  const panes = useMemo<NexusPane[]>(
    () =>
      state.panes.map((pane) => ({
        id: pane.id,
        href: pane.currentVisit.href,
        visibility: pane.visibility,
        label: resolveWorkspacePaneLabel(pane, runtimeLabelByPaneId).label,
        current: pane.id === state.activePrimaryPaneId,
      })),
    [runtimeLabelByPaneId, state],
  );
  const hints = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(NEXUS_COMMANDS).flatMap((id) => {
          const label = labelFor(id);
          return label ? [[id, label]] : [];
        }),
      ) as Partial<Record<NexusCommandId, string>>,
    [labelFor],
  );
  const candidates = useMemo(
    () => candidateRows({ query: parsed, panes, frecency: find.frecency, hints, openables: find.openables, search: find.search }),
    [find.frecency, find.openables, find.search, hints, panes, parsed],
  );
  useLayoutEffect(() => setList((previous) => mergeResults(previous, listIdentity, candidates)), [candidates, listIdentity]);

  useEffect(() => {
    setToday(readToday(accountId, todayDate));
    return subscribeDailyDraft(accountId, todayDate, (draft, storageUnavailable) => setToday({ draft, storageUnavailable }));
  }, [accountId, open, todayDate]);
  const todayAppend: TodayAppend = today.storageUnavailable
    ? { kind: "Unavailable", reason: STORAGE_UNAVAILABLE }
    : today.draft === null || dailyDraftAcceptsText(today.draft)
      ? { kind: "Available" }
      : { kind: "Unavailable", reason: TODAY_DRAFT_OPEN };

  // A navigation that lands while the Nexus is open (a resource menu's Open or Chat, closing
  // the current tab) must not sit behind it: close, and let focus follow the new pane.
  const activePane = state.panes.find((pane) => pane.id === state.activePrimaryPaneId);
  const navigationToken = `${state.activePrimaryPaneId}\0${activePane?.currentVisit.id ?? ""}`;
  const navigationBaseline = useRef(navigationToken);
  useEffect(() => {
    if (open && navigationToken !== navigationBaseline.current) {
      suppressReturnFocus.current = true;
      setOpen(false);
    }
    navigationBaseline.current = navigationToken;
  }, [navigationToken, open]);

  const playback = player.state.kind === "Loaded" && player.state.phase === "Paused" ? playingEpisode(player.state) : null;
  const groups = nexusGroups({
    desktop: !viewport.isMobile,
    query: parsed,
    list,
    panes,
    playback: playback && playbackRow(playback.title, playback.subtitle.kind === "Present" ? playback.subtitle.value : undefined),
    recent: find.recent,
    frecency: find.frecency,
    hints,
    todayAppend,
  });
  const rows = groups.flatMap((group) => group.rows);
  const activeKey = rows.some((row) => row.key === list.active) ? list.active : (rows[0]?.key ?? null);

  function dispatch(target: Dispatchable, activation: NexusTargetActivation): NexusDispatchOutcome {
    if (target.kind === "OpenDailyPage") {
      const opened = openDailyPage(target, activation);
      return opened.activation.kind === "Rejected"
        ? { kind: "Rejected", target }
        : { kind: "DailyPageAccepted", activationId: opened.activationId, localDate: opened.localDate };
    }
    if (target.kind === "PaneOpen") {
      const pane = panes.find((candidate) => candidate.id === target.paneId)!;
      if (activation.disposition.kind === "Fork") {
        return dispatch({ kind: "InternalHref", href: pane.href, labelHint: pane.label }, activation);
      }
      if (pane.visibility === "minimized") workspace.restorePane(pane.id);
      else workspace.activatePane(pane.id);
      return { kind: "Accepted" };
    }
    const result = workspace.activateWorkspaceTarget({
      originPaneId: state.activePrimaryPaneId,
      target: { href: target.href, labelHint: target.labelHint },
      disposition: activation.disposition,
    });
    return result.kind === "Rejected" ? { kind: "Rejected", target } : { kind: "Accepted" };
  }

  /** Close on acceptance; keep a tab-limit refusal as the Blocked page; open the Nexus for any page. */
  function settle(outcome: NexusDispatchOutcome, activation: NexusTargetActivation, completion: Completion): boolean {
    if (outcome.kind === "Accepted" || outcome.kind === "DailyPageAccepted") {
      suppressReturnFocus.current = true;
      addSession.discard();
      setPage({ kind: "Root" });
      setOpen(false);
      return true;
    }
    setPage({ kind: "Blocked", retained: { target: outcome.target, activation, completion } });
    setOpen(true);
    return false;
  }

  /**
   * The one activation core. On a mobile gesture that appends to Today, focusing the hidden
   * handoff input is the first side effect, so the soft keyboard survives into the Today editor.
   */
  function run(target: NexusTarget, activation: NexusTargetActivation, origin: HTMLElement | null, row?: NexusRow, completion: Completion = "Destination") {
    const note = origin && target.kind === "OpenDailyPage" && target.entry.kind === "AppendNote" ? handoff.current : null;
    note?.focus();
    setAnnouncement("");
    switch (target.kind) {
      case "OpenAdd":
        setPage({ kind: "Add", sessionId: addSession.start(target.seed), activation });
        return setOpen(true);
      case "CreatePage":
        createPage(crypto.randomUUID(), target.titleDraft, activation);
        return setOpen(true);
      case "CreateLibrary":
        setPage({ kind: "CreateLibrary", libraryId: crypto.randomUUID(), name: target.nameDraft, activation, submit: { kind: "Ready" } });
        return setOpen(true);
      case "ChooseCreate":
        setPage({ kind: "ChooseCreate", draft: target.initialDraft });
        return setOpen(true);
      case "ChooseBrowse":
        setPage({ kind: "ChooseBrowse", query: target.query });
        return setOpen(true);
      case "ManageTabs":
        setPage({ kind: "ManageTabs", retained: null, restoreBlocked: null });
        return setOpen(true);
      case "ResumeCurrentPlayback":
        playerCommands.resume();
        return setOpen(false);
    }
    let materialized: Dispatchable;
    try {
      materialized = target.kind === "OpenDailyPage" ? materializeDaily(target) : target;
    } catch (error) {
      if (!(error instanceof DailyDraftStorageError)) throw error;
      setAnnouncement(STORAGE_UNAVAILABLE);
      note?.cancel(origin);
      return;
    }
    const append = materialized.kind === "OpenDailyPage" && materialized.entry.kind === "AppendNote" ? { ...materialized, entry: materialized.entry } : null;
    if (note && append) note.prepare(append);
    const outcome = dispatch(materialized, activation);
    if (note && append) {
      if (outcome.kind === "DailyPageAccepted") note.accept(append, outcome);
      else note.cancel(origin);
    }
    if (!settle(outcome, activation, completion) || !row?.source) return;
    const href = materialized.kind === "InternalHref" ? materialized.href : materialized.kind === "PaneOpen" ? panes.find((pane) => pane.id === materialized.paneId)!.href : null;
    if (href) find.remember({ query: parsed.text || null, target_href: href, label_snapshot: row.label, source: row.source });
  }

  function materializeDaily(target: Extract<NexusTarget, { kind: "OpenDailyPage" }>): MaterializedOpenDailyPageTarget {
    const date = { kind: "LocalDate", value: resolveDailyLocalDate(target.date, calendarTimeZone) } as const;
    if (target.entry.kind === "View") return { kind: "OpenDailyPage", date, entry: { kind: "View" } };
    const draft = readDailyDraft(accountId, date.value);
    return {
      kind: "OpenDailyPage",
      date,
      entry: {
        kind: "AppendNote",
        initialText: target.entry.initialText,
        noteId: draft?.noteId ?? crypto.randomUUID(),
        clientMutationId: draft?.clientMutationId ?? crypto.randomUUID(),
      },
    };
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

  function createPage(pageId: string, titleDraft: string, activation: NexusTargetActivation) {
    const title = titleDraft.trim() || "Untitled";
    setPage({ kind: "CreatePage", pageId, title, activation, submit: { kind: "Running" } });
    createNotePage({ pageId, title }).then(
      (created) => {
        setPendingNoteFocus(created.id, "title");
        run({ kind: "InternalHref", href: `/pages/${created.id}`, labelHint: created.title }, activation, null, undefined, "Page");
      },
      (error: unknown) => {
        const content = createFailure(error, "Page couldn’t be created", CREATE_CODES);
        if (content) setPage({ kind: "CreatePage", pageId, title, activation, submit: { kind: "Retryable", content } });
      },
    );
  }

  function submitLibrary() {
    if (page.kind !== "CreateLibrary" || page.submit.kind === "Running" || !page.name.trim()) return;
    const running = { ...page, name: page.name.trim(), submit: { kind: "Running" } } as const;
    setPage(running);
    createLibrary({ libraryId: running.libraryId, name: running.name }).then(
      (library) =>
        run({ kind: "InternalHref", href: `/libraries/${library.id}`, labelHint: library.name }, running.activation, null, undefined, "Library"),
      (error: unknown) => {
        const content = createFailure(error, "Library couldn’t be created", [...CREATE_CODES, "E_NAME_INVALID"]);
        if (content) setPage({ ...running, submit: { kind: "Retryable", content } });
      },
    );
  }

  function guardExit(exit: Exit): DismissDecision {
    if (pendingExit) return "blocked";
    if (page.kind !== "Add") return "accepted";
    const confirmation = addSession.state.mutation.kind === "Running" ? "Stop" : addSession.dirty ? "Discard" : null;
    if (confirmation === null) return "accepted";
    setPendingExit({ confirmation, exit });
    return "blocked";
  }

  function performExit(exit: Exit) {
    setPendingExit(null);
    setAnnouncement("");
    if (exit.kind === "Navigate") return run(exit.target, exit.activation, null, undefined, exit.completion);
    if (exit.kind === "Replace") return openIntent(exit.intent);
    addSession.discard();
    if (exit.kind === "Root") setPage({ kind: "Root" });
    else setOpen(false);
  }

  function requestExit(exit: Exit) {
    if (guardExit(exit) === "accepted") performExit(exit);
  }

  /** An open request resets to Root or Add; a Root request only reopens a tab-limit page. */
  function openIntent(intent: NexusOpenIntent) {
    if (intent.kind === "Root" && (page.kind === "Blocked" || page.kind === "ManageTabs")) return setOpen(true);
    addSession.discard();
    setQueryState("");
    setList(EMPTY_LIST);
    setPage(intent.kind === "Add" ? { kind: "Add", sessionId: addSession.start(intent.seed), activation: ADOPT } : { kind: "Root" });
    setOpen(true);
    if (intent.kind === "QuickAction") run(NEXUS_COMMANDS[intent.actionId].target(""), ADOPT, null);
  }

  function setQuery(next: string) {
    setAnnouncement("");
    setQueryState(next);
    setList((current) => (current.moved ? { ...current, moved: false } : current));
  }

  function setActive(key: string) {
    setList((current) => (current.active === key && current.moved ? current : { ...current, active: key, moved: true }));
  }

  function openMenu(key: string) {
    setMenuRequest((current) => ({ seq: (current?.seq ?? 0) + 1, key }));
  }

  function back() {
    setAnnouncement("");
    if (page.kind === "ManageTabs" && page.retained) setPage({ kind: "Blocked", retained: page.retained });
    else if (page.kind === "Blocked") setPage({ kind: "Root" });
    else requestExit({ kind: "Root" });
  }

  function escape() {
    if (page.kind !== "Root") back();
    else if (query.trim()) setQuery("");
    else requestExit({ kind: "Close" });
  }

  function retryRetained() {
    const retained = page.kind === "Blocked" || page.kind === "ManageTabs" ? page.retained : null;
    if (retained) settle(dispatch(retained.target, retained.activation), retained.activation, retained.completion);
  }

  function restoreClosed(paneId: string) {
    const blocked = workspace.restoreClosedPane(paneId).kind === "Rejected";
    setPage((current) => (current.kind === "ManageTabs" ? { ...current, restoreBlocked: blocked ? paneId : null } : current));
    if (blocked) return;
    suppressReturnFocus.current = true;
    setOpen(false);
  }

  const keydown = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keydown.current = (event) => {
    if (event.defaultPrevented) return;
    const openCombo = keybindings["Nexus.Open"];
    if (openCombo && matchesKeyEvent(openCombo, event)) {
      event.preventDefault();
      const activeRow = rows.find((row) => row.key === activeKey);
      if (!open) requestExit({ kind: "Replace", intent: { kind: "Root" } });
      else if (page.kind === "Root" && activeRow?.menu) openMenu(activeRow.key);
      return;
    }
    for (const [id, combo] of Object.entries(keybindings)) {
      if (id === "Nexus.Open" || !matchesKeyEvent(combo, event)) continue;
      const place = DESTINATIONS.find((destination) => destination.id === id);
      const target: NexusTarget | null = Object.hasOwn(NEXUS_COMMANDS, id)
        ? NEXUS_COMMANDS[id as NexusCommandId].target("")
        : id === "today"
          ? { kind: "OpenDailyPage", date: { kind: "Today" }, entry: { kind: "View" } }
          : place
            ? { kind: "InternalHref", href: place.href, labelHint: place.label }
            : null;
      if (!target) continue;
      event.preventDefault();
      requestExit({ kind: "Navigate", target, activation: PROGRAMMATIC_NEXUS_TARGET_ACTIVATION, completion: "Destination" });
      return;
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keydown.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  useNexusOpenRequests((intent) => requestExit({ kind: "Replace", intent }));
  useEffect(() => {
    if (open) suppressReturnFocus.current = false;
  }, [open]);

  if (defect) throw defect.error;
  const addActivation = page.kind === "Add" ? page.activation : ADOPT;
  return {
    open,
    isMobile: viewport.isMobile,
    hydrated: viewport.hydrated,
    query,
    page,
    groups,
    activeKey,
    menuRequest,
    choices: choiceRows(page, todayAppend),
    failures: find.failures,
    busy: find.busy,
    pending: find.pending,
    announcement,
    dialogLabel: page.kind === "Add" ? "Add content" : "Nexus",
    focusKey: page.kind === "Add" ? addSession.state.sessionId : page.kind,
    openShortcut: labelFor("Nexus.Open") ?? "",
    handoff,
    addSession,
    addDefect: addDefect?.sessionId === addSession.state.sessionId,
    dismissalConfirmation: (pendingExit && {
      kind: pendingExit.confirmation,
      actionLabel:
        pendingExit.confirmation === "Discard"
          ? "Discard"
          : pendingExit.exit.kind === "Close" || pendingExit.exit.kind === "Navigate"
            ? "Stop and close"
            : pendingExit.exit.kind === "Replace"
              ? "Stop and continue"
              : "Stop and go back",
    }) satisfies AddDismissalConfirmation,
    panes,
    closedPanes: workspace.recentlyClosedPanes.map((snapshot) => ({
      id: snapshot.pane.id,
      label: resolveWorkspacePaneLabel(snapshot.pane, runtimeLabelByPaneId).label,
    })),
    setQuery,
    setActive,
    openMenu,
    retry: find.retry,
    activate(action: NexusAction, activation: NexusTargetActivation, origin: HTMLElement | null, row?: NexusRow) {
      if (action.kind === "Unavailable") setAnnouncement(action.reason);
      else run(action.target, activation, origin, row);
    },
    /** The mobile account menu: adopt a destination, through the Add guard. */
    openTarget: (target: NexusTarget) => requestExit({ kind: "Navigate", target, activation: addActivation, completion: "Destination" }),
    openAddTarget: (target: NexusTarget) => requestExit({ kind: "Navigate", target, activation: addActivation, completion: "Import" }),
    back,
    escape,
    close: () => requestExit({ kind: "Close" }),
    openRoot: () => requestExit({ kind: "Replace", intent: { kind: "Root" } }),
    /** Mobile Back: clear the query, leave a page, then close (from a tab-limit page, close at once). */
    guardClose(): DismissDecision {
      setAnnouncement("");
      if (page.kind === "Root" && query.trim()) {
        setQuery("");
        return "blocked";
      }
      if (page.kind !== "Root" && page.kind !== "Blocked") {
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
    suppressReturnFocus: () => suppressReturnFocus.current,
    initialFocus(container: HTMLElement): HTMLElement | null {
      if (page.kind === "Add") {
        return resolveAddPanelInitialFocus(container, viewport.isMobile);
      }
      return container.querySelector<HTMLElement>(
        page.kind === "CreateLibrary"
          ? "[data-switchboard-library-name]"
          : page.kind !== "Root"
            ? "[data-switchboard-heading]"
            : viewport.isMobile
              ? "[data-mobile-nexus-search]"
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
    retryPage: () => page.kind === "CreatePage" && createPage(page.pageId, page.title, page.activation),
    reportAddDefect(error: unknown) {
      console.error("Add content contract failed:", error);
      setAddDefect({ sessionId: addSession.state.sessionId, error });
    },
    clearAddDefect: () => setAddDefect(null),
    manageTabs: () =>
      setPage((current) => ({ kind: "ManageTabs", retained: current.kind === "Blocked" ? current.retained : null, restoreBlocked: null })),
    openPane(paneId: string) {
      const pane = panes.find((candidate) => candidate.id === paneId)!;
      if (pane.visibility === "minimized") workspace.restorePane(paneId);
      else workspace.activatePane(paneId);
      suppressReturnFocus.current = !pane.current;
      setOpen(false);
    },
    closePane: workspace.closePane,
    restorePane: restoreClosed,
    retryRetained,
    cancelRetained: () => setPage({ kind: "Root" }),
    activateAdjacentPane: workspace.activateAdjacentPane,
  };
}
