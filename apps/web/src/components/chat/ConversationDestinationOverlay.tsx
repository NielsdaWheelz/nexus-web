"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import MobileSheet from "@/components/ui/MobileSheet";
import { useSettled } from "@/lib/api/serverState";
import { pageQuery, usePaneFreeServerList } from "@/lib/api/useServerList";
import { fetchConversationIndex, presentConversationListItem, type ConversationListItem } from "@/lib/chat/conversationIndex";
import { formatDisplayNumber } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./ChatPanels.module.css";

const TITLE = "choose existing chat";

/** A destination choice changes only reader intent; the reader restores its caret. */
export default function ConversationDestinationOverlay({ open, mediaId, hasSourceChats, onClose, onSelectConversation }: {
  open: boolean;
  mediaId: string;
  hasSourceChats: boolean | null;
  onClose(): void;
  onSelectConversation(conversation: Pick<ConversationListItem, "id" | "title">): void;
}) {
  const isMobile = useIsMobileViewport();
  const host = {
    initialFocus: (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[role="combobox"]'),
    skipReturnFocus: () => true,
  };
  const picker = open ? <Picker mediaId={mediaId} hasSourceChats={hasSourceChats} onSelect={onSelectConversation} /> : null;
  return isMobile ? (
    <MobileSheet active={open} onDismiss={onClose} ariaLabel={TITLE} {...host}>
      <h2 className={styles.sheetTitle}>{TITLE}</h2>{picker}
    </MobileSheet>
  ) : <Dialog open={open} onClose={onClose} title={TITLE} {...host}>{picker}</Dialog>;
}

/** Title search and source scope own one paged list; retained rows cannot be picked. */
function Picker({ mediaId, hasSourceChats, onSelect }: {
  mediaId: string;
  hasSourceChats: boolean | null;
  onSelect(conversation: Pick<ConversationListItem, "id" | "title">): void;
}) {
  const env = useRenderEnvironment();
  const id = useId();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"Source" | "All">(hasSourceChats === false ? "All" : "Source");
  const [active, setActive] = useState<{ key: string; id: string | null } | null>(null);
  const [initializing, setInitializing] = useState(hasSourceChats === null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const search = useSettled(query.trim(), 200);
  const params = new URLSearchParams();
  if (view === "Source") params.set("media_id", mediaId);
  if (search && !initializing) params.set("title_search", search);
  const queryKey = params.toString();
  const key = `conversation-destination:${queryKey}`;
  const page = usePaneFreeServerList({ key, stale: "", pageSize: 25, drain: false, active: true,
    id: (item: ConversationListItem) => item.id,
    fetchPage: (cursor, limit, signal) => fetchConversationIndex(pageQuery(queryKey, cursor, limit), signal),
  });
  const selectable = page.current && (!initializing || !search) && search === query.trim() && page.failure === null;
  const items = selectable ? page.items : [];
  useEffect(() => {
    if (initializing && hasSourceChats !== null) {
      setInitializing(false); setView(hasSourceChats ? "Source" : "All"); setActive(null); return;
    }
    if (!page.current || search !== query.trim()) return;
    if (initializing && page.status === "ready") {
      setInitializing(false);
      if (page.complete && !page.items.length) { setView("All"); setActive(null); return; }
    }
    setActive(previous => previous?.key === key
      ? previous.id !== null && !page.items.some(item => item.id === previous.id) ? { key, id: null } : previous
      : { key, id: page.items[0]?.id ?? null });
  }, [hasSourceChats, initializing, key, page, query, search]);
  const current = selectable && active?.key === key ? active.id : null;
  const status = page.failure ? "couldn’t load chats" : !selectable || page.status !== "ready" ? "searching…"
    : !items.length ? search ? "no chats match your search" : view === "Source" ? "no chats for this source" : "no chats yet"
    : `${formatDisplayNumber(items.length, env)} ${items.length === 1 ? "chat" : "chats"}`;
  const changeView = (next: "Source" | "All") => { setInitializing(false); setView(next); setActive(null); };
  return <div className={styles.destination}>
    <div className={styles.destinationViews}>
      <Button size="sm" variant="ghost" aria-pressed={view === "Source"} onClick={() => changeView("Source")}>for this source</Button>
      <Button size="sm" variant="ghost" aria-pressed={view === "All"} onClick={() => changeView("All")}>all chats</Button>
    </div>
    <Input ref={input} role="combobox" aria-label="search chats by title" aria-expanded
      aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={current ? `${id}-${current}` : undefined}
      value={query} dir="auto" placeholder="search chats by title" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={200}
      onChange={event => { setQuery(event.target.value); setActive(null); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        const modified = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
        if (event.key === "Enter") {
          event.preventDefault(); event.stopPropagation();
          if (modified || event.repeat) return;
          const item = items.find(item => item.id === current);
          if (item) onSelect(item);
        } else if (!modified && (event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
          event.preventDefault();
          const at = items.findIndex(item => item.id === current);
          const to = Math.max(0, Math.min(items.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
          setActive({ key, id: items[to].id });
        }
      }} />
    {page.failure ? <FeedbackNotice content={{ tone: "Warning", title: status, requestId: page.failure.error.requestId }} announcement="Polite"
      actions={[{ label: "retry", onClick: page.retry, busy: page.running !== null }]} returnFocus={() => input.current} />
      : <FeedbackStatus content={{ tone: "Neutral", title: status }} announcement="Polite" />}
    <div id={`${id}-list`} role="listbox" aria-label="chats" className={styles.destinationList}>
      {items.map(item => {
        const presentation = presentConversationListItem(item, env);
        return <div key={item.id} id={`${id}-${item.id}`} role="option" aria-selected={item.id === current}
          data-active={item.id === current || undefined} className={styles.destinationOption}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive({ key, id: item.id })}
          onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) onSelect(item); }}>
          <span dir="auto">{presentation.title}</span><span className={styles.faint}>{presentation.metadata}</span>
        </div>;
      })}
    </div>
    {page.current && !page.complete ? <Button variant="secondary" size="sm" disabled={page.running !== null || page.failure !== null}
      onClick={page.more}>load more</Button> : null}
  </div>;
}
