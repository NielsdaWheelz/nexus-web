"use client";

import type { ConversationMessage } from "@/lib/conversations/types";
import { conversationMessageText } from "@/lib/conversations/types";
import ChatFailureCard from "./ChatFailureCard";
import styles from "./MessageRow.module.css";

export default function UserMessage({
  message,
  timestampLabel,
}: {
  message: ConversationMessage;
  timestampLabel: string;
}) {
  const text = conversationMessageText(message);
  const content = text || (message.status === "pending" ? "..." : "");
  const isTerminalFailure =
    message.status === "error" || message.status === "cancelled";

  return (
    <div
      className={styles.message}
      data-message-id={message.id}
      data-role="user"
    >
      <div
        className={styles.userPrompt}
        role="group"
        aria-label="User prompt"
      >
        <div className={styles.userKicker}>
          <span className={styles.userAttribution}>You</span>
        </div>
        <span className={styles.userPromptBody}>{content}</span>
      </div>
      {isTerminalFailure ? <ChatFailureCard failure={null} /> : null}
      <span className={styles.timestamp}>{timestampLabel}</span>
    </div>
  );
}
