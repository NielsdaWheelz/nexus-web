"use client";

import { useCallback, useMemo } from "react";
import { GitBranch, Search } from "lucide-react";
import Button from "@/components/ui/Button";
import MachineText, { type MachineSignatureTime } from "@/components/ui/MachineText";
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
import type { CitationOut } from "@/lib/conversations/citationOut";
import AssistantSelectionPopover from "./AssistantSelectionPopover";
import AssistantEvidenceDisclosure from "./AssistantEvidenceDisclosure";
import AssistantTrustInspector, { AssistantWriteTrail } from "./AssistantTrustInspector";
import ChatFailureCard from "./ChatFailureCard";
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
  onRerunAssistantResponse,
  rerunning,
  connectionLost,
  onReconnectAssistant,
  onStartWalk,
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
  onRerunAssistantResponse?: (assistantMessageId: string) => void;
  rerunning?: boolean;
  connectionLost?: boolean;
  onReconnectAssistant?: (assistantMessageId: string) => void;
  onStartWalk?: (citations: CitationOut[], text: string) => void;
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
  const canWalk =
    !!onStartWalk &&
    message.status === "complete" &&
    (message.citations?.length ?? 0) >= 2;

  // The one card-bearing failure read: the failure folds onto the run inside the
  // trust trail (null for a DEFECT → the generic card). A terminal message status
  // is what shows the card; a Fable `refused` failure SUPPRESSES all partial text
  // (the card is the only projection). Any rehydrated terminal status replaces the
  // client-only ConnectionLostStatusUnknown card.
  const failure = message.trust_trail?.run?.failure ?? null;
  const isRefused = failure?.code === "refused";
  const isTerminalFailure =
    message.status === "error" || message.status === "cancelled";
  const showFailureCard = isTerminalFailure;
  // The reconnect card is a client-only state for an IN-FLIGHT run whose stream
  // dropped; any terminal status — including a rehydrated `complete` — replaces
  // it (§10), so gate on non-terminal, not merely non-failure.
  const isTerminal = isTerminalFailure || message.status === "complete";
  const showReconnectCard = Boolean(connectionLost) && !isTerminal;

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
  const renderAssistantBody = isRefused
    ? false
    : showFailureCard
      ? assistantText.trim().length > 0
      : true;
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
      {canBranchFromAssistant || canWalk ? (
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
          {canWalk ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onStartWalk!(message.citations!, conversationMessageText(message))
              }
              aria-label="Walk the sources"
            >
              Walk
            </Button>
          ) : null}
        </div>
      ) : null}
      {message.status === "pending" && !showReconnectCard ? (
        <StreamingGutterCue />
      ) : null}
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
            modelName={message.trust_trail.run.model_name ?? ""}
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
      {showFailureCard ? (
        <ChatFailureCard
          failure={failure}
          canRerun={message.can_rerun}
          rerunning={rerunning}
          onRerun={
            onRerunAssistantResponse
              ? () => onRerunAssistantResponse(message.id)
              : undefined
          }
        />
      ) : showReconnectCard ? (
        <ChatFailureCard
          mode="reconnect"
          onReconnect={() => onReconnectAssistant?.(message.id)}
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
