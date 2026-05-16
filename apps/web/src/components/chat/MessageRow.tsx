"use client";

import { useCallback } from "react";
import { dispatchReaderPulse } from "@/lib/reader/pulseEvent";
import type { ContextItem } from "@/lib/api/sse";
import type {
  BranchDraft,
  ChatRunResponse,
  ConversationMessage,
  ForkOption,
  MessageEvidenceLocator,
} from "@/lib/conversations/types";
import AssistantMessage from "./AssistantMessage";
import SystemMessage from "./SystemMessage";
import UserMessage from "./UserMessage";

export type ReaderSourceTargetSource =
  | "message_context"
  | "claim_evidence"
  | "message_retrieval";

export interface ReaderSourceTarget {
  source: ReaderSourceTargetSource;
  media_id: string;
  locator: MessageEvidenceLocator;
  snippet: string | null;
  source_version: string;
  highlight_behavior: "pulse";
  focus_behavior: "scroll_into_view";
  status: string;
  label?: string;
  href?: string | null;
  evidence_span_id?: string | null;
  evidence_id?: string;
  context_id?: string | null;
}

export interface ArtifactFocusTarget {
  artifactId: string;
  artifactPartId?: string | null;
}

interface MessageRowProps {
  message: ConversationMessage;
  forkOptions?: ForkOption[];
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  retryAssistantMessageId?: string;
  retryingAssistantMessageIds?: Set<string>;
  onRetryAssistantResponse?: (assistantMessageId: string) => void;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
  onAttachContext?: (context: ContextItem) => void;
  onChatRunCreated?: (runData: ChatRunResponse["data"]) => void;
  artifactFocusTarget?: ArtifactFocusTarget | null;
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
  return message.error_code === "E_LLM_INCOMPLETE"
    ? "Response stopped before completion."
    : "The response failed.";
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
  onAskAboutSource,
  onSaveSourceQuote,
  onAttachContext,
  onChatRunCreated,
  artifactFocusTarget,
}: MessageRowProps) {
  const activateTarget = useCallback(
    (target: ReaderSourceTarget) => {
      dispatchReaderPulse({
        mediaId: target.media_id,
        locator: target.locator,
        snippet: target.snippet,
        sourceVersion: target.source_version,
        highlightBehavior: target.highlight_behavior,
        focusBehavior: target.focus_behavior,
      });
      onReaderSourceActivate?.(target);
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
          onActivateTarget={activateTarget}
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
          onActivateTarget={activateTarget}
          onAskAboutSource={onAskAboutSource}
          onSaveSourceQuote={onSaveSourceQuote}
          onAttachContext={onAttachContext}
          onChatRunCreated={onChatRunCreated}
          artifactFocusTarget={artifactFocusTarget}
          hasReaderActivator={Boolean(onReaderSourceActivate)}
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
