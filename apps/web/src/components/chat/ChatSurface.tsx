"use client";

import type { RefObject, ReactNode, UIEventHandler } from "react";
import Button from "@/components/ui/Button";
import type {
  ConversationMessage,
  ConversationScope,
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
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}) {
  return (
    <div className={styles.surface}>
      <div
        ref={scrollportRef}
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
              onReaderSourceActivate={onReaderSourceActivate}
            />
          ))}
        </div>

        <div className={styles.composerSlot}>{composer}</div>
      </div>
    </div>
  );
}
