"use client";

import {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowDown } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import type { ServerValue } from "@/lib/api/serverState";
import type { CommandState } from "@/lib/chat/commands";
import type { Live } from "@/lib/chat/runTail";
import { alternatives, type Alternative, type BranchDraft, type ChatView } from "@/lib/chat/tree";
import type { Catalog, Message } from "@/lib/chat/wire";
import AssistantMessage from "./AssistantMessage";
import type { ChatState, ChatStore } from "./conversationStore";
import { AlternativeSelector } from "./Forks";
import MessageFooter from "./MessageFooter";
import MessageDialogs, { type MessageDialogRequest } from "./MessageDialogs";
import QuotedPassage from "./QuotedPassage";
import { useChatScroll, type ChatScrollHandle } from "./useChatScroll";
import styles from "./ChatSurface.module.css";

/** What every row, footer and dialog of one conversation pane shares. */
export type ChatPane = Readonly<{
  store: ChatStore;
  command: CommandState;
  catalog: ServerValue<Catalog>;
  /** The scrollport: the focus fallback of every dialog. */
  region: RefObject<HTMLDivElement | null>;
  scroll: ChatScrollHandle;
  fork(draft: BranchDraft): void;
  openDialog(request: MessageDialogRequest): void;
}>;
const ChatPaneContext = createContext<ChatPane | null>(null);

export function useChatPane(): ChatPane {
  const pane = useContext(ChatPaneContext);
  if (!pane) throw new Error("Chat rows render inside ChatSurface");
  return pane;
}

const NONE: readonly Alternative[] = [];

/** The active transcript, its local disclosures, and the docked composer. */
const ChatSurface = forwardRef<
  ChatScrollHandle,
  {
    view: ChatView;
    live: ChatState["live"];
    command: CommandState;
    catalog: ServerValue<Catalog>;
    loading: boolean;
    store: ChatStore;
    fork(draft: BranchDraft): void;
    composer: ReactNode;
  }
>(function ChatSurface({ view, live, command, catalog, loading, store, fork, composer }, ref) {
  const scrollport = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const lastUserId = view.path.findLast((message) => message.role === "user")?.id ?? null;
  const scroll = useChatScroll(scrollport, transcript, lastUserId, view.path.at(-1)?.id ?? null, !loading);
  useImperativeHandle(ref, () => scroll.handle, [scroll.handle]);
  const [dialog, setDialog] = useState<MessageDialogRequest | null>(null);
  const closeDialog = useCallback(
    (request: MessageDialogRequest) => setDialog((current) => (current === request ? null : current)),
    [],
  );
  const pane = useMemo<ChatPane>(
    () => ({ store, command, catalog, region: scrollport, scroll: scroll.handle, fork, openDialog: setDialog }),
    [store, command, catalog, scroll.handle, fork],
  );
  const siblings = useMemo(() => {
    const groups = new Map<string | null, readonly Alternative[]>([[null, alternatives(view.children, null, view.pathIds)]]);
    for (const message of view.path)
      if (message.role === "assistant") groups.set(message.id, alternatives(view.children, message.id, view.pathIds));
    return groups;
  }, [view]);
  const roots = siblings.get(null) ?? NONE;
  const latestSettledId = view.path.findLast((message) => message.role === "assistant" && message.status !== "pending")?.id ?? null;

  return (
    <ChatPaneContext value={pane}>
      <div className={styles.surface}>
        <div
          ref={scrollport}
          className={styles.scrollport}
          role="region"
          tabIndex={0}
          aria-label="Chat conversation"
          onScroll={scroll.onScroll}
          onFocus={scroll.onFocus}
          onWheel={scroll.onUserScroll}
          onTouchMove={scroll.onUserScroll}
          onKeyDown={scroll.onKeyDown}
          onPointerDown={scroll.onPointerDown}
          onClick={scroll.onClick}
        >
          <div ref={transcript} className={styles.transcript} role="log" aria-label="Chat messages">
            {loading && view.path.length === 0 ? (
              <FeedbackNotice content={{ tone: "Info", title: "Loading conversation..." }} announcement="None" />
            ) : null}
            {roots.length ? (
              <div className={styles.rootAlternatives}>
                <AlternativeSelector options={roots} />
              </div>
            ) : null}
            {view.path.map((message, index) => (
              <Row
                key={message.id}
                message={message}
                ordinal={index + 1}
                live={live[message.id] ?? null}
                latest={message.id === latestSettledId}
                siblings={siblings.get(message.id) ?? NONE}
                engaged={dialog?.messageId === message.id}
              />
            ))}
            <div className={styles.spacer} aria-hidden="true" style={{ height: scroll.spacer }} />
          </div>
          {scroll.latestBelow ? (
            <div className={styles.latest}>
              <Button icon={<ArrowDown size={14} aria-hidden="true" />} onClick={scroll.toLatest}>
                Latest
              </Button>
            </div>
          ) : null}
        </div>
        <div className={styles.composerSlot} onWheel={scroll.onComposerWheel}>
          {composer}
        </div>
        <MessageDialogs request={dialog} messages={view.messages} onClose={closeDialog} />
      </div>
    </ChatPaneContext>
  );
});
export default ChatSurface;

/** One message of the active path; an answer owns its own details. */
const Row = memo(function Row({ message, ordinal, live, latest, siblings, engaged }: {
  message: Message;
  ordinal: number;
  live: Live | null;
  latest: boolean;
  siblings: readonly Alternative[];
  engaged: boolean;
}) {
  const choices = siblings.length ? <AlternativeSelector options={siblings} /> : null;
  if (message.role === "assistant")
    return <AssistantMessage message={message} ordinal={ordinal} live={live} latest={latest} engaged={engaged} alternatives={choices} />;
  const quote = message.reader_selection;
  return (
    <div className={styles.message} data-message-id={message.id} data-role="user" role="group" aria-label="Your message">
      <div className={styles.userPrompt}>
        {quote ? <QuotedPassage quote={{ kind: "Sent", selection: quote }} occurrenceKey={`quote:${message.id}`} /> : null}
        <span
          className={styles.userBody}
          data-pane-find-block="true"
          data-pane-find-message-ordinal={ordinal}
          data-pane-find-role="user"
        >
          {message.content}
        </span>
      </div>
      <MessageFooter message={message} latest={latest} engaged={engaged} alternatives={choices} />
    </div>
  );
});
