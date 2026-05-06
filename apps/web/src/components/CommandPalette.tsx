"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  Compass,
  FileText,
  FolderPlus,
  Globe,
  Keyboard,
  KeyRound,
  Link,
  Link2,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  PanelLeft,
  Pin,
  Plus,
  Search,
  Settings,
  Sparkles,
  Type,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import Palette from "@/components/palette/Palette";
import type { PaletteCommand } from "@/components/palette/types";
import { getAskAiFallbackCommand } from "@/components/command-palette/commandProviders";
import { rankPaletteCommands, sectionFor } from "@/components/command-palette/commandRanking";
import { dispatchOpenAddContent } from "@/components/addContentEvents";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import Chip from "@/components/ui/Chip";
import { apiFetch } from "@/lib/api/client";
import { loadKeybindings, matchesKeyEvent, formatKeyCombo } from "@/lib/keybindings";
import { createNotePage, todayLocalDate } from "@/lib/notes/api";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { resolvePaneRoute, type PaneRouteId } from "@/lib/panes/paneRouteRegistry";
import { pinObjectToNavbar } from "@/lib/pinnedObjects";
import {
  ALL_SEARCH_TYPES,
  fetchSearchResultPage,
  type SearchResultRowViewModel,
  type SearchType,
} from "@/lib/search/resultRowAdapter";
import {
  resolveWorkspacePaneTitle,
  useWorkspaceStore,
} from "@/lib/workspace/store";

const STATIC_COMMANDS: PaletteCommand[] = [
  {
    id: "nav-oracle",
    title: "Oracle",
    keywords: ["oracle", "divination", "reading", "folio", "fortune", "sortes", "motto"],
    sectionId: "navigate",
    icon: Sparkles,
    target: { kind: "href", href: "/oracle", externalShell: true },
    source: "static",
    rank: {},
  },
  {
    id: "nav-libraries",
    title: "Libraries",
    keywords: ["collections", "sources"],
    sectionId: "navigate",
    icon: BookOpen,
    target: { kind: "href", href: "/libraries", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-browse",
    title: "Browse",
    keywords: ["discover", "podcasts", "videos", "documents"],
    sectionId: "navigate",
    icon: Compass,
    target: { kind: "href", href: "/browse", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-podcasts",
    title: "Podcasts",
    keywords: ["audio", "feeds", "episodes"],
    sectionId: "navigate",
    icon: Mic,
    target: { kind: "href", href: "/podcasts", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-chats",
    title: "Chats",
    keywords: ["conversations", "messages"],
    sectionId: "navigate",
    icon: MessageSquare,
    target: { kind: "href", href: "/conversations", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-today",
    title: "Today's note",
    keywords: ["daily", "journal", "notes"],
    sectionId: "navigate",
    icon: CalendarDays,
    target: { kind: "href", href: "/daily", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-notes",
    title: "Notes",
    keywords: ["pages", "outline", "knowledge"],
    sectionId: "navigate",
    icon: FileText,
    target: { kind: "href", href: "/notes", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-search",
    title: "Search",
    keywords: ["find", "query"],
    sectionId: "navigate",
    icon: Search,
    target: { kind: "href", href: "/search", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-settings",
    title: "Settings",
    keywords: ["preferences", "account"],
    sectionId: "navigate",
    icon: Settings,
    target: { kind: "href", href: "/settings", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-appearance",
    title: "Appearance",
    keywords: ["theme", "light", "dark"],
    sectionId: "settings",
    icon: Settings,
    target: { kind: "href", href: "/settings/appearance", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-reader-settings",
    title: "Reader Settings",
    keywords: ["typography", "font", "theme"],
    sectionId: "settings",
    icon: Type,
    target: { kind: "href", href: "/settings/reader", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-api-keys",
    title: "API Keys",
    keywords: ["credentials", "providers"],
    sectionId: "settings",
    icon: KeyRound,
    target: { kind: "href", href: "/settings/keys", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-identities",
    title: "Linked Identities",
    keywords: ["google", "github", "oauth"],
    sectionId: "settings",
    icon: Link2,
    target: { kind: "href", href: "/settings/identities", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-keybindings",
    title: "Keyboard Shortcuts",
    keywords: ["keybindings", "hotkeys", "shortcuts"],
    sectionId: "settings",
    icon: Keyboard,
    target: { kind: "href", href: "/settings/keybindings", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "create-conversation",
    title: "New conversation",
    keywords: ["chat", "message"],
    sectionId: "create",
    icon: MessageSquarePlus,
    target: { kind: "action", actionId: "new-conversation" },
    source: "static",
    rank: {},
    scopeAffinity: ["conversation", "conversations", "conversationNew", "media"],
  },
  {
    id: "create-page",
    title: "New page",
    keywords: ["note", "notes", "outline"],
    sectionId: "create",
    icon: Plus,
    target: { kind: "action", actionId: "create-page" },
    source: "static",
    rank: {},
    scopeAffinity: ["note", "page", "notes"],
  },
  {
    id: "quick-note-today",
    title: "Quick note to today",
    keywords: ["daily", "capture", "journal"],
    sectionId: "create",
    icon: FileText,
    target: { kind: "action", actionId: "quick-note" },
    source: "static",
    rank: {},
    scopeAffinity: ["daily", "dailyDate", "note", "page", "notes"],
  },
  {
    id: "create-library",
    title: "New library",
    keywords: ["collection", "create"],
    sectionId: "create",
    icon: FolderPlus,
    target: { kind: "href", href: "/libraries", externalShell: false },
    source: "static",
    rank: {},
    scopeAffinity: ["library", "libraries"],
  },
  {
    id: "create-upload",
    title: "Upload file",
    keywords: ["pdf", "epub", "import", "add"],
    sectionId: "create",
    icon: Upload,
    target: { kind: "action", actionId: "add-content" },
    source: "static",
    rank: {},
    scopeAffinity: ["library", "libraries", "media"],
  },
  {
    id: "create-url",
    title: "Add from URL",
    keywords: ["link", "paste", "import"],
    sectionId: "create",
    icon: Link,
    target: { kind: "action", actionId: "add-content" },
    source: "static",
    rank: {},
    scopeAffinity: ["library", "libraries", "media"],
  },
  {
    id: "create-opml",
    title: "Import OPML",
    keywords: ["podcast", "opml", "import"],
    sectionId: "create",
    icon: Upload,
    target: { kind: "action", actionId: "add-opml" },
    source: "static",
    rank: {},
    scopeAffinity: ["library", "libraries", "podcasts", "podcastDetail"],
  },
];

const SEARCH_TYPE_ICON: Record<SearchType, PaletteCommand["icon"]> = {
  contributor: UserRound,
  media: Globe,
  podcast: Mic,
  content_chunk: FileText,
  page: FileText,
  note_block: FileText,
  message: MessageSquare,
};

const PANE_TYPE_LABELS = {
  libraries: "Libraries",
  library: "Library",
  media: "Media",
  conversations: "Chats",
  conversationNew: "New chat",
  conversation: "Chat",
  browse: "Browse",
  podcasts: "Podcasts",
  podcastDetail: "Podcast",
  search: "Search",
  author: "Author",
  notes: "Notes",
  page: "Page",
  note: "Note",
  daily: "Daily note",
  dailyDate: "Daily note",
  settings: "Settings",
  settingsBilling: "Billing",
  settingsReader: "Reader settings",
  settingsAppearance: "Appearance",
  settingsKeys: "API keys",
  settingsLocalVault: "Local vault",
  settingsIdentities: "Linked identities",
  settingsKeybindings: "Keybindings",
} as const satisfies Record<PaneRouteId, string>;

function yesterdayLocalDate(): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function commandsForPaneType(
  paneRouteId: PaneRouteId,
  paneRouteParams: Record<string, string>,
): PaletteCommand[] {
  switch (paneRouteId) {
    case "media": {
      const mediaId = paneRouteParams.id;
      if (!mediaId) return [];
      return [
        {
          id: "pane-media-open-chat",
          title: "Open chat about this",
          keywords: ["chat", "ask", "discuss"],
          sectionId: "in-this-pane",
          icon: MessageSquarePlus,
          target: {
            kind: "href",
            href: `/conversations/new?scope=media%3A${encodeURIComponent(mediaId)}`,
            externalShell: false,
          },
          source: "static",
          rank: {},
          scopeAffinity: ["media"],
        },
        {
          id: "pane-media-reader-settings",
          title: "Reader settings",
          keywords: ["typography", "font", "focus", "hyphenation"],
          sectionId: "in-this-pane",
          icon: Type,
          target: { kind: "href", href: "/settings/reader", externalShell: false },
          source: "static",
          rank: {},
          scopeAffinity: ["media"],
        },
      ];
    }
    case "library": {
      return [
        {
          id: "pane-library-add-content",
          title: "Add content",
          keywords: ["upload", "import", "add"],
          sectionId: "in-this-pane",
          icon: Upload,
          target: { kind: "action", actionId: "add-content" },
          source: "static",
          rank: {},
          scopeAffinity: ["library"],
        },
      ];
    }
    case "daily":
    case "dailyDate": {
      return [
        {
          id: "pane-daily-open-today",
          title: "Open today",
          keywords: ["daily", "today"],
          sectionId: "in-this-pane",
          icon: CalendarDays,
          target: { kind: "href", href: "/daily", externalShell: false },
          source: "static",
          rank: {},
          scopeAffinity: ["daily", "dailyDate"],
        },
        {
          id: "pane-daily-open-yesterday",
          title: "Open yesterday",
          keywords: ["daily", "yesterday"],
          sectionId: "in-this-pane",
          icon: CalendarDays,
          target: {
            kind: "href",
            href: `/daily/${yesterdayLocalDate()}`,
            externalShell: false,
          },
          source: "static",
          rank: {},
          scopeAffinity: ["daily", "dailyDate"],
        },
      ];
    }
    case "conversation":
    case "conversationNew": {
      const todayHref = `/daily/${todayLocalDate()}`;
      return [
        {
          id: "pane-conversation-quick-note-today",
          title: "Save snippet to today's note",
          keywords: ["capture", "journal"],
          sectionId: "in-this-pane",
          icon: FileText,
          target: { kind: "action", actionId: "quick-note" },
          source: "static",
          rank: {},
          scopeAffinity: ["conversation", "conversationNew"],
        },
        {
          id: "pane-conversation-open-today",
          title: "Open today's note",
          keywords: ["daily", "today"],
          sectionId: "in-this-pane",
          icon: CalendarDays,
          target: { kind: "href", href: todayHref, externalShell: false },
          source: "static",
          rank: {},
          scopeAffinity: ["conversation", "conversationNew"],
        },
      ];
    }
    case "page":
    case "note": {
      return [
        {
          id: "pane-note-open-today",
          title: "Open today's note",
          keywords: ["daily", "today"],
          sectionId: "in-this-pane",
          icon: CalendarDays,
          target: {
            kind: "href",
            href: `/daily/${todayLocalDate()}`,
            externalShell: false,
          },
          source: "static",
          rank: {},
          scopeAffinity: ["page", "note"],
        },
      ];
    }
    case "libraries":
    case "conversations":
    case "browse":
    case "podcasts":
    case "podcastDetail":
    case "search":
    case "author":
    case "notes":
    case "settings":
    case "settingsBilling":
    case "settingsReader":
    case "settingsAppearance":
    case "settingsKeys":
    case "settingsLocalVault":
    case "settingsIdentities":
    case "settingsKeybindings":
      return [];
  }
}

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

const ROMAN_VALUES: [number, string][] = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

function toRoman(value: number): string {
  let remaining = value;
  let result = "";
  for (const [amount, numeral] of ROMAN_VALUES) {
    while (remaining >= amount) {
      result += numeral;
      remaining -= amount;
    }
  }
  return result;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function matchesCommand(command: PaletteCommand, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  if (command.source === "search" || command.source === "ai") return true;
  if (command.title.toLowerCase().includes(normalized)) return true;
  return command.keywords.some((keyword) => keyword.toLowerCase().includes(normalized));
}

function getDestinationIcon(href: string): PaletteCommand["icon"] {
  const route = resolvePaneRoute(href);
  switch (route?.id) {
    case "libraries":
    case "library":
      return BookOpen;
    case "media":
      return FileText;
    case "browse":
      return Compass;
    case "conversations":
    case "conversation":
    case "conversationNew":
      return MessageSquare;
    case "podcasts":
    case "podcastDetail":
      return Mic;
    case "author":
      return UserRound;
    case "daily":
    case "dailyDate":
      return CalendarDays;
    case "notes":
    case "page":
    case "note":
      return FileText;
    case "search":
      return Search;
    case "settings":
    case "settingsBilling":
    case "settingsReader":
    case "settingsAppearance":
    case "settingsKeys":
    case "settingsLocalVault":
    case "settingsIdentities":
    case "settingsKeybindings":
      return Settings;
    default:
      return Globe;
  }
}

interface PaletteScope {
  paneRouteId: PaneRouteId;
  paneTitle: string;
  paneRouteParams: Record<string, string>;
}

export default function CommandPalette() {
  const feedback = useFeedback();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PaletteScope | null>(null);
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null);
  const [requestedCommandId, setRequestedCommandId] = useState<string | null>(null);
  const [keybindings, setKeybindings] = useState<Record<string, string>>({});
  const [historyRows, setHistoryRows] = useState<PaletteHistoryResponse["data"]["recent"]>([]);
  const [frecencyBoosts, setFrecencyBoosts] = useState<Map<string, number>>(new Map());
  const [oracleRows, setOracleRows] = useState<OracleReadingSummary[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResultRowViewModel[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const oracleFetchedAt = useRef(0);
  const {
    state: workspaceState,
    runtimeTitleByPaneId,
    activatePane,
    closePane,
    restorePane,
  } = useWorkspaceStore();

  const captureScope = useCallback((): PaletteScope | null => {
    const activePane = workspaceState.panes.find(
      (pane) => pane.id === workspaceState.activePaneId,
    );
    if (!activePane) return null;
    const route = resolvePaneRoute(activePane.href);
    if (route.id === "unsupported") return null;
    const { title } = resolveWorkspacePaneTitle(activePane, runtimeTitleByPaneId);
    return { paneRouteId: route.id, paneTitle: title, paneRouteParams: route.params };
  }, [runtimeTitleByPaneId, workspaceState.activePaneId, workspaceState.panes]);

  useEffect(() => {
    setKeybindings(loadKeybindings());
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const commandId = params.get("cmd");
    const shouldOpen = params.get("palette") === "1" || commandId !== null;
    if (!shouldOpen) return;

    setQuery(params.get("q") ?? "");
    setRequestedCommandId(commandId);
    setActiveCommandId(commandId);
    setScope(captureScope());
    setOpen(true);

    params.delete("palette");
    params.delete("q");
    params.delete("cmd");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [captureScope]);

  useEffect(() => {
    const handler = () => {
      setQuery("");
      setRequestedCommandId(null);
      setActiveCommandId(null);
      setScope(captureScope());
      setOpen(true);
    };
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handler);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handler);
  }, [captureScope]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (!open) return;
      const params = new URLSearchParams();
      const trimmed = query.trim();
      if (trimmed) params.set("query", trimmed);
      const path = params.size > 0 ? `/api/me/palette-history?${params.toString()}` : "/api/me/palette-history";
      void apiFetch<PaletteHistoryResponse>(path, {
        signal: controller.signal,
      })
        .then((response) => {
          setHistoryRows(response.data.recent);
          setFrecencyBoosts(new Map(Object.entries(response.data.frecency_boosts)));
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          setHistoryRows([]);
          setFrecencyBoosts(new Map());
        });
    }, 200);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    if (Date.now() - oracleFetchedAt.current < 5 * 60_000) return;

    void apiFetch<{ data: OracleReadingSummary[] } | OracleReadingSummary[]>("/api/oracle/readings")
      .then((response) => {
        oracleFetchedAt.current = Date.now();
        setOracleRows(Array.isArray(response) ? response : response.data);
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setOracleRows([]);
      });
  }, [open]);

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
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  const openPaneHrefs = useMemo(
    () => new Set(workspaceState.panes.map((pane) => pane.href)),
    [workspaceState.panes],
  );

  const commandsBeforeAi = useMemo<PaletteCommand[]>(() => {
    const commands: PaletteCommand[] = [];
    const normalizedQuery = query.trim().toLowerCase();

    for (const pane of workspaceState.panes) {
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
        rank: { scopeBoost: pane.id === workspaceState.activePaneId ? 300 : 0 },
      });
      commands.push({
        id: `pane-close-${pane.id}`,
        title: `Close ${title}`,
        keywords: ["tab", "pane", "close", pane.href],
        sectionId: "open-tabs",
        icon: X,
        target: { kind: "action", actionId: `pane-close:${pane.id}` },
        source: "workspace",
        rank: {},
      });
    }

    for (const row of historyRows) {
      if (openPaneHrefs.has(row.target_href)) continue;
      const resolved = resolvePaneRoute(row.target_href);
      const affinity = resolved.id === "unsupported" ? undefined : [resolved.id];
      commands.push({
        id: `recent-${row.target_key}`,
        title: row.title_snapshot,
        subtitle: row.target_href,
        keywords: [row.target_href],
        sectionId: "recent",
        icon: getDestinationIcon(row.target_href),
        target: { kind: "href", href: row.target_href, externalShell: false },
        source: "recent",
        rank: { frecencyBoost: frecencyBoosts.get(row.target_key) ?? 0 },
        scopeAffinity: affinity,
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

    const activePane =
      workspaceState.panes.find((pane) => pane.id === workspaceState.activePaneId) ?? null;
    const route = activePane ? resolvePaneRoute(activePane.href) : null;
    if (route?.id === "page" && route.params.pageId) {
      commands.push({
        id: "pin-current-page",
        title: "Pin current page",
        keywords: ["pin", "navbar", "notes"],
        sectionId: "create",
        icon: Pin,
        target: { kind: "action", actionId: `pin-page:${route.params.pageId}` },
        source: "workspace",
        rank: {},
        scopeAffinity: ["page"],
      });
    }
    if (route?.id === "note" && route.params.blockId) {
      commands.push({
        id: "pin-current-note",
        title: "Pin current note",
        keywords: ["pin", "navbar", "notes"],
        sectionId: "create",
        icon: Pin,
        target: { kind: "action", actionId: `pin-note:${route.params.blockId}` },
        source: "workspace",
        rank: {},
        scopeAffinity: ["note"],
      });
    }

    if (scope) {
      for (const command of commandsForPaneType(scope.paneRouteId, scope.paneRouteParams)) {
        commands.push(command);
      }
    }

    for (const result of searchResults) {
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
    frecencyBoosts,
    historyRows,
    keybindings,
    openPaneHrefs,
    oracleRows,
    query,
    runtimeTitleByPaneId,
    scope,
    searchResults,
    workspaceState.activePaneId,
    workspaceState.panes,
  ]);

  const askAiCommand = getAskAiFallbackCommand({
    query,
    localCommands: commandsBeforeAi.filter((command) => command.source !== "search"),
    canOpenConversation: true,
  });

  const ranked = rankPaletteCommands({
    query,
    commands: askAiCommand ? [...commandsBeforeAi, askAiCommand] : commandsBeforeAi,
    frecencyBoosts,
    currentWorkspaceHref:
      workspaceState.panes.find((pane) => pane.id === workspaceState.activePaneId)?.href ?? null,
    scopeFilter: scope?.paneRouteId ?? null,
  });

  const loadingSectionIds = searchLoading ? ["search-results"] : [];

  useEffect(() => {
    if (requestedCommandId === null) return;
    if (ranked.displayCommands.some((command) => command.id === requestedCommandId)) {
      setActiveCommandId(requestedCommandId);
      setRequestedCommandId(null);
      return;
    }
    setActiveCommandId(ranked.displayCommands[0]?.id ?? null);
    setRequestedCommandId(null);
  }, [ranked.displayCommands, requestedCommandId]);

  useEffect(() => {
    if (!open) return;
    if (requestedCommandId !== null) return;
    if (activeCommandId && ranked.displayCommands.some((command) => command.id === activeCommandId)) return;
    setActiveCommandId(ranked.displayCommands[0]?.id ?? null);
  }, [activeCommandId, open, ranked.displayCommands, requestedCommandId]);

  const executeCommand = useCallback(
    async (command: PaletteCommand) => {
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
          const pane = workspaceState.panes.find((item) => item.id === paneId);
          if (pane?.visibility === "minimized") {
            restorePane(paneId);
          } else {
            activatePane(paneId);
          }
          return;
        }
        if (actionId.startsWith("pane-close:")) {
          closePane(actionId.slice("pane-close:".length));
          return;
        }
        if (actionId.startsWith("pin-page:")) {
          await pinObjectToNavbar("page", actionId.slice("pin-page:".length));
          return;
        }
        if (actionId.startsWith("pin-note:")) {
          await pinObjectToNavbar("note_block", actionId.slice("pin-note:".length));
          return;
        }

        throw new Error(`Unknown command action: ${actionId}`);
      } catch (error) {
        feedback.show(toFeedback(error, { fallback: "Command failed" }));
      }
    },
    [activatePane, closePane, feedback, query, restorePane, workspaceState.panes],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const paletteCombo = keybindings["open-palette"];
      if (paletteCombo && matchesKeyEvent(paletteCombo, event)) {
        event.preventDefault();
        setQuery("");
        setRequestedCommandId(null);
        setActiveCommandId(null);
        if (open) {
          setScope(null);
          setOpen(false);
        } else {
          setScope(captureScope());
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
  }, [captureScope, executeCommand, keybindings, open]);

  return (
    <Palette
      open={open}
      query={query}
      sections={[
        sectionFor("top-result"),
        scope
          ? {
              id: "in-this-pane",
              label: `In this ${PANE_TYPE_LABELS[scope.paneRouteId].toLowerCase()}`,
              order: 5,
            }
          : sectionFor("in-this-pane"),
        sectionFor("search-results"),
        sectionFor("open-tabs"),
        sectionFor("recent"),
        sectionFor("recent-folios"),
        sectionFor("create"),
        sectionFor("navigate"),
        sectionFor("settings"),
        sectionFor("ask-ai"),
      ]}
      commands={ranked.displayCommands}
      activeCommandId={activeCommandId}
      loadingSectionIds={loadingSectionIds}
      searchPrefix={
        scope ? (
          <Chip
            removable
            onRemove={() => setScope(null)}
            data-testid="palette-scope-chip"
          >
            {`In: ${PANE_TYPE_LABELS[scope.paneRouteId]} — ${scope.paneTitle}`}
          </Chip>
        ) : null
      }
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setScope(null);
      }}
      onQueryChange={(nextQuery) => {
        setQuery(nextQuery);
        setRequestedCommandId(null);
      }}
      onActiveCommandChange={setActiveCommandId}
      onSelect={(command) => {
        void executeCommand(command);
      }}
      onEscape={() => {
        if (scope) {
          setScope(null);
          return true;
        }
        return false;
      }}
    />
  );
}
