"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
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

export { OPEN_UPLOAD_EVENT };

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Focus input when opening
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!query) return ACTIONS;
    const q = query.toLowerCase();
    return ACTIONS.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.keywords.some((k) => k.includes(q)),
    );
  }, [query]);

  // Group by section in display order
  const grouped = useMemo(() => {
    const groups: { section: Section; items: Action[] }[] = [];
    for (const section of SECTION_ORDER) {
      const items = filtered.filter((a) => a.section === section);
      if (items.length > 0) groups.push({ section, items });
    }
    return groups;
  }, [filtered]);

  // Flat list for arrow-key indexing
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

  // Reset active index when filter changes
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector(`[data-index="${activeIndex}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  let itemIndex = 0;

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
      </div>
    </div>
  );
}
