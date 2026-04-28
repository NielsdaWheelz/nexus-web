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
} from "@/lib/conversations/types";
import { useChatMessageUpdates } from "@/components/chat/useChatMessageUpdates";

type ChatRunData = ChatRunResponse["data"];

export function useChatRunTail({
  setMessages,
  shouldScrollRef,
  onRunFinished,
  onConversationAvailable,
}: {
  setMessages: Dispatch<SetStateAction<ConversationMessage[]>>;
  shouldScrollRef: MutableRefObject<boolean>;
  onRunFinished?: (runId: string) => void;
  onConversationAvailable?: (conversationId: string, runId: string) => void;
}) {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const activeStreamsRef = useRef<Map<string, () => void>>(new Map());
  const runTokensRef = useRef<Map<string, number>>(new Map());
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
        const replaceIds = new Set([
          ...idsToReplace,
          runData.user_message.id,
          runData.assistant_message.id,
        ]);
        const next: ConversationMessage[] = [];
        let inserted = false;

        for (const message of prev) {
          if (!replaceIds.has(message.id)) {
            next.push(message);
            continue;
          }
          if (!inserted) {
            next.push(runData.user_message, runData.assistant_message);
            inserted = true;
          }
        }

        if (!inserted) {
          next.push(runData.user_message, runData.assistant_message);
        }

        return next.sort((a, b) => a.seq - b.seq);
      });
    },
    [setMessages],
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
      if (activeStreamsRef.current.has(runId)) return;

      const originalUserId = runData.user_message.id;
      const originalAssistantId = runData.assistant_message.id;
      let currentUserId = originalUserId;
      let currentAssistantId = originalAssistantId;
      let replayDeltaCharsToSkip = 0;
      const token = (runTokensRef.current.get(runId) ?? 0) + 1;
      runTokensRef.current.set(runId, token);

      mergeRunMessages(runData);
      onConversationAvailable?.(runData.conversation.id, runId);

      if (
        runData.run.status === "complete" ||
        runData.run.status === "error" ||
        runData.run.status === "cancelled"
      ) {
        handleDone(
          runData.assistant_message.id,
          runData.run.status,
          runData.run.error_code,
        );
        onRunFinished?.(runId);
        return;
      }

      setActiveRunId(runId);
      activeStreamsRef.current.set(runId, () => {
        runTokensRef.current.set(runId, (runTokensRef.current.get(runId) ?? 0) + 1);
      });

      const reconcile = async () => {
        try {
          const response = await apiFetch<ChatRunResponse>(`/api/chat-runs/${runId}`);
          if (runTokensRef.current.get(runId) !== token) return null;
          flushDeltas();
          mergeRunMessages(response.data, [
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

          if (
            response.data.run.status === "complete" ||
            response.data.run.status === "error" ||
            response.data.run.status === "cancelled"
          ) {
            handleDone(
              currentAssistantId,
              response.data.run.status,
              response.data.run.error_code,
            );
            activeStreamsRef.current.delete(runId);
            setActiveRunId((current) => (current === runId ? null : current));
            onRunFinished?.(runId);
          }
          return response.data;
        } catch (err) {
          console.error("Failed to reconcile chat run:", err);
          activeStreamsRef.current.delete(runId);
          setActiveRunId((current) => (current === runId ? null : current));
          return null;
        }
      };

      const startStream = async (): Promise<void> => {
        if (runTokensRef.current.get(runId) !== token) return;
        let streamBaseUrl: string;
        let firstStreamToken: string | null = null;

        try {
          const tokenResponse = await fetchStreamToken();
          streamBaseUrl = tokenResponse.stream_base_url;
          firstStreamToken = tokenResponse.token;
        } catch (err) {
          console.error("Failed to fetch chat stream token:", err);
          await reconcile();
          activeStreamsRef.current.delete(runId);
          setActiveRunId((current) => (current === runId ? null : current));
          return;
        }

        if (runTokensRef.current.get(runId) !== token) return;

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
              switch (event.type) {
                case "meta":
                  currentUserId = event.data.user_message_id;
                  currentAssistantId = event.data.assistant_message_id;
                  handleMetaReceived(
                    originalUserId,
                    currentUserId,
                    originalAssistantId,
                    currentAssistantId,
                  );
                  onConversationAvailable?.(event.data.conversation_id, runId);
                  break;
                case "delta":
                  if (replayDeltaCharsToSkip > 0) {
                    if (event.data.delta.length <= replayDeltaCharsToSkip) {
                      replayDeltaCharsToSkip -= event.data.delta.length;
                      break;
                    }
                    handleDelta(
                      currentAssistantId,
                      event.data.delta.slice(replayDeltaCharsToSkip),
                    );
                    replayDeltaCharsToSkip = 0;
                    break;
                  }
                  handleDelta(currentAssistantId, event.data.delta);
                  break;
                case "tool_call":
                  handleToolCall(currentAssistantId, event.data);
                  break;
                case "tool_result":
                  handleToolResult(currentAssistantId, event.data);
                  break;
                case "citation":
                  handleCitation(currentAssistantId, event.data);
                  break;
                case "done":
                  handleDone(
                    currentAssistantId,
                    event.data.status,
                    event.data.error_code,
                  );
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
              activeStreamsRef.current.delete(runId);
              void reconcile();
            },
            onComplete: (terminalEventSeen) => {
              if (runTokensRef.current.get(runId) !== token) return;
              activeStreamsRef.current.delete(runId);
              void (async () => {
                const persisted = await reconcile();
                if (
                  persisted &&
                  !terminalEventSeen &&
                  persisted.run.status !== "complete" &&
                  persisted.run.status !== "error" &&
                  persisted.run.status !== "cancelled"
                ) {
                  replayDeltaCharsToSkip = persisted.assistant_message.content.length;
                  await startStream();
                }
              })();
            },
          },
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
      onConversationAvailable,
      onRunFinished,
    ],
  );

  useEffect(() => abortAll, [abortAll]);

  return {
    activeRunId,
    abortAll,
    tailChatRun,
  };
}
