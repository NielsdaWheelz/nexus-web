"use client";

import { useCallback } from "react";
import { GitBranch, Search } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { collapseWhitespace } from "@/lib/collapseWhitespace";
import type {
  BranchDraft,
  ConversationMessage,
  ForkOption,
  MessageToolCall,
} from "@/lib/conversations/types";
import { conversationMessageText } from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import AssistantSelectionPopover from "./AssistantSelectionPopover";
import AssistantEvidenceDisclosure from "./AssistantEvidenceDisclosure";
import AssistantTrustInspector from "./AssistantTrustInspector";
import ForkStrip from "./ForkStrip";
import StreamingGutterCue from "./StreamingGutterCue";
import { useAssistantSelectionBranch } from "./useAssistantSelectionBranch";
import styles from "./MessageRow.module.css";

export default function AssistantMessage({
  message,
  forkOptions,
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  onCitationActivate,
  errorLabel,
  timestampLabel,
}: {
  message: ConversationMessage;
  forkOptions: ForkOption[];
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  onCitationActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
  errorLabel: string;
  timestampLabel: string;
}) {
  const assistantText = conversationMessageText(message);
  const toolCalls = message.trust_trail?.tool_calls ?? [];
  const canBranchFromAssistant =
    message.status === "complete" && Boolean(onReplyToAssistant);
  const {
    answerRef,
    selection,
    captureSelection,
    clearSelection,
    branchFromSelection,
  } = useAssistantSelectionBranch({
    message,
    enabled: canBranchFromAssistant,
    onReplyToAssistant,
  });
  const renderAssistantBody =
    message.status !== "error" ||
    (assistantText.trim().length > 0 &&
      !isGenericAssistantFailureContent(assistantText));

  const createBranchDraft = useCallback(
    (): BranchDraft => ({
      parentMessageId: message.id,
      parentMessageSeq: message.seq,
      parentMessagePreview: assistantText,
      anchor: {
        kind: "assistant_message",
        message_id: message.id,
      },
    }),
    [assistantText, message.id, message.seq],
  );

  return (
    <div
      className={styles.message}
      data-message-id={message.id}
      data-role="assistant"
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
    >
      {canBranchFromAssistant ? (
        <div className={styles.messageActions}>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<GitBranch size={14} aria-hidden="true" />}
            onClick={() => onReplyToAssistant?.(createBranchDraft())}
            aria-label="Fork from this answer"
          >
            Fork
          </Button>
        </div>
      ) : null}
      <ToolActivity toolCalls={toolCalls} />
      {message.status === "pending" ? <StreamingGutterCue /> : null}
      {renderAssistantBody ? (
        <AssistantEvidenceDisclosure
          message={message}
          answerRef={answerRef}
          onCitationActivate={onCitationActivate}
        />
      ) : null}
      {message.trust_trail ? (
        <AssistantTrustInspector
          trustTrail={message.trust_trail}
          onCitationActivate={onCitationActivate}
        />
      ) : null}
      {selection ? (
        <AssistantSelectionPopover
          selection={selection}
          onBranch={branchFromSelection}
          onDismiss={clearSelection}
        />
      ) : null}
      {message.status === "error" && errorLabel ? (
        <FeedbackNotice
          severity="error"
          title={errorLabel}
          className={styles.messageFeedback}
        />
      ) : null}
      {message.status === "cancelled" ? (
        <FeedbackNotice
          severity="neutral"
          title="Response cancelled."
          className={styles.messageFeedback}
        />
      ) : null}
      {onSelectFork ? (
        <ForkStrip
          forks={forkOptions}
          switchableLeafIds={switchableLeafIds}
          onSelectFork={onSelectFork}
        />
      ) : null}
      <span className={styles.timestamp}>{timestampLabel}</span>
    </div>
  );
}

function isGenericAssistantFailureContent(content: string): boolean {
  const normalized = collapseWhitespace(content);
  return (
    normalized === "An unexpected error occurred. Please try again." ||
    normalized === "The response failed."
  );
}

function ToolActivity({ toolCalls }: { toolCalls: MessageToolCall[] }) {
  const active = toolCalls.find((toolCall) =>
    ["running", "pending"].includes(toolCall.status),
  );
  if (!active) return null;
  const label =
    active.tool_name === "web_search"
      ? "Searching web"
      : active.tool_name === "app_search"
        ? "Searching library"
        : active.tool_name === "read_resource"
          ? "Reading source"
          : active.tool_name === "inspect_resource"
            ? "Inspecting source"
            : `Running ${active.tool_name}`;

  return (
    <div className={styles.toolActivity} role="status" aria-live="polite">
      <Search size={14} aria-hidden="true" />
      <span>{label}</span>
      {active.input_preview ? (
        <span className={styles.toolActivityPreview}>{active.input_preview}</span>
      ) : null}
    </div>
  );
}
