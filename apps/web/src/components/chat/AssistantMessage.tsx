"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import { absent } from "@/lib/api/presence";
import type {
  BranchDraft,
  ConversationMessage,
  ForkOption,
  MessageToolCall,
} from "@/lib/conversations/types";
import { isAssistantPrimaryBodyVisible } from "@/lib/conversations/conversationPresentation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ChatConnectionRecovery } from "@/lib/conversations/chatConnectionRecovery";
import type { GenerationSelectionSpec } from "@/lib/conversations/generationCatalog";
import type { MessageActionMutationOutcome } from "@/lib/chat/messageActionIntent";
import { toReaderCitationData } from "@/lib/resourceGraph/citations";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import AssistantSelectionPopover from "./AssistantSelectionPopover";
import AssistantAnswer from "./AssistantAnswer";
import AssistantDetails from "./AssistantDetails";
import AssistantWriteTrail from "./AssistantWriteTrail";
import ChatFailureCard from "./ChatFailureCard";
import ChatPublicationNotice from "./ChatPublicationNotice";
import CandidateGenerationPicker from "./CandidateGenerationPicker";
import MessageSourcesDisclosure from "./MessageSourcesDisclosure";
import ForkStrip from "./ForkStrip";
import StreamingGutterCue from "./StreamingGutterCue";
import { useAssistantSelectionBranch } from "./useAssistantSelectionBranch";
import styles from "./MessageRow.module.css";

export default function AssistantMessage({
  message,
  messageOrdinal,
  forkOptions,
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  onCitationActivate,
  connectionRecovery,
  onReconnectAssistant,
  onRerun,
  onRerunWithSelection,
  onRegenerateWithSelection,
  rerunning,
  timestampLabel,
}: {
  message: ConversationMessage;
  messageOrdinal: number;
  forkOptions: ForkOption[];
  switchableLeafIds: Set<string>;
  onSelectFork: (fork: ForkOption) => void;
  onReplyToAssistant: (draft: BranchDraft) => void;
  onCitationActivate: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
  connectionRecovery?: ChatConnectionRecovery;
  onReconnectAssistant: (assistantMessageId: string) => void;
  onRerun?: () => Promise<MessageActionMutationOutcome>;
  onRerunWithSelection: (
    selection: GenerationSelectionSpec,
    catalogDefinitionRevision: string,
  ) => Promise<boolean>;
  onRegenerateWithSelection: (
    selection: GenerationSelectionSpec,
    catalogDefinitionRevision: string,
  ) => Promise<boolean>;
  rerunning: boolean;
  timestampLabel: string;
}) {
  const toolCalls = message.trust_trail?.tool_calls ?? [];
  // Citations are memoized once and shared by the answer and source disclosure.
  const citations = useMemo(
    () => (message.citations ?? []).map(toReaderCitationData),
    [message.citations],
  );
  const canBranchFromAssistant = message.status === "complete";
  // The one card-bearing failure read: the failure folds onto the run inside the
  // trust trail (null when no representable failure is stored → the generic
  // card). A terminal message status is what shows the card; any rehydrated
  // terminal status replaces client-only connection recovery.
  const trustRun = message.trust_trail?.run;
  const failure = trustRun?.failure ?? null;
  const supportId = trustRun?.support_id ?? absent();
  const [pickerOpenRequestVersion, requestPickerOpen] = useState(0);
  const isTerminalFailure =
    message.status === "error" || message.status === "cancelled";
  const showFailureCard = isTerminalFailure;
  // The reconnect card is a client-only state for an IN-FLIGHT run whose stream
  // dropped; any terminal status — including a rehydrated `complete` — replaces
  // it (§10), so gate on non-terminal, not merely non-failure.
  const isTerminal = isTerminalFailure || message.status === "complete";
  const executionPhase =
    trustRun?.execution.kind === "Present"
      ? trustRun.execution.value.phase
      : null;
  const cancelRequested =
    trustRun?.execution.kind === "Present" &&
    trustRun.execution.value.cancel_requested;
  const showSuspendedCard = !isTerminal && executionPhase === "Suspended";
  const showStopRequestedCard = !isTerminal && cancelRequested && !showSuspendedCard;
  const showReconnectCard =
    connectionRecovery !== undefined && !isTerminal && !showSuspendedCard;
  const progressLabel = !isTerminal && !showReconnectCard && !showStopRequestedCard
    ? executionPhase === "Queued"
      ? "Response queued"
      : executionPhase === "Recovering"
        ? "Recovering response"
        : null
    : null;

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
  const renderAssistantBody = isAssistantPrimaryBodyVisible(message);
  const actionRef = canonicalResourceRef({
    scheme: "message",
    id: message.id,
  });

  return (
    <div
      className={styles.message}
      data-message-id={message.id}
      data-role="assistant"
      role="group"
      aria-label="Assistant response"
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
    >
      {message.status === "pending" &&
      !showReconnectCard &&
      !showSuspendedCard &&
      !showStopRequestedCard ? (
        <StreamingGutterCue />
      ) : null}
      {showSuspendedCard || showStopRequestedCard ? null : <ToolActivity toolCalls={toolCalls} />}
      {progressLabel ? (
        <p className={styles.executionStatus} role="status">{progressLabel}</p>
      ) : null}
      {renderAssistantBody ? (
        <AssistantAnswer
          message={message}
          messageOrdinal={messageOrdinal}
          citations={citations}
          answerRef={answerRef}
          onCitationActivate={onCitationActivate}
        />
      ) : null}
      {trustRun?.publication_warning.kind === "Present" ? (
        <ChatPublicationNotice
          warning={trustRun.publication_warning.value}
          supportId={supportId}
        />
      ) : null}
      {message.trust_trail ? (
        <AssistantWriteTrail
          conversationId={message.trust_trail.conversation_id}
          toolCalls={message.trust_trail.tool_calls}
        />
      ) : null}
      <MessageSourcesDisclosure
        citations={citations}
        onCitationActivate={onCitationActivate}
      />
      {message.trust_trail ? (
        <AssistantDetails
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
      {showFailureCard ? (
        <ChatFailureCard
          failure={failure}
          supportId={supportId}
          canRerun={message.can_rerun}
          onRerun={onRerun
            ? () => {
                void onRerun().then((outcome) => {
                  if (outcome === "SelectionRequired")
                    requestPickerOpen((version) => version + 1);
                });
              }
            : undefined}
          rerunning={rerunning}
        />
      ) : showSuspendedCard ? (
        <ChatFailureCard mode="suspended" cancelRequested={Boolean(cancelRequested)} />
      ) : showStopRequestedCard ? (
        <ChatFailureCard mode="stop_requested" />
      ) : null}
      {showReconnectCard && connectionRecovery ? (
        <ChatFailureCard
          mode="reconnect"
          recovery={connectionRecovery}
          onReconnect={() => onReconnectAssistant(message.id)}
        />
      ) : null}
      {message.status !== "pending" ? (
        <div className={styles.messageActions}>
          {trustRun?.run_selection &&
          ((isTerminalFailure && message.can_rerun) ||
            message.status === "complete") ? (
            <CandidateGenerationPicker
              operation={isTerminalFailure ? "Rerun" : "Regenerate"}
              runSelection={trustRun.run_selection}
              disabled={rerunning}
              openRequestVersion={pickerOpenRequestVersion}
              onConfirm={(selection, catalogDefinitionRevision) => {
                if (isTerminalFailure) {
                  return onRerunWithSelection(
                    selection,
                    catalogDefinitionRevision,
                  );
                }
                return onRegenerateWithSelection(
                  selection,
                  catalogDefinitionRevision,
                );
              }}
            />
          ) : null}
          <ResourceActionMenu
            actionSubject={{ ref: actionRef }}
            label="Actions for this answer"
            align="start"
          />
        </div>
      ) : null}
      <ForkStrip
        forks={forkOptions}
        switchableLeafIds={switchableLeafIds}
        onSelectFork={onSelectFork}
      />
      <time className={styles.timestamp} dateTime={message.created_at}>
        {timestampLabel}
      </time>
    </div>
  );
}

function ToolActivity({ toolCalls }: { toolCalls: MessageToolCall[] }) {
  const active = toolCalls.find((toolCall) =>
    ["running", "pending"].includes(toolCall.status),
  );
  if (!active) return null;

  return (
    <div className={styles.toolActivity} role="status" aria-live="polite">
      <Search size={14} aria-hidden="true" />
      <span>{active.activity_label}</span>
      {active.input_preview ? (
        <span className={styles.toolActivityPreview}>
          {active.input_preview}
        </span>
      ) : null}
    </div>
  );
}
