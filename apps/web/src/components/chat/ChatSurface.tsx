"use client";

import {
  forwardRef,
  Fragment,
  memo,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { ArrowDown } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import Button from "@/components/ui/Button";
import type { Live } from "@/lib/chat/runTail";
import type { BranchDraft, ChatView } from "@/lib/chat/tree";
import type { Message } from "@/lib/chat/wire";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import AssistantMessage, { MessageTime } from "./AssistantMessage";
import type { ChatState, ChatStore } from "./conversationStore";
import { ForkStrip } from "./Forks";
import QuotedPassage from "./QuotedPassage";
import { useChatScroll, type ChatScrollHandle } from "./useChatScroll";
import styles from "./ChatSurface.module.css";

export type RowActions = Readonly<{
  store: ChatStore;
  fork(draft: BranchDraft): void;
  walk(message: Message): void;
  openLeaf(leafId: string, anchorId: string | null): void;
}>;

/** The transcript of the active path, its fork strips, and the docked composer. */
const ChatSurface = forwardRef<
  ChatScrollHandle,
  {
    view: ChatView;
    live: ChatState["live"];
    busy: ReadonlySet<string>;
    loading: boolean;
    actions: RowActions;
    composer: ReactNode;
    overlay: ReactNode;
  }
>(function ChatSurface(
  { view, live, busy, loading, actions, composer, overlay },
  ref,
) {
  const scrollport = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const lastUserId =
    view.path.findLast((message) => message.role === "user")?.id ?? null;
  const scroll = useChatScroll(scrollport, transcript, lastUserId, !loading);
  useImperativeHandle(ref, () => scroll.handle, [scroll.handle]);

  return (
    <div className={styles.surface}>
      <div
        ref={scrollport}
        className={styles.scrollport}
        role="region"
        tabIndex={0}
        aria-label="Chat conversation"
        onScroll={scroll.onScroll}
        onWheel={scroll.onUserScroll}
        onTouchMove={scroll.onUserScroll}
        onKeyDown={scroll.onUserScroll}
      >
        <div
          ref={transcript}
          className={styles.transcript}
          role="log"
          aria-label="Chat messages"
        >
          {loading && view.path.length === 0 ? (
            <FeedbackNotice
              content={{ tone: "Info", title: "Loading conversation..." }}
              announcement="None"
            />
          ) : null}
          <ForkStrip view={view} parentId={null} onOpen={actions.openLeaf} />
          {view.path.map((message, index) => (
            <Fragment key={message.id}>
              <Row
                message={message}
                ordinal={index + 1}
                live={live[message.id] ?? null}
                busy={busy.has(message.id)}
                actions={actions}
              />
              {message.role === "assistant" ? (
                <ForkStrip
                  view={view}
                  parentId={message.id}
                  onOpen={actions.openLeaf}
                />
              ) : null}
            </Fragment>
          ))}
          <div
            className={styles.spacer}
            aria-hidden="true"
            style={{ height: scroll.spacer }}
          />
        </div>
        {scroll.latestBelow ? (
          <div className={styles.latest}>
            <Button
              variant="pill"
              size="sm"
              leadingIcon={<ArrowDown size={14} aria-hidden="true" />}
              onClick={scroll.toLatest}
            >
              Latest
            </Button>
          </div>
        ) : null}
      </div>
      <div className={styles.composerSlot} onWheel={scroll.onComposerWheel}>
        {overlay}
        {composer}
      </div>
    </div>
  );
});
export default ChatSurface;

/** One message and its resource menu. */
const Row = memo(function Row({
  message,
  ordinal,
  live,
  busy,
  actions,
}: {
  message: Message;
  ordinal: number;
  live: Live | null;
  busy: boolean;
  actions: RowActions;
}) {
  const ref = canonicalResourceRef({ scheme: "message", id: message.id });
  if (message.role === "assistant")
    return (
      <AssistantMessage
        message={message}
        ordinal={ordinal}
        live={live}
        busy={busy}
        actions={actions}
      />
    );
  const quote = message.reader_selection;
  return (
    <div
      className={styles.message}
      data-message-id={message.id}
      data-role="user"
      role="group"
      aria-label="Your message"
    >
      <div className={styles.userPrompt}>
        {quote ? (
          <QuotedPassage
            quote={{ kind: "Sent", selection: quote }}
            occurrenceKey={`quote:${message.id}`}
          />
        ) : null}
        <span
          className={styles.userBody}
          data-pane-find-block="true"
          data-pane-find-message-ordinal={ordinal}
          data-pane-find-role="user"
        >
          {message.content}
        </span>
      </div>
      <div className={styles.actions}>
        <ResourceActionMenu
          resourceRef={ref}
          label="Actions for this message"
          align="start"
        />
      </div>
      <MessageTime at={message.created_at} />
    </div>
  );
});
