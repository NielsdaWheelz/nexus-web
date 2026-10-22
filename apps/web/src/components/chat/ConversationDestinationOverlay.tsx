"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import MobileSheet from "@/components/ui/MobileSheet";
import { useSettled } from "@/lib/api/serverState";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { pageQuery, usePaneFreeServerList } from "@/lib/api/useServerList";
import { fetchConversationIndex, presentConversationListItem, type ConversationListItem } from "@/lib/chat/conversationIndex";
import { formatDisplayNumber } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { wasOverlayInvokedByTouch } from "@/lib/ui/overlay";
import { reconcileSearchActive, useSearchOptions, type SearchActive } from "@/lib/ui/searchOptions";
import collection from "@/components/ui/Collection.module.css";
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
    initialFocus: (container: HTMLElement) => isMobile && wasOverlayInvokedByTouch() ? container
      : container.querySelector<HTMLInputElement>('input[role="combobox"]'),
    skipReturnFocus: () => true,
  };
  const picker = open ? <Picker mediaId={mediaId} hasSourceChats={hasSourceChats} onSelect={onSelectConversation} /> : null;
  return isMobile ? (
    <MobileSheet active={open} onDismiss={onClose} ariaLabel={TITLE} {...host}>
      {picker}
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
  const paneActive = usePaneIsActive();
  const id = useId();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"Source" | "All">(hasSourceChats === false ? "All" : "Source");
  const [active, setActive] = useState<SearchActive>(null);
  const [initializing, setInitializing] = useState(hasSourceChats === null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const settled = useSettled(query, 200);
  const search = settled.trim();
  const params = new URLSearchParams();
  if (view === "Source") params.set("media_id", mediaId);
  if (search && !initializing) params.set("title_search", search);
  const queryKey = params.toString();
  const key = `conversation-destination:${queryKey}`;
  const page = usePaneFreeServerList({ key, stale: "", pageSize: 25, active: paneActive && settled === query,
    id: (item: ConversationListItem) => item.id,
    fetchPage: (cursor, limit, signal) => fetchConversationIndex(pageQuery(queryKey, cursor, limit), signal),
  });
  const selectable = page.current && (!initializing || !search) && settled === query;
  const items = selectable ? page.items : [];
  useEffect(() => {
    if (initializing && hasSourceChats !== null) {
      setInitializing(false); setView(hasSourceChats ? "Source" : "All"); setActive(null); return;
    }
    if (!page.current || settled !== query) return;
    if (initializing && page.status === "ready") {
      setInitializing(false);
      if (page.complete && !page.items.length) { setView("All"); setActive(null); return; }
    }
  }, [hasSourceChats, initializing, page, query, settled]);
  const context = JSON.stringify([id, mediaId, view, query]);
  const options = items.map(item => ({ key: item.id, disabledReason: null }));
  const reconciled = reconcileSearchActive({ context, admitted: selectable, options,
    firstExistingKey: items[0]?.id ?? null, active });
  useEffect(() => { if (active !== reconciled) setActive(reconciled); }, [active, reconciled]);
  const bindings = useSearchOptions({ listId: `${id}-list`, label: "chats", open: true, options,
    activeKey: selectable ? reconciled?.key ?? null : null,
    onActiveChange: key => setActive({ context, key }),
    onActivate(key) { const item = selectable ? items.find(item => item.id === key) : null; if (item) onSelect(item); },
  });
  const failure = settled !== query || page.failure?.op === "More" ? null : page.failure;
  const status = failure ? "couldn’t load chats" : !selectable || page.status !== "ready" ? "searching…"
    : !items.length ? !page.complete ? "no matching chats found so far" : search ? "no chats match your search" : view === "Source" ? "no chats for this source" : "no chats yet"
    : `${formatDisplayNumber(items.length, env)} ${items.length === 1 ? "chat" : "chats"}${page.complete ? "" : " loaded; results incomplete"}`;
  const changeView = (next: "Source" | "All") => { setInitializing(false); setView(next); setActive(null); };
  return <div className={styles.destination}>
    <div className={styles.destinationViews}>
      <Button size="sm" variant="ghost" aria-pressed={view === "Source"} onClick={() => changeView("Source")}>for this source</Button>
      <Button size="sm" variant="ghost" aria-pressed={view === "All"} onClick={() => changeView("All")}>all chats</Button>
    </div>
    <Input ref={input} aria-label="search chats by title" {...bindings.inputProps} className={collection.search}
      value={query} dir="auto" placeholder="search chats by title" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={200}
      onChange={event => setQuery(event.target.value)}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => { if (bindings.handleKey(event.nativeEvent, composing.current)) { event.preventDefault(); event.stopPropagation(); } }} />
    {failure ? <FeedbackNotice content={{ tone: "Warning", title: status, requestId: failure.error.requestId }} announcement="Polite"
      actions={[{ label: "retry", onClick: page.retry, busy: page.running !== null }]} returnFocus={() => input.current} />
      : <FeedbackStatus content={{ tone: "Neutral", title: status }} announcement={!selectable ? "Polite" : "None"} />}
    <div {...bindings.listProps} ref={bindings.listRef} className={collection.compactViewport}>
      {items.map(item => {
        const presentation = presentConversationListItem(item, env);
        const props = bindings.optionProps(item.id);
        return <div key={item.id} {...props} className={collection.row}
          aria-labelledby={`${props.id}-title`} aria-describedby={`${props.id}-detail`}>
          <span className={collection.content}>
            <span id={`${props.id}-title`} dir="auto">{presentation.title}</span>
            <span id={`${props.id}-detail`} className={collection.detail}>{presentation.metadata}</span>
          </span>
        </div>;
      })}
    </div>
    {settled === query ? <CollectionExhaustionNotice list={page} unit={{ singular: "chat", plural: "chats" }} returnFocus={() => input.current} /> : null}
  </div>;
}
