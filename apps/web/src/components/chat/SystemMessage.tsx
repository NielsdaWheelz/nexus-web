"use client";

import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { ConversationMessage } from "@/lib/conversations/types";
import { conversationMessageText } from "@/lib/conversations/types";
import styles from "./MessageRow.module.css";

export default function SystemMessage({
  message,
  errorLabel,
  timestampLabel,
}: {
  message: ConversationMessage;
  errorLabel: string;
  timestampLabel: string;
}) {
  return (
    <div className={styles.message} data-message-id={message.id} data-role="system">
      <span className={styles.systemBody}>
        {conversationMessageText(message) || (message.status === "pending" ? "..." : "")}
      </span>
      {message.status === "error" && errorLabel ? (
        <FeedbackNotice
          severity="error"
          title={errorLabel}
          className={styles.messageFeedback}
        />
      ) : null}
      <span className={styles.timestamp}>{timestampLabel}</span>
    </div>
  );
}
