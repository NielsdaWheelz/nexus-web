"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft, Sparkles } from "lucide-react";
import PaletteDesktopShell from "@/components/palette/PaletteDesktopShell";
import PaletteMobileShell from "@/components/palette/PaletteMobileShell";
import type { PaletteCommand } from "@/components/palette/types";
import {
  getAskAiPinnedCommand,
  getSeeAllInSearchCommand,
} from "@/components/command-palette/commandProviders";
import { buildPaletteView } from "@/components/command-palette/commandRanking";
import { dispatchOpenAddContent } from "@/components/addContentEvents";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { isAbortError } from "@/lib/errors";
import { loadKeybindings, matchesKeyEvent, formatKeyCombo } from "@/lib/keybindings";
import { createNotePage } from "@/lib/notes/api";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import {
  getPaneRouteIcon,
  resolvePaneRoute,
} from "@/lib/panes/paneRouteTable";
import { toRoman } from "@/lib/toRoman";
import { fetchSearchResultPage } from "@/lib/search/resultRowAdapter";
import {
  ALL_SEARCH_TYPES,
  type SearchResultRowViewModel,
} from "@/lib/search/types";
import { SEARCH_TYPE_ICON } from "@/lib/search/searchTypeIcon";
import { isAndroidShell, isAndroidShellRestrictedRouteId } from "@/lib/androidShell";
import {
  resolveWorkspacePaneTitle,
  useWorkspaceStore,
} from "@/lib/workspace/store";
import { getWorkspacePrimaryPanes } from "@/lib/workspace/schema";
import {
  STATIC_COMMANDS,
  matchesCommand,
} from "@/components/command-palette/staticCommands";

interface PaletteHistoryResponse {
  data: {
    recent: {
      target_key: string;
      target_kind: string;
      target_href: string;
      title_snapshot: string;
      source: string;
      last_used_at: string;
    }[];
    frecency_boosts: Record<string, number>;
  };
}

interface OracleReadingSummary {
  id: string;
  folio_number: number;
  folio_motto: string | null;
  folio_theme: string | null;
  status: string;
}

type OracleReadingsResponse = { data: OracleReadingSummary[] } | OracleReadingSummary[];

const PALETTE_HISTORY_DEBOUNCE_MS = 200;
const PALETTE_SEARCH_DEBOUNCE_MS = 200;
const PALETTE_ORACLE_TTL_MS = 5 * 60_000;
const EMPTY_HISTORY_ROWS: PaletteHistoryResponse["data"]["recent"] = [];
const EMPTY_FRECENCY_BOOSTS = new Map<string, number>();

function oracleReadingsFromResponse(response: OracleReadingsResponse): OracleReadingSummary[] {
  return Array.isArray(response) ? response : response.data;
}

export default function CommandPalette() {
  const androidShell = isAndroidShell();
  const feedback = useFeedback();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [initialActiveCommandId, setInitialActiveCommandId] = useState<string | null>(null);
  const [keybindings, setKeybindings] = useState<Record<string, string>>({});
  const [paletteHistoryPath, setPaletteHistoryPath] = useState<ApiPath | null>(null);
  const [oracleResourceKey, setOracleResourceKey] = useState<string | null>(null);
  const [oracleRows, setOracleRows] = useState<OracleReadingSummary[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResultRowViewModel[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const oracleFetchedAt = useRef(0);
  const oracleLoadVersionRef = useRef(0);
  const {
    state: workspaceState,
    runtimeTitleByPaneId,
    activatePane,
    closePane,
    restorePane,
  } = useWorkspaceStore();
  const workspacePrimaryPanes = useMemo(
    () => getWorkspacePrimaryPanes(workspaceState),
    [workspaceState],
  );

  const requestedPaletteHistoryPath = useMemo<ApiPath | null>(() => {
    if (!open) return null;
    const params = new URLSearchParams();
    const trimmed = query.trim();
    if (trimmed) params.set("query", trimmed);
    return params.size > 0
      ? `/api/me/palette-history?${params.toString()}`
      : "/api/me/palette-history";
  }, [open, query]);

  useEffect(() => {
    if (requestedPaletteHistoryPath === null) {
      setPaletteHistoryPath(null);
      return;
    }

    const timer = window.setTimeout(() => {
      setPaletteHistoryPath(requestedPaletteHistoryPath);
    }, PALETTE_HISTORY_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [requestedPaletteHistoryPath]);

  const paletteHistoryResource = useResource<PaletteHistoryResponse>({
    cacheKey: paletteHistoryPath,
    path: (path) => path as ApiPath,
  });

  const historyRows =
    paletteHistoryResource.status === "ready"
      ? paletteHistoryResource.data.data.recent
      : EMPTY_HISTORY_ROWS;
  const frecencyBoosts = useMemo(
    () =>
      paletteHistoryResource.status === "ready"
        ? new Map(Object.entries(paletteHistoryResource.data.data.frecency_boosts))
        : EMPTY_FRECENCY_BOOSTS,
    [paletteHistoryResource],
  );

  useEffect(() => {
    if (!open) {
      setOracleResourceKey(null);
      return;
    }
    if (Date.now() - oracleFetchedAt.current < PALETTE_ORACLE_TTL_MS) return;

    oracleLoadVersionRef.current += 1;
    setOracleResourceKey(`oracle-readings:${oracleLoadVersionRef.current}`);
  }, [open]);

  const oracleResource = useResource<OracleReadingsResponse>({
    cacheKey: oracleResourceKey,
    path: () => "/api/oracle/readings",
  });

  useEffect(() => {
    if (oracleResource.status === "ready") {
      oracleFetchedAt.current = Date.now();
      setOracleRows(oracleReadingsFromResponse(oracleResource.data));
      return;
    }
    if (oracleResource.status === "error") {
      setOracleRows([]);
    }
  }, [oracleResource]);

  useEffect(() => {
    setKeybindings(loadKeybindings());
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const commandId = params.get("cmd");
    const shouldOpen = params.get("palette") === "1" || commandId !== null;
    if (!shouldOpen) return;

    setQuery(params.get("q") ?? "");
    setInitialActiveCommandId(commandId);
    setOpen(true);

    params.delete("palette");
    params.delete("q");
    params.delete("cmd");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, []);

  useEffect(() => {
    const handler = () => {
      setQuery("");
      setInitialActiveCommandId(null);
      setOpen(true);
    };
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handler);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handler);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!open || trimmed.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void fetchSearchResultPage({
        query: trimmed,
        selectedTypes: new Set(ALL_SEARCH_TYPES),
        limit: 5,
        cursor: null,
        signal: controller.signal,
      })
        .then((page) => {
          if (!cancelled) setSearchResults(page.rows);
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false);
        });
    }, PALETTE_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  const openPaneHrefs = useMemo(
    () => new Set(workspacePrimaryPanes.map((pane) => pane.href)),
    [workspacePrimaryPanes],
  );

  const commandsBeforeAi = useMemo<PaletteCommand[]>(() => {
    const commands: PaletteCommand[] = [];
    const normalizedQuery = query.trim().toLowerCase();

    for (const pane of workspacePrimaryPanes) {
      const route = resolvePaneRoute(pane.href);
      if (androidShell && isAndroidShellRestrictedRouteId(route.id)) {
        continue;
      }
      const { title } = resolveWorkspacePaneTitle(pane, runtimeTitleByPaneId);
      commands.push({
        id: `pane-open-${pane.id}`,
        title,
        subtitle: pane.visibility === "minimized" ? "Restore minimized tab" : "Switch to open tab",
        keywords: ["tab", "pane", "switch", pane.href],
        sectionId: "open-tabs",
        icon: PanelLeft,
        target: { kind: "action", actionId: `pane-open:${pane.id}` },
        source: "workspace",
        rank: { scopeBoost: pane.id === workspaceState.activePrimaryPaneId ? 300 : 0 },
        trailingAction: { actionId: `pane-close:${pane.id}`, ariaLabel: `Close ${title}` },
      });
    }

    for (const row of historyRows) {
      if (openPaneHrefs.has(row.target_href)) continue;
      const resolved = resolvePaneRoute(row.target_href);
      if (androidShell && isAndroidShellRestrictedRouteId(resolved.id)) continue;
      commands.push({
        id: `recent-${row.target_key}`,
        title: row.title_snapshot,
        subtitle: row.target_href,
        keywords: [row.target_href],
        sectionId: "recent",
        icon: getPaneRouteIcon(row.target_href),
        target: { kind: "href", href: row.target_href, externalShell: false },
        source: "recent",
        rank: { frecencyBoost: frecencyBoosts.get(row.target_key) ?? 0 },
      });
    }

    for (const row of oracleRows.filter((item) => item.status === "complete").slice(0, 5)) {
      const title = `Folio ${toRoman(row.folio_number)} · ${row.folio_theme ?? "Untitled"} · ${row.folio_motto ?? "Untitled"}`;
      commands.push({
        id: `oracle-recent-${row.id}`,
        title,
        keywords: [row.folio_theme ?? "", row.folio_motto ?? "", `folio ${row.folio_number}`],
        sectionId: "recent-folios",
        icon: Sparkles,
        target: { kind: "href", href: `/oracle/${row.id}`, externalShell: true },
        source: "oracle",
        rank: {},
      });
    }

    for (const command of STATIC_COMMANDS) {
      if (command.target.kind === "href") {
        const route = resolvePaneRoute(command.target.href);
        if (androidShell && isAndroidShellRestrictedRouteId(route.id)) {
          continue;
        }
      }
      const combo = keybindings[command.id];
      commands.push({
        ...command,
        shortcutLabel: combo ? formatKeyCombo(combo) : undefined,
        rank:
          command.target.kind === "href"
            ? { frecencyBoost: frecencyBoosts.get(command.target.href) ?? 0 }
            : command.rank,
      });
    }

    for (const result of searchResults) {
      const route = resolvePaneRoute(result.href);
      if (androidShell && isAndroidShellRestrictedRouteId(route.id)) continue;
      commands.push({
        id: `search-${result.key}`,
        title: result.primaryText,
        subtitle: result.typeLabel,
        keywords: [],
        sectionId: "search-results",
        icon: SEARCH_TYPE_ICON[result.type],
        target: { kind: "href", href: result.href, externalShell: false },
        source: "search",
        rank: { searchScore: 1 },
      });
    }

    return commands.filter((command) => matchesCommand(command, normalizedQuery));
  }, [
    androidShell,
    frecencyBoosts,
    historyRows,
    keybindings,
    openPaneHrefs,
    oracleRows,
    query,
    runtimeTitleByPaneId,
    searchResults,
    workspaceState.activePrimaryPaneId,
    workspacePrimaryPanes,
  ]);

  const askAiCommand = getAskAiPinnedCommand({
    query,
    localCommands: commandsBeforeAi.filter((command) => command.source !== "search"),
    canOpenConversation: true,
  });
  const seeAllCommand = getSeeAllInSearchCommand({ query });

  const view = useMemo(
    () =>
      buildPaletteView({
        query,
        commands: [
          ...commandsBeforeAi,
          ...(askAiCommand ? [askAiCommand] : []),
          ...(seeAllCommand ? [seeAllCommand] : []),
        ],
        frecencyBoosts,
        currentWorkspaceHref:
          workspacePrimaryPanes.find((p) => p.id === workspaceState.activePrimaryPaneId)?.href ?? null,
      }),
    [
      askAiCommand,
      commandsBeforeAi,
      frecencyBoosts,
      query,
      seeAllCommand,
      workspaceState.activePrimaryPaneId,
      workspacePrimaryPanes,
    ],
  );

  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);

  const executeCommand = useCallback(
    async (command: PaletteCommand) => {
      if (command.target.kind === "href" && androidShell) {
        const route = resolvePaneRoute(command.target.href);
        if (isAndroidShellRestrictedRouteId(route.id)) {
          setOpen(false);
          feedback.show({
            severity: "warning",
            title: "Local Vault is not available in the Android app.",
          });
          return;
        }
      }

      setOpen(false);

      const targetKey =
        command.target.kind === "href"
          ? command.target.href
          : command.target.kind === "prefill"
            ? `prefill:${command.target.surface}:${command.target.text}`
            : command.id;

      try {
        await apiFetch("/api/me/palette-selections", {
          method: "POST",
          body: JSON.stringify({
            query: query.trim(),
            target_key: targetKey,
            target_kind: command.target.kind,
            target_href: command.target.kind === "href" ? command.target.href : null,
            title_snapshot: command.title,
            source: command.source,
          }),
        });
      } catch (error) {
        feedback.show(toFeedback(error, { fallback: "Command history was not saved" }));
      }

      try {
        if (command.target.kind === "href") {
          if (command.target.externalShell) {
            window.location.assign(command.target.href);
            return;
          }
          requestOpenInAppPane(command.target.href, { titleHint: command.title });
          return;
        }

        if (command.target.kind === "prefill") {
          requestOpenInAppPane(
            `/conversations/new?draft=${encodeURIComponent(command.target.text)}`,
            { titleHint: "New chat" },
          );
          return;
        }

        const actionId = command.target.actionId;
        if (actionId === "create-page") {
          const page = await createNotePage({ title: "Untitled" });
          requestOpenInAppPane(`/pages/${page.id}`, { titleHint: page.title });
          return;
        }
        if (actionId === "new-conversation") {
          requestOpenInAppPane("/conversations/new", { titleHint: "New chat" });
          return;
        }
        if (actionId === "quick-note") {
          dispatchOpenAddContent("quick-note");
          return;
        }
        if (actionId === "add-content") {
          dispatchOpenAddContent("content");
          return;
        }
        if (actionId === "add-opml") {
          dispatchOpenAddContent("opml");
          return;
        }
        if (actionId.startsWith("pane-open:")) {
          const paneId = actionId.slice("pane-open:".length);
          const pane = workspacePrimaryPanes.find((item) => item.id === paneId);
          if (
            androidShell &&
            pane &&
            isAndroidShellRestrictedRouteId(resolvePaneRoute(pane.href).id)
          ) {
            feedback.show({
              severity: "warning",
              title: "Local Vault is not available in the Android app.",
            });
            return;
          }
          if (pane?.visibility === "minimized") {
            restorePane(paneId);
          } else {
            activatePane(paneId);
          }
          return;
        }

        throw new Error(`Unknown command action: ${actionId}`);
      } catch (error) {
        feedback.show(toFeedback(error, { fallback: "Command failed" }));
      }
    },
    [activatePane, androidShell, feedback, query, restorePane, workspacePrimaryPanes],
  );

  const onTrailingAction = useCallback(
    (command: PaletteCommand) => {
      if (!command.trailingAction) return;
      const actionId = command.trailingAction.actionId;
      if (actionId.startsWith("pane-close:")) {
        closePane(actionId.slice("pane-close:".length));
        return;
      }
      throw new Error(`Unknown trailing action: ${actionId}`);
    },
    [closePane],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const paletteCombo = keybindings["open-palette"];
      if (paletteCombo && matchesKeyEvent(paletteCombo, event)) {
        event.preventDefault();
        setQuery("");
        setInitialActiveCommandId(null);
        if (open) {
          setOpen(false);
        } else {
          setOpen(true);
        }
        return;
      }

      for (const [actionId, combo] of Object.entries(keybindings)) {
        if (actionId === "open-palette") continue;
        if (!matchesKeyEvent(combo, event)) continue;
        const command = STATIC_COMMANDS.find((item) => item.id === actionId);
        if (!command) return;
        event.preventDefault();
        void executeCommand(command);
        return;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [executeCommand, keybindings, open]);

  const isMobile = useIsMobileViewport();

  if (!open) return null;

  if (isMobile) {
    return (
      <PaletteMobileShell
        query={query}
        view={view}
        searchLoading={searchLoading}
        onQueryChange={setQuery}
        onSelect={executeCommand}
        onTrailingAction={onTrailingAction}
        onClose={closePalette}
      />
    );
  }

  return (
    <PaletteDesktopShell
      query={query}
      view={view}
      searchLoading={searchLoading}
      initialActiveCommandId={initialActiveCommandId}
      onQueryChange={setQuery}
      onSelect={executeCommand}
      onTrailingAction={onTrailingAction}
      onClose={closePalette}
    />
  );
}
