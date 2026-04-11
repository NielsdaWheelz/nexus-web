"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./CommandPalette.module.css";

type Section = "Navigate" | "Create";

interface Action {
  id: string;
  label: string;
  keywords: string[];
  section: Section;
  execute: () => void;
}

const OPEN_UPLOAD_EVENT = "nexus:open-upload";
const OPEN_COMMAND_PALETTE_EVENT = "nexus:open-command-palette";

function dispatchOpenUpload() {
  window.dispatchEvent(new CustomEvent(OPEN_UPLOAD_EVENT));
}

const ACTIONS: Action[] = [
  // Navigate
  { id: "nav-libraries", label: "Libraries", keywords: ["collections", "sources"], section: "Navigate", execute: () => requestOpenInAppPane("/libraries") },
  { id: "nav-discover", label: "Discover", keywords: ["browse", "content", "lanes"], section: "Navigate", execute: () => requestOpenInAppPane("/discover") },
  { id: "nav-documents", label: "Documents", keywords: ["pdf", "epub", "articles"], section: "Navigate", execute: () => requestOpenInAppPane("/documents") },
  { id: "nav-podcasts", label: "Podcasts", keywords: ["audio", "feeds", "episodes"], section: "Navigate", execute: () => requestOpenInAppPane("/podcasts") },
  { id: "nav-videos", label: "Videos", keywords: ["youtube", "video"], section: "Navigate", execute: () => requestOpenInAppPane("/videos") },
  { id: "nav-chat", label: "Chat", keywords: ["conversations", "messages"], section: "Navigate", execute: () => requestOpenInAppPane("/conversations") },
  { id: "nav-search", label: "Search", keywords: ["find", "query"], section: "Navigate", execute: () => requestOpenInAppPane("/search") },
  { id: "nav-settings", label: "Settings", keywords: ["preferences", "account"], section: "Navigate", execute: () => requestOpenInAppPane("/settings") },
  { id: "nav-reader-settings", label: "Reader Settings", keywords: ["typography", "font", "theme"], section: "Navigate", execute: () => requestOpenInAppPane("/settings/reader") },
  { id: "nav-api-keys", label: "API Keys", keywords: ["credentials", "providers"], section: "Navigate", execute: () => requestOpenInAppPane("/settings/keys") },
  { id: "nav-identities", label: "Linked Identities", keywords: ["google", "github", "oauth"], section: "Navigate", execute: () => requestOpenInAppPane("/settings/identities") },

  // Create
  { id: "create-conversation", label: "New conversation", keywords: ["chat", "message"], section: "Create", execute: () => requestOpenInAppPane("/conversations/new") },
  { id: "create-library", label: "New library", keywords: ["collection", "create"], section: "Create", execute: () => requestOpenInAppPane("/libraries") },
  { id: "create-upload", label: "Upload file", keywords: ["pdf", "epub", "import", "add"], section: "Create", execute: dispatchOpenUpload },
  { id: "create-url", label: "Add from URL", keywords: ["link", "paste", "import"], section: "Create", execute: dispatchOpenUpload },
];

const SECTION_ORDER: Section[] = ["Create", "Navigate"];

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selectors = [
    "button:not([disabled])",
    "[href]",
    "input:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(container.querySelectorAll<HTMLElement>(selectors)).filter(
    (el) => !el.hasAttribute("hidden"),
  );
}

export { OPEN_UPLOAD_EVENT, OPEN_COMMAND_PALETTE_EVENT };

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const isMobile = useIsMobileViewport();

  // Cmd+K / Ctrl+K to toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => {
          if (!prev) {
            setQuery("");
            setActiveIndex(0);
          }
          return !prev;
        });
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

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

  const filtered = useMemo(() => {
    if (!query) return ACTIONS;
    const q = query.toLowerCase();
    return ACTIONS.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.keywords.some((k) => k.includes(q)),
    );
  }, [query]);

  const grouped = useMemo(() => {
    const groups: { section: Section; items: Action[] }[] = [];
    for (const section of SECTION_ORDER) {
      const items = filtered.filter((a) => a.section === section);
      if (items.length > 0) groups.push({ section, items });
    }
    return groups;
  }, [filtered]);

  const flatItems = useMemo(
    () => grouped.flatMap((g) => g.items),
    [grouped],
  );

  const close = useCallback(() => setOpen(false), []);

  const executeAction = useCallback(
    (action: Action) => {
      close();
      action.execute();
    },
    [close],
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
      {grouped.length === 0 && (
        <div className={styles.empty}>No matching commands</div>
      )}
      {grouped.map((group) => (
        <div key={group.section}>
          <div className={styles.sectionHeader} role="presentation">
            {group.section}
          </div>
          {group.items.map((action) => {
            const idx = itemIndex++;
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
                {action.label}
              </div>
            );
          })}
        </div>
      ))}
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
