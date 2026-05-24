"use client";

import { useCallback, useRef, useState } from "react";
import { GitBranch, Search } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import {
  assistantSelectionAnchor,
  mapAssistantSelectionToSource,
} from "@/lib/conversations/assistantSelection";
import type { ContextItem } from "@/lib/api/sse/requests";
import { collapseWhitespace } from "@/lib/collapseWhitespace";
import { createRandomId } from "@/lib/createRandomId";
import type {
  BranchDraft,
  ChatRunResponse,
  ConversationMessage,
  ForkOption,
  MessageToolCall,
} from "@/lib/conversations/types";
import AssistantSelectionPopover, {
  type AssistantSelectionDraft,
} from "./AssistantSelectionPopover";
import AssistantEvidenceDisclosure from "./AssistantEvidenceDisclosure";
import ForkStrip from "./ForkStrip";
import StreamingGutterCue from "./StreamingGutterCue";
import type { ArtifactFocusTarget, ReaderSourceTarget } from "./MessageRow";
import styles from "./MessageRow.module.css";

export default function AssistantMessage({
  message,
  forkOptions,
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  onActivateTarget,
  onAskAboutSource,
  onSaveSourceQuote,
  onAttachContext,
  onChatRunCreated,
  artifactFocusTarget,
  hasReaderActivator,
  errorLabel,
  timestampLabel,
}: {
  message: ConversationMessage;
  forkOptions: ForkOption[];
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  onActivateTarget: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
  onAttachContext?: (context: ContextItem) => void;
  onChatRunCreated?: (runData: ChatRunResponse["data"]) => void;
  artifactFocusTarget?: ArtifactFocusTarget | null;
  hasReaderActivator: boolean;
  errorLabel: string;
  timestampLabel: string;
}) {
  const answerRef = useRef<HTMLDivElement>(null);
  const [selectionDraft, setSelectionDraft] =
    useState<AssistantSelectionDraft | null>(null);
  const assistantText = assistantMessageText(message);
  const toolCalls = message.tool_calls ?? [];
  const canBranchFromAssistant =
    message.status === "complete" && Boolean(onReplyToAssistant);
  const renderAssistantBody =
    message.status !== "error" ||
    (assistantText.trim().length > 0 &&
      !isGenericAssistantFailureContent(assistantText));

  const createBranchDraft = useCallback(
    (selection?: AssistantSelectionDraft): BranchDraft => ({
      parentMessageId: message.id,
      parentMessageSeq: message.seq,
      parentMessagePreview: assistantText,
      anchor: selection
        ? assistantSelectionAnchor({
            messageId: message.id,
            exact: selection.exact,
            prefix: selection.prefix,
            suffix: selection.suffix,
            clientSelectionId: selection.client_selection_id,
            mapping: selection,
          })
        : {
            kind: "assistant_message",
            message_id: message.id,
          },
    }),
    [assistantText, message.id, message.seq],
  );

  const captureAssistantSelection = useCallback(() => {
    if (!canBranchFromAssistant) return;
    const selection = window.getSelection();
    const container = answerRef.current;
    if (!selection || !container || selection.rangeCount === 0) {
      setSelectionDraft(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer) ||
      selection.isCollapsed
    ) {
      setSelectionDraft(null);
      return;
    }

    const exact = selection.toString().trim();
    if (!exact) {
      setSelectionDraft(null);
      return;
    }

    const renderedContext = renderedSelectionContext(container, range);
    const mapping = mapAssistantSelectionToSource(
      assistantText,
      container.innerText.trim(),
      exact,
    );
    let prefix = renderedContext.prefix;
    let suffix = renderedContext.suffix;
    if (
      mapping.offset_status === "mapped" &&
      typeof mapping.start_offset === "number" &&
      typeof mapping.end_offset === "number"
    ) {
      prefix =
        assistantText.slice(
          Math.max(0, mapping.start_offset - 80),
          mapping.start_offset,
        ) || null;
      suffix = assistantText.slice(mapping.end_offset, mapping.end_offset + 80) || null;
    }
    const rect = range.getBoundingClientRect();
    const fallbackRect = container.getBoundingClientRect();
    const top = rect.top || fallbackRect.top;
    const left = rect.left || fallbackRect.left;
    const width = rect.width || fallbackRect.width;

    setSelectionDraft({
      exact,
      prefix,
      suffix,
      start_offset: mapping.start_offset,
      end_offset: mapping.end_offset,
      offset_status: mapping.offset_status,
      client_selection_id: createRandomId(),
      rect: {
        top,
        left: left + width / 2,
      },
    });
  }, [assistantText, canBranchFromAssistant]);

  const branchFromSelection = useCallback(() => {
    if (!selectionDraft) return;
    onReplyToAssistant?.(createBranchDraft(selectionDraft));
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
  }, [createBranchDraft, onReplyToAssistant, selectionDraft]);

  return (
    <div
      className={styles.message}
      data-message-id={message.id}
      data-role="assistant"
      onMouseUp={captureAssistantSelection}
      onKeyUp={captureAssistantSelection}
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
          onActivateTarget={onActivateTarget}
          onAskAboutSource={onAskAboutSource}
          onSaveSourceQuote={onSaveSourceQuote}
          onAttachContext={onAttachContext}
          onChatRunCreated={onChatRunCreated}
          artifactFocusTarget={artifactFocusTarget}
          hasReaderActivator={hasReaderActivator}
        />
      ) : null}
      {selectionDraft ? (
        <AssistantSelectionPopover
          selection={selectionDraft}
          onBranch={branchFromSelection}
        />
      ) : null}
      {message.status === "error" && errorLabel ? (
        <FeedbackNotice
          severity="error"
          title={errorLabel}
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

function renderedSelectionContext(container: HTMLElement, range: Range) {
  const before = range.cloneRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);

  const after = range.cloneRange();
  after.selectNodeContents(container);
  after.setStart(range.endContainer, range.endOffset);

  const prefix = before.toString().slice(-80) || null;
  const suffix = after.toString().slice(0, 80) || null;
  before.detach();
  after.detach();
  return { prefix, suffix };
}

function assistantMessageText(message: ConversationMessage): string {
  return (message.message_document?.blocks ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

function ToolActivity({ toolCalls }: { toolCalls: MessageToolCall[] }) {
  const active = toolCalls.find((toolCall) =>
    ["running", "pending"].includes(toolCall.status),
  );
  if (!active) return null;
  const label = active.tool_name === "web_search" ? "Searching web" : "Searching library";

  return (
    <div className={styles.toolActivity} role="status" aria-live="polite">
      <Search size={14} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
