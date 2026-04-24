"use client";

import type { RefObject, ReactNode } from "react";
import type { ConversationMessage } from "@/lib/conversations/types";
import { MessageRow } from "./MessageRow";
import styles from "./ChatSurface.module.css";

export default function ChatSurface({
  messages,
  messageListRef,
  olderCursor,
  onLoadOlder,
  emptyState,
  composer,
  transcriptTestId = "chat-transcript",
}: {
  messages: ConversationMessage[];
  messageListRef?: RefObject<HTMLDivElement | null>;
  olderCursor?: string | null;
  onLoadOlder?: () => void;
  emptyState?: ReactNode;
  composer: ReactNode;
  transcriptTestId?: string;
}) {
  return (
    <div className={styles.surface}>
      <div
        ref={messageListRef}
        className={styles.transcript}
        data-testid={transcriptTestId}
      >
        {olderCursor && onLoadOlder ? (
          <button
            type="button"
            className={styles.loadOlder}
            aria-label="Load older messages"
            onClick={onLoadOlder}
          >
            Load older messages
          </button>
        ) : null}

        {messages.length === 0 && emptyState ? (
          <div className={styles.emptyState}>{emptyState}</div>
        ) : null}

        {messages.map((msg) => (
          <MessageRow key={msg.id} message={msg} />
        ))}
      </div>

      <div className={styles.composerSlot}>{composer}</div>
    </div>
  );
}
