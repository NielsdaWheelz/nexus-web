"use client";

import ReaderCitation, {
  type ReaderCitationColor,
} from "@/components/ui/ReaderCitation";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import type {
  ConversationMessage,
  MessageContextSnapshot,
} from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "./MessageRow";
import styles from "./MessageRow.module.css";

export default function UserMessage({
  message,
  errorLabel,
  timestampLabel,
  onActivateTarget,
}: {
  message: ConversationMessage;
  errorLabel: string;
  timestampLabel: string;
  onActivateTarget: (target: ReaderSourceTarget) => void;
}) {
  const contexts = message.contexts ?? [];
  const presentation = userPromptPresentation(message.content);
  const content = message.content || (message.status === "pending" ? "..." : "");

  return (
    <div
      className={styles.message}
      data-message-id={message.id}
      data-role="user"
    >
      <div
        className={`${styles.userPrompt} ${
          presentation === "compact"
            ? styles.userPromptCompact
            : styles.userPromptExpanded
        }`}
        role="group"
        aria-label="User prompt"
        data-presentation={presentation}
      >
        <div className={styles.userPromptHeader}>
          <span className={styles.userAttribution}>You</span>
        </div>
        {contexts.length > 0 ? (
          <span className={styles.userCitationRow}>
            {contexts.map((context, index) => (
              <ReaderCitation
                key={contextKey(context, index)}
                index={index + 1}
                color={citationColorFromContext(context)}
                preview={citationPreviewFromContext(context)}
                target={readerTargetFromContext(context)}
                onActivate={onActivateTarget}
                ariaLabel={`Open citation ${index + 1}`}
              />
            ))}
          </span>
        ) : null}
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

function userPromptPresentation(content: string): "compact" | "expanded" {
  const visible = content.trim().replace(/\s+/g, " ");
  if (visible.length > 320) return "expanded";
  if (/[\r\n]/.test(content)) return "expanded";
  if (content.includes("```") || content.includes("~~~")) return "expanded";
  if (/\S{81,}/.test(content)) return "expanded";
  return "compact";
}

function contextKey(context: MessageContextSnapshot, fallback: number): string {
  if (context.kind === "reader_selection") {
    return `reader-selection-${context.client_context_id ?? fallback}`;
  }
  return `${context.type ?? "ref"}-${context.id ?? fallback}`;
}

function citationColorFromContext(
  context: MessageContextSnapshot,
): ReaderCitationColor {
  switch (context.color) {
    case "yellow":
    case "green":
    case "blue":
    case "pink":
    case "purple":
      return context.color;
    case undefined:
    case null:
      return "neutral";
  }
  return "neutral";
}

function citationPreviewFromContext(context: MessageContextSnapshot) {
  const title = context.title ?? context.media_title;
  const excerpt = context.exact ?? context.preview;
  const meta: string[] = [];
  if (context.media_title && context.media_title !== title) {
    meta.push(context.media_title);
  }
  if (context.route) meta.push(context.route);
  return {
    ...(title ? { title } : {}),
    ...(excerpt ? { excerpt } : {}),
    meta,
  };
}

function readerTargetFromContext(
  context: MessageContextSnapshot,
): ReaderSourceTarget | null {
  if (context.kind !== "reader_selection") return null;
  const mediaId = context.source_media_id ?? context.media_id;
  if (!mediaId || !context.locator || Object.keys(context.locator).length === 0) {
    return null;
  }
  return {
    source: "message_context",
    media_id: mediaId,
    locator: context.locator,
    snippet: context.exact ?? context.preview ?? null,
    status: "attached_context",
    label: context.title ?? context.media_title,
    context_id: context.client_context_id ?? null,
  };
}
