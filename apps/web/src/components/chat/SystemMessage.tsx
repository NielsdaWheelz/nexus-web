"use client";

import type { ConversationMessage } from "@/lib/conversations/types";
import { conversationMessageText } from "@/lib/conversations/types";
import ChatFailureCard from "./ChatFailureCard";
import ConversationMessageText from "./ConversationMessageText";
import type { ChatFindOccurrencePosition } from "./useChatScroll";
import styles from "./MessageRow.module.css";

export default function SystemMessage({
  message,
  timestampLabel,
  findOccurrence = null,
}: {
  message: ConversationMessage;
  timestampLabel: string;
  findOccurrence?: ChatFindOccurrencePosition | null;
}) {
  const isTerminalFailure =
    message.status === "error" || message.status === "cancelled";

  return (
    <div className={styles.message} data-message-id={message.id} data-role="system">
      <span className={styles.systemBody}>
        {conversationMessageText(message) ? (
          <ConversationMessageText
            message={message}
            findOccurrence={findOccurrence}
          />
        ) : message.status === "pending" ? (
          "..."
        ) : (
          ""
        )}
      </span>
      {isTerminalFailure ? (
        <ChatFailureCard failure={null} supportId={{ kind: "Absent" }} />
      ) : null}
      <span className={styles.timestamp}>{timestampLabel}</span>
    </div>
  );
}
