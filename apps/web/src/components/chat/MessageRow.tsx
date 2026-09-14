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
  forkOptions?: ForkOption[];
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  /** One durable rerun from the failed assistant turn (replaces retry/resend). */
  onRerunAssistantResponse?: (
    assistantMessageId: string,
  ) => Promise<MessageActionMutationOutcome>;
  /** One durable regeneration from an eligible completed assistant answer. */
  onRegenerateAssistantResponse?: (
    assistantMessageId: string,
  ) => Promise<MessageActionMutationOutcome>;
  onDeleteMessage?: DeleteMessageMutation;
  /** Assistant ids in the client-only ConnectionLostStatusUnknown state (§10). */
  connectionLostAssistantIds?: Set<string>;
  onReconnectAssistant?: (assistantMessageId: string) => void;
  onReaderSourceActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
  onStartWalk?: (citations: CitationOut[], text: string) => void;
}

// Memoized so a streaming text delta — which replaces only the streaming
// message object and keeps every other row's props referentially stable —
// re-renders just that one row, not the whole transcript (AC-10).
export const MessageRow = memo(function MessageRow({
  message,
  messageOrdinal,
  forkOptions = [],
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  onRerunAssistantResponse,
  onRegenerateAssistantResponse,
  onDeleteMessage,
  connectionLostAssistantIds,
  onReconnectAssistant,
  onReaderSourceActivate,
  onStartWalk,
}: MessageRowProps) {
  const display = useRenderEnvironment();
  const activateTarget = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      event?: React.MouseEvent,
    ) => {
      onReaderSourceActivate?.(activation, target, event);
    },
    [onReaderSourceActivate],
  );

  const timestampLabel =
    formatDisplayDate(message.created_at, display, {
      month: "short",
      day: "numeric",
    }) ?? "";
  const actionRef = canonicalResourceRef({ scheme: "message", id: message.id });
  const acceptActionIntent = useCallback(
    (intent: MessageActionIntent) => {
      const settle = (
        mutation: (() => Promise<MessageActionMutationOutcome>) | undefined,
      ) => {
        if (!mutation || !("onCommitted" in intent)) return false;
        void settleMessageActionMutation(intent, mutation);
        return true;
      };
      switch (intent.kind) {
        case "ForkMessage":
          if (message.role !== "assistant" || !onReplyToAssistant) return false;
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
            !onStartWalk ||
            !message.citations ||
            message.citations.length < 2
          ) {
            return false;
          }
          onStartWalk(message.citations, conversationMessageText(message));
          return true;
        case "RerunMessage":
          if (message.role !== "assistant") return false;
          void settle(
            onRerunAssistantResponse
              ? () => onRerunAssistantResponse(message.id)
              : undefined,
          );
          return Boolean(onRerunAssistantResponse);
        case "RegenerateMessage":
          if (message.role !== "assistant") return false;
          void settle(
            onRegenerateAssistantResponse
              ? () => onRegenerateAssistantResponse(message.id)
              : undefined,
          );
          return Boolean(onRegenerateAssistantResponse);
        case "DeleteMessage":
          if (!onDeleteMessage) return false;
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

  switch (message.role) {
    case "user":
      return (
        <UserMessage
          message={message}
          messageOrdinal={messageOrdinal}
          timestampLabel={timestampLabel}
          onReaderSourceActivate={activateTarget}
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
          onCitationActivate={activateTarget}
          connectionLost={connectionLostAssistantIds?.has(message.id) === true}
          onReconnectAssistant={onReconnectAssistant}
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
