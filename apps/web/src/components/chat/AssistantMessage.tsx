"use client";

import { useMemo } from "react";
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
import { toReaderCitationData } from "@/lib/conversations/citations";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import AssistantSelectionPopover from "./AssistantSelectionPopover";
import AssistantAnswer from "./AssistantAnswer";
import AssistantDetails from "./AssistantDetails";
import AssistantWriteTrail from "./AssistantWriteTrail";
import ChatFailureCard from "./ChatFailureCard";
import ChatPublicationNotice from "./ChatPublicationNotice";
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
  connectionLost,
  onReconnectAssistant,
  timestampLabel,
}: {
  message: ConversationMessage;
  messageOrdinal: number;
  forkOptions: ForkOption[];
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  onCitationActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
  connectionLost?: boolean;
  onReconnectAssistant?: (assistantMessageId: string) => void;
  timestampLabel: string;
}) {
  const toolCalls = message.trust_trail?.tool_calls ?? [];
  // Citations are memoized once and shared by the answer and source disclosure.
  const citations = useMemo(
    () => (message.citations ?? []).map(toReaderCitationData),
    [message.citations],
  );
  const canBranchFromAssistant =
    message.status === "complete" && Boolean(onReplyToAssistant);
  // The one card-bearing failure read: the failure folds onto the run inside the
  // trust trail (null for a DEFECT → the generic card). A terminal message status
  // is what shows the card; a Fable `refused` failure SUPPRESSES all partial text
  // (the card is the only projection). Any rehydrated terminal status replaces the
  // client-only ConnectionLostStatusUnknown card.
  const trustRun = message.trust_trail?.run;
  const failure = trustRun?.failure ?? null;
  const supportId = trustRun?.support_id ?? absent();
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
  const showSuspendedCard = !isTerminal && executionPhase === "Suspended";
  const showReconnectCard =
    Boolean(connectionLost) && !isTerminal && !showSuspendedCard;

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
      !showSuspendedCard ? (
        <StreamingGutterCue />
      ) : null}
      {showSuspendedCard ? null : <ToolActivity toolCalls={toolCalls} />}
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
        <ChatFailureCard failure={failure} supportId={supportId} />
      ) : showSuspendedCard ? (
        <ChatFailureCard mode="suspended" />
      ) : showReconnectCard ? (
        <ChatFailureCard
          mode="reconnect"
          onReconnect={() => onReconnectAssistant?.(message.id)}
        />
      ) : null}
      {message.status !== "pending" ? (
        <div className={styles.messageActions}>
          <ResourceActionMenu
            actionSubject={{ ref: actionRef }}
            label="Actions for this answer"
            align="start"
          />
        </div>
      ) : null}
      {onSelectFork ? (
        <ForkStrip
          forks={forkOptions}
          switchableLeafIds={switchableLeafIds}
          onSelectFork={onSelectFork}
        />
      ) : null}
      <time className={styles.timestamp} dateTime={message.created_at}>
        {timestampLabel}
      </time>
    </div>
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
  const label =
    ACTIVE_TOOL_LABELS[active.tool_name] ?? `Running ${active.tool_name}`;

  return (
    <div className={styles.toolActivity} role="status" aria-live="polite">
      <Search size={14} aria-hidden="true" />
      <span>{label}</span>
      {active.input_preview ? (
        <span className={styles.toolActivityPreview}>
          {active.input_preview}
        </span>
      ) : null}
    </div>
  );
}
