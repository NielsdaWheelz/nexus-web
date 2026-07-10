"use client";

import { RefreshCcw } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import type { ConversationMessage } from "@/lib/conversations/types";
import { conversationMessageText } from "@/lib/conversations/types";
import styles from "./MessageRow.module.css";

export default function UserMessage({
  message,
  errorLabel,
  timestampLabel,
  retryAssistantMessageId,
  retrying,
  onRetryAssistantResponse,
}: {
  message: ConversationMessage;
  errorLabel: string;
  timestampLabel: string;
  retryAssistantMessageId?: string;
  retrying: boolean;
  onRetryAssistantResponse?: (assistantMessageId: string) => void;
}) {
  const text = conversationMessageText(message);
  const content = text || (message.status === "pending" ? "..." : "");

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
          {retryAssistantMessageId && onRetryAssistantResponse ? (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<RefreshCcw size={14} aria-hidden="true" />}
              loading={retrying}
              aria-label="Retry response"
              onClick={() => onRetryAssistantResponse(retryAssistantMessageId)}
            >
              Retry
            </Button>
          ) : null}
        </div>
        <span className={styles.userPromptBody}>{content}</span>
      </div>
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
