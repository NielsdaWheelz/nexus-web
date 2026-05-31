"use client";

import { useCallback } from "react";
import { dispatchReaderPulse } from "@/lib/reader/pulseEvent";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
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
    target: ReaderSourceTarget,
    event?: React.MouseEvent,
  ) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diffSec = Math.floor((now - d.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function errorLabel(message: ConversationMessage): string {
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
  const activateTarget = useCallback(
    (target: ReaderSourceTarget, event?: React.MouseEvent) => {
      dispatchReaderPulse({
        mediaId: target.media_id,
        evidenceSpanId: target.evidence_span_id ?? undefined,
        locator: target.locator,
        snippet: target.snippet,
        sourceVersion: target.source_version,
        highlightBehavior: target.highlight_behavior,
        focusBehavior: target.focus_behavior,
      });
      onReaderSourceActivate?.(target, event);
    },
    [onReaderSourceActivate],
  );

  const messageErrorLabel = errorLabel(message);
  const timestampLabel = formatTime(message.created_at);

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
