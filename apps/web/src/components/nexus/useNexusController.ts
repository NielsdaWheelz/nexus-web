"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  type ApiPath,
} from "@/lib/api/client";
import { absent, present, type Presence } from "@/lib/api/presence";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createLibrary } from "@/lib/libraries/client";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import { createNotePage } from "@/lib/notes/api";
import {
  readDailyDraft,
  subscribeDailyDraft,
  type DailyDraft,
} from "@/lib/notes/dailyDraftStore";
import { useOpenDailyPage, resolveDailyLocalDate } from "@/lib/notes/openDailyPage";
import { setPendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { getNexusCommand, NEXUS_COMMAND_IDS } from "@/lib/nexus/commands";
import {
  beginNexusPerformance,
  completeNexusPerformanceAfterPaint,
  NEXUS_OPEN_PERFORMANCE,
} from "@/lib/nexus/performance";
import {
  dispatchNexusTarget,
  isAndroidShellRestrictedHref,
  materializeNexusTarget,
  PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
  PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
  settleNexusDispatch,
  type MaterializedNexusTarget,
  type NexusDispatchCtx,
  type NexusDispatchOutcome,
} from "@/lib/nexus/dispatch";
import {
  consumeNexusUrlIntent,
  consumePendingNexusOpenIntents,
  NEXUS_OPEN_REQUESTED_EVENT,
  setNexusOpenReceiverReady,
} from "@/lib/nexus/events";
import type {
  CommittedWorkflow,
  NexusAction,
  NexusCommandId,
  NexusEntry,
  NexusEntryKey,
  NexusOpenIntent,
  NexusPage,
  NexusProjection,
  NexusReturnPoint,
  NexusSurface,
  NexusTarget,
  NexusTargetActivation,
  RetainedActivation,
  RetainedActivationSource,
} from "@/lib/nexus/model";
import { nexusEntryKeyValue } from "@/lib/nexus/model";
import { useNexusSelectionJournal } from "@/lib/nexus/useNexusSelectionJournal";
import {
  commitNexusRevision,
  composeNexusProjection,
  composeNexusResultCandidates,
  mergeProgressiveNexusEntries,
  nexusBrowseChoiceActions,
  nexusCreateChoiceActions,
  parseNexusQuery,
  projectNexusCurrentPlaybackEntry,
  projectNexusLocalEntries,
  projectNexusOpenableEntries,
  projectNexusSearchEntries,
  type NexusPane,
  type NexusRecentTarget,
  type ProgressiveNexusCommit,
} from "@/lib/nexus/results";
import { usePaneWarm } from "@/lib/panes/paneWarm";
import { dispatchPaneSearchRequest } from "@/lib/panes/paneSearchEvents";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import {
  usePlayerCommands,
  usePlayerSession,
} from "@/lib/player/globalPlayer";
import {
  ResourceOpenablesContractDefect,
  searchOpenableResources,
  type ResourceOpenableSearchResponse,
} from "@/lib/resources/openableResources";
import { dailyDraftAcceptsText } from "@/lib/resourceSurface/dailySurfacePersistence";
import {
  useRenderEnvironment,
  useViewportState,
} from "@/lib/renderEnvironment/provider";
import {
  fetchSearchResultPage,
  SearchContractDefect,
} from "@/lib/search/searchApi";
import { SEARCH_KINDS } from "@/lib/search/kinds";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import { useShareController } from "@/lib/sharing/controller";
import { matchesKeyEvent } from "@/lib/keybindings";
import {
  useKeybindings,
  useKeybindingsController,
} from "@/lib/keybindingsProvider";
import type { DismissDecision } from "@/lib/ui/useHistoryDismiss";
import { getWorkspacePrimaryPanes } from "@/lib/workspace/schema";
import {
  resolveWorkspacePaneLabel,
  useWorkspaceStore,
} from "@/lib/workspace/store";
import type { WorkspaceTarget } from "@/lib/workspace/targetActivation";
import type {
  DesktopNexusActionsRequest,
  DesktopNexusController,
  DesktopNexusSource,
} from "./desktop/types";
import {
  resolveAddPanelInitialFocus,
  type AddDismissalConfirmation,
} from "./AddPanel";
import {
  useAddContentSession,
  type AddContentSessionController,
} from "./useAddContentSession";

interface NexusHistoryResponse {
  readonly data: {
    readonly recent: NexusRecentTarget[];
    readonly frecency_by_href: Record<string, number>;
  };
}

export interface NexusManagedPane extends NexusPane {
  readonly activationRouteId: ReturnType<typeof resolveWorkspaceActivationRouteId>;
}

export interface NexusManagedClosedPane {
  readonly id: string;
  readonly label: string;
}

export interface NexusMobileProjection {
  readonly projection: NexusProjection;
  readonly failures: ReadonlySet<DesktopNexusSource>;
  readonly busy: boolean;
  readonly pending: boolean;
}

export interface NexusController {
  readonly open: boolean;
  readonly paneCount: number;
  readonly query: string;
  readonly page: NexusPage;
  readonly projection: NexusProjection;
  readonly actionsRequest: DesktopNexusActionsRequest | null;
  readonly failures: ReadonlySet<DesktopNexusSource>;
  readonly busy: boolean;
  readonly pending: boolean;
  readonly announcement: string;
  readonly addSession: AddContentSessionController;
  readonly dialogLabel: string;
  readonly focusKey: string;
  readonly dismissalConfirmation: AddDismissalConfirmation;
  readonly desktop: DesktopNexusController;
  readonly managedPanes: readonly NexusManagedPane[];
  readonly managedClosedPanes: readonly NexusManagedClosedPane[];
  readonly createChoiceActions: readonly NexusAction[];
  readonly browseChoiceActions: readonly NexusAction[];
  setQuery(query: string): void;
  setActiveEntry(key: NexusEntryKey): void;
  openEntryActions(entry: NexusEntry): void;
  announceUnavailable(reason: string): void;
  activateAction(
    action: NexusAction,
    activation: NexusTargetActivation,
    entry?: NexusEntry,
  ): void;
  materialize(target: NexusTarget): MaterializedNexusTarget;
  dispatch(
    target: MaterializedNexusTarget,
    activation: NexusTargetActivation,
    entry?: NexusEntry,
  ): Promise<NexusDispatchOutcome>;
  reportActivationFailure(error: unknown): void;
  retry(source: DesktopNexusSource): void;
  openTarget(target: NexusTarget): void;
  openAddTarget(target: NexusTarget): void;
  back(): void;
  escape(): void;
  openRoot(): void;
  close(): void;
  dismissAccepted(): void;
  guardClose(): DismissDecision;
  initialFocus(container: HTMLElement, isMobile: boolean): HTMLElement | null;
  shouldSuppressReturnFocusOnClose(): boolean;
  keepWorking(): void;
  confirmDismissal(): void;
  setLibraryNameDraft(name: string): void;
  submitLibrary(): void;
  retryPageCreation(): void;
  manageTabs(): void;
  openManagedPane(paneId: string): void;
  closeManagedPane(paneId: string): void;
  restoreManagedPane(paneId: string): void;
  retryRetainedActivation(): void;
  cancelRetainedActivation(): void;
}

const EMPTY_RECENT: readonly NexusRecentTarget[] = [];
const EMPTY_FRECENCY: Readonly<Record<string, number>> = {};
const EMPTY_SEARCH: readonly SearchResultRowViewModel[] = [];
const OPENABLE_DEBOUNCE_MS = 80;
const SEARCH_DEBOUNCE_MS = 160;
const BUSY_DELAY_MS = 150;
const OPENABLE_CACHE_LIMIT = 32;
const EMPTY_NEXUS_GROUPS: NexusProjection["groups"] = [];
const EMPTY_NEXUS_PROJECTION_BY_SURFACE: Readonly<
  Record<NexusSurface, NexusProjection>
> = {
  Desktop: { surface: "Desktop", groups: EMPTY_NEXUS_GROUPS, activeKey: null },
  Mobile: { surface: "Mobile", groups: EMPTY_NEXUS_GROUPS, activeKey: null },
};
const TODAY_APPEND_UNAVAILABLE =
  "Open Today to finish the current embedded draft";

type ExitIntent =
  | { readonly kind: "Close" }
  | { readonly kind: "Root" }
  | { readonly kind: "Content" }
  | { readonly kind: "Replace"; readonly detail: NexusOpenIntent }
  | {
      readonly kind: "Navigate";
      readonly target: NexusTarget;
      readonly activation?: NexusTargetActivation;
      readonly retained?: Omit<RetainedActivation, "target" | "activation">;
    };

type PendingDismissal = {
  readonly confirmation: Exclude<AddDismissalConfirmation, null>["kind"];
  readonly intent: ExitIntent;
};

function isRetryableWorkflowFailure(error: unknown): boolean {
  return isApiError(error) || error instanceof TypeError || error instanceof DOMException;
}

function actionTarget(action: NexusAction): NexusTarget | null {
  return action.availability.kind === "Available"
    ? action.availability.target
    : null;
}

function playerDescriptor(session: ReturnType<typeof usePlayerSession>) {
  const state = session.state;
  if (state.kind !== "Active" || state.phase !== "Paused") return null;
  return state.session.descriptor;
}

export function useNexusController(): NexusController {
  const { accountId, calendarTimeZone } = useAuthenticatedAccount();
  const { androidShell } = useRenderEnvironment();
  const viewport = useViewportState();
  const keybindings = useKeybindings();
  const keybindingController = useKeybindingsController();
  const feedback = useFeedback();
  const { openShare } = useShareController();
  const warmPane = usePaneWarm();
  const { placeItems } = useLectern();
  const playerSession = usePlayerSession();
  const playerCommands = usePlayerCommands();
  const openDailyPage = useOpenDailyPage();
  const addSession = useAddContentSession();
  const {
    start: startAddSession,
    backToContent: backToAddContent,
    discard: discardAddSession,
    stop: stopAddSession,
  } = addSession;
  const workspace = useWorkspaceStore();
  const {
    state,
    recentlyClosedPanes,
    runtimeLabelByPaneId,
    activatePane,
    activateWorkspaceTarget,
    closePane,
    restoreClosedPane,
    restorePane,
  } = workspace;

  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [page, setPage] = useState<NexusPage>({ kind: "Root" });
  const [commit, setCommit] = useState<ProgressiveNexusCommit>({
    normalizedQuery: "",
    entries: [],
    activeKey: null,
  });
  const [typedActionActiveKey, setTypedActionActiveKey] =
    useState<NexusEntryKey | null>(null);
  const [blankActiveKey, setBlankActiveKey] = useState<NexusEntryKey | null>(null);
  const [actionsRequest, setActionsRequest] =
    useState<DesktopNexusActionsRequest | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [openablesRetry, setOpenablesRetry] = useState(0);
  const [searchRetry, setSearchRetry] = useState(0);
  const [historyEnabled, setHistoryEnabled] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [showBusy, setShowBusy] = useState(false);
  const [pendingDismissal, setPendingDismissal] =
    useState<PendingDismissal | null>(null);
  const [todayDraft, setTodayDraft] = useState<DailyDraft | null>(() => {
    if (typeof window === "undefined") return null;
    const localDate = resolveDailyLocalDate({ kind: "Today" }, calendarTimeZone);
    return readDailyDraft(accountId, localDate);
  });
  const userMovedRef = useRef(false);
  const suppressReturnFocusRef = useRef(false);
  const requestIdRef = useRef(0);
  const openablesCacheRef = useRef(new Map<string, ResourceOpenableSearchResponse>());
  const handleHistoryWriteError = useCallback(
    (error: unknown) => {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
      feedback.show(
        toFeedback(error, { fallback: "Nexus history was not saved" }),
      );
    },
    [feedback],
  );
  const markHistoryCommitted = useCallback(
    () => setHistoryRevision((value) => value + 1),
    [],
  );
  const recordSelection = useNexusSelectionJournal({
    foregroundActive: open,
    onError: handleHistoryWriteError,
    onQuiescentCommit: markHistoryCommitted,
  });

  const parsed = useMemo(() => parseNexusQuery(query), [query]);
  const todayLocalDate = resolveDailyLocalDate(
    { kind: "Today" },
    calendarTimeZone,
  );
  useEffect(() => {
    setTodayDraft(readDailyDraft(accountId, todayLocalDate));
    return subscribeDailyDraft(accountId, todayLocalDate, setTodayDraft);
  }, [accountId, todayLocalDate]);

  useEffect(() => {
    if (open) {
      suppressReturnFocusRef.current = false;
      setHistoryEnabled(true);
      return;
    }
    // Results are useful only within one visible Nexus session. Release them
    // at dismissal instead of carrying an unbounded query corpus into the next
    // workspace interaction (where its later collection can become input
    // latency). The per-session cache below is separately LRU-bounded.
    openablesCacheRef.current = new Map();
  }, [open]);

  const baseHistoryResource = useResource<NexusHistoryResponse>({
    cacheKey: historyEnabled
      ? `${accountId}:nexus-history:${historyRevision}`
      : null,
    load: (signal) =>
      apiFetch<NexusHistoryResponse>("/api/me/nexus-history", { signal }),
  });

  const panes = useMemo<NexusManagedPane[]>(
    () =>
      getWorkspacePrimaryPanes(state).map((pane) => {
        const href = pane.currentVisit.href;
        return {
          id: pane.id,
          href,
          visibility: pane.visibility,
          label: resolveWorkspacePaneLabel(pane, runtimeLabelByPaneId).label,
          current: pane.id === state.activePrimaryPaneId,
          activationRouteId: resolveWorkspaceActivationRouteId(href),
        };
      }),
    [runtimeLabelByPaneId, state],
  );
  const managedClosedPanes = useMemo<NexusManagedClosedPane[]>(
    () =>
      recentlyClosedPanes.map((snapshot) => ({
        id: snapshot.pane.id,
        label: resolveWorkspacePaneLabel(snapshot.pane, runtimeLabelByPaneId).label,
      })),
    [recentlyClosedPanes, runtimeLabelByPaneId],
  );

  const commandShortcutHints = useMemo(
    () =>
      Object.fromEntries(
        NEXUS_COMMAND_IDS.flatMap((id) => {
          const label = keybindingController.labelFor(id);
          return label ? [[id, label]] : [];
        }),
      ) as Partial<Record<NexusCommandId, string>>,
    [keybindingController],
  );
  const findEnabled = open && parsed.text.length > 0;
  const openablesIdentity = findEnabled ? query : null;
  const openablesFetch = useDebouncedFetch(
    openablesIdentity === null ? null : `${query}:${openablesRetry}`,
    async (signal) => {
      const cacheKey = parsed.normalizedText;
      const cached = openablesCacheRef.current.get(cacheKey);
      if (cached) {
        openablesCacheRef.current.delete(cacheKey);
        openablesCacheRef.current.set(cacheKey, cached);
        return cached;
      }
      const response = await searchOpenableResources({
        q: parsed.text,
        schemes: absent(),
        signal,
      });
      if (!signal.aborted) {
        while (openablesCacheRef.current.size >= OPENABLE_CACHE_LIMIT) {
          const oldest = openablesCacheRef.current.keys().next().value;
          if (oldest === undefined) break;
          openablesCacheRef.current.delete(oldest);
        }
        openablesCacheRef.current.set(cacheKey, response);
      }
      return response;
    },
    {
      debounceMs: parsed.text.length === 1 ? 0 : OPENABLE_DEBOUNCE_MS,
      identity: openablesIdentity,
    },
  );
  const ownedSearchQuery = useMemo(() => {
    const kinds = parsed.searchQuery.requestedKinds ?? new Set(SEARCH_KINDS);
    return {
      ...parsed.searchQuery,
      requestedKinds: new Set([...kinds].filter((kind) => kind !== "web")),
    };
  }, [parsed.searchQuery]);
  const ownedCandidateIdentity = open && parsed.text.length >= 2 ? query : null;
  // Preserve the established latency policy: cheap Openables reaches a
  // terminal state before expensive owned full-text retrieval starts.
  const openablesTerminal =
    openablesIdentity !== null &&
    (openablesFetch.dataIdentity === openablesIdentity ||
      openablesFetch.errorIdentity === openablesIdentity);
  const ownedIdentity =
    ownedCandidateIdentity !== null && openablesTerminal
      ? ownedCandidateIdentity
      : null;
  const ownedFetch = useDebouncedFetch(
    ownedIdentity === null ? null : `${query}:${searchRetry}`,
    (signal) =>
      fetchSearchResultPage(ownedSearchQuery, {
        limit: 40,
        cursor: null,
        signal,
      }),
    { debounceMs: SEARCH_DEBOUNCE_MS, identity: ownedIdentity },
  );
  const ownedTerminal =
    ownedIdentity !== null &&
    (ownedFetch.dataIdentity === ownedIdentity ||
      ownedFetch.errorIdentity === ownedIdentity);
  const typedHistoryIdentity =
    findEnabled &&
    (parsed.text.length === 1 ? openablesTerminal : ownedTerminal)
      ? query
      : null;
  const typedHistoryPath =
    typedHistoryIdentity === null
      ? null
      : (`/api/me/nexus-history?${new URLSearchParams({ query: parsed.text })}` as ApiPath);
  const typedHistoryResource = useResource<NexusHistoryResponse>({
    cacheKey:
      typedHistoryPath === null
        ? null
        : `${accountId}:${historyRevision}:${typedHistoryPath}`,
    load: (signal) => {
      if (typedHistoryPath === null) {
        throw new Error("Typed Nexus history requires a current query path");
      }
      return apiFetch<NexusHistoryResponse>(typedHistoryPath, { signal });
    },
  });
  const history = useMemo(() => {
    const baseData =
      baseHistoryResource.status === "ready"
        ? baseHistoryResource.data.data
        : null;
    const typedData =
      typedHistoryResource.status === "ready"
        ? typedHistoryResource.data.data
        : null;
    return {
      recent: (baseData?.recent ?? EMPTY_RECENT).filter(
        (entry) => !isAndroidShellRestrictedHref(entry.target_href, androidShell),
      ),
      frecencyByHref:
        (parsed.text ? typedData?.frecency_by_href : null) ??
        baseData?.frecency_by_href ??
        EMPTY_FRECENCY,
    };
  }, [androidShell, baseHistoryResource, parsed.text, typedHistoryResource]);
  const openablesData =
    openablesFetch.dataIdentity === openablesIdentity
      ? openablesFetch.data
      : null;
  const openablesError =
    openablesFetch.errorIdentity === openablesIdentity
      ? openablesFetch.error
      : null;
  const ownedData =
    ownedFetch.dataIdentity === ownedIdentity ? ownedFetch.data : null;
  const ownedError =
    ownedFetch.errorIdentity === ownedIdentity ? ownedFetch.error : null;
  const contractDefect =
    openablesError instanceof ResourceOpenablesContractDefect ||
    isSameSystemApiDefect(openablesError)
      ? openablesError
      : ownedError instanceof SearchContractDefect || isSameSystemApiDefect(ownedError)
        ? ownedError
        : null;
  if (contractDefect) throw contractDefect;

  const remoteBusy = openablesFetch.loading || ownedFetch.loading;
  useEffect(() => {
    if (!remoteBusy) {
      setShowBusy(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowBusy(true), BUSY_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [remoteBusy]);

  const localEntries = useMemo(
    () =>
      projectNexusLocalEntries({
        query,
        panes,
        destinations: DESTINATIONS,
        frecencyByHref: history.frecencyByHref,
        commandShortcutHints,
      }),
    [commandShortcutHints, history.frecencyByHref, panes, query],
  );
  const openableEntries = useMemo(
    () =>
      projectNexusOpenableEntries({
        query: parsed.text,
        items: openablesData?.items ?? [],
        panes,
        frecencyByHref: history.frecencyByHref,
      }),
    [history.frecencyByHref, openablesData, panes, parsed.text],
  );
  const ownedEntries = useMemo(
    () =>
      projectNexusSearchEntries({
        query: parsed.text,
        rows: ownedData?.rows ?? EMPTY_SEARCH,
        panes,
        frecencyByHref: history.frecencyByHref,
      }),
    [history.frecencyByHref, ownedData, panes, parsed.text],
  );
  const candidates = useMemo(
    () =>
      composeNexusResultCandidates({
        local: localEntries,
        openables: openableEntries,
        search: ownedEntries,
      }),
    [localEntries, openableEntries, ownedEntries],
  );
  const localEntriesRef = useRef(localEntries);
  localEntriesRef.current = localEntries;
  useLayoutEffect(() => {
    if (!parsed.normalizedText) return;
    userMovedRef.current = false;
    setTypedActionActiveKey(null);
    setCommit(
      commitNexusRevision({
        normalizedQuery: parsed.normalizedText,
        incoming: localEntriesRef.current,
        activeKey: null,
      }),
    );
  }, [parsed.normalizedText]);
  useLayoutEffect(() => {
    if (!parsed.text) return;
    setCommit((previous) =>
      mergeProgressiveNexusEntries({
        previous,
        normalizedQuery: parsed.normalizedText,
        incoming: candidates,
        userMoved: userMovedRef.current,
      }),
    );
  }, [candidates, parsed.normalizedText, parsed.text]);

  const descriptor = playerDescriptor(playerSession);
  const currentPlayback = useMemo(
    () =>
      descriptor
        ? projectNexusCurrentPlaybackEntry({
            label: descriptor.title,
            metadata:
              descriptor.subtitle.kind === "Present"
                ? descriptor.subtitle.value
                : undefined,
          })
        : null,
    [descriptor],
  );
  const todayAppend = useMemo(
    () =>
      todayDraft === null || dailyDraftAcceptsText(todayDraft)
        ? ({ kind: "Available" } as const)
        : ({ kind: "Unavailable", reason: TODAY_APPEND_UNAVAILABLE } as const),
    [todayDraft],
  );
  const requestedActiveKey = parsed.text
    ? (typedActionActiveKey ?? commit.activeKey)
    : blankActiveKey;
  const committedVisibleProjectionRef = useRef<NexusProjection | null>(null);
  const projectionSurface: NexusSurface = viewport.isMobile
    ? "Mobile"
    : "Desktop";
  const projection = useMemo(() => {
    if (!open) {
      const committed = committedVisibleProjectionRef.current;
      return committed?.surface === projectionSurface
        ? committed
        : EMPTY_NEXUS_PROJECTION_BY_SURFACE[projectionSurface];
    }
    return composeNexusProjection({
      surface: projectionSurface,
      query,
      panes,
      currentPlayback,
      recent: history.recent,
      destinations: DESTINATIONS,
      frecencyByHref: history.frecencyByHref,
      commandShortcutHints,
      results: commit.entries,
      activeKey: requestedActiveKey,
      todayAppend,
    });
  }, [
    commandShortcutHints,
    commit.entries,
    currentPlayback,
    history.frecencyByHref,
    history.recent,
    open,
    panes,
    projectionSurface,
    query,
    requestedActiveKey,
    todayAppend,
  ]);
  useLayoutEffect(() => {
    if (open) committedVisibleProjectionRef.current = projection;
  }, [open, projection]);
  const rootReturnPoint = useMemo<NexusReturnPoint>(
    () => ({ kind: "Root", query, activeKey: projection.activeKey }),
    [projection.activeKey, query],
  );
  const failures = useMemo(() => {
    const value = new Set<DesktopNexusSource>();
    if (openablesError) value.add("Openables");
    if (ownedError) value.add("Owned");
    return value;
  }, [openablesError, ownedError]);

  const invalidateOpenables = useCallback(() => {
    openablesCacheRef.current.clear();
    setOpenablesRetry((value) => value + 1);
  }, []);
  const dispatchCtx = useMemo<NexusDispatchCtx>(
    () => ({
      androidShell,
      feedback,
      activePaneId: state.activePrimaryPaneId,
      activateWorkspaceTarget,
      placeItems: async (input) => {
        const result = await placeItems(input);
        invalidateOpenables();
        return result;
      },
      panes,
      activatePane,
      restorePane,
      closePane,
      requestPaneSearch: dispatchPaneSearchRequest,
      openShare,
      openDailyPage,
      resumeCurrentPlayback: playerCommands.resume,
      shareOptions: () => {
        const returnTarget =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        return {
          returnFocusTo: () => returnTarget,
          returnFocusFallback: present(() =>
            findPaneLandmarkFocusTarget(state.activePrimaryPaneId),
          ),
        };
      },
    }),
    [
      activatePane,
      activateWorkspaceTarget,
      androidShell,
      closePane,
      feedback,
      invalidateOpenables,
      openDailyPage,
      openShare,
      panes,
      placeItems,
      playerCommands.resume,
      restorePane,
      state.activePrimaryPaneId,
    ],
  );
  const materialize = useCallback(
    (target: NexusTarget) =>
      materializeNexusTarget(target, { accountId, calendarTimeZone }),
    [accountId, calendarTimeZone],
  );
  const fail = useCallback(
    (error: unknown) => {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
      feedback.show(toFeedback(error, { fallback: "Command failed" }));
    },
    [feedback],
  );
  const applyNavigationOutcome = useCallback(
    (
      outcome: NexusDispatchOutcome,
      activation: NexusTargetActivation,
      retained: Omit<RetainedActivation, "target" | "activation">,
    ) => {
      switch (outcome.kind) {
        case "Stayed":
        case "WorkflowRequested":
          return;
        case "NavigationAccepted":
        case "DailyPageAccepted":
          suppressReturnFocusRef.current = true;
          setOpen(false);
          return;
        case "NavigationRejected":
          setPage({
            kind: "ActivationBlocked",
            retained: {
              ...retained,
              target: outcome.target,
              activation,
            },
          });
          return;
      }
    },
    [],
  );
  const dispatchWorkspaceTarget = useCallback(
    (input: {
      readonly target: WorkspaceTarget;
      readonly source: RetainedActivationSource;
      readonly completion?: Presence<CommittedWorkflow>;
      readonly returnTo: NexusReturnPoint;
      readonly activation: NexusTargetActivation;
      readonly onAccepted?: () => void;
    }) => {
      const target = materialize({
        kind: "InternalHref",
        href: input.target.href,
        labelHint: input.target.labelHint,
      });
      void settleNexusDispatch(() =>
        dispatchNexusTarget(target, dispatchCtx, input.activation),
      )
        .then((outcome) => {
          applyNavigationOutcome(outcome, input.activation, {
            source: input.source,
            completion: input.completion ?? absent(),
            returnTo: input.returnTo,
          });
          if (outcome.kind === "NavigationAccepted") input.onAccepted?.();
        })
        .catch(fail);
    },
    [applyNavigationOutcome, dispatchCtx, fail, materialize],
  );
  const runPageCreation = useCallback(
    (input: {
      readonly pageId: string;
      readonly titleDraft: string;
      readonly activation: NexusTargetActivation;
      readonly returnTo: NexusReturnPoint;
    }) => {
      const title = input.titleDraft.trim() || "Untitled";
      setPage({
        kind: "CreatePage",
        pageId: input.pageId,
        titleDraft: title,
        activation: input.activation,
        submit: { kind: "Running" },
      });
      void createNotePage({ pageId: input.pageId, title })
        .then((created) => {
          invalidateOpenables();
          setPendingNoteFocus({ pageId: created.id, target: "title" });
          dispatchWorkspaceTarget({
            target: { href: `/pages/${created.id}`, labelHint: created.title },
            source: "Page",
            completion: present({ kind: "Page", replayId: input.pageId }),
            returnTo: input.returnTo,
            activation: input.activation,
          });
        })
        .catch((error: unknown) => {
          if (handleUnauthenticatedApiError(error)) return;
          if (isSameSystemApiDefect(error) || !isRetryableWorkflowFailure(error)) {
            throw error;
          }
          setPage({
            kind: "CreatePage",
            pageId: input.pageId,
            titleDraft: title,
            activation: input.activation,
            submit: {
              kind: "Retryable",
              message: toFeedback(error, { fallback: "Couldn’t create page. Retry" }).title,
            },
          });
        });
    },
    [dispatchWorkspaceTarget, invalidateOpenables],
  );
  const handleWorkflowRequest = useCallback(
    (
      outcome: Extract<NexusDispatchOutcome, { kind: "WorkflowRequested" }>,
      returnTo: NexusReturnPoint,
    ) => {
      const { target, activation } = outcome;
      switch (target.kind) {
        case "OpenAdd":
          setPage({
            kind: "Add",
            sessionId: startAddSession(target.seed),
            activation,
          });
          return;
        case "CreatePage":
          runPageCreation({
            pageId: crypto.randomUUID(),
            titleDraft: target.titleDraft,
            activation,
            returnTo,
          });
          return;
        case "CreateLibrary":
          setPage({
            kind: "CreateLibrary",
            nameDraft: target.nameDraft,
            libraryId: crypto.randomUUID(),
            submit: { kind: "Ready" },
            activation,
          });
          return;
        case "ChooseCreate":
          setPage({ kind: "ChooseCreate", initialDraft: target.initialDraft });
          return;
        case "ChooseBrowse":
          setPage({ kind: "ChooseBrowse", query: target.query });
          return;
        case "ManageTabs":
          setPage({ kind: "ManageTabs", origin: { kind: "Direct" } });
          return;
      }
    },
    [runPageCreation, startAddSession],
  );
  const logSelection = useCallback(
    (entry: NexusEntry, target: MaterializedNexusTarget) => {
      const href =
        target.kind === "InternalHref"
          ? target.href
          : target.kind === "ResourceOpen" &&
              target.subject.activation.kind === "route"
            ? target.subject.activation.href
            : target.kind === "PaneOpen"
              ? panes.find((pane) => pane.id === target.paneId)?.href
              : null;
      if (!href || isAndroidShellRestrictedHref(href, androidShell)) return;
      const selection = {
        query: parsed.text || null,
        target_href: href,
        label_snapshot: entry.label,
        source: entry.historySource,
      };
      recordSelection(selection);
    },
    [androidShell, panes, parsed.text, recordSelection],
  );
  const dispatch = useCallback(
    (
      target: MaterializedNexusTarget,
      activation: NexusTargetActivation,
      entry?: NexusEntry,
    ): Promise<NexusDispatchOutcome> => {
      setAnnouncement("");
      const applyOutcome = (outcome: NexusDispatchOutcome) => {
        const retained = {
          source: "Result" as const,
          completion: absent<CommittedWorkflow>(),
          returnTo: rootReturnPoint,
        };
        if (outcome.kind === "WorkflowRequested") {
          handleWorkflowRequest(outcome, rootReturnPoint);
        } else {
          applyNavigationOutcome(outcome, activation, retained);
          if (outcome.kind === "Stayed" && target.kind === "ResumeCurrentPlayback") {
            setOpen(false);
          }
        }
        if (
          entry &&
          (outcome.kind === "NavigationAccepted" ||
            outcome.kind === "DailyPageAccepted")
        ) {
          logSelection(entry, target);
        }
        return outcome;
      };
      try {
        const result = dispatchNexusTarget(target, dispatchCtx, activation);
        return result instanceof Promise
          ? result.then(applyOutcome)
          : Promise.resolve(applyOutcome(result));
      } catch (error: unknown) {
        return Promise.reject(error);
      }
    },
    [
      applyNavigationOutcome,
      dispatchCtx,
      handleWorkflowRequest,
      logSelection,
      rootReturnPoint,
    ],
  );
  const activateAction = useCallback(
    (
      action: NexusAction,
      activation: NexusTargetActivation,
      entry?: NexusEntry,
    ) => {
      if (action.availability.kind === "Unavailable") {
        setAnnouncement(action.availability.reason);
        return;
      }
      setAnnouncement("");
      const prepared = materialize(action.availability.target);
      void dispatch(prepared, activation, entry).catch(fail);
    },
    [dispatch, fail, materialize],
  );
  const setActiveEntry = useCallback(
    (key: NexusEntryKey) => {
      userMovedRef.current = true;
      const keyValue = nexusEntryKeyValue(key);
      const retainMatchingKey = (current: NexusEntryKey | null) =>
        current !== null && nexusEntryKeyValue(current) === keyValue
          ? current
          : key;
      if (parsed.text) {
        if (key.kind === "Continuation") {
          setTypedActionActiveKey(retainMatchingKey);
        } else {
          setTypedActionActiveKey(null);
          setCommit((value) => {
            const activeKey = retainMatchingKey(value.activeKey);
            return activeKey === value.activeKey
              ? value
              : { ...value, activeKey };
          });
        }
      } else {
        setBlankActiveKey(retainMatchingKey);
      }
      const entry = projection.groups
        .flatMap((group) => group.entries)
        .find((candidate) =>
          nexusEntryKeyValue(candidate.key) === keyValue,
        );
      const target = entry ? actionTarget(entry.primaryAction) : null;
      if (target?.kind === "InternalHref") warmPane(target.href);
      if (
        target?.kind === "ResourceOpen" &&
        target.subject.activation.kind === "route" &&
        target.subject.activation.href
      ) {
        warmPane(target.subject.activation.href);
      }
    },
    [parsed.text, projection.groups, warmPane],
  );
  const setQuery = useCallback((next: string) => {
    userMovedRef.current = false;
    setAnnouncement("");
    setBlankActiveKey(null);
    setQueryState(next);
  }, []);
  const openEntryActions = useCallback((entry: NexusEntry) => {
    if (entry.secondaryActions.length === 0) return;
    setPage({ kind: "EntryActions", entry });
  }, []);
  const announceUnavailable = useCallback((reason: string) => {
    setAnnouncement(reason);
  }, []);
  const requestActiveActions = useCallback(() => {
    if (page.kind !== "Root") return;
    const active = projection.activeKey;
    if (!active) return;
    const key = nexusEntryKeyValue(active);
    const entry = projection.groups
      .flatMap((group) => group.entries)
      .find((candidate) => nexusEntryKeyValue(candidate.key) === key);
    if (!entry || entry.secondaryActions.length === 0) return;
    setActionsRequest({ requestId: ++requestIdRef.current, entry });
  }, [page.kind, projection]);

  const submitLibrary = useCallback(() => {
    if (page.kind !== "CreateLibrary" || page.submit.kind === "Running") return;
    const name = page.nameDraft.trim();
    if (!name) return;
    const frozen = { ...page, nameDraft: name, submit: { kind: "Running" } as const };
    setPage(frozen);
    void createLibrary({ libraryId: frozen.libraryId, name })
      .then((library) => {
        invalidateOpenables();
        dispatchWorkspaceTarget({
          target: { href: `/libraries/${library.id}`, labelHint: library.name },
          source: "Library",
          completion: present({ kind: "Library", replayId: frozen.libraryId }),
          returnTo: rootReturnPoint,
          activation: frozen.activation,
        });
      })
      .catch((error: unknown) => {
        if (handleUnauthenticatedApiError(error)) return;
        if (isSameSystemApiDefect(error) || !isRetryableWorkflowFailure(error)) {
          throw error;
        }
        setPage({
          ...frozen,
          submit: {
            kind: "Retryable",
            message: toFeedback(error, { fallback: "Couldn’t create library. Retry" }).title,
          },
        });
      });
  }, [dispatchWorkspaceTarget, invalidateOpenables, page, rootReturnPoint]);
  const setLibraryNameDraft = useCallback((name: string) => {
    setPage((current) => {
      if (current.kind !== "CreateLibrary" || current.submit.kind === "Running") {
        return current;
      }
      return {
        ...current,
        nameDraft: name,
        libraryId:
          current.submit.kind === "Retryable" && name !== current.nameDraft
            ? crypto.randomUUID()
            : current.libraryId,
        submit: { kind: "Ready" },
      };
    });
  }, []);
  const retryPageCreation = useCallback(() => {
    if (page.kind !== "CreatePage" || page.submit.kind !== "Retryable") return;
    runPageCreation({
      pageId: page.pageId,
      titleDraft: page.titleDraft,
      activation: page.activation,
      returnTo: rootReturnPoint,
    });
  }, [page, rootReturnPoint, runPageCreation]);

  const restoreRoot = useCallback(() => setPage({ kind: "Root" }), []);
  const restoreReturnPoint = useCallback((returnTo: NexusReturnPoint) => {
    setQueryState(returnTo.query);
    if (returnTo.query.trim()) {
      if (returnTo.activeKey?.kind === "Continuation") {
        setTypedActionActiveKey(returnTo.activeKey);
      } else {
        setTypedActionActiveKey(null);
        setCommit((current) => ({
          ...current,
          normalizedQuery: parseNexusQuery(returnTo.query).normalizedText,
          activeKey: returnTo.activeKey,
        }));
      }
    } else {
      setBlankActiveKey(returnTo.activeKey);
    }
    setPage({ kind: "Root" });
  }, []);
  const manageTabs = useCallback(() => {
    setPage((current) =>
      current.kind === "ActivationBlocked"
        ? {
            kind: "ManageTabs",
            origin: { kind: "Recovery", retained: current.retained },
          }
        : { kind: "ManageTabs", origin: { kind: "Direct" } },
    );
  }, []);
  const retryRetainedActivation = useCallback(() => {
    const retained =
      page.kind === "ActivationBlocked"
        ? page.retained
        : page.kind === "ManageTabs" && page.origin.kind === "Recovery"
          ? page.origin.retained
          : null;
    if (!retained) return;
    void settleNexusDispatch(() =>
      dispatchNexusTarget(retained.target, dispatchCtx, retained.activation),
    )
      .then((outcome) => {
        applyNavigationOutcome(outcome, retained.activation, {
          source: retained.source,
          completion: retained.completion,
          returnTo: retained.returnTo,
        });
        if (outcome.kind === "NavigationAccepted" || outcome.kind === "DailyPageAccepted") {
          restoreReturnPoint(retained.returnTo);
        }
      })
      .catch(fail);
  }, [
    applyNavigationOutcome,
    dispatchCtx,
    fail,
    page,
    restoreReturnPoint,
  ]);
  const cancelRetainedActivation = useCallback(() => {
    const retained =
      page.kind === "ActivationBlocked"
        ? page.retained
        : page.kind === "ManageTabs" && page.origin.kind === "Recovery"
          ? page.origin.retained
          : null;
    if (!retained) return;
    restoreReturnPoint(retained.returnTo);
  }, [page, restoreReturnPoint]);
  const openManagedPane = useCallback(
    (paneId: string) => {
      const pane = panes.find((candidate) => candidate.id === paneId);
      if (!pane) throw new Error(`Unknown Nexus pane: ${paneId}`);
      if (pane.visibility === "minimized") restorePane(paneId);
      else activatePane(paneId);
      suppressReturnFocusRef.current = paneId !== state.activePrimaryPaneId;
      setOpen(false);
    },
    [activatePane, panes, restorePane, state.activePrimaryPaneId],
  );
  const closeManagedPane = useCallback((paneId: string) => closePane(paneId), [closePane]);
  const restoreManagedPane = useCallback(
    (paneId: string) => {
      const restored = restoreClosedPane(paneId);
      if (restored.kind === "Rejected") {
        feedback.show({
          severity: "warning",
          title: "Tab limit reached",
          message: "Close a tab, then restore this one.",
        });
        return;
      }
      suppressReturnFocusRef.current = true;
      setOpen(false);
    },
    [feedback, restoreClosedPane],
  );

  const performExit = useCallback(
    (intent: ExitIntent) => {
      setPendingDismissal(null);
      switch (intent.kind) {
        case "Content":
          backToAddContent();
          return;
        case "Root":
          discardAddSession();
          restoreRoot();
          return;
        case "Close":
          discardAddSession();
          setOpen(false);
          return;
        case "Navigate": {
          const activation = intent.activation ?? PROGRAMMATIC_NEXUS_TARGET_ACTIVATION;
          const target = materialize(intent.target);
          void settleNexusDispatch(() =>
            dispatchNexusTarget(target, dispatchCtx, activation),
          )
            .then((outcome) => {
              if (outcome.kind === "WorkflowRequested") {
                handleWorkflowRequest(outcome, rootReturnPoint);
                return;
              }
              applyNavigationOutcome(
                outcome,
                activation,
                intent.retained ?? {
                  source: page.kind === "Add" ? "Import" : "Place",
                  completion: absent(),
                  returnTo: rootReturnPoint,
                },
              );
              if (outcome.kind === "NavigationAccepted" || outcome.kind === "DailyPageAccepted") {
                discardAddSession();
              }
            })
            .catch(fail);
          return;
        }
        case "Replace": {
          const detail = intent.detail;
          if (detail.kind === "Root") {
            beginNexusPerformance(NEXUS_OPEN_PERFORMANCE);
          }
          suppressReturnFocusRef.current = false;
          if (
            detail.kind === "Root" &&
            (page.kind === "ActivationBlocked" || page.kind === "ManageTabs")
          ) {
            setOpen(true);
            return;
          }
          discardAddSession();
          setQueryState("");
          setBlankActiveKey(null);
          if (detail.kind === "Add") {
            setPage({
              kind: "Add",
              sessionId: startAddSession(detail.seed),
              activation: PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
            });
          } else if (detail.kind === "UnsupportedLink") {
            setPage({ kind: "UnsupportedLink" });
          } else {
            setPage({ kind: "Root" });
          }
          setOpen(true);
          if (detail.kind === "QuickAction") {
            const command = getNexusCommand(detail.actionId);
            const target = materialize(command.target({ argument: "" }));
            void dispatch(target, PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION).catch(fail);
          }
          return;
        }
      }
    },
    [
      applyNavigationOutcome,
      backToAddContent,
      discardAddSession,
      dispatch,
      dispatchCtx,
      fail,
      handleWorkflowRequest,
      materialize,
      page.kind,
      restoreRoot,
      rootReturnPoint,
      startAddSession,
    ],
  );
  const guardExit = useCallback(
    (intent: ExitIntent): DismissDecision => {
      if (pendingDismissal) return "blocked";
      if (page.kind !== "Add") return "accepted";
      if (addSession.state.mutation.kind === "Running") {
        setPendingDismissal({ confirmation: "Stop", intent });
        return "blocked";
      }
      if (intent.kind === "Content") return "accepted";
      if (addSession.dirty) {
        setPendingDismissal({ confirmation: "Discard", intent });
        return "blocked";
      }
      return "accepted";
    },
    [addSession.dirty, addSession.state.mutation.kind, page.kind, pendingDismissal],
  );
  const requestExit = useCallback(
    (intent: ExitIntent) => {
      if (guardExit(intent) === "accepted") performExit(intent);
    },
    [guardExit, performExit],
  );
  const back = useCallback(() => {
    if (page.kind === "Add" && addSession.state.branch === "Opml") {
      requestExit({ kind: "Content" });
      return;
    }
    if (page.kind === "ManageTabs" && page.origin.kind === "Recovery") {
      setPage({ kind: "ActivationBlocked", retained: page.origin.retained });
      return;
    }
    if (page.kind === "ActivationBlocked") {
      restoreReturnPoint(page.retained.returnTo);
      return;
    }
    requestExit({ kind: "Root" });
  }, [addSession.state.branch, page, requestExit, restoreReturnPoint]);
  const close = useCallback(() => requestExit({ kind: "Close" }), [requestExit]);
  const escape = useCallback(() => {
    if (page.kind === "Root" && query.trim()) {
      setQuery("");
      return;
    }
    if (page.kind !== "Root") {
      back();
      return;
    }
    close();
  }, [back, close, page.kind, query, setQuery]);
  const openRoot = useCallback(
    () => requestExit({ kind: "Replace", detail: { kind: "Root" } }),
    [requestExit],
  );
  const guardClose = useCallback((): DismissDecision => {
    if (page.kind === "Root" && query.trim()) {
      setQuery("");
      return "blocked";
    }
    if (page.kind !== "Root" && page.kind !== "ActivationBlocked") {
      back();
      return "blocked";
    }
    return guardExit({ kind: "Close" });
  }, [back, guardExit, page.kind, query, setQuery]);
  const dismissAccepted = useCallback(() => performExit({ kind: "Close" }), [performExit]);
  const openTarget = useCallback(
    (target: NexusTarget) =>
      requestExit({
        kind: "Navigate",
        target,
        activation:
          page.kind === "Add"
            ? page.activation
            : PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
      }),
    [page, requestExit],
  );
  const openAddTarget = useCallback(
    (target: NexusTarget) => {
      let replayId: string | null = null;
      if (
        target.kind === "InternalHref" &&
        target.href === "/podcasts" &&
        addSession.state.opml.kind === "Complete"
      ) {
        replayId = addSession.opmlReplayIdentity;
      } else if (target.kind === "InternalHref") {
        const mediaId = /^\/media\/([^/?#]+)/.exec(target.href)?.[1] ?? null;
        const committed = mediaId
          ? addSession.state.items.find(
              (item) =>
                (item.kind === "Accepted" && item.result.mediaId === mediaId) ||
                (item.kind === "AcceptedUncertain" && item.mediaId === mediaId),
            )
          : undefined;
        replayId = committed?.id ?? null;
      }
      requestExit({
        kind: "Navigate",
        target,
        activation:
          page.kind === "Add"
            ? page.activation
            : PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
        retained: {
          source: "Import",
          completion: replayId
            ? present({ kind: "Import", replayId })
            : absent(),
          returnTo: rootReturnPoint,
        },
      });
    },
    [
      addSession.opmlReplayIdentity,
      addSession.state.items,
      addSession.state.opml.kind,
      page,
      requestExit,
      rootReturnPoint,
    ],
  );
  const keepWorking = useCallback(() => setPendingDismissal(null), []);
  const confirmDismissal = useCallback(() => {
    if (!pendingDismissal) return;
    const pending = pendingDismissal;
    setPendingDismissal(null);
    if (pending.confirmation === "Stop") stopAddSession();
    performExit(pending.intent);
  }, [pendingDismissal, performExit, stopAddSession]);

  const retry = useCallback(
    (source: DesktopNexusSource) => {
      if (source === "Openables") invalidateOpenables();
      else setSearchRetry((value) => value + 1);
    },
    [invalidateOpenables],
  );
  const initialFocus = useCallback(
    (container: HTMLElement, isMobile: boolean): HTMLElement | null => {
      if (page.kind === "Root") {
        return container.querySelector<HTMLElement>(
          isMobile ? "[data-mobile-nexus-search]" : '[role="combobox"]',
        );
      }
      if (page.kind === "CreateLibrary") {
        return container.querySelector<HTMLElement>("[data-switchboard-library-name]");
      }
      if (page.kind === "Add") {
        return resolveAddPanelInitialFocus(container, isMobile, {
          branch: addSession.state.branch,
          initialFocus: addSession.state.initialFocus,
        });
      }
      return container.querySelector<HTMLElement>("[data-switchboard-heading]");
    },
    [addSession.state.branch, addSession.state.initialFocus, page.kind],
  );
  const shouldSuppressReturnFocusOnClose = useCallback(
    () => suppressReturnFocusRef.current,
    [],
  );
  const dialogLabel =
    page.kind === "Add"
      ? addSession.state.branch === "Opml"
        ? "Import OPML"
        : "Add content"
      : "Nexus";
  const focusKey =
    page.kind === "Add"
      ? `${addSession.state.sessionId}:${addSession.state.branch}:${addSession.state.initialFocus}`
      : page.kind;
  const dismissalConfirmation: AddDismissalConfirmation = pendingDismissal
    ? {
        kind: pendingDismissal.confirmation,
        actionLabel:
          pendingDismissal.confirmation === "Discard"
            ? "Discard"
            : pendingDismissal.intent.kind === "Close" ||
                pendingDismissal.intent.kind === "Navigate"
              ? "Stop and close"
              : pendingDismissal.intent.kind === "Replace"
                ? "Stop and continue"
                : "Stop and go back",
      }
    : null;

  useEffect(() => {
    const openIntent = (detail: NexusOpenIntent) =>
      requestExit({ kind: "Replace", detail });
    const handler = (event: Event) =>
      openIntent(
        (event as CustomEvent<NexusOpenIntent>).detail ?? { kind: "Root" },
      );
    window.addEventListener(NEXUS_OPEN_REQUESTED_EVENT, handler);
    setNexusOpenReceiverReady(true);
    consumePendingNexusOpenIntents().forEach(openIntent);
    return () => {
      window.removeEventListener(NEXUS_OPEN_REQUESTED_EVENT, handler);
      setNexusOpenReceiverReady(false);
    };
  }, [requestExit]);
  useLayoutEffect(() => {
    const intent = consumeNexusUrlIntent();
    if (intent) requestExit({ kind: "Replace", detail: intent });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot URL ingress.
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const openBinding = keybindings["Nexus.Open"];
      if (openBinding && matchesKeyEvent(openBinding, event)) {
        event.preventDefault();
        if (open) requestActiveActions();
        else openRoot();
        return;
      }
      for (const [actionId, combo] of Object.entries(keybindings)) {
        if (actionId === "Nexus.Open" || !matchesKeyEvent(combo, event)) continue;
        const command = NEXUS_COMMAND_IDS.includes(actionId as NexusCommandId)
          ? getNexusCommand(actionId as NexusCommandId)
          : null;
        const destination = DESTINATIONS.find((entry) => entry.id === actionId);
        const target = command
          ? command.target({ argument: "" })
          : destination?.id === "today"
            ? {
                kind: "OpenDailyPage" as const,
                date: { kind: "Today" as const },
                entry: { kind: "View" as const },
              }
            : destination
              ? {
                  kind: "InternalHref" as const,
                  href: destination.href,
                  labelHint: destination.label,
                }
              : null;
        if (!target) continue;
        event.preventDefault();
        requestExit({ kind: "Navigate", target });
        return;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [keybindings, open, openRoot, requestActiveActions, requestExit]);

  const createChoiceActions = useMemo(
    () =>
      page.kind === "ChooseCreate"
        ? nexusCreateChoiceActions(page.initialDraft, todayAppend)
        : [],
    [page, todayAppend],
  );
  const browseChoiceActions = useMemo(
    () =>
      page.kind === "ChooseBrowse"
        ? nexusBrowseChoiceActions(page.query)
        : [],
    [page],
  );
  const desktop: DesktopNexusController = {
    open,
    projection,
    query,
    failures,
    busy: showBusy && remoteBusy,
    announcement: announcement || null,
    focusKey,
    nexusOpenShortcutLabel: keybindingController.labelFor("Nexus.Open") ?? "",
    actionsRequest,
    inputReady: () =>
      completeNexusPerformanceAfterPaint(NEXUS_OPEN_PERFORMANCE),
    setQuery,
    setActiveEntry,
    activatePrimary: ({ entry, disposition, modality }) =>
      activateAction(
        entry.primaryAction,
        { disposition: { kind: disposition }, modality },
        entry,
      ),
    activateAction: ({ entry, action, modality }) =>
      activateAction(
        action,
        { disposition: { kind: "Follow" }, modality },
        entry,
      ),
    retry,
    escape,
    shouldSuppressReturnFocusOnClose,
  };

  return {
    open,
    paneCount: panes.length,
    query,
    page,
    projection,
    actionsRequest,
    failures,
    busy: showBusy && remoteBusy,
    pending: remoteBusy,
    announcement,
    addSession,
    dialogLabel,
    focusKey,
    dismissalConfirmation,
    desktop,
    managedPanes: panes,
    managedClosedPanes,
    createChoiceActions,
    browseChoiceActions,
    setQuery,
    setActiveEntry,
    openEntryActions,
    announceUnavailable,
    activateAction,
    materialize,
    dispatch,
    reportActivationFailure: fail,
    retry,
    openTarget,
    openAddTarget,
    back,
    escape,
    openRoot,
    close,
    dismissAccepted,
    guardClose,
    initialFocus,
    shouldSuppressReturnFocusOnClose,
    keepWorking,
    confirmDismissal,
    setLibraryNameDraft,
    submitLibrary,
    retryPageCreation,
    manageTabs,
    openManagedPane,
    closeManagedPane,
    restoreManagedPane,
    retryRetainedActivation,
    cancelRetainedActivation,
  };
}
