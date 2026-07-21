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
import AssistantMessage from "./AssistantMessage";
import SystemMessage from "./SystemMessage";
import UserMessage from "./UserMessage";

interface MessageRowProps {
  message: ConversationMessage;
  forkOptions?: ForkOption[];
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  /** One durable rerun from the failed assistant turn (replaces retry/resend). */
  onRerunAssistantResponse?: (assistantMessageId: string) => void;
  rerunningAssistantMessageIds?: Set<string>;
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
  forkOptions = [],
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  onRerunAssistantResponse,
  rerunningAssistantMessageIds,
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
    formatDisplayDate(message.created_at, display, { month: "short", day: "numeric" }) ??
    "";

  switch (message.role) {
    case "user":
      return <UserMessage message={message} timestampLabel={timestampLabel} />;
    case "assistant":
      return (
        <AssistantMessage
          message={message}
          forkOptions={forkOptions}
          switchableLeafIds={switchableLeafIds}
          onSelectFork={onSelectFork}
          onReplyToAssistant={onReplyToAssistant}
          onCitationActivate={activateTarget}
          onRerunAssistantResponse={onRerunAssistantResponse}
          rerunning={rerunningAssistantMessageIds?.has(message.id) === true}
          connectionLost={connectionLostAssistantIds?.has(message.id) === true}
          onReconnectAssistant={onReconnectAssistant}
          onStartWalk={onStartWalk}
        />
      );
    case "system":
      return <SystemMessage message={message} timestampLabel={timestampLabel} />;
  }

  const _exhaustive: never = message.role;
  return _exhaustive;
});
