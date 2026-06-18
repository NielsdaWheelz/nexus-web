"use client";

import { useCallback } from "react";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import type {
  BranchDraft,
  ConversationMessage,
  ForkOption,
} from "@/lib/conversations/types";
import AssistantMessage from "./AssistantMessage";
import SystemMessage from "./SystemMessage";
import UserMessage from "./UserMessage";

interface MessageRowProps {
  message: ConversationMessage;
  forkOptions?: ForkOption[];
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  retryAssistantMessageId?: string;
  retryingAssistantMessageIds?: Set<string>;
  onRetryAssistantResponse?: (assistantMessageId: string) => void;
  onReaderSourceActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}

function errorLabel(message: ConversationMessage): string {
  if (message.error_code === "E_CANCELLED") return "Response cancelled.";
  if (message.error_code === "E_LLM_INCOMPLETE")
    return "Response stopped before completion.";
  if (message.error_code === "E_STREAM_INTERRUPTED")
    return "The connection was interrupted. Reload to continue.";
  return "The response failed.";
}

export function MessageRow({
  message,
  forkOptions = [],
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  retryAssistantMessageId,
  retryingAssistantMessageIds,
  onRetryAssistantResponse,
  onReaderSourceActivate,
}: MessageRowProps) {
  const display = useRenderEnvironment();
  const activateTarget = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      event?: React.MouseEvent,
    ) => {
      onReaderSourceActivate?.(activation, target, event);
    },
    [onReaderSourceActivate],
  );

  const messageErrorLabel = errorLabel(message);
  const timestampLabel =
    formatDisplayDate(message.created_at, display, { month: "short", day: "numeric" }) ??
    "";

  switch (message.role) {
    case "user":
      return (
        <UserMessage
          message={message}
          errorLabel={messageErrorLabel}
          timestampLabel={timestampLabel}
          retryAssistantMessageId={retryAssistantMessageId}
          retrying={
            retryAssistantMessageId
              ? retryingAssistantMessageIds?.has(retryAssistantMessageId) ===
                true
              : false
          }
          onRetryAssistantResponse={onRetryAssistantResponse}
        />
      );
    case "assistant":
      return (
        <AssistantMessage
          message={message}
          errorLabel={messageErrorLabel}
          timestampLabel={timestampLabel}
          forkOptions={forkOptions}
          switchableLeafIds={switchableLeafIds}
          onSelectFork={onSelectFork}
          onReplyToAssistant={onReplyToAssistant}
          onCitationActivate={activateTarget}
        />
      );
    case "system":
      return (
        <SystemMessage
          message={message}
          errorLabel={messageErrorLabel}
          timestampLabel={timestampLabel}
        />
      );
  }

  const _exhaustive: never = message.role;
  return _exhaustive;
}
