"use client";

import { useCallback, useRef, useState } from "react";
import { GitBranch, Search } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { StreamingMarkdownMessage } from "@/components/ui/MarkdownMessage";
import Button from "@/components/ui/Button";
import {
  assistantSelectionAnchor,
  mapAssistantSelectionToSource,
} from "@/lib/conversations/assistantSelection";
import type {
  BranchDraft,
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
import type { ReaderSourceTarget } from "./MessageRow";
import styles from "./MessageRow.module.css";

export default function AssistantMessage({
  message,
  forkOptions,
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  onActivateTarget,
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
  hasReaderActivator: boolean;
  errorLabel: string;
  timestampLabel: string;
}) {
  const answerRef = useRef<HTMLDivElement>(null);
  const [selectionDraft, setSelectionDraft] =
    useState<AssistantSelectionDraft | null>(null);
  const toolCalls = message.tool_calls ?? [];
  const canBranchFromAssistant =
    message.status === "complete" && Boolean(onReplyToAssistant);

  const createBranchDraft = useCallback(
    (selection?: AssistantSelectionDraft): BranchDraft => ({
      parentMessageId: message.id,
      parentMessageSeq: message.seq,
      parentMessagePreview: message.content,
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
    [message.content, message.id, message.seq],
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
      message.content,
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
        message.content.slice(
          Math.max(0, mapping.start_offset - 80),
          mapping.start_offset,
        ) || null;
      suffix = message.content.slice(mapping.end_offset, mapping.end_offset + 80) || null;
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
      client_selection_id: crypto.randomUUID(),
      rect: {
        top,
        left: left + width / 2,
      },
    });
  }, [canBranchFromAssistant, message.content]);

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
        {message.status === "pending" ? (
          <div ref={answerRef} className={styles.assistantBody}>
            <StreamingGutterCue />
            {message.content ? (
              <StreamingMarkdownMessage content={message.content} />
            ) : null}
          </div>
      ) : (
        <AssistantEvidenceDisclosure
          message={message}
          answerRef={answerRef}
          onActivateTarget={onActivateTarget}
          hasReaderActivator={hasReaderActivator}
        />
      )}
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

function ToolActivity({ toolCalls }: { toolCalls: MessageToolCall[] }) {
  const active = toolCalls.find((toolCall) =>
    ["started", "pending"].includes(toolCall.status),
  );
  if (!active) return null;
  const label = active.tool_name === "web_search" ? "Searching web" : "Searching library";

  return (
    <div className={styles.toolActivity}>
      <Search size={14} />
      <span>{label}</span>
    </div>
  );
}
