"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Compass,
  FileText,
  FolderPlus,
  Globe,
  Highlighter,
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
  Video,
  X,
} from "lucide-react";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { resolvePaneDescriptor } from "@/lib/workspace/paneDescriptor";
import { apiFetch } from "@/lib/api/client";
import {
  type SearchResponseShape,
  type SearchResultRowViewModel,
  type SearchType,
  ALL_SEARCH_TYPES,
  buildSearchQueryParams,
  normalizeSearchResult,
  adaptSearchResultRow,
} from "@/lib/search/resultRowAdapter";
import {
  loadKeybindings,
  matchesKeyEvent,
  formatKeyCombo,
} from "@/lib/keybindings";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { getFocusableElements } from "@/lib/ui/getFocusableElements";
import styles from "./CommandPalette.module.css";

type Section = "Recent" | "Panes" | "Create" | "Navigate" | "Search Results";

interface Action {
  id: string;
  label: string;
  keywords: string[];
  section: Section;
  icon: LucideIcon;
  execute: () => void;
}

const OPEN_UPLOAD_EVENT = "nexus:open-upload";
const OPEN_COMMAND_PALETTE_EVENT = "nexus:open-command-palette";

const RECENT_STORAGE_KEY = "nexus.commandPalette.recent.v1";
const MAX_RECENT = 8;

function dispatchOpenUpload() {
  window.dispatchEvent(new CustomEvent(OPEN_UPLOAD_EVENT));
}

const ACTIONS: Action[] = [
  // Navigate
  { id: "nav-libraries", label: "Libraries", keywords: ["collections", "sources"], section: "Navigate", icon: BookOpen, execute: () => requestOpenInAppPane("/libraries") },
  { id: "nav-discover", label: "Discover", keywords: ["browse", "content", "lanes"], section: "Navigate", icon: Compass, execute: () => requestOpenInAppPane("/discover") },
  { id: "nav-documents", label: "Documents", keywords: ["pdf", "epub", "articles"], section: "Navigate", icon: FileText, execute: () => requestOpenInAppPane("/documents") },
  { id: "nav-podcasts", label: "Podcasts", keywords: ["audio", "feeds", "episodes"], section: "Navigate", icon: Mic, execute: () => requestOpenInAppPane("/podcasts") },
  { id: "nav-videos", label: "Videos", keywords: ["youtube", "video"], section: "Navigate", icon: Video, execute: () => requestOpenInAppPane("/videos") },
  { id: "nav-chat", label: "Chat", keywords: ["conversations", "messages"], section: "Navigate", icon: MessageSquare, execute: () => requestOpenInAppPane("/conversations") },
  { id: "nav-search", label: "Search", keywords: ["find", "query"], section: "Navigate", icon: Search, execute: () => requestOpenInAppPane("/search") },
  { id: "nav-settings", label: "Settings", keywords: ["preferences", "account"], section: "Navigate", icon: Settings, execute: () => requestOpenInAppPane("/settings") },
  { id: "nav-reader-settings", label: "Reader Settings", keywords: ["typography", "font", "theme"], section: "Navigate", icon: Type, execute: () => requestOpenInAppPane("/settings/reader") },
  { id: "nav-api-keys", label: "API Keys", keywords: ["credentials", "providers"], section: "Navigate", icon: KeyRound, execute: () => requestOpenInAppPane("/settings/keys") },
  { id: "nav-identities", label: "Linked Identities", keywords: ["google", "github", "oauth"], section: "Navigate", icon: Link2, execute: () => requestOpenInAppPane("/settings/identities") },
  { id: "nav-keybindings", label: "Keyboard Shortcuts", keywords: ["keybindings", "hotkeys", "shortcuts"], section: "Navigate", icon: Keyboard, execute: () => requestOpenInAppPane("/settings/keybindings") },

  // Create
  { id: "create-conversation", label: "New conversation", keywords: ["chat", "message"], section: "Create", icon: MessageSquarePlus, execute: () => requestOpenInAppPane("/conversations/new") },
  { id: "create-library", label: "New library", keywords: ["collection", "create"], section: "Create", icon: FolderPlus, execute: () => requestOpenInAppPane("/libraries") },
  { id: "create-upload", label: "Upload file", keywords: ["pdf", "epub", "import", "add"], section: "Create", icon: Upload, execute: dispatchOpenUpload },
  { id: "create-url", label: "Add from URL", keywords: ["link", "paste", "import"], section: "Create", icon: Link, execute: dispatchOpenUpload },
];

const ACTIONS_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
const SECTION_ORDER: Section[] = ["Recent", "Panes", "Create", "Navigate", "Search Results"];

const SEARCH_TYPE_ICON: Record<SearchType, LucideIcon> = {
  media: Globe,
  fragment: FileText,
  annotation: Highlighter,
  message: MessageSquare,
  transcript_chunk: Mic,
};

function loadRecentIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveRecentIds(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(ids));
  } catch { /* quota or private mode — ignore */ }
}

function pushRecent(ids: string[], actionId: string): string[] {
  const next = [actionId, ...ids.filter((id) => id !== actionId)];
  return next.slice(0, MAX_RECENT);
}

export { OPEN_UPLOAD_EVENT, OPEN_COMMAND_PALETTE_EVENT };

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>([]);
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
    openHintByPaneId,
    resourceTitleByRef,
    activatePane,
  } = useWorkspaceStore();

  // Load recent IDs and keybindings on mount
  useEffect(() => {
    setRecentIds(loadRecentIds());
    setKeybindings(loadKeybindings());
  }, []);

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
            setActiveIndex(0);
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
            const next = pushRecent(recentIds, actionId);
            setRecentIds(next);
            saveRecentIds(next);
            action.execute();
          }
          return;
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [keybindings, recentIds]);

  // External open trigger (mobile Search button)
  useEffect(() => {
    const handler = () => {
      setQuery("");
      setActiveIndex(0);
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
  useEffect(() => {
    if (!isMobile || !open || !sheetRef.current) return;
    const sheet = sheetRef.current;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const els = getFocusableElements(sheet);
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement;
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, open]);

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
    searchTimerRef.current = setTimeout(async () => {
      try {
        const params = buildSearchQueryParams({
          query: q,
          selectedTypes: new Set(ALL_SEARCH_TYPES),
          limit: 5,
          cursor: null,
        });
        const response = await apiFetch<SearchResponseShape>(
          `/api/search?${params.toString()}`,
        );
        const valid = response.results
          .map((r) => normalizeSearchResult(r))
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .map((r) => adaptSearchResultRow(r));
        setSearchResults(valid);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query]);

  // Filter static actions
  const filtered = useMemo(() => {
    if (!query) return ACTIONS;
    const q = query.toLowerCase();
    return ACTIONS.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.keywords.some((k) => k.includes(q)),
    );
  }, [query]);

  // Build recent actions (only when no query)
  const recentActions = useMemo(() => {
    if (query) return [];
    return recentIds
      .map((id) => ACTIONS_BY_ID.get(id))
      .filter((a): a is Action => a !== undefined)
      .map((a) => ({ ...a, section: "Recent" as Section }));
  }, [query, recentIds]);

  // Build pane-switching actions from workspace state
  const paneActions: Action[] = useMemo(() => {
    const panes = workspaceState.panes.map((pane) => {
      const descriptor = resolvePaneDescriptor(pane, {
        nowMs: Date.now(),
        runtimeTitleByPaneId,
        openHintByPaneId,
        resourceTitleByRef,
      });
      return {
        id: `pane-${pane.id}`,
        label: descriptor.resolvedTitle,
        keywords: ["tab", "pane", "switch"],
        section: "Panes" as Section,
        icon: PanelLeft,
        execute: () => activatePane(pane.id),
      };
    });
    if (!query) return panes;
    const q = query.toLowerCase();
    return panes.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.keywords.some((k) => k.includes(q)),
    );
  }, [workspaceState.panes, runtimeTitleByPaneId, openHintByPaneId, resourceTitleByRef, activatePane, query]);

  // Build search result actions
  const searchActions: Action[] = useMemo(
    () =>
      searchResults.map((r) => ({
        id: `search-${r.key}`,
        label: r.primaryText,
        keywords: [],
        section: "Search Results" as Section,
        icon: SEARCH_TYPE_ICON[r.type],
        execute: () => requestOpenInAppPane(r.href),
      })),
    [searchResults],
  );

  // Group by section in display order
  const grouped = useMemo(() => {
    const allItems = [...recentActions, ...paneActions, ...filtered, ...searchActions];
    const groups: { section: Section; items: Action[] }[] = [];
    for (const section of SECTION_ORDER) {
      const items = allItems.filter((a) => a.section === section);
      if (items.length > 0) groups.push({ section, items });
    }
    return groups;
  }, [recentActions, paneActions, filtered, searchActions]);

  const flatItems = useMemo(
    () => grouped.flatMap((g) => g.items),
    [grouped],
  );

  const close = useCallback(() => setOpen(false), []);

  const executeAction = useCallback(
    (action: Action) => {
      // Track in recents (only for static actions, not search results)
      if (ACTIONS_BY_ID.has(action.id)) {
        const next = pushRecent(recentIds, action.id);
        setRecentIds(next);
        saveRecentIds(next);
      }
      close();
      action.execute();
    },
    [close, recentIds],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = flatItems[activeIndex];
        if (item) executeAction(item);
      }
    },
    [activeIndex, close, executeAction, flatItems],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector(`[data-index="${activeIndex}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  let itemIndex = 0;

  const listContent = (
    <div
      ref={listRef}
      id="command-palette-list"
      className={styles.list}
      role="listbox"
    >
      {grouped.length === 0 && !searchLoading && (
        <div className={styles.empty}>No matching commands</div>
      )}
      {grouped.map((group) => (
        <div key={group.section}>
          <div className={styles.sectionHeader} role="presentation">
            {group.section}
          </div>
          {group.items.map((action) => {
            const idx = itemIndex++;
            const Icon = action.icon;
            const combo = keybindings[action.id];
            const searchVm = action.id.startsWith("search-")
              ? searchResults.find((r) => `search-${r.key}` === action.id)
              : null;
            return (
              <div
                key={action.id}
                id={`cmd-${action.id}`}
                className={`${styles.item} ${idx === activeIndex ? styles.active : ""}`}
                role="option"
                aria-selected={idx === activeIndex}
                data-index={idx}
                onClick={() => executeAction(action)}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                <span className={styles.itemLabel}>
                  <Icon size={16} aria-hidden="true" />
                  {action.label}
                  {searchVm && (
                    <span className={styles.searchResultMeta}>{searchVm.typeLabel}</span>
                  )}
                </span>
                {combo && (
                  <span className={styles.shortcutHint}>{formatKeyCombo(combo)}</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {searchLoading && (
        <div className={styles.searchingIndicator}>Searching...</div>
      )}
    </div>
  );

  const inputElement = (
    <input
      ref={inputRef}
      type="text"
      className={styles.input}
      placeholder="Type a command..."
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      aria-label="Filter commands"
      aria-activedescendant={
        flatItems[activeIndex]
          ? `cmd-${flatItems[activeIndex].id}`
          : undefined
      }
      role="combobox"
      aria-expanded="true"
      aria-controls="command-palette-list"
      aria-autocomplete="list"
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
          aria-label="Command palette"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <div className={styles.mobileHandle} aria-hidden="true" />
          <header className={styles.mobileHeader}>
            <h2>Commands</h2>
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
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {inputElement}
        {listContent}
      </div>
    </div>
  );
}
