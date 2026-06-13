"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  toChatSSEEvent,
  type SSEEvent,
  type SSEContextRefAddedEvent,
} from "@/lib/api/sse/events";
import type { SseBackoffConfig } from "@/lib/api/sse-client";
import { openGenerationRunStream } from "@/lib/api/useGenerationRun";
import type {
  ChatRunResponse,
  ConversationMessage,
  ForkOption,
} from "@/lib/conversations/types";
import { conversationMessageText } from "@/lib/conversations/types";
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

const CHAT_STREAM_MAX_RECONNECTS = 8;
const CHAT_STREAM_BACKOFF: SseBackoffConfig = {
  baseMs: 1000,
  maxMs: 8000,
  jitterMs: 250,
};

function isTerminalRunStatus(
  status: ChatRunData["run"]["status"],
): status is TerminalRunStatus {
  return status === "complete" || status === "error" || status === "cancelled";
}

export function useChatRunTail({
  setMessages,
  setForkOptionsByParentId,
  onRunFinished,
  onFirstDelta,
  onRunDone,
  onConversationAvailable,
  onContextRefAdded,
  shouldStartRun,
  shouldApplyRun,
}: {
  setMessages: Dispatch<SetStateAction<ConversationMessage[]>>;
  setForkOptionsByParentId?: Dispatch<SetStateAction<Record<string, ForkOption[]>>>;
  onRunFinished?: (runId: string) => void;
  onFirstDelta?: (runId: string) => void;
  onRunDone?: (runId: string, status: TerminalRunStatus, errorCode: string | null) => void;
  onConversationAvailable?: (conversationId: string, runId: string) => void;
  onContextRefAdded?: (data: SSEContextRefAddedEvent["data"]) => void;
  shouldStartRun?: (target: RunVisibilityTarget) => boolean;
  shouldApplyRun?: (target: RunVisibilityTarget) => boolean;
}) {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const activeStreamsRef = useRef<Map<string, () => void>>(new Map());
  const runTokensRef = useRef<Map<string, number>>(new Map());
  const firstDeltaRunIdsRef = useRef<Set<string>>(new Set());
  const {
    handleMetaReceived,
    handleDelta,
    handleToolCall,
    handleToolResult,
    handleCitationIndex,
    handleContextRefAdded,
    handleDone,
    flushDeltas,
  } = useChatMessageUpdates({ setMessages, onContextRefAdded });

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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortAll();
    };
  }, [abortAll]);

  const tailChatRun = useCallback(
    async (runData: ChatRunData) => {
      if (!mountedRef.current) return;
      const runId = runData.run.id;

      const originalUserId = runData.user_message.id;
      const originalAssistantId = runData.assistant_message.id;
      let currentUserId = originalUserId;
      let currentAssistantId = originalAssistantId;
      let replayDeltaCharsToSkip = 0;
      let doneNotified = false;
      let finished = false;
      let streamDoneSeen = false;
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

      const runCanStart = () =>
        mountedRef.current &&
        (shouldStartRun?.({
          runId,
          conversationId: runData.conversation.id,
          userMessageId: currentUserId,
          assistantMessageId: currentAssistantId,
        }) ??
          true);

      const mergeRunMessagesIfVisible = (
        data: ChatRunData,
        idsToReplace?: string[],
      ) => {
        if (!runIsVisible(data, data.user_message.id, data.assistant_message.id)) {
          return;
        }
        mergeRunMessages(data, idsToReplace);
      };

      if (!runCanStart()) return;

      if (activeStreamsRef.current.has(runId)) {
        mergeRunMessagesIfVisible(runData);
        return;
      }

      runTokensRef.current.set(runId, token);

      mergeRunMessagesIfVisible(runData);
      onConversationAvailable?.(runData.conversation.id, runId);

      // Aborting this stops the SSE connection (its signal feeds the opener) and,
      // because the opener honors the signal post-mint, also cancels a tail that
      // is superseded (abortAll) or finished mid-token-mint.
      const streamAbort = new AbortController();

      const notifyDone = (status: TerminalRunStatus, errorCode: string | null) => {
        if (doneNotified) return;
        doneNotified = true;
        onRunDone?.(runId, status, errorCode);
      };

      const finishRun = () => {
        if (finished) return;
        finished = true;
        streamAbort.abort();
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
      activeStreamsRef.current.set(runId, () => streamAbort.abort());

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
          if (handleUnauthenticatedApiError(err)) return null;
          console.error("Failed to reconcile chat run:", err);
          return null;
        }
      };

      const startStream = async (): Promise<void> => {
        if (runTokensRef.current.get(runId) !== token || finished || !runCanStart()) {
          finishRun();
          return;
        }

        try {
          await openGenerationRunStream<SSEEvent>("chat-runs", runId, {
            decode: toChatSSEEvent,
            isTerminal: (event) => event.type === "done",
            onEvent: (event) => {
              if (runTokensRef.current.get(runId) !== token) return;
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
                case "retrieval_result":
                  if (!currentRunIsVisible()) break;
                  handleToolResult(currentAssistantId, event.data);
                  break;
                case "citation_index":
                  if (!currentRunIsVisible()) break;
                  handleCitationIndex(currentAssistantId, event.data);
                  break;
                case "context_ref_added":
                  handleContextRefAdded(currentAssistantId, event.data);
                  break;
                case "done":
                  streamDoneSeen = true;
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
            // A recoverable boundary (network/401/5xx/clean-EOF/interrupt) before a
            // terminal event: reconcile against the persisted run, then either stop
            // (the run is terminal in the DB) or resume — skipping the assistant
            // text already persisted so the reconnect doesn't double-render deltas.
            onReconnect: async () => {
              const persisted = await reconcile();
              if (runTokensRef.current.get(runId) !== token || finished) {
                return "stop";
              }
              replayDeltaCharsToSkip = persisted
                ? conversationMessageText(persisted.assistant_message).length
                : 0;
              return "continue";
            },
            onError: (err) => {
              if (runTokensRef.current.get(runId) !== token || finished) return;
              // Reconnect budget exhausted (or a fatal stream error). Reconcile one
              // last time — the run may have completed in the DB exactly as the
              // stream died — and only surface the interruption if it did not.
              console.error("Chat run stream failed:", err);
              void (async () => {
                await reconcile();
                if (runTokensRef.current.get(runId) !== token || finished) return;
                if (currentRunIsVisible()) {
                  handleDone(currentAssistantId, "error", "E_STREAM_INTERRUPTED");
                }
                notifyDone("error", "E_STREAM_INTERRUPTED");
                finishRun();
              })();
            },
            onComplete: (terminalEventSeen) => {
              // Terminal events still reconcile so the backend-built trust trail wins.
              if (runTokensRef.current.get(runId) !== token) return;
              if (!terminalEventSeen || !streamDoneSeen) {
                finishRun();
                return;
              }
              void (async () => {
                await reconcile();
                if (runTokensRef.current.get(runId) !== token || finished) return;
                finishRun();
              })();
            },
            // The client owns Last-Event-ID resumption across its own reconnects;
            // a fresh tail always starts from the stream head.
            maxReconnects: CHAT_STREAM_MAX_RECONNECTS,
            backoff: CHAT_STREAM_BACKOFF,
            // Aborts the live stream on finish/supersede; the opener also honors
            // it post-mint, so a tail superseded mid-token-mint never connects.
            signal: streamAbort.signal,
          });
        } catch (err) {
          // First-token mint failed. 401 hands off to the auth boundary; anything
          // else mirrors onError — the run may already be terminal in the DB, so
          // reconcile once and only surface the interruption if it did not finish.
          if (handleUnauthenticatedApiError(err)) return;
          console.error("Failed to open chat run stream:", err);
          await reconcile();
          if (runTokensRef.current.get(runId) !== token || finished) return;
          if (currentRunIsVisible()) {
            handleDone(currentAssistantId, "error", "E_STREAM_INTERRUPTED");
          }
          notifyDone("error", "E_STREAM_INTERRUPTED");
          finishRun();
          return;
        }

        // Superseded (abortAll bumped the token) or unmounted during the mint:
        // the opener skipped connecting; still run finish orchestration.
        if (runTokensRef.current.get(runId) !== token || finished || !runCanStart()) {
          finishRun();
        }
      };

      await startStream();
    },
    [
      handleDelta,
      handleDone,
      handleMetaReceived,
      handleToolCall,
      handleToolResult,
      handleCitationIndex,
      handleContextRefAdded,
      flushDeltas,
      mergeRunMessages,
      onFirstDelta,
      onConversationAvailable,
      onRunDone,
      onRunFinished,
      shouldApplyRun,
      shouldStartRun,
    ],
  );

  return {
    activeRunId,
    abortAll,
    tailChatRun,
  };
}
