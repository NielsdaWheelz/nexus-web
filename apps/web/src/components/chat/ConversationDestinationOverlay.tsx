"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PickerSurface from "@/components/ui/PickerSurface";
import { useSettled, usePaneFreeServerValue } from "@/lib/api/serverState";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import { usePaneIsActive, usePaneIsVisible } from "@/lib/panes/paneRuntime";
import { fetchConversationIndex, presentConversationListItem, type ConversationListItem } from "@/lib/chat/conversationIndex";
import { useChatAgeClock } from "@/lib/chat/useChatAgeClock";
import ConversationMetadata from "./ConversationMetadata";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { wasOverlayInvokedByTouch } from "@/lib/ui/overlay";
import { reconcileSearchActive, useSearchOptions, type SearchActive } from "@/lib/ui/searchOptions";
import collection from "@/components/ui/Collection.module.css";
import styles from "./ChatPanels.module.css";

const TITLE = "choose existing chat";

/** A destination choice changes only reader intent; the reader restores its caret. */
export default function ConversationDestinationOverlay({ open, mediaId, hasSourceChats, anchor, panelId, onClose, onSelectConversation }: {
  open: boolean;
  mediaId: string;
  hasSourceChats: boolean | null;
  anchor: () => HTMLElement | null;
  panelId: string;
  onClose(): void;
  onSelectConversation(conversation: Pick<ConversationListItem, "id" | "title">): void;
}) {
  const isMobile = useIsMobileViewport();
  const slipContent = useRef<HTMLDivElement>(null);
  return <PickerSurface slipContent={slipContent} active={open} onClose={onClose} anchor={anchor} panelId={panelId} title={TITLE}
    initialFocus={container => isMobile && wasOverlayInvokedByTouch() ? container
      : container.querySelector<HTMLInputElement>('input[role="combobox"]')}
    skipReturnFocus={() => true}>
    {open ? <Picker scrollRef={slipContent} mediaId={mediaId} hasSourceChats={hasSourceChats} onSelect={onSelectConversation} /> : null}
  </PickerSurface>;
}

/** Title search and source scope admit choices only for the exact settled query. A failed first
 * read stands in the list region, outside listbox markup; a failed refresh over shown rows says
 * nothing. */
function Picker({ mediaId, hasSourceChats, onSelect, scrollRef }: {
  scrollRef: RefObject<HTMLDivElement | null>;
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
  const readKey = paneActive && settled === query ? key : null;
  const page = usePaneFreeServerValue({ key: readKey, stale: "",
    load: signal => fetchConversationIndex(new URLSearchParams(queryKey), signal),
  });
  const pageItems = page.status === "ready" ? page.data.items : [];

  const nowMs = useChatAgeClock({ initialInstant: env.currentInstant, items: pageItems, visible: usePaneIsVisible() });
  const selectable = (page.status === "ready") && (!initializing || !search) && settled === query;
  const items = selectable ? pageItems : [];
  useEffect(() => {
    if (initializing && hasSourceChats !== null) {
      setInitializing(false); setView(hasSourceChats ? "Source" : "All"); setActive(null); return;
    }
    if (!(page.status === "ready") || settled !== query) return;
    if (initializing && page.status === "ready") {
      setInitializing(false);
      if (!pageItems.length) { setView("All"); setActive(null); return; }
    }
  }, [hasSourceChats, initializing, page, pageItems.length, query, settled]);
  const context = JSON.stringify([id, mediaId, view, query]);
  const options = items.map(item => ({ key: item.id, disabledReason: null }));
  const reconciled = reconcileSearchActive({ context, admitted: selectable, options,
    initialKey: items[0]?.id ?? null, active });
  useEffect(() => { if (active !== reconciled) setActive(reconciled); }, [active, reconciled]);
  const bindings = useSearchOptions({ listId: `${id}-list`, label: "chats", open: true, options,
    activeKey: selectable ? reconciled?.key ?? null : null,
    onActiveChange: key => setActive({ context, key }),
    onActivate(key) { const item = selectable ? items.find(item => item.id === key) : null; if (item) onSelect(item); },
  });
  const failed = settled === query && page.status === "failed" ? page : null;
  const emptyTitle = search ? "no chats match this search." : view === "Source" ? "no chats for this source." : "no chats yet.";
  const readFeedback = useIndexReadFeedback({
    value: page, requestedKey: readKey, active: paneActive, unit: { singular: "chat", plural: "chats" }, waiting: settled === query && !(page.status === "ready") && failed === null,
    outcome: items.length > 0 ? null : emptyTitle,
    returnFocus: () => input.current,
  });
  const changeView = (next: "Source" | "All") => { setInitializing(false); setView(next); setActive(null); };
  return <div className={styles.destination}>
    <div className={styles.destinationViews}>
      <Button aria-pressed={view === "Source"} onClick={() => changeView("Source")}>for this source</Button>
      <Button aria-pressed={view === "All"} onClick={() => changeView("All")}>all chats</Button>
    </div>
    <Input ref={input} aria-label="search chats by title" {...bindings.inputProps} className={collection.search}
      value={query} dir="auto" placeholder="search chats by title" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={200}
      onChange={event => setQuery(event.target.value)}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => { if (bindings.handleKey(event.nativeEvent, composing.current)) { event.preventDefault(); event.stopPropagation(); } }} />
    <div ref={scrollRef} className={styles.destinationBody}>
    {failed ? <Failed error={failed.error} noun="chats" retry={{ run: () => void failed.refetch(), busy: failed.retrying }} />
      : selectable && items.length === 0 ? <Fact line={{ fact: emptyTitle }} /> : null}
    <div {...bindings.listProps} ref={bindings.listRef} className={collection.compactViewport}>
      {items.map(item => {
        const presentation = presentConversationListItem(item, env, nowMs);
        const props = bindings.optionProps(item.id);
        return <div key={item.id} {...props} className={collection.row}
          aria-labelledby={`${props.id}-title`} aria-describedby={`${props.id}-detail`}>
          <span className={collection.content}>
            <span id={`${props.id}-title`} dir="auto">{presentation.title}</span>
            <span id={`${props.id}-detail`} className={collection.detail}><ConversationMetadata metadata={presentation.metadata} /></span>
          </span>
        </div>;
      })}
    </div>
    </div>
    {readFeedback.announcement}
  </div>;
}
