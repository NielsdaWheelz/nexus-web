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
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  type ApiPath,
} from "@/lib/api/client";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import { useResource } from "@/lib/api/useResource";
import { usePaneWarm } from "@/lib/panes/paneWarm";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { matchesKeyEvent } from "@/lib/keybindings";
import { useKeybindings } from "@/lib/keybindingsProvider";
import { useLectern } from "@/lib/lectern/LecternProvider";
import {
  buildItemActions,
  buildResourceItemActions,
} from "@/lib/launcher/actions";
import {
  dispatchTarget,
  isAndroidShellRestrictedHref,
  PROGRAMMATIC_ADOPT_LAUNCHER_TARGET_ACTIVATION,
  PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
  type DispatchOutcome,
  type LauncherTargetActivation,
  type LauncherDispatchCtx,
} from "@/lib/launcher/dispatch";
import {
  OPEN_LAUNCHER_EVENT,
  type OpenLauncherDetail,
} from "@/lib/launcher/launcherEvents";
import {
  LANE_SIGIL,
  launcherRowIds,
  type LauncherAction,
  type LauncherActionTarget,
  type LauncherItem,
  type LauncherLane,
  type LauncherView,
} from "@/lib/launcher/model";
import type { LauncherPage } from "@/lib/switchboard/model";
import { paneStatusLabel } from "@/lib/switchboard/paneStatusLabel";
import {
  parseLauncherInput,
  type LauncherInput,
} from "@/lib/launcher/parseLauncherInput";
import {
  buildLauncherItems,
  type LauncherContext,
  type LauncherOracleRow,
  type LauncherRecentRow,
  type LauncherWebResult,
} from "@/lib/launcher/providers";
import { rankLauncher } from "@/lib/launcher/ranking";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import type { Destination } from "@/lib/navigation/destinations";
import {
  fetchSearchResultPage,
  SearchContractDefect,
} from "@/lib/search/searchApi";
import { searchHref } from "@/lib/search/searchParams";
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
import {
  fetchBrowseResults,
  fetchPodcastBrowseResults,
} from "@/lib/browse/client";
import {
  ResourceOpenablesContractDefect,
  searchOpenableResources,
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
  CommittedWorkflow,
  RetainedActivation,
  SwitchboardFindScope,
  SwitchboardItem,
  SwitchboardRowModel,
} from "@/lib/switchboard/model";
import { SWITCHBOARD_PLACES } from "@/lib/switchboard/places";
import {
  getQuickAction,
  SWITCHBOARD_QUICK_ACTION_IDS,
  type SwitchboardQuickAction,
} from "@/lib/launcher/quickActions";
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

interface LauncherHistoryResponse {
  data: {
    recent: LauncherRecentRow[];
    frecency_boosts: Record<string, number>;
  };
}
interface OracleReadingsResponse {
  data: LauncherOracleRow[];
}

const HISTORY_DEBOUNCE_MS = 200;
const SWITCHBOARD_OPENABLE_DEBOUNCE_MS = 80;
const SWITCHBOARD_DEEP_DEBOUNCE_MS = 160;
const SWITCHBOARD_BUSY_DELAY_MS = 150;
const ORACLE_TTL_MS = 5 * 60_000;
const EMPTY_RECENT: LauncherRecentRow[] = [];
const EMPTY_FRECENCY = new Map<string, number>();
const EMPTY_SEARCH: SearchResultRowViewModel[] = [];
const EMPTY_BROWSE: BrowseResult[] = [];
const EMPTY_WEB: LauncherWebResult[] = [];
// Quick add-url / browse-acquire ingest with no additional libraries; the AddPanel offers a picker.
const DEFAULT_LIBRARY_IDS: string[] = [];

function isRetryableWorkflowFailure(error: unknown): boolean {
  return (
    isApiError(error) ||
    error instanceof TypeError ||
    error instanceof DOMException
  );
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

async function fetchWeb(
  query: string,
  signal: AbortSignal,
): Promise<LauncherWebResult[]> {
  const params = new URLSearchParams({ q: query });
  const response = await apiFetch<{ data: { results: LauncherWebResult[] } }>(
    `/api/web/search?${params.toString()}`,
    { signal },
  );
  return response.data.results;
}

export interface LauncherController {
  open: boolean;
  paneCount: number;
  query: string;
  input: LauncherInput;
  lane: LauncherLane;
  page: LauncherPage;
  addSession: AddContentSessionController;
  todaySession: TodayCaptureSessionController;
  dialogLabel: string;
  focusKey: string;
  dismissalConfirmation: AddDismissalConfirmation;
  view: LauncherView;
  searchLoading: boolean;
  browseLoading: boolean;
  activeId: string | null;
  switchboardPanes: readonly SwitchboardPane[];
  switchboardClosedPanes: readonly SwitchboardClosedPane[];
  switchboardPlaces: readonly Destination[];
  switchboardQuickActions: readonly SwitchboardQuickAction[];
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
  setLane(lane: LauncherLane): void;
  clearLane(): void;
  setActiveId(id: string): void;
  select(item: LauncherItem, activation: LauncherTargetActivation): void;
  openTarget(target: LauncherActionTarget): void;
  openAddTarget(target: LauncherActionTarget): void;
  drill(item: LauncherItem): void;
  back(): void;
  runAction(action: LauncherAction): void;
  trailing(item: LauncherItem): void;
  askCurrent(): void;
  openRoot(): void;
  enterFind(): void;
  setFindScope(scope: SwitchboardFindScope): void;
  setSwitchboardFindActiveId(id: string): void;
  openSwitchboardItem(item: SwitchboardItem, fork: boolean): void;
  switchboardItemActions(item: SwitchboardItem): readonly LauncherAction[];
  runSwitchboardAction(action: LauncherAction): void;
  openSwitchboardPlace(destination: Destination): void;
  runSwitchboardQuickAction(action: SwitchboardQuickAction): void;
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
      target: LauncherActionTarget;
      retained?: Omit<RetainedActivation, "target">;
      // Absent → Follow (desktop destination/today keyboard navigation). A
      // completed Switchboard workflow (Import result) passes an Adopt
      // activation so it opens beside, never replaces, the source pane.
      activation?: LauncherTargetActivation;
    }
  | { kind: "Replace"; detail: OpenLauncherDetail };

type PendingDismissal = {
  confirmation: Exclude<AddDismissalConfirmation, null>["kind"];
  intent: ExitIntent;
};

export function useLauncherController(): LauncherController {
  const { androidShell, platform } = useRenderEnvironment();
  const viewport = useViewportState();
  const keybindings = useKeybindings();
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
  const [laneOverride, setLaneOverride] = useState<LauncherLane | null>(null);
  const [page, setPage] = useState<LauncherPage>({ kind: "Root" });
  const [activeId, setActiveIdState] = useState<string | null>(null);
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
  const userMovedRef = useRef(false); // true once the user arrows/hovers; else active follows the top
  const [historyPath, setHistoryPath] = useState<ApiPath | null>(null);
  const [oracleKey, setOracleKey] = useState<string | null>(null);
  const [oracleRows, setOracleRows] = useState<LauncherOracleRow[]>([]);
  const oracleFetchedAt = useRef(0);
  const oracleVersion = useRef(0);
  // Close reason for the dialog's return-focus. Reset to the a11y default (restore the
  // opener) on every open; a navigating dispatch flips it true just before it closes so
  // the surface's useReturnFocus doesn't yank focus back from the destination.
  const suppressReturnFocusRef = useRef(false);
  const previousSwitchboardRowsRef = useRef<{
    key: string;
    rows: readonly SwitchboardRowModel[];
  }>({ key: "", rows: [] });

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
    if (open) suppressReturnFocusRef.current = false;
  }, [open]);

  const input = useMemo(() => parseLauncherInput(query), [query]);
  // A typed leading sigil wins over a chip override; both fall back to the blended `all`.
  const lane = input.explicitLane ?? laneOverride ?? "all";

  // --- Fetching: recents (debounced via useResource), oracle (TTL), search + browse/web (debounced) ---
  const requestedHistoryPath = useMemo<ApiPath | null>(() => {
    if (
      !open ||
      (viewport.isMobile && page.kind !== "Find")
    ) {
      return null;
    }
    return input.text
      ? `/api/me/palette-history?${new URLSearchParams({ query: input.text }).toString()}`
      : "/api/me/palette-history";
  }, [open, input.text, page.kind, viewport.isMobile]);

  useEffect(() => {
    if (requestedHistoryPath === null) {
      setHistoryPath(null);
      return;
    }
    const timer = window.setTimeout(
      () => setHistoryPath(requestedHistoryPath),
      HISTORY_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [requestedHistoryPath]);

  const historyResource = useResource<LauncherHistoryResponse>({
    cacheKey: historyPath,
    path: (path) => path as ApiPath,
  });
  const historyRows =
    historyResource.status === "ready"
      ? historyResource.data.data.recent
      : EMPTY_RECENT;
  const frecencyBoosts = useMemo(
    () =>
      historyResource.status === "ready"
        ? new Map(Object.entries(historyResource.data.data.frecency_boosts))
        : EMPTY_FRECENCY,
    [historyResource],
  );

  useEffect(() => {
    if (!open || viewport.isMobile) {
      setOracleKey(null);
      return;
    }
    if (Date.now() - oracleFetchedAt.current < ORACLE_TTL_MS) return;
    oracleVersion.current += 1;
    setOracleKey(`oracle-readings:${oracleVersion.current}`);
  }, [open, viewport.isMobile]);

  const oracleResource = useResource<OracleReadingsResponse>({
    cacheKey: oracleKey,
    path: () => "/api/oracle/readings",
  });
  useEffect(() => {
    if (oracleResource.status === "ready") {
      oracleFetchedAt.current = Date.now();
      setOracleRows(oracleResource.data.data);
    } else if (oracleResource.status === "error") {
      setOracleRows([]);
    }
  }, [oracleResource]);

  // Search feeds the blended `all` lane and the dedicated `search` lane; the other lanes
  // don't show in-library hits, so don't fetch for them.
  const searchFetch = useDebouncedFetch(
    open &&
      !viewport.isMobile &&
      (lane === "all" || lane === "search") &&
      input.text.length >= 2
      ? searchHref(input.searchQuery)
      : null,
    (signal) =>
      fetchSearchResultPage(input.searchQuery, {
        limit: 6,
        cursor: null,
        signal,
      }),
    { debounceMs: 200 },
  );
  const searchResults = searchFetch.data?.rows ?? EMPTY_SEARCH;

  // Inline external discovery (/api/browse + /api/web/search) is the `browse` lane only; `all` shows
  // just the pinned "Browse the web" deep-link row, so it never hits external providers.
  const browseEnabled =
    open &&
    !viewport.isMobile &&
    lane === "browse" &&
    input.text.length >= 2;
  const browseFetch = useDebouncedFetch(
    browseEnabled ? input.text : null,
    async (signal) => {
      const [browseRows, webRows] = await Promise.all([
        fetchBrowseResults({
          query: input.text,
          limit: 4,
          signal,
        }),
        fetchWeb(input.text, signal),
      ]);
      return { browseRows, webRows };
    },
    { debounceMs: 200 },
  );
  const browseResults = browseFetch.data?.browseRows ?? EMPTY_BROWSE;
  const webResults = browseFetch.data?.webRows ?? EMPTY_WEB;

  const mobileFindQuery =
    page.kind === "Find" ? page.query.trim() : "";
  const mobileFindScope =
    page.kind === "Find" ? page.scope : ("All" as const);
  const mobileFindEnabled =
    open && viewport.isMobile && page.kind === "Find";
  const openablesFetch = useDebouncedFetch(
    mobileFindEnabled && mobileFindQuery.length >= 1
      ? `${mobileFindScope}:${mobileFindQuery}:${openablesRetry}`
      : null,
    (signal) =>
      searchOpenableResources({
        q: mobileFindQuery,
        schemes: switchboardOpenableSchemes(mobileFindScope),
        signal,
      }),
    { debounceMs: SWITCHBOARD_OPENABLE_DEBOUNCE_MS },
  );
  useLayoutEffect(() => {
    if (openablesFetch.data !== null) {
      completeSwitchboardPerformance(NEXUS_OPENABLES_PERFORMANCE);
    }
  }, [openablesFetch.data]);
  const switchboardDeepQuery = useMemo(
    () => switchboardSearchQuery(mobileFindScope, mobileFindQuery),
    [mobileFindQuery, mobileFindScope],
  );
  const deepFetch = useDebouncedFetch(
    mobileFindEnabled &&
      mobileFindQuery.length >= 2 &&
      switchboardDeepQuery !== null
      ? `${mobileFindScope}:${mobileFindQuery}:${deepRetry}`
      : null,
    (signal) =>
      fetchSearchResultPage(switchboardDeepQuery!, {
        limit: 20,
        cursor: null,
        signal,
      }),
    { debounceMs: SWITCHBOARD_DEEP_DEBOUNCE_MS },
  );

  const podcastQuery =
    page.kind === "PodcastDiscovery" ? page.query.trim() : "";
  const podcastFetch = useDebouncedFetch(
    open &&
      page.kind === "PodcastDiscovery" &&
      podcastQuery.length >= 1
      ? `${podcastQuery}:${podcastRetry}`
      : null,
    (signal) =>
      fetchPodcastBrowseResults({
        query: podcastQuery,
        signal,
      }),
    { debounceMs: SWITCHBOARD_DEEP_DEBOUNCE_MS },
  );

  const switchboardContractDefect =
    openablesFetch.error instanceof ResourceOpenablesContractDefect ||
    isSameSystemApiDefect(openablesFetch.error)
      ? openablesFetch.error
      : deepFetch.error instanceof SearchContractDefect ||
          isSameSystemApiDefect(deepFetch.error)
        ? deepFetch.error
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
  const currentHref =
    panes.find((pane) => pane.id === state.activePrimaryPaneId)?.href ?? null;

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
      (openablesFetch.data?.items ?? []).map((item) =>
        openableRow(item, mobileFindQuery, recentRouteIds),
      ),
    [mobileFindQuery, openablesFetch.data, recentRouteIds],
  );
  const deepRows = useMemo(() => {
    return (deepFetch.data?.rows ?? []).flatMap((result) => {
      const row = deepSearchRow(result, mobileFindQuery, recentRouteIds);
      return row ? [row] : [];
    });
  }, [deepFetch.data, mobileFindQuery, recentRouteIds]);
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

  const ctx = useMemo<LauncherContext>(
    () => ({
      input,
      panes,
      activePaneId: state.activePrimaryPaneId,
      currentHref,
      historyRows,
      frecencyBoosts,
      oracleRows,
      searchResults,
      browseResults,
      webResults,
      keybindings,
      androidShell,
      platform,
    }),
    [
      input,
      panes,
      state.activePrimaryPaneId,
      currentHref,
      historyRows,
      frecencyBoosts,
      oracleRows,
      searchResults,
      browseResults,
      webResults,
      keybindings,
      androidShell,
      platform,
    ],
  );
  const rootView = useMemo(
    () => rankLauncher(ctx, buildLauncherItems(ctx)),
    [ctx],
  );
  const view = useMemo<LauncherView>(
    () =>
      page.kind === "Actions"
        ? { state: "actions", item: page.item, actions: page.actions }
        : rootView,
    [page, rootView],
  );

  useEffect(() => {
    const ids = launcherRowIds(view);
    setActiveIdState((current) =>
      userMovedRef.current && current && ids.includes(current)
        ? current
        : (ids[0] ?? null),
    );
  }, [view]);

  // Keep the latest view reachable from the stable setActiveId without recreating it
  // each keystroke (rows pass it as onHover).
  const viewRef = useRef(view);
  viewRef.current = view;

  // Prefetch-on-intent: hovering or arrow-keying onto a row (both call setActiveId) is
  // intent for the imminent Enter — warm that row's destination pane (chunk + data). Only
  // href / route-resource rows have a pre-known pane; others (create/ask/external) no-op.
  const setActiveId = useCallback(
    (id: string) => {
      userMovedRef.current = true;
      setActiveIdState(id);
      const current = viewRef.current;
      const rows: (LauncherItem | LauncherAction)[] =
        current.state === "resting"
          ? current.groups.flatMap((group) => group.items)
          : current.state === "querying"
            ? current.results
            : current.actions;
      const target = rows.find((row) => row.id === id)?.target;
      if (target?.kind === "href" && !target.externalShell) {
        warmPane(target.href);
      } else if (
        target?.kind === "ResourceOpen" &&
        target.subject.activation.kind === "route" &&
        target.subject.activation.href
      ) {
        warmPane(target.subject.activation.href);
      }
    },
    [warmPane],
  );

  const dispatchCtx = useMemo<LauncherDispatchCtx>(
    () => ({
      androidShell,
      feedback,
      activePaneId: state.activePrimaryPaneId,
      activateWorkspaceTarget,
      defaultLibraryIds: DEFAULT_LIBRARY_IDS,
      placeItems,
      panes,
      activatePane,
      restorePane,
      closePane,
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
    (item: LauncherItem) => {
      if (item.source === "browse") return; // not a logged enum value; browse rows have no stable key
      const target = item.target;
      // Only href and route-resource selections post as `href`; a resource without a
      // route href (external/none) has no loggable open target.
      const wire =
        target.kind === "href"
          ? { key: target.href, href: target.href }
          : target.kind === "ResourceOpen" &&
              target.subject.activation.kind === "route" &&
              target.subject.activation.href
            ? {
                key: target.subject.ref,
                href: target.subject.activation.href,
              }
            : null;
      if (!wire) return;
      // Don't record a target the viewer can't actually open (Android-restricted route):
      // dispatch no-ops it, so logging would only pollute frecency.
      if (isAndroidShellRestrictedHref(wire.href, androidShell)) return;
      void apiFetch("/api/me/palette-selections", {
        method: "POST",
        body: JSON.stringify({
          query: input.text,
          target_key: wire.key,
          target_kind: "href",
          target_href: wire.href,
          title_snapshot: item.title,
          source: item.source,
        }),
      }).catch((error) => {
        if (handleUnauthenticatedApiError(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
        feedback.show(
          toFeedback(error, { fallback: "Command history was not saved" }),
        );
      });
    },
    [input.text, feedback, androidShell],
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
      outcome: DispatchOutcome,
      retained: Omit<RetainedActivation, "target">,
    ) => {
      switch (outcome.kind) {
        case "Stayed":
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
            },
          });
          return;
      }
    },
    [],
  );

  const dispatchOwned = useCallback(
    (
      target: LauncherActionTarget,
      activation: LauncherTargetActivation,
      retained: Omit<RetainedActivation, "target">,
    ) =>
      dispatchTarget(target, dispatchCtx, activation).then((outcome) => {
        applyDispatchOutcome(outcome, retained);
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
      fork?: boolean;
      onAccepted?: () => void;
    }) => {
      void dispatchOwned(
        {
          kind: "href",
          href: input.target.href,
          externalShell: false,
          labelHint: input.target.labelHint,
        },
        {
          disposition: { kind: input.fork ? "Fork" : "Adopt" },
          modality: "Programmatic",
        },
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
    (pageId: string) => {
      setPage({ kind: "CreatePage", pageId, submit: { kind: "Running" } });
      void createNotePage({ pageId, title: "Untitled" })
        .then((created) => {
          setPendingNoteFocus({ pageId: created.id, target: "title" });
          dispatchWorkspaceTarget({
            target: {
              href: `/pages/${created.id}`,
              labelHint: created.title,
            },
            source: "Page",
            completion: present({ kind: "Page", replayId: pageId }),
            returnTo: { kind: "Root" },
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
            submit: {
              kind: "Retryable",
              message: toFeedback(error, {
                fallback: "Couldn’t create page. Retry",
              }).title,
            },
          });
        });
    },
    [dispatchWorkspaceTarget],
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
        dispatchWorkspaceTarget({
          target: {
            href: `/libraries/${library.id}`,
            labelHint: library.name,
          },
          source: "Library",
          completion: present({ kind: "Library", replayId: libraryId }),
          returnTo: { kind: "Root" },
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
          submit: {
            kind: "Retryable",
            message: toFeedback(error, {
              fallback: "Couldn’t create library. Retry",
            }).title,
          },
        });
      });
  }, [dispatchWorkspaceTarget, page]);

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
              fork: true,
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
            fork,
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
            fork,
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
      });
    },
    [dispatchWorkspaceTarget],
  );

  const switchboardItemActions = useCallback(
    (item: SwitchboardItem): readonly LauncherAction[] =>
      item.kind === "Resource"
        ? buildResourceItemActions(item.subject, item.label)
        : [],
    [],
  );

  const runSwitchboardAction = useCallback(
    (action: LauncherAction) => {
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
    (action: SwitchboardQuickAction) => {
      switch (action.target.kind) {
        case "TodayCapture":
          setPage({
            kind: "TodayCapture",
            sessionId: todaySession.start(),
          });
          return;
        case "CreatePage":
          runPageCreation(crypto.randomUUID());
          return;
        case "CreateChat":
          dispatchWorkspaceTarget({
            target: { href: "/conversations/new", labelHint: "New chat" },
            source: "Chat",
            returnTo: { kind: "Root" },
            fork: true,
          });
          return;
        case "CreateLibrary":
          setPage({
            kind: "CreateLibrary",
            nameDraft: "",
            libraryId: crypto.randomUUID(),
            submit: { kind: "Ready" },
          });
          return;
        case "Import":
          setPage({
            kind: "Add",
            sessionId: startAddSession(action.target.seed),
          });
          return;
        case "PodcastDiscovery":
          setPage({
            kind: "PodcastDiscovery",
            query: "",
            sessionId: createRandomId("podcast-discovery"),
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
    [dispatchWorkspaceTarget, feedback, page],
  );

  const select = useCallback(
    (item: LauncherItem, activation: LauncherTargetActivation) => {
      const target = item.target;
      if (target.kind === "open-add") {
        setPage({ kind: "Add", sessionId: startAddSession(target.seed) });
        return;
      }
      if (target.kind === "open-today-capture") {
        setPage({
          kind: "TodayCapture",
          sessionId: todaySession.start(),
        });
        return;
      }
      if (target.kind === "create-page") {
        runPageCreation(crypto.randomUUID());
        return;
      }
      if (target.kind === "set-lane") {
        userMovedRef.current = false;
        const nextQuery = target.query ?? input.text;
        setPage(
          nextQuery
            ? { kind: "Find", query: nextQuery, scope: "All" }
            : { kind: "Root" },
        );
        const sigil = LANE_SIGIL[target.lane];
        if (sigil) {
          setLaneOverride(null);
          setQueryState(sigil + (target.query ?? input.text));
        } else {
          setLaneOverride(target.lane === "all" ? null : target.lane);
          setQueryState(target.query ?? input.text);
        }
        // stay open — do NOT call setOpen(false)
        return;
      }
      logSelection(item);
      void dispatchOwned(target, activation, {
        source: "Find",
        completion: absent(),
        returnTo,
      }).catch(fail);
    },
    [
      dispatchOwned,
      fail,
      input.text,
      logSelection,
      returnTo,
      runPageCreation,
      startAddSession,
      todaySession,
    ],
  );

  // TodayCapturePanel opens its post-action pane through the one dispatch owner.
  // AddPanel uses openAddTarget,
  // whose guarded Navigate intent closes Add after the destination accepts focus.
  const openTarget = useCallback(
    (target: LauncherActionTarget) => {
      void dispatchOwned(
        target,
        // Completed Today capture opens with Adopt (never replace the source
        // pane); reuses an exact today pane or creates one beside it.
        PROGRAMMATIC_ADOPT_LAUNCHER_TARGET_ACTIVATION,
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
    [dispatchOwned, fail, page.kind, returnTo, todaySession.committedReplayId],
  );

  const runAction = useCallback(
    (action: LauncherAction) => {
      // pane-close keeps the Launcher open and returns to the root list; everything else closes.
      if (action.target.kind === "pane-close") {
        void dispatchOwned(
          action.target,
          PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
          {
            source: "Find",
            completion: absent(),
            returnTo,
          },
        ).catch(fail);
        setPage({ kind: "Root" });
        return;
      }
      void dispatchOwned(
        action.target,
        PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
        {
          source: "Find",
          completion: absent(),
          returnTo,
        },
      ).catch(fail);
    },
    [dispatchOwned, fail, returnTo],
  );

  const trailing = useCallback(
    (item: LauncherItem) => {
      if (item.trailingAction)
        void dispatchOwned(
          item.trailingAction.target,
          PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
          {
            source: "Find",
            completion: absent(),
            returnTo,
          },
        ).catch(
          fail,
        );
    },
    [dispatchOwned, fail, returnTo],
  );

  const drill = useCallback((item: LauncherItem) => {
    if (!item.hasActions) return;
    const actions = buildItemActions(item);
    if (actions.length === 0) return;
    setPage({ kind: "Actions", item, actions });
  }, []);

  const askCurrent = useCallback(() => {
    if (!input.text) return;
    void dispatchOwned(
      { kind: "Ask", text: input.text },
      PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
      {
        source: "Chat",
        completion: absent(),
        returnTo,
      },
    ).catch(
      fail,
    );
  }, [dispatchOwned, fail, input.text, returnTo]);

  const setQuery = useCallback((next: string) => {
    userMovedRef.current = false;
    setQueryState(next);
    setPage((current) =>
      current.kind === "Find"
        ? { ...current, query: next }
        : next.trim()
          ? { kind: "Find", query: next, scope: "All" }
          : { kind: "Root" },
    );
  }, []);

  const setLane = useCallback(
    (next: LauncherLane) => {
      userMovedRef.current = false;
      setPage(
        input.text
          ? {
              kind: "Find",
              query: input.text,
              scope: page.kind === "Find" ? page.scope : "All",
            }
          : { kind: "Root" },
      );
      const sigil = LANE_SIGIL[next];
      if (sigil) {
        setLaneOverride(null);
        setQueryState(sigil + input.text);
      } else {
        setLaneOverride(next === "all" ? null : next);
        setQueryState(input.text);
      }
    },
    [input.text, page],
  );

  const clearLane = useCallback(() => {
    userMovedRef.current = false;
    setLaneOverride(null);
    setQueryState(input.text); // peel any leading sigil
  }, [input.text]);

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
            intent.activation ?? PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
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
          // A bare Root reopen (no query, no lane, not Add) preserves a retained
          // recovery page so a dismiss → reopen through the open event / hotkey
          // doesn't lose the target (AC11) — mirrors openRoot's own guard for the
          // entry points that route straight through requestExit(Replace).
          if (
            detail.kind === "Root" &&
            !detail.query &&
            (!detail.lane || detail.lane === "all") &&
            (page.kind === "ActivationBlocked" || page.kind === "ManageTabs")
          ) {
            setOpen(true);
            return;
          }
          if (detail.kind === "Add") {
            setPage({
              kind: "Add",
              sessionId: startAddSession(detail.seed),
            });
            setLaneOverride(null);
            setQueryState("");
          } else {
            discardAddSession();
            const seedQuery = detail.query ?? "";
            setPage(
              seedQuery
                ? { kind: "Find", query: seedQuery, scope: "All" }
                : { kind: "Root" },
            );
            const sigil = detail.lane ? LANE_SIGIL[detail.lane] : undefined;
            if (sigil) {
              setLaneOverride(null);
              setQueryState(sigil + seedQuery);
            } else {
              setLaneOverride(
                detail.lane && detail.lane !== "all" ? detail.lane : null,
              );
              setQueryState(seedQuery);
            }
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
      if (guardExit(intent) === "accepted") performExit(intent);
    },
    [guardExit, performExit],
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
  const setFindScope = useCallback((scope: SwitchboardFindScope) => {
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
      runPageCreation(page.pageId);
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
      fork: retained.source === "Chat",
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
    (target: LauncherActionTarget) => {
      let replayId: string | null = null;
      if (
        target.kind === "href" &&
        target.href === "/podcasts" &&
        addSession.state.opml.kind === "Complete"
      ) {
        replayId = addSession.opmlReplayIdentity;
      } else if (target.kind === "href") {
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
        activation: PROGRAMMATIC_ADOPT_LAUNCHER_TARGET_ACTIVATION,
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
      : "Launcher";
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
        (event as CustomEvent<OpenLauncherDetail>).detail ??
        ({ kind: "Root" } as const);
      requestExit({ kind: "Replace", detail });
    };
    window.addEventListener(OPEN_LAUNCHER_EVENT, handler);
    return () => window.removeEventListener(OPEN_LAUNCHER_EVENT, handler);
  }, [requestExit]);

  useLayoutEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cmd = params.get("cmd");
    if (params.get("launcher") !== "1" && cmd === null) return;
    setQueryState(params.get("q") ?? "");
    if (cmd) {
      userMovedRef.current = true;
      setActiveIdState(cmd);
    }
    const laneParam = params.get("lane");
    const validLanes: LauncherLane[] = [
      "all",
      "open",
      "search",
      "browse",
      "create",
      "ask",
      "go",
    ];
    const seedLane =
      laneParam && (validLanes as string[]).includes(laneParam)
        ? (laneParam as LauncherLane)
        : null;
    if (seedLane && seedLane !== "all") setLaneOverride(seedLane);
    params.delete("launcher");
    params.delete("q");
    params.delete("cmd");
    params.delete("lane");
    setOpen(true);
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const launcherCombo = keybindings["open-launcher"];
      if (launcherCombo && matchesKeyEvent(launcherCombo, event)) {
        event.preventDefault();
        if (open) {
          requestExit({ kind: "Close" });
          return;
        }
        userMovedRef.current = false;
        requestExit({ kind: "Replace", detail: { kind: "Root" } });
        return;
      }
      for (const [actionId, combo] of Object.entries(keybindings)) {
        if (actionId === "open-launcher") continue;
        if (!matchesKeyEvent(combo, event)) continue;
        const destination = DESTINATIONS.find((entry) => entry.id === actionId);
        const target: LauncherActionTarget | null =
          actionId === "today"
            ? { kind: "open-today" }
            : destination
              ? { kind: "href", href: destination.href, externalShell: false }
              : null;
        if (!target) continue; // a bound non-destination combo (e.g. pane-nav) is owned elsewhere
        event.preventDefault();
        requestExit({ kind: "Navigate", target });
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [keybindings, open, requestExit]);

  return {
    open,
    paneCount: panes.length,
    query,
    input,
    lane,
    page,
    addSession,
    todaySession,
    dialogLabel,
    focusKey,
    dismissalConfirmation,
    view,
    searchLoading: searchFetch.loading,
    browseLoading: browseFetch.loading,
    activeId,
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
    switchboardOpenablesFailed: openablesFetch.error !== null,
    switchboardDeepFailed: deepFetch.error !== null,
    podcastResults: podcastFetch.data ?? [],
    podcastBusy: showSwitchboardBusy && podcastFetch.loading,
    podcastSubscribingId,
    podcastFailed: podcastFetch.error !== null,
    setQuery,
    setLane,
    clearLane,
    setActiveId,
    select,
    openTarget,
    openAddTarget,
    drill,
    back,
    runAction,
    trailing,
    askCurrent,
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
