"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
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
  Search,
  Settings,
  Type,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import {
  resolveWorkspacePaneTitle,
  useWorkspaceStore,
} from "@/lib/workspace/store";
import {
  dispatchOpenAddContent,
} from "@/components/addContentEvents";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { apiFetch } from "@/lib/api/client";
import {
  type SearchResultRowViewModel,
  type SearchType,
  ALL_SEARCH_TYPES,
  fetchSearchResultPage,
} from "@/lib/search/resultRowAdapter";
import {
  loadKeybindings,
  matchesKeyEvent,
  formatKeyCombo,
} from "@/lib/keybindings";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import styles from "./CommandPalette.module.css";

type Section = "Open tabs" | "Recent" | "Create" | "Navigate" | "Settings" | "Search results";

interface Action {
  id: string;
  label: string;
  keywords: string[];
  section: Section;
  icon: LucideIcon;
  execute: () => void;
  meta?: string;
  paneId?: string;
  paneVisibility?: "visible" | "minimized";
}

interface CommandPaletteRecentRow {
  href: string;
  title_snapshot: string | null;
  last_used_at: string;
}

const ACTIONS: Action[] = [
  // Navigate
  { id: "nav-libraries", label: "Libraries", keywords: ["collections", "sources"], section: "Navigate", icon: BookOpen, execute: () => requestOpenInAppPane("/libraries") },
  { id: "nav-browse", label: "Browse", keywords: ["discover", "podcasts", "videos", "documents"], section: "Navigate", icon: Compass, execute: () => requestOpenInAppPane("/browse") },
  { id: "nav-podcasts", label: "Podcasts", keywords: ["audio", "feeds", "episodes"], section: "Navigate", icon: Mic, execute: () => requestOpenInAppPane("/podcasts") },
  { id: "nav-chats", label: "Chats", keywords: ["conversations", "messages"], section: "Navigate", icon: MessageSquare, execute: () => requestOpenInAppPane("/conversations") },
  { id: "nav-search", label: "Search", keywords: ["find", "query"], section: "Navigate", icon: Search, execute: () => requestOpenInAppPane("/search") },
  { id: "nav-settings", label: "Settings", keywords: ["preferences", "account"], section: "Navigate", icon: Settings, execute: () => requestOpenInAppPane("/settings") },
  { id: "nav-reader-settings", label: "Reader Settings", keywords: ["typography", "font", "theme"], section: "Settings", icon: Type, execute: () => requestOpenInAppPane("/settings/reader") },
  { id: "nav-api-keys", label: "API Keys", keywords: ["credentials", "providers"], section: "Settings", icon: KeyRound, execute: () => requestOpenInAppPane("/settings/keys") },
  { id: "nav-identities", label: "Linked Identities", keywords: ["google", "github", "oauth"], section: "Settings", icon: Link2, execute: () => requestOpenInAppPane("/settings/identities") },
  { id: "nav-keybindings", label: "Keyboard Shortcuts", keywords: ["keybindings", "hotkeys", "shortcuts"], section: "Settings", icon: Keyboard, execute: () => requestOpenInAppPane("/settings/keybindings") },

  // Create
  { id: "create-conversation", label: "New conversation", keywords: ["chat", "message"], section: "Create", icon: MessageSquarePlus, execute: () => requestOpenInAppPane("/conversations/new") },
  { id: "open-notes", label: "Open notes", keywords: ["notes", "page", "outline"], section: "Navigate", icon: FileText, execute: () => requestOpenInAppPane("/notes") },
  { id: "create-library", label: "New library", keywords: ["collection", "create"], section: "Create", icon: FolderPlus, execute: () => requestOpenInAppPane("/libraries") },
  { id: "create-upload", label: "Upload file", keywords: ["pdf", "epub", "import", "add"], section: "Create", icon: Upload, execute: () => dispatchOpenAddContent("content") },
  { id: "create-url", label: "Add from URL", keywords: ["link", "paste", "import"], section: "Create", icon: Link, execute: () => dispatchOpenAddContent("content") },
  { id: "create-opml", label: "Import OPML", keywords: ["podcast", "opml", "import"], section: "Create", icon: Upload, execute: () => dispatchOpenAddContent("opml") },
];

const ACTIONS_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

const SEARCH_TYPE_ICON: Record<SearchType, LucideIcon> = {
  contributor: UserRound,
  media: Globe,
  podcast: Mic,
  content_chunk: FileText,
  page: FileText,
  note_block: FileText,
  message: MessageSquare,
};
const EMPTY_RUNTIME_TITLE_BY_PANE_ID = new Map<string, string>();

function getRecentDestinationIcon(routeId: string): LucideIcon {
  switch (routeId) {
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
    case "search":
      return Search;
    case "settings":
    case "settingsBilling":
    case "settingsReader":
    case "settingsKeys":
    case "settingsLocalVault":
    case "settingsIdentities":
    case "settingsKeybindings":
      return Settings;
    default:
      return Globe;
  }
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recentRows, setRecentRows] = useState<CommandPaletteRecentRow[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResultRowViewModel[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [keybindings, setKeybindings] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMobile = useIsMobileViewport();
  const {
    state: workspaceState,
    runtimeTitleByPaneId,
    activatePane,
    closePane,
    restorePane,
  } = useWorkspaceStore();

  // Load keybindings on mount
  useEffect(() => {
    setKeybindings(loadKeybindings());
  }, []);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    void (async () => {
      try {
        const response = await apiFetch<{ data: CommandPaletteRecentRow[] }>(
          "/api/me/command-palette-recents"
        );
        if (!cancelled) {
          setRecentRows(Array.isArray(response.data) ? response.data : []);
        }
      } catch {
        if (!cancelled) {
          setRecentRows([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Global keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check palette toggle binding (default: Cmd+K / Ctrl+K)
      const paletteCombo = keybindings["open-palette"];
      if (paletteCombo && matchesKeyEvent(paletteCombo, e)) {
        e.preventDefault();
        setOpen((prev) => {
          if (!prev) {
            setQuery("");
          }
          return !prev;
        });
        return;
      }

      // Check action-specific bindings
      for (const [actionId, combo] of Object.entries(keybindings)) {
        if (actionId === "open-palette") continue;
        if (matchesKeyEvent(combo, e)) {
          e.preventDefault();
          const action = ACTIONS_BY_ID.get(actionId);
          if (action) {
            action.execute();
          }
          return;
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [keybindings]);

  // External open trigger (mobile Search button)
  useEffect(() => {
    const handler = () => {
      setQuery("");
      setOpen(true);
    };
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handler);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handler);
  }, []);

  // Focus input when opening
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Mobile: lock scroll
  useEffect(() => {
    if (!isMobile || !open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isMobile, open]);

  // Mobile: focus trap
  useFocusTrap(sheetRef, isMobile && open);

  // Debounced backend search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (query.trim().length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    const q = query.trim();
    let cancelled = false;
    searchTimerRef.current = setTimeout(async () => {
      try {
        const page = await fetchSearchResultPage({
          query: q,
          selectedTypes: new Set(ALL_SEARCH_TYPES),
          limit: 5,
          cursor: null,
        });
        if (!cancelled) {
          setSearchResults(page.rows);
        }
      } catch {
        if (!cancelled) {
          setSearchResults([]);
        }
      } finally {
        if (!cancelled) {
          setSearchLoading(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query]);

  const normalizedQuery = query.trim().toLowerCase();

  const createActions = useMemo(() => {
    const actions = ACTIONS.filter((action) => action.section === "Create");
    if (!normalizedQuery) return actions;
    return actions.filter(
      (action) =>
        action.label.toLowerCase().includes(normalizedQuery) ||
        action.keywords.some((keyword) => keyword.includes(normalizedQuery)),
    );
  }, [normalizedQuery]);

  const navigateActions = useMemo(() => {
    const actions = ACTIONS.filter((action) => action.section === "Navigate");
    if (!normalizedQuery) return actions;
    return actions.filter(
      (action) =>
        action.label.toLowerCase().includes(normalizedQuery) ||
        action.keywords.some((keyword) => keyword.includes(normalizedQuery)),
    );
  }, [normalizedQuery]);

  const settingsActions = useMemo(() => {
    const actions = ACTIONS.filter((action) => action.section === "Settings");
    if (!normalizedQuery) return actions;
    return actions.filter(
      (action) =>
        action.label.toLowerCase().includes(normalizedQuery) ||
        action.keywords.some((keyword) => keyword.includes(normalizedQuery)),
    );
  }, [normalizedQuery]);

  const openPaneHrefs = useMemo(
    () => new Set(workspaceState.panes.map((pane) => pane.href)),
    [workspaceState.panes],
  );

  // Build recent actions
  const recentActions = useMemo(() => {
    return recentRows.flatMap((row) => {
      if (openPaneHrefs.has(row.href)) return [];
      const descriptor = resolveWorkspacePaneTitle(
        { id: row.href, href: row.href },
        EMPTY_RUNTIME_TITLE_BY_PANE_ID
      );
      const label = row.title_snapshot?.trim() || descriptor.title;
      if (
        normalizedQuery &&
        !label.toLowerCase().includes(normalizedQuery) &&
        !row.href.toLowerCase().includes(normalizedQuery)
      ) {
        return [];
      }
      return [{
        id: `recent-${encodeURIComponent(row.href)}`,
        label,
        keywords: [row.href],
        section: "Recent" as Section,
        icon: getRecentDestinationIcon(descriptor.route.id),
        execute: () =>
          requestOpenInAppPane(row.href, {
            titleHint: row.title_snapshot ?? undefined,
          }),
      }];
    });
  }, [normalizedQuery, openPaneHrefs, recentRows]);

  // Build pane-switching actions from workspace state
  const paneActions: Action[] = useMemo(() => {
    const panes = workspaceState.panes.map((pane) => {
      const { title } = resolveWorkspacePaneTitle(pane, runtimeTitleByPaneId);
      return {
        id: `pane-${pane.id}`,
        label: title,
        keywords:
          pane.visibility === "minimized"
            ? ["tab", "pane", "switch", "restore", "minimized"]
            : ["tab", "pane", "switch"],
        section: "Open tabs" as Section,
        icon: PanelLeft,
        execute: () => {
          switch (pane.visibility) {
            case "visible":
              activatePane(pane.id);
              return;
            case "minimized":
              restorePane(pane.id);
              return;
          }
          const exhaustiveVisibility: never = pane.visibility;
          return exhaustiveVisibility;
        },
        paneId: pane.id,
        paneVisibility: pane.visibility,
      };
    });
    if (!normalizedQuery) return panes;
    return panes.filter(
      (action) =>
        action.label.toLowerCase().includes(normalizedQuery) ||
        action.keywords.some((keyword) => keyword.includes(normalizedQuery)),
    );
  }, [workspaceState.panes, runtimeTitleByPaneId, activatePane, restorePane, normalizedQuery]);

  // Build search result actions
  const searchActions: Action[] = useMemo(
    () =>
      searchResults.map((result) => ({
        id: `search-${result.key}`,
        label: result.primaryText,
        keywords: [],
        section: "Search results" as Section,
        icon: SEARCH_TYPE_ICON[result.type],
        meta: result.typeLabel,
        execute: () => requestOpenInAppPane(result.href),
      })),
    [searchResults],
  );

  const firstVisibleAction = normalizedQuery
    ? paneActions[0] ??
      searchActions[0] ??
      recentActions[0] ??
      createActions[0] ??
      navigateActions[0] ??
      settingsActions[0]
    : paneActions[0] ??
      recentActions[0] ??
      createActions[0] ??
      navigateActions[0] ??
      settingsActions[0];

  const hasVisibleActions =
    paneActions.length > 0 ||
    searchActions.length > 0 ||
    recentActions.length > 0 ||
    createActions.length > 0 ||
    navigateActions.length > 0 ||
    settingsActions.length > 0;

  const close = useCallback(() => setOpen(false), []);

  const executeAction = useCallback(
    (action: Action) => {
      close();
      action.execute();
    },
    [close],
  );

  const focusAdjacentCommand = useCallback((current: HTMLElement, offset: number) => {
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-command-palette-primary='true']") ?? []
    );
    const index = buttons.indexOf(current);
    if (index < 0) return;
    buttons[Math.max(0, Math.min(buttons.length - 1, index + offset))]?.focus();
  }, []);

  const handleCommandButtonKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusAdjacentCommand(event.currentTarget, 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusAdjacentCommand(event.currentTarget, -1);
        return;
      }
    },
    [focusAdjacentCommand],
  );

  const handleDialogKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    },
    [close],
  );

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        listRef.current
          ?.querySelector<HTMLElement>("[data-command-palette-primary='true']")
          ?.focus();
        return;
      }
      if (event.key === "Enter" && normalizedQuery && firstVisibleAction) {
        event.preventDefault();
        executeAction(firstVisibleAction);
      }
    },
    [executeAction, firstVisibleAction, normalizedQuery],
  );

  const renderSection = (section: Section, actions: Action[], searching: boolean) => {
    if (actions.length === 0 && !searching) return null;
    const sectionId = `command-palette-${section.toLowerCase().replace(/\s+/g, "-")}`;
    return (
      <section key={section} className={styles.section} aria-labelledby={sectionId}>
        <h3 id={sectionId} className={styles.sectionHeader}>
          {section}
        </h3>
        {actions.map((action) => {
          const Icon = action.icon;
          const combo = keybindings[action.id];
          const isPane = action.paneId != null;
          const isCurrentPane = action.id === `pane-${workspaceState.activePaneId}`;
          const isMinimizedPane = action.paneVisibility === "minimized";
          return (
            <div key={action.id} className={styles.row}>
              <button
                type="button"
                className={styles.item}
                data-command-palette-primary="true"
                onClick={() => executeAction(action)}
                onKeyDown={handleCommandButtonKeyDown}
              >
                <span className={styles.itemLabel}>
                  <Icon size={16} aria-hidden="true" />
                  <span className={styles.itemText}>{action.label}</span>
                  {action.meta && (
                    <span className={styles.searchResultMeta}>{action.meta}</span>
                  )}
                </span>
                <span className={styles.itemTrailing}>
                  {isCurrentPane && (
                    <span className={styles.currentBadge}>Current</span>
                  )}
                  {isMinimizedPane && (
                    <span className={styles.minimizedBadge}>Minimized</span>
                  )}
                  {combo && (
                    <span className={styles.shortcutHint}>{formatKeyCombo(combo)}</span>
                  )}
                </span>
              </button>
              {isPane && (
                <button
                  type="button"
                  className={styles.paneClose}
                  aria-label={`Close ${action.label}`}
                  onClick={() => {
                    if (action.paneId) {
                      closePane(action.paneId);
                    }
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
        {searching && (
          <div className={styles.searchingIndicator}>Searching...</div>
        )}
      </section>
    );
  };

  if (!open) return null;

  const listContent = (
    <div
      ref={listRef}
      id="command-palette-list"
      className={styles.list}
    >
      {!hasVisibleActions && !searchLoading && (
        <div className={styles.empty}>No matching commands</div>
      )}
      {renderSection("Open tabs", paneActions, false)}
      {normalizedQuery ? renderSection("Search results", searchActions, searchLoading) : null}
      {renderSection("Recent", recentActions, false)}
      {renderSection("Create", createActions, false)}
      {renderSection("Navigate", navigateActions, false)}
      {renderSection("Settings", settingsActions, false)}
    </div>
  );

  const inputElement = (
    <input
      ref={inputRef}
      type="text"
      className={styles.input}
      placeholder="Search or run an action..."
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={handleInputKeyDown}
      aria-label="Search actions"
      aria-controls="command-palette-list"
    />
  );

  if (isMobile) {
    return (
      <div className={styles.mobileBackdrop} onClick={close}>
        <section
          ref={sheetRef}
          className={styles.mobileSheet}
          role="dialog"
          aria-modal="true"
          aria-label="Search"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleDialogKeyDown}
        >
          <header className={styles.mobileHeader}>
            <h2>Search</h2>
            <button
              type="button"
              className={styles.mobileClose}
              onClick={close}
              aria-label="Close"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          {inputElement}
          {listContent}
        </section>
      </div>
    );
  }

  return (
    <div className={styles.backdrop} onClick={close}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        {inputElement}
        {listContent}
      </div>
    </div>
  );
}
