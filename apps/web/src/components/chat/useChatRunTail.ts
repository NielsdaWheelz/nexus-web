"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { apiFetch } from "@/lib/api/client";
import { sseClientDirect, type SSEEvent } from "@/lib/api/sse";
import { fetchStreamToken } from "@/lib/api/streamToken";
import type {
  ChatRunResponse,
  ConversationMessage,
  ForkOption,
} from "@/lib/conversations/types";
import { useChatMessageUpdates } from "@/components/chat/useChatMessageUpdates";
import {
  selectedPathAfterRun,
  upsertForkOptionForRun,
} from "@/lib/conversations/branching";

type ChatRunData = ChatRunResponse["data"];
type TerminalRunStatus = "complete" | "error" | "cancelled";
type RunVisibilityTarget = {
  runId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
};

const CHAT_STREAM_RETRY_BASE_MS = 1000;
const CHAT_STREAM_RETRY_MAX_MS = 8000;
const CHAT_STREAM_RETRY_JITTER_MS = 250;

function isTerminalRunStatus(
  status: ChatRunData["run"]["status"],
): status is TerminalRunStatus {
  return status === "complete" || status === "error" || status === "cancelled";
}

function chatStreamRetryDelayMs(attempt: number): number {
  return (
    Math.min(CHAT_STREAM_RETRY_BASE_MS * 2 ** attempt, CHAT_STREAM_RETRY_MAX_MS) +
    Math.floor(Math.random() * CHAT_STREAM_RETRY_JITTER_MS)
  );
}

export function useChatRunTail({
  setMessages,
  setForkOptionsByParentId,
  shouldScrollRef,
  onRunFinished,
  onFirstDelta,
  onRunDone,
  onConversationAvailable,
  shouldApplyRun,
}: {
  setMessages: Dispatch<SetStateAction<ConversationMessage[]>>;
  setForkOptionsByParentId?: Dispatch<SetStateAction<Record<string, ForkOption[]>>>;
  shouldScrollRef: MutableRefObject<boolean>;
  onRunFinished?: (runId: string) => void;
  onFirstDelta?: (runId: string) => void;
  onRunDone?: (runId: string, status: TerminalRunStatus, errorCode: string | null) => void;
  onConversationAvailable?: (conversationId: string, runId: string) => void;
  shouldApplyRun?: (target: RunVisibilityTarget) => boolean;
}) {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const activeStreamsRef = useRef<Map<string, () => void>>(new Map());
  const runTokensRef = useRef<Map<string, number>>(new Map());
  const firstDeltaRunIdsRef = useRef<Set<string>>(new Set());
  const {
    handleMetaReceived,
    handleDelta,
    handleToolCall,
    handleToolResult,
    handleCitation,
    handleDone,
    flushDeltas,
  } = useChatMessageUpdates({ setMessages, shouldScrollRef });

  const mergeRunMessages = useCallback(
    (
      runData: ChatRunData,
      idsToReplace: string[] = [
        runData.user_message.id,
        runData.assistant_message.id,
      ],
    ) => {
      setMessages((prev) => {
        return selectedPathAfterRun(prev, runData, idsToReplace);
      });
      setForkOptionsByParentId?.((prev) => upsertForkOptionForRun(prev, runData));
    },
    [setForkOptionsByParentId, setMessages],
  );

  const abortAll = useCallback(() => {
    for (const abort of activeStreamsRef.current.values()) {
      abort();
    }
    activeStreamsRef.current.clear();
    for (const runId of runTokensRef.current.keys()) {
      runTokensRef.current.set(runId, (runTokensRef.current.get(runId) ?? 0) + 1);
    }
    setActiveRunId(null);
  }, []);

  const tailChatRun = useCallback(
    async (runData: ChatRunData) => {
      const runId = runData.run.id;

      const originalUserId = runData.user_message.id;
      const originalAssistantId = runData.assistant_message.id;
      let currentUserId = originalUserId;
      let currentAssistantId = originalAssistantId;
      let lastEventId = "";
      let replayDeltaCharsToSkip = 0;
      let retryAttempt = 0;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let doneNotified = false;
      let finished = false;
      const token = (runTokensRef.current.get(runId) ?? 0) + 1;

      const runIsVisible = (
        data: ChatRunData,
        userMessageId: string,
        assistantMessageId: string,
      ) =>
        shouldApplyRun?.({
          runId,
          conversationId: data.conversation.id,
          userMessageId,
          assistantMessageId,
        }) ?? true;

      const currentRunIsVisible = () =>
        runIsVisible(runData, currentUserId, currentAssistantId);

      const mergeRunMessagesIfVisible = (
        data: ChatRunData,
        idsToReplace?: string[],
      ) => {
        if (!runIsVisible(data, data.user_message.id, data.assistant_message.id)) {
          return;
        }
        mergeRunMessages(data, idsToReplace);
      };

      if (activeStreamsRef.current.has(runId)) {
        mergeRunMessagesIfVisible(runData);
        return;
      }

      runTokensRef.current.set(runId, token);

      mergeRunMessagesIfVisible(runData);
      onConversationAvailable?.(runData.conversation.id, runId);

      const clearRetryTimer = () => {
        if (retryTimer === null) return;
        clearTimeout(retryTimer);
        retryTimer = null;
      };

      const notifyDone = (status: TerminalRunStatus, errorCode: string | null) => {
        if (doneNotified) return;
        doneNotified = true;
        onRunDone?.(runId, status, errorCode);
      };

      const finishRun = () => {
        if (finished) return;
        finished = true;
        clearRetryTimer();
        activeStreamsRef.current.delete(runId);
        setActiveRunId((current) => (current === runId ? null : current));
        onRunFinished?.(runId);
      };

      if (isTerminalRunStatus(runData.run.status)) {
        if (currentRunIsVisible()) {
          handleDone(
            runData.assistant_message.id,
            runData.run.status,
            runData.run.error_code,
          );
        }
        notifyDone(runData.run.status, runData.run.error_code);
        finishRun();
        return;
      }

      setActiveRunId(runId);
      activeStreamsRef.current.set(runId, clearRetryTimer);

      const reconcile = async () => {
        try {
          const response = await apiFetch<ChatRunResponse>(`/api/chat-runs/${runId}`);
          if (runTokensRef.current.get(runId) !== token) return null;
          flushDeltas();
          mergeRunMessagesIfVisible(response.data, [
            originalUserId,
            originalAssistantId,
            currentUserId,
            currentAssistantId,
            response.data.user_message.id,
            response.data.assistant_message.id,
          ]);
          onConversationAvailable?.(response.data.conversation.id, runId);
          currentUserId = response.data.user_message.id;
          currentAssistantId = response.data.assistant_message.id;

          if (isTerminalRunStatus(response.data.run.status)) {
            if (currentRunIsVisible()) {
              handleDone(
                currentAssistantId,
                response.data.run.status,
                response.data.run.error_code,
              );
            }
            notifyDone(response.data.run.status, response.data.run.error_code);
            finishRun();
          }
          return response.data;
        } catch (err) {
          console.error("Failed to reconcile chat run:", err);
          return null;
        }
      };

      const continueAfterStreamBoundary = async (terminalEventSeen: boolean) => {
        const persisted = await reconcile();
        if (runTokensRef.current.get(runId) !== token || finished) return;
        if (terminalEventSeen) {
          finishRun();
          return;
        }
        if (persisted) {
          replayDeltaCharsToSkip = persisted.assistant_message.content.length;
        }
        const delayMs = chatStreamRetryDelayMs(retryAttempt);
        retryAttempt += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void startStream();
        }, delayMs);
        activeStreamsRef.current.set(runId, clearRetryTimer);
      };

      const startStream = async (): Promise<void> => {
        if (runTokensRef.current.get(runId) !== token || finished) return;
        clearRetryTimer();
        let streamBaseUrl: string;
        let firstStreamToken: string | null = null;

        try {
          const tokenResponse = await fetchStreamToken();
          streamBaseUrl = tokenResponse.stream_base_url;
          firstStreamToken = tokenResponse.token;
        } catch (err) {
          console.error("Failed to fetch chat stream token:", err);
          await continueAfterStreamBoundary(false);
          return;
        }

        if (runTokensRef.current.get(runId) !== token || finished) return;

        const abort = sseClientDirect(
          streamBaseUrl,
          async () => {
            if (firstStreamToken !== null) {
              const streamToken = firstStreamToken;
              firstStreamToken = null;
              return streamToken;
            }
            return (await fetchStreamToken()).token;
          },
          runId,
          {
            onEvent: (event: SSEEvent) => {
              if (runTokensRef.current.get(runId) !== token) return;
              retryAttempt = 0;
              switch (event.type) {
                case "meta":
                  currentUserId = event.data.user_message_id;
                  currentAssistantId = event.data.assistant_message_id;
                  if (currentRunIsVisible()) {
                    handleMetaReceived(
                      originalUserId,
                      currentUserId,
                      originalAssistantId,
                      currentAssistantId,
                    );
                  }
                  onConversationAvailable?.(event.data.conversation_id, runId);
                  break;
                case "delta":
                  if (currentRunIsVisible() && !firstDeltaRunIdsRef.current.has(runId)) {
                    firstDeltaRunIdsRef.current.add(runId);
                    onFirstDelta?.(runId);
                  }
                  if (replayDeltaCharsToSkip > 0) {
                    if (event.data.delta.length <= replayDeltaCharsToSkip) {
                      replayDeltaCharsToSkip -= event.data.delta.length;
                      break;
                    }
                    const remainingDelta = event.data.delta.slice(replayDeltaCharsToSkip);
                    replayDeltaCharsToSkip = 0;
                    if (!currentRunIsVisible()) break;
                    handleDelta(currentAssistantId, remainingDelta);
                    break;
                  }
                  if (!currentRunIsVisible()) break;
                  handleDelta(currentAssistantId, event.data.delta);
                  break;
                case "tool_call":
                  if (!currentRunIsVisible()) break;
                  handleToolCall(currentAssistantId, event.data);
                  break;
                case "tool_result":
                  if (!currentRunIsVisible()) break;
                  handleToolResult(currentAssistantId, event.data);
                  break;
                case "citation":
                  if (!currentRunIsVisible()) break;
                  handleCitation(currentAssistantId, event.data);
                  break;
                case "done":
                  if (currentRunIsVisible()) {
                    handleDone(
                      currentAssistantId,
                      event.data.status,
                      event.data.error_code,
                    );
                  }
                  notifyDone(event.data.status, event.data.error_code);
                  break;
                default: {
                  const _exhaustive: never = event;
                  return _exhaustive;
                }
              }
            },
            onError: (err) => {
              if (runTokensRef.current.get(runId) !== token) return;
              console.error("Chat run stream failed:", err);
              void continueAfterStreamBoundary(false);
            },
            onComplete: (terminalEventSeen) => {
              if (runTokensRef.current.get(runId) !== token) return;
              void continueAfterStreamBoundary(terminalEventSeen);
            },
            onLastEventId: (id) => {
              lastEventId = id;
            },
          },
          lastEventId ? { lastEventId } : undefined,
        );
        activeStreamsRef.current.set(runId, abort);
      };

      await startStream();
    },
    [
      handleCitation,
      handleDelta,
      handleDone,
      handleMetaReceived,
      handleToolCall,
      handleToolResult,
      flushDeltas,
      mergeRunMessages,
      onFirstDelta,
      onConversationAvailable,
      onRunDone,
      onRunFinished,
      shouldApplyRun,
    ],
  );

  useEffect(() => abortAll, [abortAll]);

  return {
    activeRunId,
    abortAll,
    tailChatRun,
  };
}
