"use client";

import type { ConversationMessage } from "@/lib/conversations/types";
import { conversationMessageText } from "@/lib/conversations/types";
import ChatFailureCard from "./ChatFailureCard";
import styles from "./MessageRow.module.css";

export default function SystemMessage({
  message,
  timestampLabel,
}: {
  message: ConversationMessage;
  timestampLabel: string;
}) {
  const isTerminalFailure =
    message.status === "error" || message.status === "cancelled";

  return (
    <div className={styles.message} data-message-id={message.id} data-role="system">
      <span className={styles.systemBody}>
        {conversationMessageText(message) || (message.status === "pending" ? "..." : "")}
      </span>
      {isTerminalFailure ? <ChatFailureCard failure={null} /> : null}
      <span className={styles.timestamp}>{timestampLabel}</span>
    </div>
  );
}
