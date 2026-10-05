"use client";

import { useEffect, useId, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import MobileSheet from "@/components/ui/MobileSheet";
import { conversationsInitialResource } from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import {
  fetchConversationIndex,
  presentConversationListItem,
} from "@/lib/chat/conversationIndex";
import { CANONICAL_UPDATED_TITLE_INDEX_VIEW } from "@/lib/collections/updatedTitleIndexView";
import { formatDisplayNumber } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./ChatPanels.module.css";

const TITLE = "Ask in existing chat";

/**
 * "Ask in existing chat…": picks which owned chat a reader quote goes to; it
 * never creates one. A pick closes without returning focus — the chat claims it.
 */
export default function ConversationDestinationOverlay({
  open,
  onClose,
  onSelectConversation,
}: {
  open: boolean;
  onClose: () => void;
  onSelectConversation: (conversationId: string) => void;
}) {
  const isMobile = useIsMobileViewport();
  const picked = useRef(false);
  useEffect(() => {
    if (open) picked.current = false;
  }, [open]);
  const select = (id: string) => {
    picked.current = true;
    onSelectConversation(id);
    onClose();
  };
  const host = {
    initialFocus: (container: HTMLElement) =>
      container.querySelector<HTMLInputElement>('input[role="combobox"]'),
    skipReturnFocus: () => picked.current,
  };
  return isMobile ? (
    <MobileSheet active={open} onDismiss={onClose} ariaLabel={TITLE} {...host}>
      <h2 className={styles.sheetTitle}>{TITLE}</h2>
      <Picker onSelect={select} />
    </MobileSheet>
  ) : (
    <Dialog open={open} onClose={onClose} title={TITLE} {...host}>
      <Picker onSelect={select} />
    </Dialog>
  );
}

/** A combobox over the 25 newest owned chats, searchable by title; unmounted on close. */
function Picker({ onSelect }: { onSelect: (conversationId: string) => void }) {
  const env = useRenderEnvironment();
  const id = useId();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const params = {
    view: CANONICAL_UPDATED_TITLE_INDEX_VIEW,
    titleSearch: search,
    limit: 25,
  };
  const page = useResource({
    cacheKey: `conversation-destination:${conversationsInitialResource.cacheKey(params)}`,
    load: (signal) => fetchConversationIndex({ ...params, signal }),
  });
  const items = page.status === "ready" ? page.data.items : [];
  const current = items.some((item) => item.id === active)
    ? active
    : (items[0]?.id ?? null);
  const status =
    page.status === "error"
      ? "Couldn’t load chats."
      : page.status !== "ready"
        ? "Searching…"
        : !items.length
          ? search
            ? "No chats match your search."
            : "You have no chats yet."
          : `${formatDisplayNumber(items.length, env)} ${items.length === 1 ? "chat" : "chats"}`;
  return (
    <div className={styles.destination}>
      <Input
        role="combobox"
        aria-label="Search your chats"
        aria-expanded
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={current ? `${id}-${current}` : undefined}
        value={query}
        dir="auto"
        placeholder="Search chats by title"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          const at = items.findIndex((item) => item.id === current);
          const moves: Record<string, number> = {
            ArrowDown: at + 1,
            ArrowUp: at - 1,
            Home: 0,
            End: items.length - 1,
          };
          if (event.key === "Enter") {
            event.preventDefault();
            if (page.status === "error") page.retry();
            else if (current) onSelect(current);
          } else if (event.key in moves && items.length) {
            event.preventDefault();
            const to = Math.min(
              items.length - 1,
              Math.max(0, moves[event.key]),
            );
            setActive(items[to].id);
          }
        }}
      />
      <p className={styles.faint} role="status" aria-live="polite">
        {status}
      </p>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="Your chats"
        className={styles.destinationList}
      >
        {items.map((item) => {
          const presentation = presentConversationListItem(item, env);
          return (
            <div
              key={item.id}
              id={`${id}-${item.id}`}
              role="option"
              aria-selected={item.id === current}
              data-active={item.id === current || undefined}
              className={styles.destinationOption}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(item.id)}
              onClick={() => onSelect(item.id)}
            >
              <span dir="auto">{presentation.title}</span>
              <span className={styles.faint}>{presentation.metadata}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
