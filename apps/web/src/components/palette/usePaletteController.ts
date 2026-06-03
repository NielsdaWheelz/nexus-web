"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { dispatchOpenAddContent } from "@/components/addContentEvents";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { isAbortError } from "@/lib/errors";
import { copyText } from "@/lib/ui/copyText";
import { matchesKeyEvent } from "@/lib/keybindings";
import { useKeybindings } from "@/lib/keybindingsProvider";
import { createNotePage } from "@/lib/notes/api";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import { fetchSearchResultPage } from "@/lib/search/resultRowAdapter";
import { ALL_SEARCH_TYPES, type SearchResultRowViewModel } from "@/lib/search/types";
import { isAndroidShellRestrictedRouteId } from "@/lib/androidShell";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { resolveWorkspacePaneTitle, useWorkspaceStore } from "@/lib/workspace/store";
import { getWorkspacePrimaryPanes } from "@/lib/workspace/schema";
import { parsePaletteInput, type PaletteIntent } from "./paletteIntent";
import {
  paletteRowIds,
  STATIC_COMMANDS,
  type PaletteAction,
  type PaletteItem,
  type PaletteView,
} from "./paletteModel";
import {
  buildPaletteItems,
  type PaletteContext,
  type PaletteOracleRow,
  type PaletteRecentRow,
} from "./paletteProviders";
import { rankPalette } from "./paletteRanking";
import { buildItemActions } from "./paletteActions";

interface PaletteHistoryResponse {
  data: { recent: PaletteRecentRow[]; frecency_boosts: Record<string, number> };
}
interface OracleReadingsResponse {
  data: PaletteOracleRow[];
}

function openAskConversation(text: string): void {
  requestOpenInAppPane(`/conversations/new?draft=${encodeURIComponent(text)}`, {
    titleHint: "New chat",
  });
}

const HISTORY_DEBOUNCE_MS = 200;
const SEARCH_DEBOUNCE_MS = 200;
const ORACLE_TTL_MS = 5 * 60_000;
const EMPTY_RECENT: PaletteRecentRow[] = [];
const EMPTY_FRECENCY = new Map<string, number>();

export type PalettePage =
  | { kind: "root" }
  | { kind: "actions"; item: PaletteItem; actions: PaletteAction[] };

export interface PaletteController {
  open: boolean;
  query: string;
  intent: PaletteIntent;
  page: PalettePage;
  view: PaletteView;
  searchLoading: boolean;
  activeId: string | null;
  setQuery(next: string): void;
  setActiveId(id: string): void;
  clearLane(): void;
  select(item: PaletteItem): void;
  drill(item: PaletteItem): void;
  back(): void;
  runAction(action: PaletteAction): void;
  trailing(item: PaletteItem): void;
  close(): void;
}

export function usePaletteController(): PaletteController {
  const { androidShell, platform } = useRenderEnvironment();
  const keybindings = useKeybindings();
  const feedback = useFeedback();
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [page, setPage] = useState<PalettePage>({ kind: "root" });
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const userMovedRef = useRef(false); // true once the user arrows/hovers; else the active row follows the top result
  const [historyPath, setHistoryPath] = useState<ApiPath | null>(null);
  const [oracleKey, setOracleKey] = useState<string | null>(null);
  const [oracleRows, setOracleRows] = useState<PaletteOracleRow[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResultRowViewModel[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const oracleFetchedAt = useRef(0);
  const oracleVersion = useRef(0);

  const { state, runtimeTitleByPaneId, activatePane, closePane, restorePane } = useWorkspaceStore();
  const intent = useMemo(() => parsePaletteInput(query), [query]);

  // --- Fetching: recents (debounced), oracle folios (TTL), search (debounced + aborted) ---
  const requestedHistoryPath = useMemo<ApiPath | null>(() => {
    if (!open) return null;
    return intent.term
      ? `/api/me/palette-history?${new URLSearchParams({ query: intent.term }).toString()}`
      : "/api/me/palette-history";
  }, [open, intent.term]);

  useEffect(() => {
    if (requestedHistoryPath === null) {
      setHistoryPath(null);
      return;
    }
    const timer = window.setTimeout(() => setHistoryPath(requestedHistoryPath), HISTORY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [requestedHistoryPath]);

  const historyResource = useResource<PaletteHistoryResponse>({
    cacheKey: historyPath,
    path: (path) => path as ApiPath,
  });
  const historyRows =
    historyResource.status === "ready" ? historyResource.data.data.recent : EMPTY_RECENT;
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

  useEffect(() => {
    if (!open || intent.term.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void fetchSearchResultPage({
        query: intent.term,
        selectedTypes: new Set(ALL_SEARCH_TYPES),
        limit: 5,
        cursor: null,
        signal: controller.signal,
      })
        .then((pageResult) => {
          if (!cancelled) setSearchResults(pageResult.rows);
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, intent.term]);

  // --- Context → items → view (pure, memoized) ---
  const panes = useMemo(
    () =>
      getWorkspacePrimaryPanes(state).map((pane) => ({
        id: pane.id,
        href: pane.href,
        visibility: pane.visibility,
        title: resolveWorkspacePaneTitle(pane, runtimeTitleByPaneId, androidShell).title,
      })),
    [androidShell, state, runtimeTitleByPaneId],
  );
  const currentHref = panes.find((pane) => pane.id === state.activePrimaryPaneId)?.href ?? null;

  const ctx = useMemo<PaletteContext>(
    () => ({
      intent,
      panes,
      activePaneId: state.activePrimaryPaneId,
      currentHref,
      historyRows,
      frecencyBoosts,
      oracleRows,
      searchResults,
      keybindings,
      androidShell,
      platform,
      canOpenConversation: true,
    }),
    [
      intent,
      panes,
      state.activePrimaryPaneId,
      currentHref,
      historyRows,
      frecencyBoosts,
      oracleRows,
      searchResults,
      keybindings,
      androidShell,
      platform,
    ],
  );
  const rootView = useMemo(() => rankPalette(ctx, buildPaletteItems(ctx)), [ctx]);
  const view = useMemo<PaletteView>(
    () =>
      page.kind === "actions"
        ? { state: "actions", item: page.item, actions: page.actions }
        : rootView,
    [page, rootView],
  );

  // The active row follows the top result as the view changes, unless the user
  // has explicitly moved it (arrow/hover) and it is still present.
  useEffect(() => {
    const ids = paletteRowIds(view);
    setActiveIdState((current) =>
      userMovedRef.current && current && ids.includes(current) ? current : (ids[0] ?? null),
    );
  }, [view]);

  const setActiveId = useCallback((id: string) => {
    userMovedRef.current = true;
    setActiveIdState(id);
  }, []);

  // --- Execution ---
  const navigate = useCallback(
    async (item: PaletteItem) => {
      const target = item.target;
      if (target.kind === "href") {
        if (target.externalShell) window.location.assign(target.href);
        else requestOpenInAppPane(target.href, { titleHint: item.title });
        return;
      }
      if (target.kind === "ask") {
        openAskConversation(target.text);
        return;
      }
      const actionId = target.actionId;
      if (actionId === "create-page") {
        const created = await createNotePage({ title: "Untitled" });
        requestOpenInAppPane(`/pages/${created.id}`, { titleHint: created.title });
        return;
      }
      if (actionId === "new-conversation") {
        requestOpenInAppPane("/conversations/new", { titleHint: "New chat" });
        return;
      }
      if (actionId === "quick-note") return dispatchOpenAddContent("quick-note");
      if (actionId === "add-content") return dispatchOpenAddContent("content");
      if (actionId === "add-opml") return dispatchOpenAddContent("opml");
      if (actionId.startsWith("pane-open:")) {
        const paneId = actionId.slice("pane-open:".length);
        const pane = panes.find((item) => item.id === paneId);
        if (pane && androidShell && isAndroidShellRestrictedRouteId(resolvePaneRoute(pane.href).id)) {
          feedback.show({ severity: "warning", title: "Local Vault is not available in the Android app." });
          return;
        }
        if (pane?.visibility === "minimized") restorePane(paneId);
        else activatePane(paneId);
        return;
      }
      throw new Error(`Unknown command action: ${actionId}`);
    },
    [panes, androidShell, feedback, activatePane, restorePane],
  );

  const select = useCallback(
    (item: PaletteItem) => {
      const target = item.target;
      if (
        target.kind === "href" &&
        androidShell &&
        isAndroidShellRestrictedRouteId(resolvePaneRoute(target.href).id)
      ) {
        setOpen(false);
        feedback.show({ severity: "warning", title: "Local Vault is not available in the Android app." });
        return;
      }
      setOpen(false);

      // Selection logging — wire contract preserved (§7.7). `ask` maps to wire "prefill".
      const wire =
        target.kind === "href"
          ? { kind: "href", key: target.href, href: target.href as string | null }
          : target.kind === "ask"
            ? { kind: "prefill", key: `prefill:conversation:${target.text}`, href: null }
            : { kind: "action", key: item.id, href: null };
      void apiFetch("/api/me/palette-selections", {
        method: "POST",
        body: JSON.stringify({
          query: intent.term,
          target_key: wire.key,
          target_kind: wire.kind,
          target_href: wire.href,
          title_snapshot: item.title,
          source: item.source,
        }),
      }).catch((error) =>
        feedback.show(toFeedback(error, { fallback: "Command history was not saved" })),
      );

      void navigate(item).catch((error) =>
        feedback.show(toFeedback(error, { fallback: "Command failed" })),
      );
    },
    [androidShell, feedback, intent.term, navigate],
  );

  const runAction = useCallback(
    (action: PaletteAction) => {
      const run = action.run;
      switch (run.kind) {
        case "open":
          setOpen(false);
          if (run.externalShell) window.location.assign(run.href);
          else requestOpenInAppPane(run.href);
          return;
        case "ask":
          setOpen(false);
          openAskConversation(run.text);
          return;
        case "copy-link":
          copyText(new URL(run.href, window.location.origin).toString());
          feedback.show({ severity: "success", title: "Link copied" });
          setOpen(false);
          return;
        case "pane-activate": {
          setOpen(false);
          const pane = panes.find((item) => item.id === run.paneId);
          if (pane?.visibility === "minimized") restorePane(run.paneId);
          else activatePane(run.paneId);
          return;
        }
        case "pane-close":
          closePane(run.paneId);
          setPage({ kind: "root" });
          return;
        default: {
          const exhaustive: never = run;
          return exhaustive;
        }
      }
    },
    [panes, feedback, activatePane, restorePane, closePane],
  );

  const trailing = useCallback(
    (item: PaletteItem) => {
      const actionId = item.trailingAction?.actionId;
      if (actionId?.startsWith("pane-close:")) closePane(actionId.slice("pane-close:".length));
    },
    [closePane],
  );

  const drill = useCallback(
    (item: PaletteItem) => {
      if (!item.hasActions) return;
      const actions = buildItemActions(item, ctx);
      if (actions.length === 0) return;
      setPage({ kind: "actions", item, actions });
    },
    [ctx],
  );

  const setQuery = useCallback((next: string) => {
    userMovedRef.current = false;
    setQueryState(next);
    setPage({ kind: "root" });
  }, []);
  const clearLane = useCallback(() => {
    userMovedRef.current = false;
    setQueryState(intent.term);
  }, [intent.term]);
  const back = useCallback(() => setPage({ kind: "root" }), []);
  const close = useCallback(() => setOpen(false), []);

  // --- Triggers: open event, deep link, global hotkeys ---
  useEffect(() => {
    const handler = () => {
      userMovedRef.current = false;
      setQueryState("");
      setPage({ kind: "root" });
      setOpen(true);
    };
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handler);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handler);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cmd = params.get("cmd");
    if (params.get("palette") !== "1" && cmd === null) return;
    setQueryState(params.get("q") ?? "");
    if (cmd) {
      userMovedRef.current = true;
      setActiveIdState(cmd);
    }
    setOpen(true);
    params.delete("palette");
    params.delete("q");
    params.delete("cmd");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const paletteCombo = keybindings["open-palette"];
      if (paletteCombo && matchesKeyEvent(paletteCombo, event)) {
        event.preventDefault();
        userMovedRef.current = false;
        setQueryState("");
        setPage({ kind: "root" });
        setOpen((value) => !value);
        return;
      }
      for (const [actionId, combo] of Object.entries(keybindings)) {
        if (actionId === "open-palette") continue;
        if (!matchesKeyEvent(combo, event)) continue;
        const command = STATIC_COMMANDS.find((item) => item.id === actionId);
        if (!command) return;
        event.preventDefault();
        select(command);
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [keybindings, select]);

  return {
    open,
    query,
    intent,
    page,
    view,
    searchLoading,
    activeId,
    setQuery,
    setActiveId,
    clearLane,
    select,
    drill,
    back,
    runAction,
    trailing,
    close,
  };
}
