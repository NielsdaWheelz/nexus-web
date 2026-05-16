"use client";

import { RefreshCcw } from "lucide-react";
import ReaderCitation, {
  type ReaderCitationColor,
} from "@/components/ui/ReaderCitation";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import type {
  ConversationMessage,
  MessageContextSnapshot,
} from "@/lib/conversations/types";
import { conversationMessageText } from "@/lib/conversations/types";
import { isRetrievalLocator } from "@/lib/api/sse";
import type { ReaderSourceTarget } from "./MessageRow";
import styles from "./MessageRow.module.css";

export default function UserMessage({
  message,
  errorLabel,
  timestampLabel,
  retryAssistantMessageId,
  retrying,
  onRetryAssistantResponse,
  onActivateTarget,
}: {
  message: ConversationMessage;
  errorLabel: string;
  timestampLabel: string;
  retryAssistantMessageId?: string;
  retrying: boolean;
  onRetryAssistantResponse?: (assistantMessageId: string) => void;
  onActivateTarget: (target: ReaderSourceTarget) => void;
}) {
  const contexts = message.contexts ?? [];
  const text = conversationMessageText(message);
  const presentation = userPromptPresentation(text);
  const content = text || (message.status === "pending" ? "..." : "");

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
          <span className={styles.userAttribution}>You</span>
        </div>
        {contexts.length > 0 ? (
          <span className={styles.userCitationRow}>
            {contexts.map((context, index) => {
              const href = contextHref(context);
              return (
                <ReaderCitation
                  key={contextKey(context, index)}
                  index={index + 1}
                  color={citationColorFromContext(context)}
                  preview={citationPreviewFromContext(context)}
                  target={readerTargetFromContext(context, href)}
                  href={href}
                  onActivate={onActivateTarget}
                  ariaLabel={`Open citation ${index + 1}`}
                />
              );
            })}
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
  href: string | null,
): ReaderSourceTarget | null {
  if (context.kind !== "reader_selection") return null;
  const mediaId = context.source_media_id ?? context.media_id;
  if (
    !mediaId ||
    !context.source_version ||
    !isRetrievalLocator(context.locator)
  ) {
    return null;
  }
  return {
    source: "message_context",
    media_id: mediaId,
    locator: context.locator,
    snippet: context.exact ?? context.preview ?? null,
    source_version: context.source_version,
    highlight_behavior: "pulse",
    focus_behavior: "scroll_into_view",
    status: "attached_context",
    label: context.title ?? context.media_title,
    href,
    context_id: context.client_context_id ?? null,
  };
}

function contextHref(context: MessageContextSnapshot): string | null {
  if (context.kind === "reader_selection") {
    return context.route ?? null;
  }
  if (context.route) {
    return context.route;
  }
  if (!context.id) {
    return null;
  }
  const type = context.type;
  switch (type) {
    case "highlight":
      return context.media_id
        ? `/media/${context.media_id}?highlight=${context.id}`
        : null;
    case "content_chunk": {
      const mediaId = context.media_id ?? context.source_media_id;
      if (!mediaId) return null;
      const params = new URLSearchParams();
      const evidenceSpanId = context.evidence_span_ids?.[0];
      if (evidenceSpanId) params.set("evidence", evidenceSpanId);
      const query = params.toString();
      return query ? `/media/${mediaId}?${query}` : `/media/${mediaId}`;
    }
    case "media":
      return `/media/${context.id}`;
    case "podcast":
      return `/podcasts/${context.id}`;
    case "fragment":
      return context.media_id || context.source_media_id
        ? `/media/${context.media_id ?? context.source_media_id}?fragment=${context.id}`
        : null;
    case "evidence_span":
      return context.media_id || context.source_media_id
        ? `/media/${context.media_id ?? context.source_media_id}?evidence=${context.id}`
        : null;
    case "artifact":
      return null;
    case "artifact_part":
      if (context.locator?.type !== "artifact_part_ref") return null;
      return `/conversations/${context.locator.conversation_id}?artifact=${context.locator.artifact_id}&artifactPart=${context.locator.artifact_part_id}`;
    case "conversation":
      return `/conversations/${context.id}`;
    case "message":
      return context.locator?.type === "message_offsets"
        ? `/conversations/${context.locator.conversation_id}`
        : null;
    case "page":
      return `/pages/${context.id}`;
    case "note_block":
      return `/notes/${context.id}`;
    default:
      return null;
  }
}
