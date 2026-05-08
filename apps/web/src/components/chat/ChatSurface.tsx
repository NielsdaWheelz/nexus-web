"use client";

import {
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
  type UIEventHandler,
  type WheelEvent,
} from "react";
import Button from "@/components/ui/Button";
import type {
  BranchDraft,
  ConversationMessage,
  ConversationScope,
  ForkOption,
} from "@/lib/conversations/types";
import ConversationScopeChip from "./ConversationScopeChip";
import { MessageRow, type ReaderSourceTarget } from "./MessageRow";
import styles from "./ChatSurface.module.css";

export default function ChatSurface({
  messages,
  scrollportRef,
  onScroll,
  olderCursor,
  onLoadOlder,
  emptyState,
  composer,
  scope,
  forkOptionsByParentId = {},
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  onRetryAssistantResponse,
  retryingAssistantMessageIds,
  onReaderSourceActivate,
}: {
  messages: ConversationMessage[];
  scrollportRef?: RefObject<HTMLDivElement | null>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  olderCursor?: string | null;
  onLoadOlder?: () => void;
  emptyState?: ReactNode;
  composer: ReactNode;
  scope?: ConversationScope;
  forkOptionsByParentId?: Record<string, ForkOption[]>;
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  onRetryAssistantResponse?: (assistantMessageId: string) => void;
  retryingAssistantMessageIds?: Set<string>;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}) {
  const transcriptScrollportRef = useRef<HTMLDivElement | null>(null);
  const setScrollportRef = useCallback(
    (node: HTMLDivElement | null) => {
      transcriptScrollportRef.current = node;
      if (scrollportRef) {
        scrollportRef.current = node;
      }
    },
    [scrollportRef],
  );
  const retryAssistantIdByUserId = useMemo(() => {
    const retryByUserId = new Map<string, string>();
    for (const message of messages) {
      if (
        message.role === "assistant" &&
        message.can_retry_response === true &&
        message.parent_message_id
      ) {
        retryByUserId.set(message.parent_message_id, message.id);
      }
    }
    return retryByUserId;
  }, [messages]);

  const handleComposerWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.deltaY === 0) return;

    let target = event.target instanceof Element ? event.target : null;
    while (target && target !== event.currentTarget) {
      if (
        target instanceof HTMLElement &&
        target.scrollHeight > target.clientHeight &&
        ((event.deltaY < 0 && target.scrollTop > 0) ||
          (event.deltaY > 0 &&
            target.scrollTop + target.clientHeight < target.scrollHeight))
      ) {
        return;
      }
      target = target.parentElement;
    }

    const scrollport = transcriptScrollportRef.current;
    if (!scrollport) return;

    if (
      (event.deltaY < 0 && scrollport.scrollTop <= 0) ||
      (event.deltaY > 0 &&
        scrollport.scrollTop + scrollport.clientHeight >= scrollport.scrollHeight)
    ) {
      return;
    }

    scrollport.scrollTop += event.deltaY;
    event.preventDefault();
  };

  return (
    <div className={styles.surface}>
      <div
        ref={setScrollportRef}
        className={styles.scrollport}
        role="region"
        tabIndex={0}
        aria-label="Chat conversation"
        onScroll={onScroll}
      >
        <div
          className={styles.transcript}
          role="log"
          aria-label="Chat messages"
        >
          {scope && scope.type !== "general" ? (
            <div className={styles.scopeBanner}>
              <ConversationScopeChip scope={scope} />
            </div>
          ) : null}

          {olderCursor && onLoadOlder ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Load older messages"
              onClick={onLoadOlder}
            >
              Load older messages
            </Button>
          ) : null}

          {messages.length === 0 && emptyState ? (
            <div className={styles.emptyState}>{emptyState}</div>
          ) : null}

          {messages.map((msg) => (
            <MessageRow
              key={msg.id}
              message={msg}
              forkOptions={forkOptionsByParentId[msg.id] ?? []}
              switchableLeafIds={switchableLeafIds}
              onSelectFork={onSelectFork}
              onReplyToAssistant={onReplyToAssistant}
              retryAssistantMessageId={retryAssistantIdByUserId.get(msg.id)}
              retryingAssistantMessageIds={retryingAssistantMessageIds}
              onRetryAssistantResponse={onRetryAssistantResponse}
              onReaderSourceActivate={onReaderSourceActivate}
            />
          ))}
        </div>
      </div>

      <div
        className={styles.composerSlot}
        data-testid="chat-composer-dock"
        onWheel={handleComposerWheel}
      >
        {composer}
      </div>
    </div>
  );
}
