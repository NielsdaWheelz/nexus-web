"use client";

import { memo, useCallback } from "react";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import type {
  BranchDraft,
  ConversationMessage,
  ForkOption,
} from "@/lib/conversations/types";
import type { CitationOut } from "@/lib/conversations/citationOut";
import type { ChatConnectionRecovery } from "@/lib/conversations/chatConnectionRecovery";
import type { GenerationSelectionSpec } from "@/lib/conversations/generationCatalog";
import {
  settleMessageActionMutation,
  useMessageActionIntentOwner,
  type DeleteMessageMutation,
  type MessageActionIntent,
  type MessageActionMutationOutcome,
} from "@/lib/chat/messageActionIntent";
import { executeDestructiveMountedMutation } from "@/lib/actions/mountedActionHandoff";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { conversationMessageText } from "@/lib/conversations/types";
import AssistantMessage from "./AssistantMessage";
import SystemMessage from "./SystemMessage";
import UserMessage from "./UserMessage";

interface MessageRowProps {
  message: ConversationMessage;
  messageOrdinal: number;
  forkOptions: ForkOption[];
  switchableLeafIds: Set<string>;
  onSelectFork: (fork: ForkOption) => void;
  onReplyToAssistant: (draft: BranchDraft) => void;
  /** One durable rerun from the failed assistant turn (replaces retry/resend). */
  onRerunAssistantResponse: (
    assistantMessageId: string,
  ) => Promise<MessageActionMutationOutcome>;
  rerunning: boolean;
  onRerunAssistantResponseWithSelection: (
    assistantMessageId: string,
    selection: GenerationSelectionSpec,
    catalogDefinitionRevision: string,
  ) => Promise<MessageActionMutationOutcome>;
  /** One durable regeneration from an eligible completed assistant answer. */
  onRegenerateAssistantResponse: (
    assistantMessageId: string,
  ) => Promise<MessageActionMutationOutcome>;
  onRegenerateAssistantResponseWithSelection: (
    assistantMessageId: string,
    selection: GenerationSelectionSpec,
    catalogDefinitionRevision: string,
  ) => Promise<MessageActionMutationOutcome>;
  onDeleteMessage: DeleteMessageMutation;
  /** Client-only recovery for this assistant's interrupted live tail. */
  connectionRecovery?: ChatConnectionRecovery;
  onReconnectAssistant: (assistantMessageId: string) => void;
  onReaderSourceActivate: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
  onStartWalk: (citations: CitationOut[], text: string) => void;
}

// Memoized so a streaming text delta — which replaces only the streaming
// message object and keeps every other row's props referentially stable —
// re-renders just that one row, not the whole transcript (AC-10).
export const MessageRow = memo(function MessageRow({
  message,
  messageOrdinal,
  forkOptions,
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  onRerunAssistantResponse,
  rerunning,
  onRerunAssistantResponseWithSelection,
  onRegenerateAssistantResponse,
  onRegenerateAssistantResponseWithSelection,
  onDeleteMessage,
  connectionRecovery,
  onReconnectAssistant,
  onReaderSourceActivate,
  onStartWalk,
}: MessageRowProps) {
  const display = useRenderEnvironment();

  const timestampLabel =
    formatDisplayDate(message.created_at, display, {
      month: "short",
      day: "numeric",
    }) ?? "";
  const actionRef = canonicalResourceRef({ scheme: "message", id: message.id });
  const acceptActionIntent = useCallback(
    (intent: MessageActionIntent) => {
      const settle = (
        mutation: () => Promise<MessageActionMutationOutcome>,
      ) => {
        if (!("onCommitted" in intent)) return;
        void settleMessageActionMutation(intent, mutation);
      };
      switch (intent.kind) {
        case "ForkMessage":
          if (message.role !== "assistant") return false;
          onReplyToAssistant({
            parentMessageId: message.id,
            parentMessageSeq: message.seq,
            parentMessagePreview: conversationMessageText(message),
            anchor: { kind: "assistant_message", message_id: message.id },
          });
          return true;
        case "WalkMessageSources":
          if (
            message.role !== "assistant" ||
            !message.citations ||
            message.citations.length < 2
          ) {
            return false;
          }
          onStartWalk(message.citations, conversationMessageText(message));
          return true;
        case "RerunMessage":
          if (message.role !== "assistant") return false;
          settle(() => onRerunAssistantResponse(message.id));
          return true;
        case "RegenerateMessage":
          if (message.role !== "assistant") return false;
          settle(() => onRegenerateAssistantResponse(message.id));
          return true;
        case "DeleteMessage":
          void onDeleteMessage(
            message.id,
            (command, projectCommitted) =>
              executeDestructiveMountedMutation(
                intent,
                command,
                projectCommitted,
              ),
            intent.settleDeletedConversation,
          );
          return true;
      }
    },
    [
      message,
      onDeleteMessage,
      onRegenerateAssistantResponse,
      onReplyToAssistant,
      onRerunAssistantResponse,
      onStartWalk,
    ],
  );
  useMessageActionIntentOwner(actionRef, acceptActionIntent);

  const rerunFromFailureCard = useCallback(() => {
    if (message.role !== "assistant" || !message.can_rerun) return;
    void onRerunAssistantResponse(message.id);
  }, [
    message.can_rerun,
    message.id,
    message.role,
    onRerunAssistantResponse,
  ]);

  switch (message.role) {
    case "user":
      return (
        <UserMessage
          message={message}
          messageOrdinal={messageOrdinal}
          timestampLabel={timestampLabel}
          onReaderSourceActivate={onReaderSourceActivate}
        />
      );
    case "assistant":
      return (
        <AssistantMessage
          message={message}
          messageOrdinal={messageOrdinal}
          forkOptions={forkOptions}
          switchableLeafIds={switchableLeafIds}
          onSelectFork={onSelectFork}
          onReplyToAssistant={onReplyToAssistant}
          onCitationActivate={onReaderSourceActivate}
          connectionRecovery={connectionRecovery}
          onReconnectAssistant={onReconnectAssistant}
          onRerun={message.can_rerun ? rerunFromFailureCard : undefined}
          rerunning={rerunning}
          onRerunWithSelection={async (selection, revision) =>
            (await onRerunAssistantResponseWithSelection(
              message.id,
              selection,
              revision,
            )) === "Committed"
          }
          onRegenerateWithSelection={async (selection, revision) =>
            (await onRegenerateAssistantResponseWithSelection(
              message.id,
              selection,
              revision,
            )) === "Committed"
          }
          timestampLabel={timestampLabel}
        />
      );
    case "system":
      return (
        <SystemMessage
          message={message}
          messageOrdinal={messageOrdinal}
          timestampLabel={timestampLabel}
        />
      );
  }

  const _exhaustive: never = message.role;
  return _exhaustive;
});
