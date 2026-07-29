"use client";

import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  type ApiPath,
} from "@/lib/api/client";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import { useResource } from "@/lib/api/useResource";
import { usePaneWarm } from "@/lib/panes/paneWarm";
import { dispatchPaneSearchRequest } from "@/lib/panes/paneSearchEvents";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { matchesKeyEvent } from "@/lib/keybindings";
import {
  useKeybindingLabel,
  useKeybindings,
} from "@/lib/keybindingsProvider";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { buildResourceNexusActions } from "@/lib/nexus/actions";
import {
  dispatchNexusTarget,
  isAndroidShellRestrictedHref,
  PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
  PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
  type NexusDispatchOutcome,
  type NexusDispatchCtx,
} from "@/lib/nexus/dispatch";
import {
  consumeNexusUrlIntent,
  NEXUS_OPEN_REQUESTED_EVENT,
} from "@/lib/nexus/events";
import {
  type CommittedWorkflow,
  type NexusAction,
  type NexusEntry,
  type NexusFindScope,
  type NexusOpenIntent,
  type NexusPage,
  type NexusQuickAction,
  type NexusSourceStatus,
  type NexusTarget,
  type NexusTargetActivation,
  type RetainedActivation,
} from "@/lib/nexus/model";
import {
  buildNexusZeroState,
  commitNexusRevision,
  composeNexusFindEntries,
  mergeProgressiveNexusEntries,
  parseNexusFindQuery,
  projectNexusLocalEntries,
  projectNexusOpenableEntries,
  projectNexusSearchEntries,
  type NexusPane,
  type NexusRecentTarget,
  type ProgressiveNexusCommit,
} from "@/lib/nexus/results";
import { serializeNexusEntryKey } from "@/lib/nexus/ranking";
import {
  beginNexusDesktopLocalRows,
  beginNexusDesktopOpen,
  beginNexusDesktopPaneActivation,
  beginNexusDesktopProviders,
  cancelNexusDesktopRun,
  completeNexusDesktopLocalRows,
  completeNexusDesktopOpenInputReady,
  completeNexusDesktopProviders,
  NEXUS_DESKTOP_PANE_ACTIVATE,
  NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
  type NexusProviderPhase,
  type NexusProviderSource,
} from "@/lib/nexus/performance";
import {
  getQuickAction,
  SWITCHBOARD_QUICK_ACTION_IDS,
} from "@/lib/nexus/quickActions";
import {
  NexusWebContractDefect,
  searchNexusWeb,
  webResultAddSeed,
} from "@/lib/nexus/webSearch";
import type {
  DesktopNexusController,
  DesktopNexusModality,
  DesktopNexusWebResult,
} from "./desktop/types";
import { paneStatusLabel } from "@/lib/switchboard/paneStatusLabel";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import type { Destination } from "@/lib/navigation/destinations";
import {
  fetchSearchResultPage,
  SearchContractDefect,
} from "@/lib/search/searchApi";
import { SEARCH_KINDS } from "@/lib/search/kinds";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import {
  useRenderEnvironment,
  useViewportState,
} from "@/lib/renderEnvironment/provider";
import type { DismissDecision } from "@/lib/ui/useHistoryDismiss";
import { getWorkspacePrimaryPanes } from "@/lib/workspace/schema";
import {
  resolveWorkspacePaneLabel,
  useWorkspaceStore,
} from "@/lib/workspace/store";
import { useShareController } from "@/lib/sharing/controller";
import { findPaneChromeFocusTarget } from "@/lib/workspace/paneDom";
import type { BrowseResult } from "@/lib/browse/types";
import { fetchPodcastBrowseResults } from "@/lib/browse/client";
import {
  ResourceOpenablesContractDefect,
  searchOpenableResources,
  type ResourceOpenableSearchResponse,
} from "@/lib/resources/openableResources";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import {
  switchboardOpenableSchemes,
  switchboardSearchQuery,
} from "@/lib/switchboard/findScopes";
import {
  mergeSwitchboardRows,
  resourceMatchForQuery,
} from "@/lib/switchboard/merge";
import {
  completeSwitchboardPerformance,
  NEXUS_OPENABLES_PERFORMANCE,
} from "@/lib/switchboard/performance";
import type {
  SwitchboardItem,
  SwitchboardRowModel,
} from "@/lib/switchboard/model";
import { SWITCHBOARD_PLACES } from "@/lib/switchboard/places";
import { absent, present, type Presence } from "@/lib/api/presence";
import { createNotePage } from "@/lib/notes/api";
import { setPendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { createLibrary } from "@/lib/libraries/client";
import { createRandomId } from "@/lib/createRandomId";
import { subscribeToPodcast } from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import {
  resolveAddPanelInitialFocus,
  type AddDismissalConfirmation,
} from "./AddPanel";
import {
  useAddContentSession,
  type AddContentSessionController,
} from "./useAddContentSession";
import {
  useTodayCaptureSession,
  type TodayCaptureSessionController,
} from "./useTodayCaptureSession";

interface NexusHistoryResponse {
  data: {
    recent: NexusRecentTarget[];
    frecency_by_href: Record<string, number>;
  };
}

const NEXUS_OPENABLE_DEBOUNCE_MS = 80;
const NEXUS_SEARCH_DEBOUNCE_MS = 160;
const SWITCHBOARD_OPENABLE_DEBOUNCE_MS = 80;
const SWITCHBOARD_DEEP_DEBOUNCE_MS = 160;
const SWITCHBOARD_BUSY_DELAY_MS = 150;
const EMPTY_RECENT: NexusRecentTarget[] = [];
const EMPTY_FRECENCY: Record<string, number> = {};
const EMPTY_SEARCH: SearchResultRowViewModel[] = [];
const DEFAULT_LIBRARY_IDS: string[] = [];

function isRetryableWorkflowFailure(error: unknown): boolean {
  return (
    isApiError(error) ||
    error instanceof TypeError ||
    error instanceof DOMException
  );
}

function nexusSourceStatus(input: {
  enabled: boolean;
  loading: boolean;
  ready: boolean;
  failed: boolean;
}): NexusSourceStatus {
  if (!input.enabled) return "Idle";
  if (input.loading) return "Loading";
  if (input.failed) return "RetryableFailure";
  return input.ready ? "Ready" : "Idle";
}

function desktopPaneTargetId(
  target: NexusTarget,
  panes: readonly NexusPane[],
): string | null {
  if (target.kind === "InternalHref") {
    return resolveWorkspaceActivationRouteId(target.href);
  }
  if (target.kind === "PaneOpen") {
    const pane = panes.find((candidate) => candidate.id === target.paneId);
    return pane ? resolveWorkspaceActivationRouteId(pane.href) : null;
  }
  if (
    target.kind === "ResourceOpen" &&
    target.subject.activation.kind === "route" &&
    target.subject.activation.href !== null
  ) {
    return resolveWorkspaceActivationRouteId(target.subject.activation.href);
  }
  return null;
}

type PodcastBrowseResult = Extract<
  BrowseResult,
  { type: "podcasts" | "podcast_episodes" }
>;

export interface SwitchboardPane {
  id: string;
  href: string;
  label: string;
  visibility: "visible" | "minimized";
  current: boolean;
  activationRouteId: ReturnType<typeof resolveWorkspaceActivationRouteId>;
}

export interface SwitchboardClosedPane {
  id: string;
  label: string;
}

function routeOnlyOpenableSubject(item: ResourceItem) {
  const href = item.activation.href;
  if (item.activation.kind !== "route" || href === null) {
    // justify-defect: the owned openables endpoint admits route activations only.
    throw new Error(`Openable resource is not route-admitted: ${item.ref}`);
  }
  const ref = assumeCanonicalResourceRef(item.ref);
  if (item.activation.resourceRef !== ref) {
    // justify-defect: a canonical ResourceItem cannot identify two resources.
    throw new Error(`Openable activation does not match ${item.ref}`);
  }
  return {
    href,
    subject: {
      kind: "Resource" as const,
      ref,
      activation: item.activation,
      missing: item.missing,
    },
  };
}

function openableRow(
  item: ResourceItem,
  query: string,
  recentRouteIds: ReadonlySet<string>,
): SwitchboardRowModel {
  const { href, subject } = routeOnlyOpenableSubject(item);
  return {
    id: `Resource:${item.ref}`,
    item: {
      kind: "Resource",
      occurrenceRef: item.ref,
      ownerRef: item.ref,
      activationRouteId: resolveWorkspaceActivationRouteId(href),
      subject,
      label: item.label,
      summary: item.summary,
      match: resourceMatchForQuery(
        item.label,
        item.summary,
        query,
        "Openable",
      ),
    },
    label: item.label,
    metadata: item.summary,
    recent: recentRouteIds.has(resolveWorkspaceActivationRouteId(href)),
  };
}

function deepSearchRow(
  result: SearchResultRowViewModel,
  query: string,
  recentRouteIds: ReadonlySet<string>,
): SwitchboardRowModel | null {
  const href = result.actionTarget.activation.href;
  if (
    result.actionTarget.missing ||
    result.actionTarget.activation.kind !== "route" ||
    href === null
  ) {
    return null;
  }
  const summary =
    result.snippetSegments.map((segment) => segment.text).join("").trim() ||
    result.sourceMeta ||
    result.typeLabel;
  const deep =
    result.resourceRef !== result.ownerResourceRef ||
    result.contextRef?.locator !== undefined ||
    result.type === "note_block" ||
    result.type === "message";
  return {
    id: `Resource:${result.resourceRef}`,
    item: {
      kind: "Resource",
      occurrenceRef: result.resourceRef,
      ownerRef: result.ownerResourceRef,
      activationRouteId: resolveWorkspaceActivationRouteId(href),
      subject: result.actionTarget,
      label: result.primaryText,
      summary,
      match: deep
        ? "Deep"
        : resourceMatchForQuery(
            result.primaryText,
            summary,
            query,
            "Openable",
          ),
    },
    label: result.primaryText,
    metadata: result.sourceMeta ?? result.typeLabel,
    recent: recentRouteIds.has(resolveWorkspaceActivationRouteId(href)),
  };
}

export interface NexusController {
  open: boolean;
  paneCount: number;
  query: string;
  page: NexusPage;
  addSession: AddContentSessionController;
  todaySession: TodayCaptureSessionController;
  dialogLabel: string;
  focusKey: string;
  dismissalConfirmation: AddDismissalConfirmation;
  desktop: DesktopNexusController;
  webSearch: {
    readonly query: string;
    readonly status: NexusSourceStatus;
    readonly results: readonly DesktopNexusWebResult[];
  } | null;
  switchboardPanes: readonly SwitchboardPane[];
  switchboardClosedPanes: readonly SwitchboardClosedPane[];
  switchboardPlaces: readonly Destination[];
  switchboardQuickActions: readonly NexusQuickAction[];
  switchboardFindRows: readonly SwitchboardRowModel[];
  switchboardFindActiveId: string | null;
  switchboardFindBusy: boolean;
  // Raw (undelayed) remote in-flight state. `busy` is delayed by
  // SWITCHBOARD_BUSY_DELAY for the "Searching…" indicator; `pending` gates the
  // "No results" empty state so it never flashes while a search is running.
  switchboardFindPending: boolean;
  switchboardOpenablesFailed: boolean;
  switchboardDeepFailed: boolean;
  podcastResults: readonly PodcastBrowseResult[];
  podcastBusy: boolean;
  podcastSubscribingId: string | null;
  podcastFailed: boolean;
  setQuery(next: string): void;
  openTarget(target: NexusTarget): void;
  openAddTarget(target: NexusTarget): void;
  back(): void;
  openRoot(): void;
  enterFind(): void;
  setFindScope(scope: NexusFindScope): void;
  setSwitchboardFindActiveId(id: string | null): void;
  openSwitchboardItem(item: SwitchboardItem, fork: boolean): void;
  switchboardItemActions(item: SwitchboardItem): readonly NexusAction[];
  runSwitchboardAction(action: NexusAction): void;
  runAction(action: NexusAction): void;
  openSwitchboardPlace(destination: Destination): void;
  runSwitchboardQuickAction(action: NexusQuickAction): void;
  closeSwitchboardPane(paneId: string): void;
  restoreSwitchboardPane(paneId: string): void;
  retrySwitchboardOpenables(): void;
  retrySwitchboardDeep(): void;
  setLibraryNameDraft(name: string): void;
  submitLibrary(): void;
  retryPageCreation(): void;
  setPodcastQuery(query: string): void;
  selectPodcast(result: PodcastBrowseResult): void;
  retryPodcastSearch(): void;
  setWebQuery(next: string): void;
  retryWebSearch(): void;
  selectMobileWebResult(id: string, fork: boolean): void;
  manageTabs(): void;
  retryRetainedActivation(): void;
  cancelRetainedActivation(): void;
  close(): void;
  dismissAccepted(): void;
  guardClose(): DismissDecision;
  escape(): void;
  initialFocus(container: HTMLElement, isMobile: boolean): HTMLElement | null;
  keepWorking(): void;
  confirmDismissal(): void;
  shouldSuppressReturnFocusOnClose(): boolean; // read at close: true after a navigating dispatch
}

type ExitIntent =
  | { kind: "Close" }
  | { kind: "Root" }
  | { kind: "Content" }
  | {
      kind: "Navigate";
      target: NexusTarget;
      retained?: Omit<RetainedActivation, "target" | "activation">;
      // Absent → Follow (desktop destination/today keyboard navigation). A
      // completed Switchboard workflow (Import result) passes an Adopt
      // activation so it opens beside, never replaces, the source pane.
      activation?: NexusTargetActivation;
    }
  | { kind: "Replace"; detail: NexusOpenIntent };

type PendingDismissal = {
  confirmation: Exclude<AddDismissalConfirmation, null>["kind"];
  intent: ExitIntent;
};

export function useNexusController(): NexusController {
  const { androidShell } = useRenderEnvironment();
  const viewport = useViewportState();
  const keybindings = useKeybindings();
  const paneSearchKeybindingHint = useKeybindingLabel("Pane.Search");
  const feedback = useFeedback();
  const { openShare } = useShareController();
  const warmPane = usePaneWarm();
  // The one Lectern capability (append is stable across renders); dispatch's queue-add
  // case calls it. useLectern requires a LecternProvider ancestor (AuthenticatedShell).
  const { placeItems } = useLectern();
  const addSession = useAddContentSession();
  const todaySession = useTodayCaptureSession();
  const {
    start: startAddSession,
    backToContent: backToAddContent,
    discard: discardAddSession,
    stop: stopAddSession,
  } = addSession;
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [page, setPage] = useState<NexusPage>({ kind: "Root" });
  const [desktopCommit, setDesktopCommit] =
    useState<ProgressiveNexusCommit>({
      entries: [],
      activeKey: null,
    });
  const [desktopOpenablesRetry, setDesktopOpenablesRetry] = useState(0);
  const [desktopSearchRetry, setDesktopSearchRetry] = useState(0);
  const [webRetry, setWebRetry] = useState(0);
  const [activeWebResultId, setActiveWebResultId] =
    useState<string | null>(null);
  const [pendingDismissal, setPendingDismissal] =
    useState<PendingDismissal | null>(null);
  const [switchboardFindActiveId, setSwitchboardFindActiveId] =
    useState<string | null>(null);
  const [openablesRetry, setOpenablesRetry] = useState(0);
  const [deepRetry, setDeepRetry] = useState(0);
  const [podcastRetry, setPodcastRetry] = useState(0);
  const [podcastSubscribingId, setPodcastSubscribingId] =
    useState<string | null>(null);
  const [showSwitchboardBusy, setShowSwitchboardBusy] = useState(false);
  const podcastSubscribeRunningRef = useRef(new Set<string>());
  const userMovedRef = useRef(false);
  // Close reason for the dialog's return-focus. Reset to the a11y default (restore the
  // opener) on every open; a navigating dispatch flips it true just before it closes so
  // the surface's useReturnFocus doesn't yank focus back from the destination.
  const suppressReturnFocusRef = useRef(false);
  const previousSwitchboardRowsRef = useRef<{
    key: string;
    rows: readonly SwitchboardRowModel[];
  }>({ key: "", rows: [] });
  const desktopRunCounterRef = useRef(0);
  const desktopOpenRunRef = useRef<string | null>(null);
  const desktopLocalRunRef = useRef<{
    id: string;
    revision: string;
  } | null>(null);
  const desktopProviderRunsRef = useRef<
    Record<
      NexusProviderSource,
      {
        id: string;
        revision: string;
        phase: NexusProviderPhase;
        sawLoading: boolean;
        terminalEpoch: number | null;
      } | null
    >
  >({ Openables: null, Owned: null });
  const desktopProviderWarmRef = useRef<
    Record<NexusProviderSource, boolean>
  >({ Openables: false, Owned: false });
  const desktopOpenablesCacheRef = useRef(
    new Map<string, ResourceOpenableSearchResponse>(),
  );
  const clearDesktopOpenablesCache = useCallback(() => {
    desktopOpenablesCacheRef.current.clear();
  }, []);
  const invalidateDesktopOpenablesCache = useCallback(() => {
    clearDesktopOpenablesCache();
    setDesktopOpenablesRetry((current) => current + 1);
  }, [clearDesktopOpenablesCache]);
  const previousAddMutationKindRef = useRef(
    addSession.state.mutation.kind,
  );
  const previousTodaySaveStatusRef = useRef(todaySession.saveStatus);
  const [desktopCommitEpoch, setDesktopCommitEpoch] = useState(0);

  const {
    state,
    recentlyClosedPanes,
    runtimeLabelByPaneId,
    activatePane,
    activateWorkspaceTarget,
    closePane,
    restoreClosedPane,
    restorePane,
  } = useWorkspaceStore();

  useEffect(() => {
    if (!open) return;
    suppressReturnFocusRef.current = false;
    // Openables are reusable only within one modal invocation. Resource
    // mutations elsewhere in the app cannot race this modal, and a later open
    // always starts from the canonical owner.
    clearDesktopOpenablesCache();
  }, [clearDesktopOpenablesCache, open]);

  useEffect(() => {
    const current = addSession.state.mutation.kind;
    if (
      previousAddMutationKindRef.current === "Running" &&
      current === "Idle"
    ) {
      invalidateDesktopOpenablesCache();
    }
    previousAddMutationKindRef.current = current;
  }, [
    addSession.state.mutation.kind,
    invalidateDesktopOpenablesCache,
  ]);

  useEffect(() => {
    const current = todaySession.saveStatus;
    if (
      previousTodaySaveStatusRef.current !== current &&
      current === "saved"
    ) {
      invalidateDesktopOpenablesCache();
    }
    previousTodaySaveStatusRef.current = current;
  }, [invalidateDesktopOpenablesCache, todaySession.saveStatus]);

  const parsedQuery = useMemo(() => parseNexusFindQuery(query), [query]);
  const requestedHistoryPath = useMemo<ApiPath | null>(() => {
    if (!open || viewport.isMobile) return null;
    return parsedQuery.text
      ? `/api/me/nexus-history?${new URLSearchParams({ query: parsedQuery.text }).toString()}`
      : "/api/me/nexus-history";
  }, [open, parsedQuery.text, viewport.isMobile]);

  const historyResource = useResource<NexusHistoryResponse>({
    cacheKey: requestedHistoryPath,
    path: (path) => path as ApiPath,
  });
  const historyProjection = useMemo(() => {
    if (historyResource.status !== "ready") {
      return { rows: EMPTY_RECENT, frecencyByHref: EMPTY_FRECENCY };
    }
    return {
      rows: historyResource.data.data.recent.filter(
        (recent) =>
          !isAndroidShellRestrictedHref(recent.target_href, androidShell),
      ),
      frecencyByHref: historyResource.data.data.frecency_by_href,
    };
  }, [androidShell, historyResource]);
  const historyRows = historyProjection.rows;
  const frecencyByHref = historyProjection.frecencyByHref;

  const desktopFindEnabled =
    open && !viewport.isMobile && parsedQuery.text.length > 0;
  const desktopOpenablesIdentity = desktopFindEnabled ? query : null;
  const desktopOpenablesFetch = useDebouncedFetch(
    desktopOpenablesIdentity !== null
      ? `${query}:${desktopOpenablesRetry}`
      : null,
    async (signal) => {
      const cacheKey = parsedQuery.text.toLocaleLowerCase();
      const cached = desktopOpenablesCacheRef.current.get(cacheKey);
      if (cached !== undefined) {
        desktopOpenablesCacheRef.current.delete(cacheKey);
        desktopOpenablesCacheRef.current.set(cacheKey, cached);
        return cached;
      }
      const response = await searchOpenableResources({
        q: parsedQuery.text,
        schemes: absent(),
        signal,
      });
      if (!signal.aborted) {
        desktopOpenablesCacheRef.current.set(cacheKey, response);
        if (desktopOpenablesCacheRef.current.size > 32) {
          const oldest = desktopOpenablesCacheRef.current.keys().next().value;
          if (oldest !== undefined) {
            desktopOpenablesCacheRef.current.delete(oldest);
          }
        }
      }
      return response;
    },
    {
      debounceMs:
        parsedQuery.text.length === 1 ? 0 : NEXUS_OPENABLE_DEBOUNCE_MS,
      identity: desktopOpenablesIdentity,
    },
  );
  const ownedSearchQuery = useMemo(
    () => {
      const requestedKinds =
        parsedQuery.searchQuery.requestedKinds ??
        new Set(SEARCH_KINDS);
      return {
        ...parsedQuery.searchQuery,
        requestedKinds: new Set(
          [...requestedKinds].filter((kind) => kind !== "web"),
        ),
      };
    },
    [parsedQuery.searchQuery],
  );
  const desktopSearchCandidateIdentity =
    open && !viewport.isMobile && parsedQuery.text.length >= 2
      ? query
      : null;
  const desktopOpenablesTerminal =
    desktopOpenablesFetch.dataIdentity === desktopSearchCandidateIdentity ||
    desktopOpenablesFetch.errorIdentity === desktopSearchCandidateIdentity;
  // Owned retrieval is the expensive enrichment path. Its quiet period starts
  // only after the faster Openables source reaches a terminal state, so stale
  // deep SQL never contends with the first-usable path during rapid typing.
  const desktopSearchIdentity =
    desktopSearchCandidateIdentity !== null &&
    desktopOpenablesTerminal
      ? desktopSearchCandidateIdentity
      : null;
  const desktopSearchFetch = useDebouncedFetch(
    desktopSearchIdentity !== null
      ? `${query}:${desktopSearchRetry}`
      : null,
    (signal) =>
      fetchSearchResultPage(ownedSearchQuery, {
        limit: 40,
        cursor: null,
        signal,
      }),
    {
      debounceMs: NEXUS_SEARCH_DEBOUNCE_MS,
      identity: desktopSearchIdentity,
    },
  );
  const webQuery =
    page.kind === "WebSearch" ? page.query.trim() : "";
  const webIdentity =
    open && page.kind === "WebSearch" && webQuery.length > 0
      ? webQuery
      : null;
  const webFetch = useDebouncedFetch(
    webIdentity !== null
      ? `${webQuery}:${webRetry}`
      : null,
    (signal) => searchNexusWeb({ query: webQuery, signal }),
    {
      debounceMs: NEXUS_SEARCH_DEBOUNCE_MS,
      identity: webIdentity,
    },
  );

  const mobileFindQuery =
    page.kind === "Find" ? page.query.trim() : "";
  const mobileFindScope =
    page.kind === "Find" ? page.scope : ("All" as const);
  const mobileFindEnabled =
    open && viewport.isMobile && page.kind === "Find";
  const openablesIdentity =
    mobileFindEnabled && mobileFindQuery.length >= 1
      ? `${mobileFindScope}:${mobileFindQuery}`
      : null;
  const openablesFetch = useDebouncedFetch(
    openablesIdentity !== null
      ? `${openablesIdentity}:${openablesRetry}`
      : null,
    (signal) =>
      searchOpenableResources({
        q: mobileFindQuery,
        schemes: switchboardOpenableSchemes(mobileFindScope),
        signal,
      }),
    {
      debounceMs: SWITCHBOARD_OPENABLE_DEBOUNCE_MS,
      identity: openablesIdentity,
    },
  );
  const switchboardDeepQuery = useMemo(
    () => switchboardSearchQuery(mobileFindScope, mobileFindQuery),
    [mobileFindQuery, mobileFindScope],
  );
  const deepIdentity =
    mobileFindEnabled &&
    mobileFindQuery.length >= 2 &&
    switchboardDeepQuery !== null
      ? `${mobileFindScope}:${mobileFindQuery}`
      : null;
  const deepFetch = useDebouncedFetch(
    deepIdentity !== null
      ? `${deepIdentity}:${deepRetry}`
      : null,
    (signal) =>
      fetchSearchResultPage(switchboardDeepQuery!, {
        limit: 20,
        cursor: null,
        signal,
      }),
    {
      debounceMs: SWITCHBOARD_DEEP_DEBOUNCE_MS,
      identity: deepIdentity,
    },
  );

  const podcastQuery =
    page.kind === "PodcastDiscovery" ? page.query.trim() : "";
  const podcastIdentity =
    open &&
    page.kind === "PodcastDiscovery" &&
    podcastQuery.length >= 1
      ? podcastQuery
      : null;
  const podcastFetch = useDebouncedFetch(
    podcastIdentity !== null
      ? `${podcastQuery}:${podcastRetry}`
      : null,
    (signal) =>
      fetchPodcastBrowseResults({
        query: podcastQuery,
        signal,
      }),
    {
      debounceMs: SWITCHBOARD_DEEP_DEBOUNCE_MS,
      identity: podcastIdentity,
    },
  );
  const desktopOpenablesData =
    desktopOpenablesFetch.dataIdentity === desktopOpenablesIdentity
      ? desktopOpenablesFetch.data
      : null;
  const desktopOpenablesError =
    desktopOpenablesFetch.errorIdentity === desktopOpenablesIdentity
      ? desktopOpenablesFetch.error
      : null;
  const desktopSearchData =
    desktopSearchFetch.dataIdentity === desktopSearchIdentity
      ? desktopSearchFetch.data
      : null;
  const desktopSearchError =
    desktopSearchFetch.errorIdentity === desktopSearchIdentity
      ? desktopSearchFetch.error
      : null;
  const webData =
    webFetch.dataIdentity === webIdentity ? webFetch.data : null;
  const webError =
    webFetch.errorIdentity === webIdentity ? webFetch.error : null;
  const openablesData =
    openablesFetch.dataIdentity === openablesIdentity
      ? openablesFetch.data
      : null;
  const openablesError =
    openablesFetch.errorIdentity === openablesIdentity
      ? openablesFetch.error
      : null;
  const deepData =
    deepFetch.dataIdentity === deepIdentity ? deepFetch.data : null;
  const deepError =
    deepFetch.errorIdentity === deepIdentity ? deepFetch.error : null;
  const podcastData =
    podcastFetch.dataIdentity === podcastIdentity
      ? podcastFetch.data
      : null;
  const podcastError =
    podcastFetch.errorIdentity === podcastIdentity
      ? podcastFetch.error
      : null;
  useLayoutEffect(() => {
    if (openablesData !== null) {
      completeSwitchboardPerformance(NEXUS_OPENABLES_PERFORMANCE);
    }
  }, [openablesData]);

  const switchboardContractDefect =
    openablesError instanceof ResourceOpenablesContractDefect ||
    isSameSystemApiDefect(openablesError)
      ? openablesError
      : deepError instanceof SearchContractDefect ||
          isSameSystemApiDefect(deepError)
        ? deepError
        : null;
  if (switchboardContractDefect !== null) {
    throw switchboardContractDefect;
  }

  const mobileRemoteBusy =
    openablesFetch.loading || deepFetch.loading || podcastFetch.loading;
  useEffect(() => {
    if (!mobileRemoteBusy) {
      setShowSwitchboardBusy(false);
      return;
    }
    const timer = window.setTimeout(
      () => setShowSwitchboardBusy(true),
      SWITCHBOARD_BUSY_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [mobileRemoteBusy]);

  // --- Context → items → view (pure, memoized) ---
  const panes = useMemo(
    () =>
      getWorkspacePrimaryPanes(state).map((pane) => ({
        id: pane.id,
        href: pane.currentVisit.href,
        visibility: pane.visibility,
        label: resolveWorkspacePaneLabel(pane, runtimeLabelByPaneId).label,
      })),
    [state, runtimeLabelByPaneId],
  );
  const switchboardPanes = useMemo<SwitchboardPane[]>(
    () =>
      panes.map((pane) => ({
        ...pane,
        current: pane.id === state.activePrimaryPaneId,
        activationRouteId: resolveWorkspaceActivationRouteId(pane.href),
      })),
    [panes, state.activePrimaryPaneId],
  );
  const switchboardClosedPanes = useMemo<SwitchboardClosedPane[]>(
    () =>
      recentlyClosedPanes.map((snapshot) => ({
        id: snapshot.pane.id,
        label: resolveWorkspacePaneLabel(
          snapshot.pane,
          runtimeLabelByPaneId,
        ).label,
      })),
    [recentlyClosedPanes, runtimeLabelByPaneId],
  );
  const ownerPaneRows = useMemo<SwitchboardRowModel[]>(
    () =>
      [...switchboardPanes]
        .sort((left, right) => {
          if (left.current !== right.current) return left.current ? -1 : 1;
          if (left.visibility !== right.visibility) {
            return left.visibility === "visible" ? -1 : 1;
          }
          return 0;
        })
        .map((pane) => ({
          id: `OpenPane:${pane.id}`,
          item: {
            kind: "OpenPane",
            paneId: pane.id,
            activationRouteId: pane.activationRouteId,
          },
          label: pane.label,
          metadata: paneStatusLabel(pane),
          recent: false,
        })),
    [switchboardPanes],
  );
  const recentRouteIds = useMemo(() => {
    const ids = new Set<string>();
    for (const history of historyRows) {
      if (resolvePaneRoute(history.target_href).id !== "unsupported") {
        ids.add(resolveWorkspaceActivationRouteId(history.target_href));
      }
    }
    return ids;
  }, [historyRows]);

  const localFindRows = useMemo<SwitchboardRowModel[]>(() => {
    const query = mobileFindQuery.toLocaleLowerCase();
    if (!query) return [];
    const paneRows = switchboardPanes.flatMap((pane) => {
      if (
        !pane.label.toLocaleLowerCase().includes(query) &&
        !pane.href.toLocaleLowerCase().includes(query)
      ) {
        return [];
      }
      return [
        {
          id: `OpenPane:${pane.id}`,
          item: {
            kind: "OpenPane" as const,
            paneId: pane.id,
            activationRouteId: resolveWorkspaceActivationRouteId(pane.href),
          },
          label: pane.label,
          metadata: paneStatusLabel(pane),
          recent: false,
        },
      ];
    });
    const recentHrefs = new Set(
      historyRows.map((history) => history.target_href),
    );
    const destinationRows = DESTINATIONS.flatMap((destination) => {
      if (
        ![
          destination.label,
          destination.href,
          ...destination.keywords,
        ].some((value) => value.toLocaleLowerCase().includes(query))
      ) {
        return [];
      }
      return [
        {
          id: `Destination:${destination.id}`,
          item: {
            kind: "Destination" as const,
            destinationId: destination.id,
          },
          label: destination.label,
          metadata: "Place",
          recent: recentHrefs.has(destination.href),
        },
      ];
    });
    return [...paneRows, ...destinationRows];
  }, [historyRows, mobileFindQuery, switchboardPanes]);

  const openableRows = useMemo(
    () =>
      (openablesData?.items ?? []).map((item) =>
        openableRow(item, mobileFindQuery, recentRouteIds),
      ),
    [mobileFindQuery, openablesData, recentRouteIds],
  );
  const deepRows = useMemo(() => {
    return (deepData?.rows ?? []).flatMap((result) => {
      const row = deepSearchRow(result, mobileFindQuery, recentRouteIds);
      return row ? [row] : [];
    });
  }, [deepData, mobileFindQuery, recentRouteIds]);
  const switchboardFindRows = useMemo(() => {
    const key = `${mobileFindScope}:${mobileFindQuery}`;
    const previous =
      previousSwitchboardRowsRef.current.key === key
        ? previousSwitchboardRowsRef.current.rows
        : [];
    const rows = mergeSwitchboardRows({
      query: mobileFindQuery,
      previous,
      incoming: [...localFindRows, ...openableRows, ...deepRows],
      ownerPanes: ownerPaneRows,
      activeId: switchboardFindActiveId,
    });
    previousSwitchboardRowsRef.current = { key, rows };
    return rows;
  }, [
    localFindRows,
    deepRows,
    mobileFindQuery,
    mobileFindScope,
    openableRows,
    ownerPaneRows,
    switchboardFindActiveId,
  ]);

  const nexusPanes = useMemo<NexusPane[]>(
    () =>
      switchboardPanes.map((pane) => ({
        id: pane.id,
        href: pane.href,
        visibility: pane.visibility,
        label: pane.label,
        current: pane.current,
      })),
    [switchboardPanes],
  );
  const quickActions = useMemo(
    () => SWITCHBOARD_QUICK_ACTION_IDS.map(getQuickAction),
    [],
  );
  const synchronousEntries = useMemo(
    () =>
      parsedQuery.text
        ? projectNexusLocalEntries({
            query: parsedQuery.text,
            panes: nexusPanes,
            destinations: DESTINATIONS,
            quickActions,
            frecencyByHref,
            paneSearchKeybindingHint: paneSearchKeybindingHint ?? undefined,
          })
        : buildNexusZeroState({
            panes: nexusPanes,
            recent: historyRows,
            frecencyByHref,
            quickActions,
          }),
    [
      frecencyByHref,
      historyRows,
      nexusPanes,
      parsedQuery.text,
      paneSearchKeybindingHint,
      quickActions,
    ],
  );
  const openableEntries = useMemo(
    () =>
      projectNexusOpenableEntries({
        query: parsedQuery.text,
        items: desktopOpenablesData?.items ?? [],
        panes: nexusPanes,
      }),
    [desktopOpenablesData, nexusPanes, parsedQuery.text],
  );
  const searchEntries = useMemo(
    () =>
      projectNexusSearchEntries({
        query: parsedQuery.text,
        rows: desktopSearchData?.rows ?? EMPTY_SEARCH,
        panes: nexusPanes,
      }),
    [desktopSearchData, nexusPanes, parsedQuery.text],
  );
  const composedDesktopEntries = useMemo(
    () =>
      parsedQuery.text
        ? composeNexusFindEntries({
            query,
            local: synchronousEntries,
            openables: openableEntries,
            search: searchEntries,
          })
        : synchronousEntries,
    [
      openableEntries,
      parsedQuery.text,
      query,
      searchEntries,
      synchronousEntries,
    ],
  );
  const desktopRevision = `${open ? "Open" : "Closed"}:${query}`;
  const revisionRef = useRef(desktopRevision);
  const synchronousEntriesRef = useRef(synchronousEntries);
  synchronousEntriesRef.current = synchronousEntries;
  useLayoutEffect(() => {
    if (viewport.isMobile) return;
    revisionRef.current = desktopRevision;
    userMovedRef.current = false;
    setDesktopCommit(
      commitNexusRevision(synchronousEntriesRef.current),
    );
    setDesktopCommitEpoch((current) => current + 1);
  }, [desktopRevision, viewport.isMobile]);
  useLayoutEffect(() => {
    if (viewport.isMobile) return;
    if (revisionRef.current !== desktopRevision) return;
    setDesktopCommit((previous) =>
      mergeProgressiveNexusEntries({
        previous,
        incoming: composedDesktopEntries,
        userMoved: userMovedRef.current,
      }),
    );
    setDesktopCommitEpoch((current) => current + 1);
  }, [composedDesktopEntries, desktopRevision, viewport.isMobile]);
  const desktopCommitRef = useRef(desktopCommit);
  desktopCommitRef.current = desktopCommit;

  useLayoutEffect(() => {
    if (viewport.isMobile) return;
    const run = desktopLocalRunRef.current;
    if (!run || run.revision !== desktopRevision) return;
    completeNexusDesktopLocalRows(run.id);
    desktopLocalRunRef.current = null;
  }, [desktopCommitEpoch, desktopRevision, viewport.isMobile]);

  useEffect(() => {
    if (
      !desktopOpenablesFetch.loading &&
      desktopOpenablesError === null &&
      desktopOpenablesData !== null
    ) {
      desktopProviderWarmRef.current.Openables = true;
    }
    if (
      !desktopSearchFetch.loading &&
      desktopSearchError === null &&
      desktopSearchData !== null
    ) {
      desktopProviderWarmRef.current.Owned = true;
    }
  }, [
    desktopOpenablesData,
    desktopOpenablesError,
    desktopOpenablesFetch.loading,
    desktopSearchData,
    desktopSearchError,
    desktopSearchFetch.loading,
  ]);

  useLayoutEffect(() => {
    for (const source of ["Openables", "Owned"] as const) {
      const run = desktopProviderRunsRef.current[source];
      if (!run || run.revision !== desktopRevision) continue;
      const loading =
        source === "Openables"
          ? desktopOpenablesFetch.loading
          : desktopSearchFetch.loading;
      const data =
        source === "Openables"
          ? desktopOpenablesData
          : desktopSearchData;
      const error =
        source === "Openables"
          ? desktopOpenablesError
          : desktopSearchError;
      if (loading) {
        run.sawLoading = true;
        continue;
      }
      if (!run.sawLoading && data === null && error === null) continue;
      if (error !== null || data === null) {
        cancelNexusDesktopRun(
          NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
          run.id,
        );
        desktopProviderRunsRef.current[source] = null;
        continue;
      }
      if (run.terminalEpoch === null) {
        run.terminalEpoch = desktopCommitEpoch;
        const other = source === "Openables" ? "Owned" : "Openables";
        const superseded = desktopProviderRunsRef.current[other];
        if (superseded) {
          cancelNexusDesktopRun(
            NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
            superseded.id,
          );
          desktopProviderRunsRef.current[other] = null;
        }
        return;
      }
      if (desktopCommitEpoch <= run.terminalEpoch) return;
      completeNexusDesktopProviders(run.id, run.phase, source);
      desktopProviderRunsRef.current[source] = null;
      return;
    }
  }, [
    desktopCommitEpoch,
    desktopOpenablesData,
    desktopOpenablesError,
    desktopOpenablesFetch.loading,
    desktopRevision,
    desktopSearchData,
    desktopSearchError,
    desktopSearchFetch.loading,
  ]);

  const setActiveEntry = useCallback(
    (key: string) => {
      userMovedRef.current = true;
      setDesktopCommit((current) => ({ ...current, activeKey: key }));
      const entry = desktopCommitRef.current.entries.find(
        (candidate) => serializeNexusEntryKey(candidate.key) === key,
      );
      const target = entry?.primaryAction.target;
      if (target?.kind === "InternalHref") {
        warmPane(target.href);
      } else if (
        target?.kind === "ResourceOpen" &&
        target.subject.activation.kind === "route" &&
        target.subject.activation.href !== null
      ) {
        warmPane(target.subject.activation.href);
      } else if (target?.kind === "PaneOpen") {
        const pane = panes.find((candidate) => candidate.id === target.paneId);
        if (pane) warmPane(pane.href);
      }
    },
    [panes, warmPane],
  );

  const dispatchCtx = useMemo<NexusDispatchCtx>(
    () => ({
      androidShell,
      feedback,
      activePaneId: state.activePrimaryPaneId,
      activateWorkspaceTarget,
      placeItems: async (input) => {
        const result = await placeItems(input);
        invalidateDesktopOpenablesCache();
        return result;
      },
      panes,
      activatePane,
      restorePane,
      closePane,
      requestPaneSearch: dispatchPaneSearchRequest,
      openShare,
      shareOptions: () => {
        const returnTarget =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        return {
          returnFocusTo: () => returnTarget,
          returnFocusFallback: present(() =>
            findPaneChromeFocusTarget(state.activePrimaryPaneId),
          ),
        };
      },
    }),
    [
      androidShell,
      feedback,
      activateWorkspaceTarget,
      invalidateDesktopOpenablesCache,
      placeItems,
      panes,
      activatePane,
      restorePane,
      closePane,
      openShare,
      state.activePrimaryPaneId,
    ],
  );

  const logSelection = useCallback(
    (entry: NexusEntry, clientMutationId: string) => {
      const target = entry.primaryAction.target;
      const href =
        target.kind === "InternalHref"
          ? target.href
          : target.kind === "ResourceOpen" &&
              target.subject.activation.kind === "route" &&
              target.subject.activation.href
            ? target.subject.activation.href
            : target.kind === "PaneOpen"
              ? panes.find((pane) => pane.id === target.paneId)?.href
              : undefined;
      if (!href || isAndroidShellRestrictedHref(href, androidShell)) return;
      void apiFetch("/api/me/nexus-selections", {
        method: "POST",
        body: JSON.stringify({
          client_mutation_id: clientMutationId,
          query: parsedQuery.text || null,
          target_href: href,
          label_snapshot: entry.label,
          source: entry.historySource,
        }),
      }).catch((error) => {
        if (handleUnauthenticatedApiError(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
        feedback.show(
          toFeedback(error, { fallback: "Nexus history was not saved" }),
        );
      });
    },
    [androidShell, feedback, panes, parsedQuery.text],
  );

  const fail = useCallback(
    (error: unknown) => {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
      feedback.show(toFeedback(error, { fallback: "Command failed" }));
    },
    [feedback],
  );

  const returnTo = useMemo<RetainedActivation["returnTo"]>(
    () =>
      page.kind === "Find"
        ? { kind: "Find", query: page.query, scope: page.scope }
        : { kind: "Root" },
    [page],
  );

  const applyDispatchOutcome = useCallback(
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

  const dispatchOwned = useCallback(
    (
      target: NexusTarget,
      activation: NexusTargetActivation,
      retained: Omit<RetainedActivation, "target" | "activation">,
    ) =>
      dispatchNexusTarget(target, dispatchCtx, activation).then((outcome) => {
        applyDispatchOutcome(outcome, activation, retained);
        return outcome;
      }),
    [applyDispatchOutcome, dispatchCtx],
  );

  const dispatchWorkspaceTarget = useCallback(
    (input: {
      target: RetainedActivation["target"];
      source: RetainedActivation["source"];
      completion?: Presence<CommittedWorkflow>;
      returnTo: RetainedActivation["returnTo"];
      activation?: NexusTargetActivation;
      onAccepted?: () => void;
    }) => {
      void dispatchOwned(
        {
          kind: "InternalHref",
          href: input.target.href,
          labelHint: input.target.labelHint,
        },
        input.activation ?? PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
        {
          source: input.source,
          completion: input.completion ?? absent(),
          returnTo: input.returnTo,
        },
      )
        .then((outcome) => {
          if (outcome.kind === "NavigationAccepted") input.onAccepted?.();
        })
        .catch(fail);
    },
    [dispatchOwned, fail],
  );

  const runPageCreation = useCallback(
    (pageId: string, activation: NexusTargetActivation) => {
      setPage({
        kind: "CreatePage",
        pageId,
        submit: { kind: "Running" },
        activation,
      });
      void createNotePage({ pageId, title: "Untitled" })
        .then((created) => {
          invalidateDesktopOpenablesCache();
          setPendingNoteFocus({ pageId: created.id, target: "title" });
          dispatchWorkspaceTarget({
            target: {
              href: `/pages/${created.id}`,
              labelHint: created.title,
            },
            source: "Page",
            completion: present({ kind: "Page", replayId: pageId }),
            returnTo: { kind: "Root" },
            activation,
          });
        })
        .catch((error: unknown) => {
          if (handleUnauthenticatedApiError(error)) return;
          if (
            isSameSystemApiDefect(error) ||
            !isRetryableWorkflowFailure(error)
          ) {
            throw error;
          }
          setPage({
            kind: "CreatePage",
            pageId,
            activation,
            submit: {
              kind: "Retryable",
              message: toFeedback(error, {
                fallback: "Couldn’t create page. Retry",
              }).title,
            },
          });
        });
    },
    [dispatchWorkspaceTarget, invalidateDesktopOpenablesCache],
  );

  const submitLibrary = useCallback(() => {
    if (page.kind !== "CreateLibrary" || page.submit.kind === "Running") {
      return;
    }
    const name = page.nameDraft.trim();
    if (!name) return;
    const libraryId = page.libraryId;
    setPage({ ...page, nameDraft: name, submit: { kind: "Running" } });
    void createLibrary({ libraryId, name })
      .then((library) => {
        invalidateDesktopOpenablesCache();
        dispatchWorkspaceTarget({
          target: {
            href: `/libraries/${library.id}`,
            labelHint: library.name,
          },
          source: "Library",
          completion: present({ kind: "Library", replayId: libraryId }),
          returnTo: { kind: "Root" },
          activation: page.activation,
        });
      })
      .catch((error: unknown) => {
        if (handleUnauthenticatedApiError(error)) return;
        if (
          isSameSystemApiDefect(error) ||
          !isRetryableWorkflowFailure(error)
        ) {
          throw error;
        }
        setPage({
          kind: "CreateLibrary",
          libraryId,
          nameDraft: name,
          activation: page.activation,
          submit: {
            kind: "Retryable",
            message: toFeedback(error, {
              fallback: "Couldn’t create library. Retry",
            }).title,
          },
        });
      });
  }, [dispatchWorkspaceTarget, invalidateDesktopOpenablesCache, page]);

  const setLibraryNameDraft = useCallback((name: string) => {
    setPage((current) => {
      if (
        current.kind !== "CreateLibrary" ||
        current.submit.kind === "Running"
      ) {
        return current;
      }
      return {
        ...current,
        nameDraft: name,
        libraryId:
          current.submit.kind === "Retryable" &&
          name !== current.nameDraft
            ? crypto.randomUUID()
            : current.libraryId,
        submit: { kind: "Ready" },
      };
    });
  }, []);

  const openSwitchboardItem = useCallback(
    (item: SwitchboardItem, fork: boolean) => {
      const activation: NexusTargetActivation = {
        disposition: { kind: fork ? "Fork" : "Adopt" },
        modality: "Programmatic",
      };
      switch (item.kind) {
        case "OpenPane": {
          const pane = panes.find((candidate) => candidate.id === item.paneId);
          if (!pane) {
            // justify-defect: rendered pane rows come from the current workspace.
            throw new Error(`Unknown Switchboard pane: ${item.paneId}`);
          }
          if (fork) {
            dispatchWorkspaceTarget({
              target: { href: pane.href, labelHint: pane.label },
              source: "Find",
              returnTo,
              activation,
            });
            return;
          }
          if (pane.visibility === "minimized") restorePane(item.paneId);
          else activatePane(item.paneId);
          suppressReturnFocusRef.current =
            item.paneId !== state.activePrimaryPaneId;
          setOpen(false);
          return;
        }
        case "ClosedPane": {
          const result = restoreClosedPane(item.paneId);
          if (result.kind === "Rejected") {
            feedback.show({
              severity: "warning",
              title: "Tab limit reached",
              message: "Close a tab, then restore this one.",
            });
            return;
          }
          suppressReturnFocusRef.current = true;
          setOpen(false);
          return;
        }
        case "Destination": {
          const destination = DESTINATIONS.find(
            (candidate) => candidate.id === item.destinationId,
          );
          if (!destination) {
            // justify-defect: destination ids are projected from the registry.
            throw new Error(
              `Unknown Switchboard destination: ${item.destinationId}`,
            );
          }
          dispatchWorkspaceTarget({
            target: {
              href: destination.href,
              labelHint: destination.label,
            },
            source: "Find",
            returnTo,
            activation,
          });
          return;
        }
        case "Resource": {
          const href = item.subject.activation.href;
          if (item.subject.activation.kind !== "route" || href === null) {
            // justify-defect: Switchboard Find admits internal routes only.
            throw new Error(
              `Switchboard resource is not internally routeable: ${item.occurrenceRef}`,
            );
          }
          dispatchWorkspaceTarget({
            target: { href, labelHint: item.label },
            source: "Find",
            returnTo,
            activation,
          });
          return;
        }
        default: {
          const _exhaustive: never = item;
          return _exhaustive;
        }
      }
    },
    [
      activatePane,
      dispatchWorkspaceTarget,
      feedback,
      panes,
      restoreClosedPane,
      restorePane,
      returnTo,
      state.activePrimaryPaneId,
    ],
  );

  const openSwitchboardPlace = useCallback(
    (destination: Destination) => {
      dispatchWorkspaceTarget({
        target: { href: destination.href, labelHint: destination.label },
        source: "Place",
        returnTo: { kind: "Root" },
        activation: PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
      });
    },
    [dispatchWorkspaceTarget],
  );

  const switchboardItemActions = useCallback(
    (item: SwitchboardItem): readonly NexusAction[] =>
      item.kind === "Resource"
        ? buildResourceNexusActions(item.subject, item.label)
        : [],
    [],
  );

  const runSwitchboardAction = useCallback(
    (action: NexusAction) => {
      void dispatchOwned(
        action.target,
        {
          disposition: { kind: "Adopt" },
          modality: "Programmatic",
        },
        {
          source: "Find",
          completion: absent(),
          returnTo,
        },
      ).catch(fail);
    },
    [dispatchOwned, fail, returnTo],
  );

  const runSwitchboardQuickAction = useCallback(
    (action: NexusQuickAction) => {
      const adopt = PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION;
      switch (action.target.kind) {
        case "TodayCapture":
          setPage({
            kind: "TodayCapture",
            sessionId: todaySession.start(),
            activation: adopt,
          });
          return;
        case "CreatePage":
          runPageCreation(crypto.randomUUID(), adopt);
          return;
        case "CreateChat":
          dispatchWorkspaceTarget({
            target: { href: "/conversations/new", labelHint: "New chat" },
            source: "Chat",
            returnTo: { kind: "Root" },
            activation: {
              disposition: { kind: "Fork" },
              modality: "Programmatic",
            },
          });
          return;
        case "CreateLibrary":
          setPage({
            kind: "CreateLibrary",
            nameDraft: "",
            libraryId: crypto.randomUUID(),
            submit: { kind: "Ready" },
            activation: adopt,
          });
          return;
        case "Import":
          setPage({
            kind: "Add",
            sessionId: startAddSession(action.target.seed),
            activation: adopt,
          });
          return;
        case "PodcastDiscovery":
          setPage({
            kind: "PodcastDiscovery",
            query: "",
            sessionId: createRandomId("podcast-discovery"),
            activation: adopt,
          });
          return;
        default: {
          const _exhaustive: never = action.target;
          return _exhaustive;
        }
      }
    },
    [dispatchWorkspaceTarget, runPageCreation, startAddSession, todaySession],
  );

  const selectPodcast = useCallback(
    (result: PodcastBrowseResult) => {
      const title =
        result.type === "podcasts" ? result.title : result.podcast_title;
      if (result.podcast_id) {
        dispatchWorkspaceTarget({
          target: {
            href: `/podcasts/${result.podcast_id}`,
            labelHint: title,
          },
          source: "Podcast",
          returnTo: { kind: "Root" },
          activation:
            page.kind === "PodcastDiscovery"
              ? page.activation
              : PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
        });
        return;
      }
      const subscriptionKey = result.provider_podcast_id;
      if (podcastSubscribeRunningRef.current.size > 0) return;
      podcastSubscribeRunningRef.current.add(subscriptionKey);
      setPodcastSubscribingId(subscriptionKey);
      const replayId =
        page.kind === "PodcastDiscovery"
          ? `${page.sessionId}:${subscriptionKey}`
          : createRandomId("podcast-discovery");
      const podcast =
        result.type === "podcasts"
          ? {
              provider_podcast_id: result.provider_podcast_id,
              title: result.title,
              contributors: result.contributors,
              feed_url: result.feed_url,
              website_url: result.website_url,
              image_url: result.image_url,
              description: result.description,
            }
          : {
              provider_podcast_id: result.provider_podcast_id,
              title: result.podcast_title,
              contributors: result.podcast_contributors,
              feed_url: result.feed_url,
              website_url: result.website_url,
              image_url: result.podcast_image_url,
              description: null,
            };
      void subscribeToPodcast({
        ...podcast,
        library_ids: DEFAULT_LIBRARY_IDS,
      })
        .then((subscribed) => {
          invalidateDesktopOpenablesCache();
          dispatchWorkspaceTarget({
            target: {
              href: `/podcasts/${subscribed.podcast_id}`,
              labelHint: title,
            },
            source: "Podcast",
            completion: present({
              kind: "PodcastSubscription",
              replayId,
            }),
            returnTo: { kind: "Root" },
            activation:
              page.kind === "PodcastDiscovery"
                ? page.activation
                : PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
          });
        })
        .catch((error: unknown) => {
          if (handleUnauthenticatedApiError(error)) return;
          if (
            isSameSystemApiDefect(error) ||
            !isRetryableWorkflowFailure(error)
          ) {
            throw error;
          }
          feedback.show(
            toFeedback(error, {
              fallback: "Podcast could not be subscribed. Retry",
            }),
          );
        })
        .finally(() => {
          podcastSubscribeRunningRef.current.delete(subscriptionKey);
          setPodcastSubscribingId((current) =>
            current === subscriptionKey ? null : current,
          );
        });
    },
    [
      dispatchWorkspaceTarget,
      feedback,
      invalidateDesktopOpenablesCache,
      page,
    ],
  );

  const handleWorkflowRequest = useCallback(
    (
      outcome: Extract<
        NexusDispatchOutcome,
        { kind: "WorkflowRequested" }
      >,
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
        case "OpenTodayCapture":
          setPage({
            kind: "TodayCapture",
            sessionId: todaySession.start(),
            activation,
          });
          return;
        case "CreatePage":
          runPageCreation(crypto.randomUUID(), activation);
          return;
        case "CreateLibrary":
          setPage({
            kind: "CreateLibrary",
            nameDraft: "",
            libraryId: crypto.randomUUID(),
            submit: { kind: "Ready" },
            activation,
          });
          return;
        case "PodcastDiscovery":
          setPage({
            kind: "PodcastDiscovery",
            query: "",
            sessionId: createRandomId("podcast-discovery"),
            activation,
          });
          return;
        case "OpenWebSearch":
          setActiveWebResultId(null);
          setPage({
            kind: "WebSearch",
            query: target.query,
            status: "Idle",
          });
          return;
      }
    },
    [runPageCreation, startAddSession, todaySession],
  );

  const selectEntry = useCallback(
    (
      key: string,
      disposition: "Follow" | "Fork",
      modality: DesktopNexusModality,
    ) => {
      const snapshot = desktopCommitRef.current;
      const entry = snapshot.entries.find(
        (candidate) => serializeNexusEntryKey(candidate.key) === key,
      );
      if (!entry) return;
      const activation: NexusTargetActivation = {
        disposition: { kind: disposition },
        modality,
      };
      const paneTargetId = desktopPaneTargetId(entry.primaryAction.target, nexusPanes);
      const targetIsCurrent = paneTargetId
        ? nexusPanes.some(
            (pane) =>
              pane.current &&
              resolveWorkspaceActivationRouteId(pane.href) === paneTargetId,
          )
        : false;
      const paneRunId = paneTargetId && !(disposition === "Follow" && targetIsCurrent)
        ? `pane-${++desktopRunCounterRef.current}`
        : null;
      if (paneRunId && paneTargetId) {
        beginNexusDesktopPaneActivation(paneRunId, paneTargetId);
      }
      const clientMutationId = crypto.randomUUID();
      void dispatchOwned(entry.primaryAction.target, activation, {
        source: "Find",
        completion: absent(),
        returnTo,
      })
        .then((outcome) => {
          if (outcome.kind === "WorkflowRequested") {
            if (paneRunId) {
              cancelNexusDesktopRun(NEXUS_DESKTOP_PANE_ACTIVATE, paneRunId);
            }
            handleWorkflowRequest(outcome);
          } else if (outcome.kind === "NavigationAccepted") {
            logSelection(entry, clientMutationId);
          } else if (paneRunId) {
            cancelNexusDesktopRun(NEXUS_DESKTOP_PANE_ACTIVATE, paneRunId);
          }
        })
        .catch((error: unknown) => {
          if (paneRunId) {
            cancelNexusDesktopRun(NEXUS_DESKTOP_PANE_ACTIVATE, paneRunId);
          }
          fail(error);
        });
    },
    [
      dispatchOwned,
      fail,
      handleWorkflowRequest,
      logSelection,
      nexusPanes,
      returnTo,
    ],
  );

  // TodayCapturePanel opens its post-action pane through the one dispatch owner.
  // AddPanel uses openAddTarget,
  // whose guarded Navigate intent closes Add after the destination accepts focus.
  const openTarget = useCallback(
    (target: NexusTarget) => {
      const activation =
        page.kind === "TodayCapture" || page.kind === "Add"
          ? page.activation
          : PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION;
      void dispatchOwned(
        target,
        activation,
        {
          source: page.kind === "TodayCapture" ? "TodayCapture" : "Find",
          completion:
            page.kind === "TodayCapture" &&
            todaySession.committedReplayId !== null
              ? present({
                  kind: "TodayCapture",
                  replayId: todaySession.committedReplayId,
                })
              : absent(),
          returnTo,
        },
      ).catch(fail);
    },
    [dispatchOwned, fail, page, returnTo, todaySession.committedReplayId],
  );

  const openActions = useCallback(() => {
    if (page.kind !== "Root" && page.kind !== "Find") return;
    const snapshot = desktopCommitRef.current;
    const entry = snapshot.entries.find(
      (candidate) =>
        serializeNexusEntryKey(candidate.key) === snapshot.activeKey,
    );
    if (!entry || entry.secondaryActions.length === 0) return;
    setPage({
      kind: "Actions",
      entry,
      actions: entry.secondaryActions,
    });
  }, [page.kind]);

  const runAction = useCallback(
    (action: NexusAction) => {
      void dispatchOwned(
        action.target,
        PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
        {
          source: "Find",
          completion: absent(),
          returnTo,
        },
      )
        .then((outcome) => {
          if (outcome.kind === "WorkflowRequested") {
            handleWorkflowRequest(outcome);
          } else if (
            outcome.kind === "Stayed" &&
            action.target.kind === "PaneClose"
          ) {
            setPage({ kind: "Root" });
          }
        })
        .catch(fail);
    },
    [dispatchOwned, fail, handleWorkflowRequest, returnTo],
  );

  const runDesktopAction = useCallback(
    (actionId: string) => {
      if (page.kind !== "Actions") return;
      const action = page.actions.find(
        (candidate) => candidate.id === actionId,
      );
      if (action) runAction(action);
    },
    [page, runAction],
  );

  const setQuery = useCallback(
    (next: string) => {
      if (open && !viewport.isMobile) {
        const revision = `Open:${next}`;
        const localRunId = `local-${++desktopRunCounterRef.current}`;
        beginNexusDesktopLocalRows(localRunId);
        desktopLocalRunRef.current = { id: localRunId, revision };

        const normalized = next.trim();
        for (const source of ["Openables", "Owned"] as const) {
          const previous = desktopProviderRunsRef.current[source];
          if (previous) {
            cancelNexusDesktopRun(
              NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
              previous.id,
            );
            desktopProviderRunsRef.current[source] = null;
          }
        }
        const sources: NexusProviderSource[] =
          normalized.length >= 2
            ? ["Openables", "Owned"]
            : normalized.length === 1
              ? ["Openables"]
              : [];
        for (const source of sources) {
          const providerRunId =
            `providers-${source}-${++desktopRunCounterRef.current}`;
          beginNexusDesktopProviders(providerRunId, source);
          desktopProviderRunsRef.current[source] = {
            id: providerRunId,
            revision,
            phase: desktopProviderWarmRef.current[source] ? "Warm" : "Cold",
            sawLoading: false,
            terminalEpoch: null,
          };
        }
      }
      userMovedRef.current = false;
      setQueryState(next);
      setPage((current) =>
        current.kind === "Find"
          ? { ...current, query: next }
          : next.trim()
            ? { kind: "Find", query: next, scope: "All" }
            : { kind: "Root" },
      );
    },
    [open, viewport.isMobile],
  );

  const inputReady = useCallback(() => {
    const runId = desktopOpenRunRef.current;
    if (!runId) return;
    completeNexusDesktopOpenInputReady(runId);
    desktopOpenRunRef.current = null;
  }, []);

  const performExit = useCallback(
    (intent: ExitIntent) => {
      setPendingDismissal(null);
      switch (intent.kind) {
        case "Content":
          backToAddContent();
          return;
        case "Root":
          discardAddSession();
          setPage({ kind: "Root" });
          return;
        case "Close":
          discardAddSession();
          setOpen(false);
          return;
        case "Navigate":
          void dispatchOwned(
            intent.target,
            intent.activation ?? PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
            intent.retained ?? {
              source: page.kind === "Add" ? "Import" : "Place",
              completion: absent(),
              returnTo,
            },
          )
            .then((outcome) => {
              if (outcome.kind === "NavigationAccepted") {
                discardAddSession();
              }
            })
            .catch(fail);
          return;
        case "Replace": {
          const { detail } = intent;
          userMovedRef.current = false;
          suppressReturnFocusRef.current = false;
          // A Root reopen preserves retained recovery so dismiss → reopen does
          // not lose the exact activation target.
          if (
            detail.kind === "Root" &&
            (page.kind === "ActivationBlocked" || page.kind === "ManageTabs")
          ) {
            setOpen(true);
            return;
          }
          if (detail.kind === "Add") {
            setPage({
              kind: "Add",
              sessionId: startAddSession(detail.seed),
              activation: PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
            });
            setQueryState("");
          } else if (detail.kind === "QuickAction") {
            discardAddSession();
            runSwitchboardQuickAction(getQuickAction(detail.actionId));
            setQueryState("");
          } else if (detail.kind === "WebSearch") {
            discardAddSession();
            setActiveWebResultId(null);
            setPage({
              kind: "WebSearch",
              query: detail.query,
              status: "Idle",
            });
            setQueryState("");
          } else {
            discardAddSession();
            setPage({ kind: "Root" });
            setQueryState("");
          }
          setOpen(true);
          return;
        }
      }
    },
    [
      backToAddContent,
      discardAddSession,
      dispatchOwned,
      fail,
      page.kind,
      returnTo,
      runSwitchboardQuickAction,
      startAddSession,
    ],
  );

  const guardExit = useCallback(
    (intent: ExitIntent): DismissDecision => {
      if (pendingDismissal) return "blocked";
      if (page.kind === "TodayCapture") {
        return todaySession.checkpointForDismissal();
      }
      if (page.kind !== "Add") return "accepted";
      if (addSession.state.mutation.kind === "Running") {
        setPendingDismissal({ confirmation: "Stop", intent });
        return "blocked";
      }
      // OPML Back is an explicit branch-local discard, not a request to throw
      // away the parent Content session.
      if (intent.kind === "Content") return "accepted";
      if (addSession.dirty) {
        setPendingDismissal({ confirmation: "Discard", intent });
        return "blocked";
      }
      return "accepted";
    },
    [
      addSession.dirty,
      addSession.state.mutation.kind,
      page.kind,
      pendingDismissal,
      todaySession,
    ],
  );

  const requestExit = useCallback(
    (intent: ExitIntent) => {
      if (guardExit(intent) !== "accepted") return;
      if (
        intent.kind === "Replace" &&
        !open &&
        !viewport.isMobile
      ) {
        const runId = `open-${++desktopRunCounterRef.current}`;
        beginNexusDesktopOpen(runId);
        desktopOpenRunRef.current = runId;
      }
      performExit(intent);
    },
    [guardExit, open, performExit, viewport.isMobile],
  );

  const back = useCallback(() => {
    if (page.kind === "Add" && addSession.state.branch === "Opml") {
      requestExit({ kind: "Content" });
      return;
    }
    requestExit({ kind: "Root" });
  }, [addSession.state.branch, page.kind, requestExit]);

  const close = useCallback(
    () => requestExit({ kind: "Close" }),
    [requestExit],
  );
  const openRoot = useCallback(
    () => {
      if (
        page.kind === "ActivationBlocked" ||
        page.kind === "ManageTabs"
      ) {
        suppressReturnFocusRef.current = false;
        setOpen(true);
        return;
      }
      requestExit({ kind: "Replace", detail: { kind: "Root" } });
    },
    [page.kind, requestExit],
  );
  const enterFind = useCallback(() => {
    setSwitchboardFindActiveId(null);
    setQueryState("");
    setPage({ kind: "Find", query: "", scope: "All" });
  }, []);
  const setFindScope = useCallback((scope: NexusFindScope) => {
    setSwitchboardFindActiveId(null);
    setPage((current) =>
      current.kind === "Find" ? { ...current, scope } : current,
    );
  }, []);
  const closeSwitchboardPane = useCallback(
    (paneId: string) => closePane(paneId),
    [closePane],
  );
  const restoreSwitchboardPane = useCallback(
    (paneId: string) =>
      openSwitchboardItem({ kind: "ClosedPane", paneId }, false),
    [openSwitchboardItem],
  );
  const retryPageCreation = useCallback(() => {
    if (page.kind === "CreatePage" && page.submit.kind === "Retryable") {
      runPageCreation(page.pageId, page.activation);
    }
  }, [page, runPageCreation]);
  const setPodcastQuery = useCallback((query: string) => {
    setPage((current) =>
      current.kind === "PodcastDiscovery" ? { ...current, query } : current,
    );
  }, []);
  const manageTabs = useCallback(() => {
    setPage((current) =>
      current.kind === "ActivationBlocked"
        ? { kind: "ManageTabs", retained: current.retained }
        : current,
    );
  }, []);
  const retryRetainedActivation = useCallback(() => {
    if (
      page.kind !== "ActivationBlocked" &&
      page.kind !== "ManageTabs"
    ) {
      return;
    }
    const retained = page.retained;
    dispatchWorkspaceTarget({
      target: retained.target,
      source: retained.source,
      completion: retained.completion,
      returnTo: retained.returnTo,
      activation: retained.activation,
      onAccepted: () => {
        setPage(
          retained.returnTo.kind === "Find"
            ? {
                kind: "Find",
                query: retained.returnTo.query,
                scope: retained.returnTo.scope,
              }
            : { kind: "Root" },
        );
      },
    });
  }, [dispatchWorkspaceTarget, page]);
  const cancelRetainedActivation = useCallback(() => {
    setPage((current) => {
      if (
        current.kind !== "ActivationBlocked" &&
        current.kind !== "ManageTabs"
      ) {
        return current;
      }
      return current.retained.returnTo.kind === "Find"
        ? {
            kind: "Find",
            query: current.retained.returnTo.query,
            scope: current.retained.returnTo.scope,
          }
        : { kind: "Root" };
    });
  }, []);
  useEffect(() => {
    const replayId = todaySession.committedReplayId;
    if (replayId === null) return;
    setPage((current) => {
      if (
        (current.kind !== "ActivationBlocked" &&
          current.kind !== "ManageTabs") ||
        current.retained.source !== "TodayCapture" ||
        current.retained.completion.kind === "Present"
      ) {
        return current;
      }
      return {
        ...current,
        retained: {
          ...current.retained,
          completion: present({
            kind: "TodayCapture",
            replayId,
          }),
        },
      };
    });
  }, [todaySession.committedReplayId]);
  const dismissAccepted = useCallback(
    () => performExit({ kind: "Close" }),
    [performExit],
  );
  const guardClose = useCallback((): DismissDecision => {
    if (
      page.kind === "Root" ||
      page.kind === "ActivationBlocked" ||
      page.kind === "ManageTabs"
    ) {
      return guardExit({ kind: "Close" });
    }
    const intent: ExitIntent =
      page.kind === "Add" && addSession.state.branch === "Opml"
        ? { kind: "Content" }
        : { kind: "Root" };
    if (guardExit(intent) === "accepted") performExit(intent);
    // A nested transition always keeps the one mounted sheet open. MobileSheet
    // must therefore treat even a successful pop as a blocked sheet dismissal.
    return "blocked";
  }, [addSession.state.branch, guardExit, page.kind, performExit]);
  const escape = useCallback(() => {
    if (guardClose() === "accepted") dismissAccepted();
  }, [dismissAccepted, guardClose]);

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
                (item.kind === "Accepted" &&
                  item.result.mediaId === mediaId) ||
                (item.kind === "AcceptedUncertain" &&
                  item.mediaId === mediaId),
            )
          : undefined;
        replayId = committed?.id ?? null;
      }
      requestExit({
        kind: "Navigate",
        target,
        // Completed Import opens the result with Adopt (never replace the
        // source pane), matching the capability table's "Adopt result".
        activation:
          page.kind === "Add"
            ? page.activation
            : PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION,
        retained: {
          source: "Import",
          completion: replayId
            ? present({ kind: "Import", replayId })
            : absent(),
          returnTo: { kind: "Root" },
        },
      });
    },
    [
      addSession.opmlReplayIdentity,
      addSession.state.items,
      addSession.state.opml.kind,
      page,
      requestExit,
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

  const initialFocus = useCallback(
    (container: HTMLElement, isMobile: boolean): HTMLElement | null => {
      if (page.kind === "Root") {
        return isMobile
          ? container.querySelector<HTMLElement>("[data-switchboard-heading]")
          : container.querySelector<HTMLElement>('[role="combobox"]');
      }
      if (page.kind === "Find") {
        return container.querySelector<HTMLElement>('input[type="search"]');
      }
      if (page.kind === "TodayCapture") {
        return container.querySelector<HTMLElement>(
          '[role="textbox"][aria-label="Quick note to today"]',
        );
      }
      if (page.kind === "CreateLibrary") {
        return container.querySelector<HTMLElement>(
          "[data-switchboard-library-name]",
        );
      }
      if (page.kind === "PodcastDiscovery") {
        return container.querySelector<HTMLElement>(
          "[data-switchboard-podcast-query]",
        );
      }
      if (page.kind === "ManageTabs") {
        return container.querySelector<HTMLElement>(
          "[data-switchboard-open-heading]",
        );
      }
      if (page.kind !== "Add") {
        return container.querySelector<HTMLElement>("[data-switchboard-heading]");
      }
      return resolveAddPanelInitialFocus(container, isMobile, {
        branch: addSession.state.branch,
        initialFocus: addSession.state.initialFocus,
      });
    },
    [addSession.state.branch, addSession.state.initialFocus, page.kind],
  );

  const dialogLabel =
    page.kind === "Add"
      ? addSession.state.branch === "Opml"
        ? "Import OPML"
        : "Add content"
      : "Nexus";
  const focusKey =
    page.kind === "Add"
      ? `${addSession.state.sessionId}:${addSession.state.branch}:${
          addSession.state.branch === "Content" &&
          addSession.state.initialFocus === "Opml"
            ? "Url"
            : addSession.state.initialFocus
        }`
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
  const shouldSuppressReturnFocusOnClose = useCallback(
    () => suppressReturnFocusRef.current,
    [],
  );

  // --- Triggers: open event, deep link, global hotkeys ---
  useEffect(() => {
    const handler = (event: Event) => {
      const detail =
        (event as CustomEvent<NexusOpenIntent>).detail ??
        ({ kind: "Root" } as const);
      requestExit({ kind: "Replace", detail });
    };
    window.addEventListener(NEXUS_OPEN_REQUESTED_EVENT, handler);
    return () =>
      window.removeEventListener(NEXUS_OPEN_REQUESTED_EVENT, handler);
  }, [requestExit]);

  // The URL intent is a one-shot bootstrap ingress, not a reactive route state.
  useLayoutEffect(() => {
    const intent = consumeNexusUrlIntent();
    if (intent !== null) {
      requestExit({ kind: "Replace", detail: intent });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consume once only.
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const nexusCombo = keybindings["Nexus.Open"];
      if (nexusCombo && matchesKeyEvent(nexusCombo, event)) {
        event.preventDefault();
        if (open) {
          openActions();
          return;
        }
        userMovedRef.current = false;
        requestExit({ kind: "Replace", detail: { kind: "Root" } });
        return;
      }
      for (const [actionId, combo] of Object.entries(keybindings)) {
        if (actionId === "Nexus.Open") continue;
        if (!matchesKeyEvent(combo, event)) continue;
        const destination = DESTINATIONS.find((entry) => entry.id === actionId);
        const target: NexusTarget | null =
          actionId === "today"
            ? { kind: "OpenToday" }
            : destination
              ? {
                  kind: "InternalHref",
                  href: destination.href,
                  labelHint: destination.label,
                }
              : null;
        if (!target) continue; // a bound non-destination combo (e.g. pane-nav) is owned elsewhere
        event.preventDefault();
        requestExit({ kind: "Navigate", target });
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [keybindings, open, openActions, requestExit]);

  const desktopContractDefect =
    desktopOpenablesError instanceof ResourceOpenablesContractDefect ||
    isSameSystemApiDefect(desktopOpenablesError)
      ? desktopOpenablesError
      : desktopSearchError instanceof SearchContractDefect ||
          isSameSystemApiDefect(desktopSearchError)
        ? desktopSearchError
        : webError instanceof NexusWebContractDefect ||
            isSameSystemApiDefect(webError)
          ? webError
          : null;
  if (desktopContractDefect !== null) throw desktopContractDefect;

  const setWebQuery = useCallback((next: string) => {
    setActiveWebResultId(null);
    setPage((current) =>
      current.kind === "WebSearch"
        ? { ...current, query: next, status: "Idle" }
        : current,
    );
  }, []);
  const selectWebResult = useCallback(
    (
      id: string,
      disposition: "Follow" | "Fork",
      modality: DesktopNexusModality,
    ) => {
      const result = (webData ?? []).find(
        (candidate) => candidate.id === id,
      );
      if (!result) return;
      setPage({
        kind: "Add",
        sessionId: startAddSession(webResultAddSeed(result)),
        activation: {
          disposition: { kind: disposition },
          modality,
        },
      });
    },
    [startAddSession, webData],
  );
  const selectMobileWebResult = useCallback(
    (id: string, fork: boolean) => {
      const result = (webData ?? []).find(
        (candidate) => candidate.id === id,
      );
      if (!result) return;
      setPage({
        kind: "Add",
        sessionId: startAddSession(webResultAddSeed(result)),
        activation: {
          disposition: { kind: fork ? "Fork" : "Adopt" },
          modality: "Pointer",
        },
      });
    },
    [startAddSession, webData],
  );
  const retryDesktop = useCallback(
    (source: "Openables" | "Owned" | "Web") => {
      if (source === "Openables") {
        invalidateDesktopOpenablesCache();
      } else if (source === "Owned") {
        setDesktopSearchRetry((current) => current + 1);
      } else {
        setWebRetry((current) => current + 1);
      }
    },
    [invalidateDesktopOpenablesCache],
  );
  const desktopFailures = useMemo(() => {
    const failed = new Set<"Openables" | "Owned">();
    if (desktopOpenablesError !== null) failed.add("Openables");
    if (desktopSearchError !== null) failed.add("Owned");
    return failed;
  }, [desktopOpenablesError, desktopSearchError]);
  const desktopEntries = useMemo(
    () =>
      desktopCommit.entries.map((entry) => ({
        key: serializeNexusEntryKey(entry.key),
        label: entry.label,
        shortcutHint: entry.shortcutHint,
        typeLabel: entry.typeLabel,
        metadata: entry.metadata,
        excerpt: entry.snippetSegments
          ?.map((segment) => segment.text)
          .join(""),
        excerptSegments: entry.snippetSegments,
        open: entry.openState !== undefined,
        parentKey: entry.parent
          ? serializeNexusEntryKey(entry.parent.key)
          : undefined,
        parentLabel: entry.parent?.label,
        icon: createElement(entry.icon, {
          size: 18,
          "aria-hidden": true,
        }),
        hasSecondaryActions: entry.secondaryActions.length > 0,
      })),
    [desktopCommit.entries],
  );
  const desktopPage = useMemo<DesktopNexusController["page"]>(() => {
    if (page.kind === "Actions") {
      return {
        kind: "Actions",
        label: page.entry.label,
        actions: page.actions.map((action) => ({
          id: action.id,
          label: action.label,
          icon: createElement(action.icon, {
            size: 18,
            "aria-hidden": true,
          }),
        })),
      };
    }
    if (page.kind === "WebSearch") {
      return {
        kind: "WebSearch",
        query: page.query,
        status: nexusSourceStatus({
          enabled: page.query.trim().length > 0,
          loading: webFetch.loading,
          ready: webData !== null,
          failed: webError !== null,
        }),
        results: (webData ?? []).map((result) => ({
          id: result.id,
          title: result.title,
          url: result.url,
          source: result.sourceName ?? result.displayUrl,
          excerpt: result.snippet || undefined,
        })),
      };
    }
    return { kind: query.trim() ? "Find" : "Root" };
  }, [
    page,
    query,
    webData,
    webError,
    webFetch.loading,
  ]);
  const desktop: DesktopNexusController = {
    open,
    page: desktopPage,
    query,
    entries: desktopEntries,
    activeEntryKey: desktopCommit.activeKey,
    activeWebResultId,
    failures: desktopFailures,
    busy:
      desktopOpenablesFetch.loading || desktopSearchFetch.loading,
    focusKey,
    inputReady,
    setQuery,
    setWebQuery,
    setActiveEntry,
    setActiveWebResult: setActiveWebResultId,
    selectEntry,
    openActions,
    runAction: runDesktopAction,
    selectWebResult,
    retry: retryDesktop,
    back,
    escape,
    shouldSuppressReturnFocusOnClose,
  };

  return {
    open,
    paneCount: panes.length,
    query,
    page,
    addSession,
    todaySession,
    dialogLabel,
    focusKey,
    dismissalConfirmation,
    desktop,
    webSearch:
      desktopPage.kind === "WebSearch"
        ? {
            query: desktopPage.query,
            status: desktopPage.status,
            results: desktopPage.results,
          }
        : null,
    switchboardPanes,
    switchboardClosedPanes,
    switchboardPlaces: SWITCHBOARD_PLACES,
    switchboardQuickActions:
      SWITCHBOARD_QUICK_ACTION_IDS.map(getQuickAction),
    switchboardFindRows,
    switchboardFindActiveId,
    switchboardFindBusy:
      showSwitchboardBusy &&
      (openablesFetch.loading || deepFetch.loading),
    switchboardFindPending: openablesFetch.loading || deepFetch.loading,
    switchboardOpenablesFailed: openablesError !== null,
    switchboardDeepFailed: deepError !== null,
    podcastResults: podcastData ?? [],
    podcastBusy: showSwitchboardBusy && podcastFetch.loading,
    podcastSubscribingId,
    podcastFailed: podcastError !== null,
    setQuery,
    openTarget,
    openAddTarget,
    back,
    runAction,
    openRoot,
    enterFind,
    setFindScope,
    setSwitchboardFindActiveId,
    openSwitchboardItem,
    switchboardItemActions,
    runSwitchboardAction,
    openSwitchboardPlace,
    runSwitchboardQuickAction,
    closeSwitchboardPane,
    restoreSwitchboardPane,
    retrySwitchboardOpenables: () =>
      setOpenablesRetry((current) => current + 1),
    retrySwitchboardDeep: () =>
      setDeepRetry((current) => current + 1),
    setLibraryNameDraft,
    submitLibrary,
    retryPageCreation,
    setPodcastQuery,
    selectPodcast,
    retryPodcastSearch: () =>
      setPodcastRetry((current) => current + 1),
    setWebQuery,
    retryWebSearch: () => retryDesktop("Web"),
    selectMobileWebResult,
    manageTabs,
    retryRetainedActivation,
    cancelRetainedActivation,
    close,
    dismissAccepted,
    guardClose,
    escape,
    initialFocus,
    keepWorking,
    confirmDismissal,
    shouldSuppressReturnFocusOnClose,
  };
}
