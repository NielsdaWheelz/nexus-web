"use client";

import {
  forwardRef,
  Fragment,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { ArrowDown } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import Button from "@/components/ui/Button";
import { executeCommittingMountedMutation } from "@/lib/actions/mountedActionHandoff";
import {
  settleMessageActionMutation,
  useMessageActionIntentOwner,
  type MessageActionIntent,
} from "@/lib/chat/messageActionIntent";
import type { Live } from "@/lib/chat/runTail";
import type { BranchDraft, ChatView } from "@/lib/chat/tree";
import type { Message } from "@/lib/chat/wire";
import type { ReaderSourceTarget } from "@/lib/resourceGraph/citations";
import type { ResourceActivation } from "@/lib/resources/activation";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import AssistantMessage, { MessageTime } from "./AssistantMessage";
import type { ChatState, ChatStore } from "./conversationStore";
import { ForkStrip } from "./Forks";
import QuotedPassageCard, {
  readerTargetFromSelection,
} from "./QuotedPassageCard";
import { useChatScroll, type ChatScrollHandle } from "./useChatScroll";
import styles from "./ChatSurface.module.css";

export type ActivateSource = (
  activation: ResourceActivation,
  target: ReaderSourceTarget | null,
  event?: React.MouseEvent,
) => void;
export type RowActions = Readonly<{
  store: ChatStore;
  fork(draft: BranchDraft): void;
  walk(message: Message): void;
  openLeaf(leafId: string, anchorId: string | null): void;
  activate: ActivateSource;
}>;

/** The transcript of the active path, its fork strips, and the docked composer. */
const ChatSurface = forwardRef<
  ChatScrollHandle,
  {
    view: ChatView;
    live: ChatState["live"];
    busy: ReadonlySet<string>;
    loading: boolean;
    targetMessageId: string | null;
    actions: RowActions;
    composer: ReactNode;
    overlay: ReactNode;
  }
>(function ChatSurface(
  { view, live, busy, loading, targetMessageId, actions, composer, overlay },
  ref,
) {
  const scrollport = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const lastUserId =
    view.path.findLast((message) => message.role === "user")?.id ?? null;
  const scroll = useChatScroll(scrollport, transcript, lastUserId, !loading);
  useImperativeHandle(ref, () => scroll.handle, [scroll.handle]);
  const revealed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!targetMessageId || loading || revealed.current === targetMessageId)
      return;
    if (!view.pathIds.has(targetMessageId)) return;
    revealed.current = targetMessageId;
    scroll.handle.scrollToMessage(targetMessageId);
  }, [targetMessageId, loading, view.pathIds, scroll.handle]);

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

/** One message, and the owner of the resource-menu actions aimed at it. */
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
  const accept = useCallback(
    (intent: MessageActionIntent) => {
      const assistant = message.role === "assistant";
      switch (intent.kind) {
        case "ForkMessage":
          if (assistant)
            actions.fork({
              parentId: message.id,
              anchor: { kind: "assistant_message", message_id: message.id },
              quote: "",
            });
          return assistant;
        case "WalkMessageSources":
          if (!assistant || message.citations.length < 2) return false;
          actions.walk(message);
          return true;
        case "RerunMessage":
        case "RegenerateMessage": {
          const op = intent.kind === "RerunMessage" ? "rerun" : "regenerate";
          if (assistant)
            void settleMessageActionMutation(intent, async () =>
              (await actions.store.repeat(op, message.id))
                ? "Committed"
                : "Failed",
            );
          return assistant;
        }
        case "DeleteMessage":
          executeCommittingMountedMutation(
            intent,
            () => actions.store.deleteMessage(message.id),
            ({ conversationId: id, conversationDeleted }) =>
              intent.settleDeletedConversation({
                conversationRef: canonicalResourceRef({
                  scheme: "conversation",
                  id,
                }),
                conversationDeleted,
              }),
          ).catch(() => undefined); // the store reported the failure
          return true;
      }
    },
    [message, actions],
  );
  useMessageActionIntentOwner(ref, accept);
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
  const quote =
    message.reader_selection.kind === "Present"
      ? message.reader_selection.value
      : null;
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
          <QuotedPassageCard
            quote={{ kind: "Sent", selection: quote }}
            onOpen={(s) =>
              actions.activate(s.activation, readerTargetFromSelection(s))
            }
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
          actionSubject={{ ref }}
          label="Actions for this message"
          align="start"
        />
      </div>
      <MessageTime at={message.created_at} />
    </div>
  );
});
