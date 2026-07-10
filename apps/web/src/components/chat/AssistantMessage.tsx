"use client";

import { useCallback, useMemo } from "react";
import { GitBranch, RefreshCcw, Search } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import MachineText, { type MachineSignatureTime } from "@/components/ui/MachineText";
import { collapseWhitespace } from "@/lib/collapseWhitespace";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type {
  BranchDraft,
  ConversationMessage,
  ForkOption,
  MessageToolCall,
} from "@/lib/conversations/types";
import { conversationMessageText } from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import { toReaderCitationData } from "@/lib/conversations/citations";
import AssistantSelectionPopover from "./AssistantSelectionPopover";
import AssistantEvidenceDisclosure from "./AssistantEvidenceDisclosure";
import AssistantTrustInspector, { AssistantWriteTrail } from "./AssistantTrustInspector";
import Colophon from "./Colophon";
import MessageFootnotes from "./MessageFootnotes";
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
  resendAssistantMessageId,
  resending,
  onResendAssistantResponse,
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
  resendAssistantMessageId?: string;
  resending?: boolean;
  onResendAssistantResponse?: (assistantMessageId: string) => void;
}) {
  const display = useRenderEnvironment();
  const assistantText = conversationMessageText(message);
  const toolCalls = message.trust_trail?.tool_calls ?? [];
  // Citations memoized once at this level; shared by EvidenceDisclosure + MessageFootnotes.
  const citations = useMemo(
    () => (message.citations ?? []).map(toReaderCitationData),
    [message.citations],
  );
  const canBranchFromAssistant =
    message.status === "complete" && Boolean(onReplyToAssistant);
  const canResendAssistant =
    Boolean(resendAssistantMessageId) && Boolean(onResendAssistantResponse);
  const resendAssistant = () => {
    if (!resendAssistantMessageId) return;
    onResendAssistantResponse?.(resendAssistantMessageId);
  };
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
  // The head signature carries this turn's time (hh:mm), so AssistantMessage owns
  // its own formatting — the parent row's label is a month/day string (D-9).
  const signatureTime = formatDisplayDate(message.created_at, display, {
    hour: "numeric",
    minute: "2-digit",
  });
  // Pair the display time with its ISO instant, or pass neither — the D-9 contract.
  const signature: MachineSignatureTime = signatureTime
    ? { timestamp: signatureTime, timestampIso: message.created_at }
    : {};

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
      {canBranchFromAssistant || canResendAssistant ? (
        <div className={styles.messageActions}>
          {canBranchFromAssistant ? (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<GitBranch size={14} aria-hidden="true" />}
              onClick={() => onReplyToAssistant?.(createBranchDraft())}
              aria-label="Fork from this answer"
            >
              Fork
            </Button>
          ) : null}
          {canResendAssistant ? (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<RefreshCcw size={14} aria-hidden="true" />}
              loading={resending}
              onClick={resendAssistant}
              aria-label="Resend response"
            >
              Resend
            </Button>
          ) : null}
        </div>
      ) : null}
      {message.status === "pending" ? <StreamingGutterCue /> : null}
      <MachineText origin={{ label: "Assistant" }} {...signature}>
        <ToolActivity toolCalls={toolCalls} />
        {renderAssistantBody ? (
          <AssistantEvidenceDisclosure
            message={message}
            citations={citations}
            answerRef={answerRef}
            onCitationActivate={onCitationActivate}
          />
        ) : null}
        <MessageFootnotes
          citations={citations}
          onCitationActivate={onCitationActivate}
        />
        {message.trust_trail ? (
          <AssistantWriteTrail
            conversationId={message.trust_trail.conversation_id}
            toolCalls={message.trust_trail.tool_calls}
          />
        ) : null}
        {message.trust_trail ? (
          <AssistantTrustInspector
            trustTrail={message.trust_trail}
            onCitationActivate={onCitationActivate}
          />
        ) : null}
        {message.status === "complete" && message.trust_trail?.run ? (
          <Colophon
            modelName={message.trust_trail.run.model_name}
            inputTokens={
              typeof message.trust_trail.run.usage?.input_tokens === "number"
                ? message.trust_trail.run.usage.input_tokens
                : null
            }
            outputTokens={
              typeof message.trust_trail.run.usage?.output_tokens === "number"
                ? message.trust_trail.run.usage.output_tokens
                : null
            }
            totalCostUsdMicros={message.trust_trail.run.total_cost_usd_micros}
            sourceCount={citations.length}
          />
        ) : null}
      </MachineText>
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

const ACTIVE_TOOL_LABELS: Record<string, string> = {
  web_search: "Searching web",
  app_search: "Searching library",
  read_resource: "Reading source",
  inspect_resource: "Inspecting source",
  add_to_library: "Filing to library",
  jot_note: "Writing note",
  create_highlight: "Highlighting passage",
  mint_edge: "Connecting resources",
  queue_add: "Adding to queue",
};

function ToolActivity({ toolCalls }: { toolCalls: MessageToolCall[] }) {
  const active = toolCalls.find((toolCall) =>
    ["running", "pending"].includes(toolCall.status),
  );
  if (!active) return null;
  const label = ACTIVE_TOOL_LABELS[active.tool_name] ?? `Running ${active.tool_name}`;

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
