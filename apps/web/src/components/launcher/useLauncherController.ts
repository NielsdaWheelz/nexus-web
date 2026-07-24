"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import { useResource } from "@/lib/api/useResource";
import { usePaneWarm } from "@/lib/panes/paneWarm";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { matchesKeyEvent } from "@/lib/keybindings";
import { useKeybindings } from "@/lib/keybindingsProvider";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { buildItemActions } from "@/lib/launcher/actions";
import {
  dispatchTarget,
  isAndroidShellRestrictedHref,
  targetNavigates,
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
  type LauncherPage,
  type LauncherView,
} from "@/lib/launcher/model";
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
import { fetchSearchResultPage } from "@/lib/search/searchApi";
import { searchHref } from "@/lib/search/searchParams";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { DismissDecision } from "@/lib/ui/useHistoryDismiss";
import { getWorkspacePrimaryPanes } from "@/lib/workspace/schema";
import {
  resolveWorkspacePaneLabel,
  useWorkspaceStore,
} from "@/lib/workspace/store";
import type { BrowseResponse, BrowseResult } from "@/lib/browse/types";
import {
  resolveAddPanelInitialFocus,
  type AddDismissalConfirmation,
} from "./AddPanel";
import {
  useAddContentSession,
  type AddContentSessionController,
} from "./useAddContentSession";

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
const ORACLE_TTL_MS = 5 * 60_000;
const EMPTY_RECENT: LauncherRecentRow[] = [];
const EMPTY_FRECENCY = new Map<string, number>();
const EMPTY_SEARCH: SearchResultRowViewModel[] = [];
const EMPTY_BROWSE: BrowseResult[] = [];
const EMPTY_WEB: LauncherWebResult[] = [];
// Quick add-url / browse-acquire ingest into "My Library only"; the AddPanel offers a picker.
const DEFAULT_LIBRARY_IDS: string[] = [];

async function fetchBrowse(
  query: string,
  signal: AbortSignal,
): Promise<BrowseResult[]> {
  const params = new URLSearchParams({ q: query, limit: "4" });
  const response = await apiFetch<BrowseResponse>(
    `/api/browse?${params.toString()}`,
    { signal },
  );
  return Object.values(response.data.sections).flatMap(
    (section) => section?.results ?? [],
  );
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
  query: string;
  input: LauncherInput;
  lane: LauncherLane;
  page: LauncherPage;
  addSession: AddContentSessionController;
  dialogLabel: string;
  focusKey: string;
  dismissalConfirmation: AddDismissalConfirmation;
  view: LauncherView;
  searchLoading: boolean;
  browseLoading: boolean;
  activeId: string | null;
  setQuery(next: string): void;
  setLane(lane: LauncherLane): void;
  clearLane(): void;
  setActiveId(id: string): void;
  select(item: LauncherItem): void;
  openTarget(target: LauncherActionTarget): void;
  openAddTarget(target: LauncherActionTarget): void;
  drill(item: LauncherItem): void;
  back(): void;
  runAction(action: LauncherAction): void;
  trailing(item: LauncherItem): void;
  askCurrent(): void;
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
  | { kind: "Navigate"; target: LauncherActionTarget }
  | { kind: "Replace"; detail: OpenLauncherDetail };

type PendingDismissal = {
  confirmation: Exclude<AddDismissalConfirmation, null>["kind"];
  intent: ExitIntent;
};

export function useLauncherController(): LauncherController {
  const { androidShell, platform } = useRenderEnvironment();
  const keybindings = useKeybindings();
  const feedback = useFeedback();
  const warmPane = usePaneWarm();
  // The one Lectern capability (append is stable across renders); dispatch's queue-add
  // case calls it. useLectern requires a LecternProvider ancestor (AuthenticatedShell).
  const { placeItems } = useLectern();
  const addSession = useAddContentSession();
  const {
    start: startAddSession,
    backToContent: backToAddContent,
    discard: discardAddSession,
    stop: stopAddSession,
  } = addSession;
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [laneOverride, setLaneOverride] = useState<LauncherLane | null>(null);
  const [page, setPage] = useState<LauncherPage>({ kind: "root" });
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [pendingDismissal, setPendingDismissal] =
    useState<PendingDismissal | null>(null);
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

  const { state, runtimeLabelByPaneId, activatePane, closePane, restorePane } =
    useWorkspaceStore();

  useEffect(() => {
    if (open) suppressReturnFocusRef.current = false;
  }, [open]);

  const input = useMemo(() => parseLauncherInput(query), [query]);
  // A typed leading sigil wins over a chip override; both fall back to the blended `all`.
  const lane = input.explicitLane ?? laneOverride ?? "all";

  // --- Fetching: recents (debounced via useResource), oracle (TTL), search + browse/web (debounced) ---
  const requestedHistoryPath = useMemo<ApiPath | null>(() => {
    if (!open) return null;
    return input.text
      ? `/api/me/palette-history?${new URLSearchParams({ query: input.text }).toString()}`
      : "/api/me/palette-history";
  }, [open, input.text]);

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
    if (!open) {
      setOracleKey(null);
      return;
    }
    if (Date.now() - oracleFetchedAt.current < ORACLE_TTL_MS) return;
    oracleVersion.current += 1;
    setOracleKey(`oracle-readings:${oracleVersion.current}`);
  }, [open]);

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
    open && (lane === "all" || lane === "search") && input.text.length >= 2
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
  const browseEnabled = open && lane === "browse" && input.text.length >= 2;
  const browseFetch = useDebouncedFetch(
    browseEnabled ? input.text : null,
    async (signal) => {
      const [browseRows, webRows] = await Promise.all([
        fetchBrowse(input.text, signal),
        fetchWeb(input.text, signal).catch(() => EMPTY_WEB),
      ]);
      return { browseRows, webRows };
    },
    { debounceMs: 200 },
  );
  const browseResults = browseFetch.data?.browseRows ?? EMPTY_BROWSE;
  const webResults = browseFetch.data?.webRows ?? EMPTY_WEB;

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
      page.kind === "actions"
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
        target?.kind === "resource" &&
        target.activation.kind === "route" &&
        target.activation.href
      ) {
        warmPane(target.activation.href);
      }
    },
    [warmPane],
  );

  const dispatchCtx = useMemo<LauncherDispatchCtx>(
    () => ({
      androidShell,
      feedback,
      defaultLibraryIds: DEFAULT_LIBRARY_IDS,
      placeItems,
      panes,
      activatePane,
      restorePane,
      closePane,
    }),
    [
      androidShell,
      feedback,
      placeItems,
      panes,
      activatePane,
      restorePane,
      closePane,
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
          : target.kind === "resource" &&
              target.activation.kind === "route" &&
              target.activation.href
            ? {
                key: target.activation.resourceRef,
                href: target.activation.href,
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
      feedback.show(toFeedback(error, { fallback: "Command failed" }));
    },
    [feedback],
  );

  const select = useCallback(
    (item: LauncherItem) => {
      const target = item.target;
      if (target.kind === "open-add") {
        startAddSession(target.seed);
        setPage({ kind: "add" });
        return;
      }
      if (target.kind === "open-create") {
        setPage({ kind: "create" });
        return;
      }
      if (target.kind === "set-lane") {
        userMovedRef.current = false;
        setPage({ kind: "root" });
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
      suppressReturnFocusRef.current = targetNavigates(target);
      setOpen(false);
      logSelection(item);
      void dispatchTarget(target, dispatchCtx).catch(fail);
    },
    [dispatchCtx, logSelection, fail, input.text, startAddSession],
  );

  // CreatePanel opens its post-action pane through the one dispatch owner (AC-9)
  // instead of calling requestOpenInAppPane directly. AddPanel uses openAddTarget,
  // whose guarded Navigate intent closes Add after the destination accepts focus.
  const openTarget = useCallback(
    (target: LauncherActionTarget) => {
      void dispatchTarget(target, dispatchCtx).catch(fail);
    },
    [dispatchCtx, fail],
  );

  const runAction = useCallback(
    (action: LauncherAction) => {
      // pane-close keeps the Launcher open and returns to the root list; everything else closes.
      if (action.target.kind === "pane-close") {
        void dispatchTarget(action.target, dispatchCtx).catch(fail);
        setPage({ kind: "root" });
        return;
      }
      suppressReturnFocusRef.current = targetNavigates(action.target);
      setOpen(false);
      void dispatchTarget(action.target, dispatchCtx).catch(fail);
    },
    [dispatchCtx, fail],
  );

  const trailing = useCallback(
    (item: LauncherItem) => {
      if (item.trailingAction)
        void dispatchTarget(item.trailingAction.target, dispatchCtx).catch(
          fail,
        );
    },
    [dispatchCtx, fail],
  );

  const drill = useCallback((item: LauncherItem) => {
    if (!item.hasActions) return;
    const actions = buildItemActions(item);
    if (actions.length === 0) return;
    setPage({ kind: "actions", item, actions });
  }, []);

  const askCurrent = useCallback(() => {
    if (!input.text) return;
    suppressReturnFocusRef.current = true; // ask opens a new chat pane
    setOpen(false);
    void dispatchTarget({ kind: "ask", text: input.text }, dispatchCtx).catch(
      fail,
    );
  }, [input.text, dispatchCtx, fail]);

  const setQuery = useCallback((next: string) => {
    userMovedRef.current = false;
    setQueryState(next);
    setPage({ kind: "root" });
  }, []);

  const setLane = useCallback(
    (next: LauncherLane) => {
      userMovedRef.current = false;
      setPage({ kind: "root" });
      const sigil = LANE_SIGIL[next];
      if (sigil) {
        setLaneOverride(null);
        setQueryState(sigil + input.text);
      } else {
        setLaneOverride(next === "all" ? null : next);
        setQueryState(input.text);
      }
    },
    [input.text],
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
          setPage({ kind: "root" });
          return;
        case "Close":
          discardAddSession();
          setOpen(false);
          return;
        case "Navigate":
          suppressReturnFocusRef.current = targetNavigates(intent.target);
          discardAddSession();
          setOpen(false);
          void dispatchTarget(intent.target, dispatchCtx).catch(fail);
          return;
        case "Replace": {
          const { detail } = intent;
          userMovedRef.current = false;
          suppressReturnFocusRef.current = false;
          if (detail.kind === "Add") {
            startAddSession(detail.seed);
            setPage({ kind: "add" });
            setLaneOverride(null);
            setQueryState("");
          } else {
            discardAddSession();
            setPage({ kind: "root" });
            const seedQuery = detail.query ?? "";
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
    [backToAddContent, discardAddSession, dispatchCtx, fail, startAddSession],
  );

  const guardExit = useCallback(
    (intent: ExitIntent): DismissDecision => {
      if (pendingDismissal) return "blocked";
      if (page.kind !== "add") return "accepted";
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
    ],
  );

  const requestExit = useCallback(
    (intent: ExitIntent) => {
      if (guardExit(intent) === "accepted") performExit(intent);
    },
    [guardExit, performExit],
  );

  const back = useCallback(() => {
    if (page.kind === "add" && addSession.state.branch === "Opml") {
      requestExit({ kind: "Content" });
      return;
    }
    requestExit({ kind: "Root" });
  }, [addSession.state.branch, page.kind, requestExit]);

  const close = useCallback(
    () => requestExit({ kind: "Close" }),
    [requestExit],
  );
  const dismissAccepted = useCallback(
    () => performExit({ kind: "Close" }),
    [performExit],
  );
  const guardClose = useCallback(
    () => guardExit({ kind: "Close" }),
    [guardExit],
  );
  const escape = useCallback(() => {
    if (page.kind === "root") {
      requestExit({ kind: "Close" });
      return;
    }
    back();
  }, [back, page.kind, requestExit]);

  const openAddTarget = useCallback(
    (target: LauncherActionTarget) => requestExit({ kind: "Navigate", target }),
    [requestExit],
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
      if (page.kind !== "add") {
        return container.querySelector<HTMLElement>('[role="combobox"]');
      }
      return resolveAddPanelInitialFocus(container, isMobile, {
        branch: addSession.state.branch,
        initialFocus: addSession.state.initialFocus,
      });
    },
    [addSession.state.branch, addSession.state.initialFocus, page.kind],
  );

  const dialogLabel =
    page.kind === "add"
      ? addSession.state.branch === "Opml"
        ? "Import OPML"
        : "Add content"
      : "Launcher";
  const focusKey =
    page.kind === "add"
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

  useEffect(() => {
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
    query,
    input,
    lane,
    page,
    addSession,
    dialogLabel,
    focusKey,
    dismissalConfirmation,
    view,
    searchLoading: searchFetch.loading,
    browseLoading: browseFetch.loading,
    activeId,
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
