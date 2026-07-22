"use client";

import {
  useCallback,
  useEffect,
  useMemo,
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
  ForkOption,
  MessageToolCall,
} from "@/lib/conversations/types";
import type { MessageUpdateAction } from "@/lib/conversations/messageUpdateReducer";
import {
  createRunVisibility,
  type RunVisibilityContext,
} from "@/lib/conversations/runVisibility";
import { useChatMessageUpdates } from "@/components/chat/useChatMessageUpdates";
import { PerRunStreamContext } from "@/components/chat/perRunStreamContext";
import { upsertForkOptionForRun } from "@/lib/conversations/branching";
import { decodeRunDataReaderSelection } from "@/lib/conversations/messageWire";

type ChatRunData = ChatRunResponse["data"];
type TerminalRunStatus = "complete" | "error" | "cancelled";

/**
 * ConnectionLostStatusUnknown — a CLIENT-ONLY tail state (§10). It is never
 * persisted, never an SSE event, and never a server failure: it is the local
 * fact that the live stream dropped and, after the bounded auto-reconnect
 * budget, could not confirm the run's status. It is keyed by the assistant
 * message id so a message row can render the single `Reconnect` action, which
 * resumes the tail from `last_cursor`. Any rehydrated server state (a terminal
 * run status folded onto the message) replaces it.
 */
interface ConnectionLostStatusUnknown {
  run_id: string;
  last_cursor: string;
}

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

function mergeStreamToolCalls(
  existing: MessageToolCall[],
  live: MessageToolCall[],
): MessageToolCall[] {
  const merged = existing.map((call) => {
    const preview = live.find(
      (item) => item.tool_call_index === call.tool_call_index,
    )?.input_preview;
    return preview ? { ...call, input_preview: preview } : call;
  });
  for (const item of live) {
    if (!existing.some((call) => call.tool_call_index === item.tool_call_index)) {
      merged.push(item);
    }
  }
  return merged;
}

export function useChatRunTail({
  dispatch,
  setForkOptionsByParentId,
  onRunFinished,
  onFirstDelta,
  onRunDone,
  onConversationAvailable,
  onContextRefAdded,
  shouldStartRun,
  shouldApplyRun,
}: {
  dispatch: (action: MessageUpdateAction) => void;
  setForkOptionsByParentId?: Dispatch<SetStateAction<Record<string, ForkOption[]>>>;
  onRunFinished?: (runId: string) => void;
  onFirstDelta?: (runId: string) => void;
  onRunDone?: (runId: string, status: TerminalRunStatus) => void;
  onConversationAvailable?: (conversationId: string, runId: string) => void;
  onContextRefAdded?: (data: SSEContextRefAddedEvent["data"]) => void;
  shouldStartRun?: (ctx: RunVisibilityContext) => boolean;
  shouldApplyRun?: (ctx: RunVisibilityContext) => boolean;
}) {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Client-only ConnectionLostStatusUnknown state, keyed by assistant message id
  // (§10). Surfaced to the transcript so exactly one `Reconnect` card shows.
  const [lostConnections, setLostConnections] = useState<
    Record<string, ConnectionLostStatusUnknown>
  >({});
  const mountedRef = useRef(false);
  // One per-run lifecycle owner (abort handle + supersession token + first-delta
  // latch), replacing the three former refs. `useState` with a lazy initializer
  // creates the instance exactly once and React guarantees it persists for the
  // component's lifetime (unlike `useMemo`, which may be discarded).
  const [streamCtx] = useState(() => new PerRunStreamContext());

  const {
    handleMetaReceived,
    shouldFoldEvent,
    handleDelta,
    handleToolCall,
    handleToolCallDelta,
    handleToolCallDone,
    handleToolResult,
    handleCitationIndex,
    handleContextRefAdded,
    handleDone,
    flushDeltas,
  } = useChatMessageUpdates({ dispatch, onContextRefAdded });

  // The single run-visibility owner (replaces the five scattered predicates).
  const visibility = useMemo(
    () =>
      createRunVisibility({
        shouldStart: shouldStartRun,
        shouldApply: shouldApplyRun,
        isMounted: () => mountedRef.current,
      }),
    [shouldStartRun, shouldApplyRun],
  );

  const mergeRunMessages = useCallback(
    (
      runData: ChatRunData,
      idsToReplace: string[] = [
        runData.user_message.id,
        runData.assistant_message.id,
      ],
    ) => {
      const hasStreamSnapshot =
        !runData.stream_state.terminal &&
        (runData.stream_state.assistant_current_text ||
          runData.stream_state.tool_calls.length > 0);
      const displayRunData =
        hasStreamSnapshot
          ? {
              ...runData,
              assistant_message: {
                ...runData.assistant_message,
                message_document: {
                  type: "message_document" as const,
                  blocks: runData.stream_state.assistant_current_text
                    ? [
                        {
                          type: "text" as const,
                          format: "markdown" as const,
                          text: runData.stream_state.assistant_current_text,
                        },
                      ]
                    : [],
                },
                trust_trail: runData.assistant_message.trust_trail
                  ? {
                      ...runData.assistant_message.trust_trail,
                      status: "running" as const,
                      tool_calls: mergeStreamToolCalls(
                        runData.assistant_message.trust_trail.tool_calls,
                        runData.stream_state.tool_calls,
                      ),
                    }
                  : runData.assistant_message.trust_trail,
              },
            }
          : runData;
      // The transcript merge is owned by the reducer (merge_run_pair →
      // selectedPathAfterRun). The fork-options index is a separate state, not
      // the transcript, so it stays its own setState.
      dispatch({
        type: "merge_run_pair",
        run: displayRunData,
        idsToReplace,
      });
      setForkOptionsByParentId?.((prev) =>
        upsertForkOptionForRun(prev, displayRunData),
      );
    },
    [dispatch, setForkOptionsByParentId],
  );

  const abortAll = useCallback(() => {
    streamCtx.abortAll();
    setActiveRunId(null);
    setLostConnections({});
  }, [streamCtx]);

  const clearLostConnection = useCallback((assistantMessageId: string) => {
    setLostConnections((prev) => {
      if (!(assistantMessageId in prev)) return prev;
      const next = { ...prev };
      delete next[assistantMessageId];
      return next;
    });
  }, []);

  const cancelRun = useCallback(
    async (runId: string | null = activeRunId) => {
      if (!runId) return;
      try {
        await apiFetch<ChatRunResponse>(`/api/chat-runs/${runId}/cancel`, {
          method: "POST",
        });
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        console.error("Failed to cancel chat run:", err);
      }
    },
    [activeRunId],
  );

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
      let doneNotified = false;
      let finished = false;
      let streamDoneSeen = false;
      const token = streamCtx.currentToken(runId) + 1;

      // Visibility context binders over the single factory; they read the
      // mutable current ids by reference, so they always reflect the latest meta.
      const currentVisible = () =>
        visibility.isVisible({
          conversationId: runData.conversation.id,
          userMessageId: currentUserId,
          assistantMessageId: currentAssistantId,
        });
      const canStart = () =>
        visibility.canStart({
          conversationId: runData.conversation.id,
          userMessageId: currentUserId,
          assistantMessageId: currentAssistantId,
        });
      const dataVisible = (data: ChatRunData) =>
        visibility.isVisible({
          conversationId: data.conversation.id,
          userMessageId: data.user_message.id,
          assistantMessageId: data.assistant_message.id,
        });

      const mergeRunMessagesIfVisible = (
        data: ChatRunData,
        idsToReplace?: string[],
      ) => {
        if (!dataVisible(data)) {
          return;
        }
        mergeRunMessages(data, idsToReplace);
      };

      if (!canStart()) return;

      if (streamCtx.isStreaming(runId)) {
        mergeRunMessagesIfVisible(runData);
        return;
      }

      streamCtx.claim(runId, token);
      // A fresh tail (including a user-driven Reconnect) supersedes any prior
      // client-only connection-lost card for this message.
      clearLostConnection(originalAssistantId);
      if (runData.stream_state.folded_event_seq > 0) {
        shouldFoldEvent(runId, runData.stream_state.folded_event_seq);
      }

      mergeRunMessagesIfVisible(runData);
      onConversationAvailable?.(runData.conversation.id, runId);

      // Aborting this stops the SSE connection (its signal feeds the opener) and,
      // because the opener honors the signal post-mint, also cancels a tail that
      // is superseded (abortAll) or finished mid-token-mint.
      const streamAbort = new AbortController();

      const notifyDone = (status: TerminalRunStatus) => {
        if (doneNotified) return;
        doneNotified = true;
        onRunDone?.(runId, status);
      };

      // Client-only ConnectionLostStatusUnknown fold: the auto-reconnect budget
      // is spent and the run is not confirmed terminal. Keep partial text +
      // pending status; surface the single `Reconnect` card via lostConnections.
      const markConnectionLost = (lastCursor: string) => {
        if (!currentVisible()) return;
        setLostConnections((prev) => ({
          ...prev,
          [currentAssistantId]: { run_id: runId, last_cursor: lastCursor },
        }));
      };

      const finishRun = () => {
        if (finished) return;
        finished = true;
        streamAbort.abort();
        streamCtx.endStream(runId);
        setActiveRunId((current) => (current === runId ? null : current));
        onRunFinished?.(runId);
      };

      if (isTerminalRunStatus(runData.run.status)) {
        if (currentVisible()) {
          handleDone(runData.assistant_message.id, runData.run.status);
        }
        notifyDone(runData.run.status);
        finishRun();
        return;
      }

      setActiveRunId(runId);
      streamCtx.beginStream(runId, streamAbort);

      const reconcile = async () => {
        try {
          const response = await apiFetch<ChatRunResponse>(`/api/chat-runs/${runId}`);
          if (streamCtx.isSuperseded(runId, token)) return null;
          flushDeltas();
          mergeRunMessagesIfVisible(decodeRunDataReaderSelection(response.data), [
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
          if (response.data.stream_state.folded_event_seq > 0) {
            shouldFoldEvent(runId, response.data.stream_state.folded_event_seq);
          }

          if (isTerminalRunStatus(response.data.run.status)) {
            if (currentVisible()) {
              handleDone(currentAssistantId, response.data.run.status);
            }
            notifyDone(response.data.run.status);
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
        if (streamCtx.isSuperseded(runId, token) || finished || !canStart()) {
          finishRun();
          return;
        }

        try {
          await openGenerationRunStream<SSEEvent>("chat-runs", runId, {
            decode: toChatSSEEvent,
            isTerminal: (event) => event.type === "done",
            onEvent: (event) => {
              if (streamCtx.isSuperseded(runId, token)) return;
              if (event.seq > 0 && !shouldFoldEvent(runId, event.seq)) return;
              switch (event.type) {
                case "meta":
                  currentUserId = event.data.user_message_id;
                  currentAssistantId = event.data.assistant_message_id;
                  if (currentVisible()) {
                    handleMetaReceived(
                      originalUserId,
                      currentUserId,
                      originalAssistantId,
                      currentAssistantId,
                    );
                  }
                  onConversationAvailable?.(event.data.conversation_id, runId);
                  break;
                case "assistant_activity":
                  flushDeltas();
                  break;
                case "assistant_text_delta":
                  if (currentVisible() && streamCtx.latchFirstDelta(runId)) {
                    onFirstDelta?.(runId);
                  }
                  if (!currentVisible()) break;
                  handleDelta(currentAssistantId, event.data.text);
                  break;
                case "tool_call_start":
                  if (!currentVisible()) break;
                  flushDeltas();
                  handleToolCall(currentAssistantId, event.data);
                  break;
                case "tool_call_delta":
                  if (!currentVisible()) break;
                  handleToolCallDelta(currentAssistantId, event.data);
                  break;
                case "tool_call_done":
                  if (!currentVisible()) break;
                  handleToolCallDone(currentAssistantId, event.data);
                  break;
                case "tool_result":
                  if (!currentVisible()) break;
                  flushDeltas();
                  handleToolResult(currentAssistantId, event.data);
                  break;
                case "citation_index":
                  if (!currentVisible()) break;
                  handleCitationIndex(currentAssistantId, event.data);
                  break;
                case "context_ref_added":
                  handleContextRefAdded(currentAssistantId, event.data);
                  break;
                case "done":
                  streamDoneSeen = true;
                  if (currentVisible()) {
                    handleDone(currentAssistantId, event.data.status);
                  }
                  notifyDone(event.data.status);
                  break;
                default: {
                  const _exhaustive: never = event;
                  return _exhaustive;
                }
              }
            },
            // A recoverable boundary before a terminal event: reconcile against
            // the persisted run, then resume after the folded DB cursor.
            onReconnect: async () => {
              const persisted = await reconcile();
              if (streamCtx.isSuperseded(runId, token) || finished) {
                return "stop";
              }
              return persisted
                ? { after: String(persisted.stream_state.folded_event_seq) }
                : "continue";
            },
            onError: (err) => {
              if (streamCtx.isSuperseded(runId, token) || finished) return;
              // Auto-reconnect budget exhausted (or a fatal stream error).
              // Reconcile one last time — the run may have completed in the DB
              // exactly as the stream died, in which case reconcile() folds the
              // terminal status and finishes. If it did NOT confirm terminal,
              // fold the client-only ConnectionLostStatusUnknown card instead of
              // a server failure: partial text stays, the row offers Reconnect.
              console.error("Chat run stream failed:", err);
              void (async () => {
                const persisted = await reconcile();
                if (streamCtx.isSuperseded(runId, token) || finished) return;
                markConnectionLost(
                  String(
                    persisted?.stream_state.folded_event_seq ??
                      runData.stream_state.folded_event_seq,
                  ),
                );
                finishRun();
              })();
            },
            onComplete: (terminalEventSeen) => {
              // Terminal events still reconcile so the backend-built trust trail wins.
              if (streamCtx.isSuperseded(runId, token)) return;
              if (!terminalEventSeen || !streamDoneSeen) {
                finishRun();
                return;
              }
              void (async () => {
                await reconcile();
                if (streamCtx.isSuperseded(runId, token) || finished) return;
                finishRun();
              })();
            },
            initialAfter: String(runData.stream_state.folded_event_seq),
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
          const persisted = await reconcile();
          if (streamCtx.isSuperseded(runId, token) || finished) return;
          markConnectionLost(
            String(
              persisted?.stream_state.folded_event_seq ??
                runData.stream_state.folded_event_seq,
            ),
          );
          finishRun();
          return;
        }

        // Superseded (abortAll bumped the token) or unmounted during the mint:
        // the opener skipped connecting; still run finish orchestration.
        if (streamCtx.isSuperseded(runId, token) || finished || !canStart()) {
          finishRun();
        }
      };

      await startStream();
    },
    [
      streamCtx,
      visibility,
      clearLostConnection,
      handleDelta,
      handleDone,
      handleMetaReceived,
      handleToolCall,
      handleToolCallDelta,
      handleToolCallDone,
      handleToolResult,
      handleCitationIndex,
      handleContextRefAdded,
      flushDeltas,
      shouldFoldEvent,
      mergeRunMessages,
      onFirstDelta,
      onConversationAvailable,
      onRunDone,
      onRunFinished,
    ],
  );

  // User-driven resume of a ConnectionLostStatusUnknown card: re-fetch the run
  // and re-tail it from the persisted cursor. Never calls /rerun.
  const reconnectRun = useCallback(
    async (assistantMessageId: string) => {
      const entry = lostConnections[assistantMessageId];
      if (!entry) return;
      clearLostConnection(assistantMessageId);
      try {
        const response = await apiFetch<ChatRunResponse>(
          `/api/chat-runs/${entry.run_id}`,
        );
        await tailChatRun(decodeRunDataReaderSelection(response.data));
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        console.error("Failed to reconnect chat run:", err);
      }
    },
    [lostConnections, clearLostConnection, tailChatRun],
  );

  return {
    activeRunId,
    abortAll,
    cancelRun,
    tailChatRun,
    lostConnections,
    reconnectRun,
  };
}
