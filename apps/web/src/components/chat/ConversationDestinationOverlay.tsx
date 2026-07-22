"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import MobileSheet from "@/components/ui/MobileSheet";
import type { ApiPath } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { useCursorPagination, type CursorPage } from "@/lib/api/useCursorPagination";
import { formatDisplayNumber, formatRelativeTime } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { ConversationListItem } from "@/lib/conversations/types";
import styles from "./ConversationDestinationOverlay.module.css";

const OVERLAY_TITLE = "Ask in existing chat";
const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 200;

export interface ConversationDestinationOverlayProps {
  /** Mount-gate; keep the component mounted and drive open/close with this. */
  open: boolean;
  /** Escape / backdrop / Back / close button — dismiss, returning focus to the reader. */
  onClose: () => void;
  /** A row was picked. The caller navigates to that conversation and claims focus. */
  onSelectConversation: (conversationId: string) => void;
}

/**
 * The "Ask in existing chat…" destination picker (reader-highlight-quote-chat
 * cutover §Destination picker). It resolves *which* owned conversation the reader
 * quote should go into — it never creates or mutates a conversation. Desktop rides
 * the shared `Dialog`; mobile the always-mounted `MobileSheet`, chosen by
 * `useIsMobileViewport`. The search field is a combobox over a listbox of recent
 * owned conversations (`GET /api/conversations`, cursor-paginated), following the
 * shared combobox contract cloned from `AuthorSearchField`: `role="combobox"` with
 * `aria-controls`/`aria-activedescendant`, Arrow/Home/End/Enter, non-tabbable rows,
 * and polite result-count announcements.
 *
 * A successful pick closes WITHOUT returning focus to the reader — the destination
 * pane claims it — via the `skipReturnFocus` handoff. Every dismissal path keeps the
 * default return-focus.
 */
export default function ConversationDestinationOverlay({
  open,
  onClose,
  onSelectConversation,
}: ConversationDestinationOverlayProps) {
  const isMobile = useIsMobileViewport();
  // Read at close time: true only for a successful pick, so the picker keeps the
  // opener's return-focus for Escape/backdrop/Back but yields it on selection.
  const skipReturnRef = useRef(false);
  useEffect(() => {
    if (open) skipReturnRef.current = false;
  }, [open]);

  const handleSelect = useCallback(
    (conversationId: string) => {
      skipReturnRef.current = true;
      onSelectConversation(conversationId);
      onClose();
    },
    [onSelectConversation, onClose],
  );

  const focusSearchField = useCallback(
    (container: HTMLElement) =>
      container.querySelector<HTMLInputElement>('input[role="combobox"]'),
    [],
  );

  const body = <DestinationPicker onSelect={handleSelect} />;

  if (isMobile) {
    return (
      <MobileSheet
        active={open}
        onDismiss={onClose}
        ariaLabel={OVERLAY_TITLE}
        initialFocus={focusSearchField}
        skipReturnFocus={() => skipReturnRef.current}
        backdropTestId="ask-existing-chat-backdrop"
      >
        <div className={styles.sheetHeader}>
          <h2 className={styles.sheetTitle}>{OVERLAY_TITLE}</h2>
        </div>
        {body}
      </MobileSheet>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={OVERLAY_TITLE}
      initialFocus={focusSearchField}
      skipReturnFocus={() => skipReturnRef.current}
    >
      {body}
    </Dialog>
  );
}

function messageCountLabel(
  count: number,
  context: Parameters<typeof formatDisplayNumber>[1],
): string {
  return count === 1 ? "1 message" : `${formatDisplayNumber(count, context)} messages`;
}

function conversationTitle(item: ConversationListItem): string {
  const trimmed = item.title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled chat";
}

function buildListHref(query: string, cursor: string | null): ApiPath {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (query) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  return `/api/conversations?${params.toString()}` as ApiPath;
}

/**
 * The self-contained search + results body. Mounted only while the overlay is open
 * (both hosts unmount their children on close), so it starts fresh each time.
 */
function DestinationPicker({ onSelect }: { onSelect: (conversationId: string) => void }) {
  const env = useRenderEnvironment();
  const now = useMemo(() => new Date(env.currentInstant), [env.currentInstant]);

  const id = useId();
  const inputId = `${id}-input`;
  const listboxId = `${id}-listbox`;
  const statusId = `${id}-status`;
  const optionId = (conversationId: string) => `${id}-option-${conversationId}`;

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  // Debounce the trimmed query. The initial empty query is already committed, so
  // the recent-conversations page loads immediately; only edits wait out the delay.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === debouncedQuery) return;
    const timer = setTimeout(() => setDebouncedQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, debouncedQuery]);

  const firstPage = useResource<CursorPage<ConversationListItem>>({
    cacheKey: `conversation-destination:${debouncedQuery}`,
    path: () => buildListHref(debouncedQuery, null),
  });
  const { items, status, error, hasMore, loadingMore, loadMore, retry } =
    useCursorPagination<ConversationListItem>({
      firstPage,
      buildMoreHref: (cursor) => buildListHref(debouncedQuery, cursor),
    });

  // Effective active row derived during render (never via an effect) so an in-flight
  // Arrow move is never clobbered: an explicit `activeId` wins while it still points
  // at a live row, otherwise the first row is active by default.
  const effectiveActiveId =
    activeId && items.some((item) => item.id === activeId)
      ? activeId
      : (items[0]?.id ?? null);

  const isSearch = debouncedQuery.length > 0;
  const politeStatus =
    status === "loading"
      ? "Searching…"
      : status === "error"
        ? ""
        : items.length === 0
          ? isSearch
            ? "No chats match your search"
            : "No chats yet"
          : items.length === 1
            ? "1 chat"
            : `${formatDisplayNumber(items.length, env)} chats`;
  const assertiveStatus = status === "error" ? "Couldn't load chats" : "";

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (status === "error") {
        retry();
        return;
      }
      if (effectiveActiveId) onSelect(effectiveActiveId);
      return;
    }
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      if (items.length === 0) return;
      const current = items.findIndex((item) => item.id === effectiveActiveId);
      const start = current >= 0 ? current : 0;
      const last = items.length - 1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : event.key === "ArrowDown"
              ? Math.min(last, start + 1)
              : Math.max(0, start - 1);
      setActiveId(items[next]!.id);
    }
  }

  return (
    <div className={styles.root}>
      <label className={styles.srOnly} htmlFor={inputId}>
        Search your chats
      </label>
      <Input
        id={inputId}
        className={styles.input}
        role="combobox"
        aria-expanded
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={effectiveActiveId ? optionId(effectiveActiveId) : undefined}
        aria-describedby={statusId}
        value={query}
        dir="auto"
        placeholder="Search chats by title"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div id={statusId} className={styles.srOnly} role="status" aria-live="polite">
        {politeStatus}
      </div>
      <div className={styles.srOnly} role="alert" aria-live="assertive">
        {assertiveStatus}
      </div>

      <div id={listboxId} role="listbox" aria-label="Your chats" className={styles.list}>
        {status === "loading" ? (
          <div className={styles.status}>Searching…</div>
        ) : status === "error" ? (
          <div className={styles.errorRow}>
            <span className={styles.errorText}>Couldn&rsquo;t load chats</span>
            <button
              type="button"
              className={styles.tryAgain}
              // Not a listbox tab stop: the combobox owns focus; keyboard retry is
              // Enter-on-input. The button stays pointer-clickable.
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={retry}
            >
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className={styles.status}>
            {isSearch ? "No chats match your search." : "You have no chats yet."}
          </div>
        ) : (
          items.map((item) => {
            const active = item.id === effectiveActiveId;
            const relative = formatRelativeTime(item.updated_at, env, now);
            return (
              <div
                key={item.id}
                id={optionId(item.id)}
                role="option"
                aria-selected={active}
                className={styles.option}
                data-active={active || undefined}
                // Rows are roving (aria-activedescendant), never tab stops.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveId(item.id)}
                onClick={() => onSelect(item.id)}
              >
                <span className={styles.title} dir="auto">
                  {conversationTitle(item)}
                </span>
                <span className={styles.meta}>
                  {relative ? (
                    <>
                      <span>{relative}</span>
                      {" · "}
                    </>
                  ) : null}
                  <span>{messageCountLabel(item.message_count, env)}</span>
                </span>
              </div>
            );
          })
        )}
      </div>

      {status === "ready" && error ? (
        <div className={styles.footerError}>Couldn&rsquo;t load more chats.</div>
      ) : null}
      <LoadMoreFooter
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={loadMore}
        label="Load more chats"
      />
    </div>
  );
}
