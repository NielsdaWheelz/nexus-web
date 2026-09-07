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
import {
  apiFetch,
  decodeApiPayload,
  isApiError,
  isSameSystemApiDefect,
  isToolProjectionReloadRequired,
  type ApiError,
} from "@/lib/api/client";
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
import type { ChatConnectionRecovery } from "@/lib/conversations/chatConnectionRecovery";
import { decodeChatRunResponse } from "@/lib/conversations/messageWire";

type ChatRunData = ChatRunResponse["data"];
type TerminalRunStatus = "complete" | "error" | "cancelled";

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

function reconnectFailure(
  error: ApiError,
): Pick<
  Extract<ChatConnectionRecovery, { kind: "Failed" }>,
  "message" | "requestId" | "retryable"
> | null {
  switch (error.code) {
    case "E_NETWORK":
      return {
        message:
          "Nexus could not be reached. Check your connection, then reconnect again.",
        requestId: error.requestId,
        retryable: true,
      };
    case "E_NOT_FOUND":
      return {
        message:
          "This response is no longer available. Refresh the conversation to reconcile its status.",
        requestId: error.requestId,
        retryable: false,
      };
    case "E_FORBIDDEN":
      return {
        message:
          "You no longer have access to this response. Refresh the conversation before trying again.",
        requestId: error.requestId,
        retryable: false,
      };
    default:
      return null;
  }
}

function isChatStreamContractDefect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("Invalid SSE payload") ||
    error.message.startsWith("Failed to parse SSE ") ||
    error.message.startsWith("SSE event exceeds maximum size") ||
    error.message.startsWith("Unknown SSE event type")
  );
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
    if (
      !existing.some((call) => call.tool_call_index === item.tool_call_index)
    ) {
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
  onProjectionReloadRequired,
  onDefect,
  shouldStartRun,
  shouldApplyRun,
}: {
  dispatch: (action: MessageUpdateAction) => void;
  setForkOptionsByParentId?: Dispatch<
    SetStateAction<Record<string, ForkOption[]>>
  >;
  onRunFinished?: (runId: string) => void;
  onFirstDelta?: (runId: string) => void;
  onRunDone?: (runId: string, status: TerminalRunStatus) => void;
  onConversationAvailable?: (conversationId: string, runId: string) => void;
  onContextRefAdded?: (data: SSEContextRefAddedEvent["data"]) => void;
  onProjectionReloadRequired?: (error: ApiError) => void;
  onDefect?: (error: unknown) => void;
  shouldStartRun?: (ctx: RunVisibilityContext) => boolean;
  shouldApplyRun?: (ctx: RunVisibilityContext) => boolean;
}) {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Client-only recovery state, keyed by assistant message id. It remains
  // addressable through reconnect attempts until a tail has actually claimed
  // the run or durable terminal state replaces the pending message.
  const [connectionRecoveries, setConnectionRecoveries] = useState<
    Record<string, ChatConnectionRecovery>
  >({});
  const mountedRef = useRef(false);
  const reconnectFlightsRef = useRef<Set<string>>(new Set());
  // One per-run lifecycle owner (abort handle + supersession token + first-delta
  // latch), replacing the three former refs. `useState` with a lazy initializer
  // creates the instance exactly once and React guarantees it persists for the
  // component's lifetime (unlike `useMemo`, which may be discarded).
  const [streamCtx] = useState(() => new PerRunStreamContext());

  const reportProjectionReload = useCallback(
    (error: unknown): boolean => {
      if (!isToolProjectionReloadRequired(error)) return false;
      onProjectionReloadRequired?.(error);
      return true;
    },
    [onProjectionReloadRequired],
  );

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
    handleExecutionAdvisory,
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
      const displayRunData = hasStreamSnapshot
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
    setConnectionRecoveries({});
  }, [streamCtx]);

  const clearConnectionRecovery = useCallback((assistantMessageId: string) => {
    setConnectionRecoveries((prev) => {
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
        const raw = await apiFetch<unknown>(`/api/chat-runs/${runId}/cancel`, {
          method: "POST",
        });
        const response = decodeApiPayload(
          raw,
          decodeChatRunResponse,
          "Cancel chat run",
        );
        const runData = response.data;
        if (
          visibility.isVisible({
            conversationId: runData.conversation.id,
            userMessageId: runData.user_message.id,
            assistantMessageId: runData.assistant_message.id,
          })
        ) {
          mergeRunMessages(runData);
        }
      } catch (err) {
        reportProjectionReload(err);
        throw err;
      }
    },
    [activeRunId, mergeRunMessages, reportProjectionReload, visibility],
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
      if (!mountedRef.current) return false;
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

      if (!canStart()) return false;

      if (streamCtx.isStreaming(runId)) {
        mergeRunMessagesIfVisible(runData);
        clearConnectionRecovery(originalAssistantId);
        return true;
      }

      streamCtx.claim(runId, token);
      // Clear recovery only after this owner has successfully claimed the run.
      // A failed GET, invisible run, or rejected reconnect keeps its state.
      clearConnectionRecovery(originalAssistantId);
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

      // The auto-reconnect budget is spent and the run is not confirmed
      // terminal. Keep partial text + pending status and surface recovery.
      const markConnectionLost = (lastCursor: string) => {
        if (!currentVisible()) return;
        setConnectionRecoveries((prev) => ({
          ...prev,
          [currentAssistantId]: {
            kind: "Lost",
            runId,
            lastCursor,
          },
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
        return true;
      }

      setActiveRunId(runId);
      streamCtx.beginStream(runId, streamAbort);

      const reconcile = async () => {
        try {
          const raw = await apiFetch<unknown>(`/api/chat-runs/${runId}`);
          const response = decodeApiPayload(
            raw,
            decodeChatRunResponse,
            "Reconcile chat run",
          );
          if (streamCtx.isSuperseded(runId, token)) return null;
          const persisted = response.data;
          flushDeltas();
          mergeRunMessagesIfVisible(persisted, [
            originalUserId,
            originalAssistantId,
            currentUserId,
            currentAssistantId,
            persisted.user_message.id,
            persisted.assistant_message.id,
          ]);
          onConversationAvailable?.(persisted.conversation.id, runId);
          currentUserId = persisted.user_message.id;
          currentAssistantId = persisted.assistant_message.id;
          if (persisted.stream_state.folded_event_seq > 0) {
            shouldFoldEvent(runId, persisted.stream_state.folded_event_seq);
          }

          if (isTerminalRunStatus(persisted.run.status)) {
            if (currentVisible()) {
              handleDone(currentAssistantId, persisted.run.status);
            }
            notifyDone(persisted.run.status);
            finishRun();
          }
          return persisted;
        } catch (err) {
          if (reportProjectionReload(err)) {
            finishRun();
            return null;
          }
          if (handleUnauthenticatedApiError(err)) return null;
          if (!isApiError(err) || isSameSystemApiDefect(err)) {
            onDefect?.(err);
            finishRun();
            return null;
          }
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
                case "ExecutionAdvisory":
                  if (!currentVisible()) break;
                  handleExecutionAdvisory(currentAssistantId, event.data);
                  break;
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
              if (isChatStreamContractDefect(err)) {
                onDefect?.(err);
                finishRun();
                return;
              }
              if (reportProjectionReload(err)) {
                finishRun();
                return;
              }
              // Auto-reconnect budget exhausted (or a fatal stream error).
              // Reconcile one last time — the run may have completed in the DB
              // exactly as the stream died, in which case reconcile() folds the
              // terminal status and finishes. If it did NOT confirm terminal,
              // fold client-only recovery instead of a server failure: partial
              // text stays and the row offers Reconnect.
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
          if (reportProjectionReload(err)) {
            finishRun();
            return;
          }
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
      return true;
    },
    [
      streamCtx,
      visibility,
      clearConnectionRecovery,
      handleDelta,
      handleDone,
      handleMetaReceived,
      handleToolCall,
      handleToolCallDelta,
      handleToolCallDone,
      handleToolResult,
      handleCitationIndex,
      handleContextRefAdded,
      handleExecutionAdvisory,
      flushDeltas,
      shouldFoldEvent,
      mergeRunMessages,
      onFirstDelta,
      onConversationAvailable,
      onRunDone,
      onRunFinished,
      onDefect,
      reportProjectionReload,
    ],
  );

  // User-driven resume of a connection-recovery card: re-fetch the same run and
  // re-tail it from durable state. Never calls /rerun.
  const reconnectRun = useCallback(
    async (assistantMessageId: string) => {
      const entry = connectionRecoveries[assistantMessageId];
      if (!entry || reconnectFlightsRef.current.has(assistantMessageId)) return;
      reconnectFlightsRef.current.add(assistantMessageId);
      setConnectionRecoveries((prev) => ({
        ...prev,
        [assistantMessageId]: {
          kind: "Reconnecting",
          runId: entry.runId,
          lastCursor: entry.lastCursor,
        },
      }));

      const restoreOrFail = (
        failure: Pick<
          Extract<ChatConnectionRecovery, { kind: "Failed" }>,
          "message" | "requestId" | "retryable"
        > | null,
      ) => {
        if (!mountedRef.current) return;
        setConnectionRecoveries((prev) => {
          const current = prev[assistantMessageId];
          if (
            current?.kind !== "Reconnecting" ||
            current.runId !== entry.runId ||
            current.lastCursor !== entry.lastCursor
          ) {
            return prev;
          }
          return {
            ...prev,
            [assistantMessageId]: failure
              ? {
                  kind: "Failed",
                  runId: entry.runId,
                  lastCursor: entry.lastCursor,
                  ...failure,
                }
              : {
                  kind: "Lost",
                  runId: entry.runId,
                  lastCursor: entry.lastCursor,
                },
          };
        });
      };

      try {
        const raw = await apiFetch<unknown>(`/api/chat-runs/${entry.runId}`);
        const response = decodeApiPayload(
          raw,
          decodeChatRunResponse,
          "Reconnect chat run",
        );
        const claimed = await tailChatRun(response.data);
        if (!claimed) {
          restoreOrFail({
            message:
              "This response is not available in the current conversation. Return to it, then reconnect again.",
            retryable: true,
          });
        }
      } catch (err) {
        if (isToolProjectionReloadRequired(err)) {
          reportProjectionReload(err);
          restoreOrFail({
            message:
              "Nexus was updated while this response was open. Reload the page to reconnect safely.",
            requestId: err.requestId,
            retryable: false,
          });
          return;
        }
        if (handleUnauthenticatedApiError(err)) {
          restoreOrFail(null);
          return;
        }
        if (!isApiError(err) || isSameSystemApiDefect(err)) {
          restoreOrFail(null);
          onDefect?.(err);
          return;
        }
        const failure = reconnectFailure(err);
        if (failure) {
          restoreOrFail(failure);
          return;
        }
        restoreOrFail(null);
        onDefect?.(err);
      } finally {
        reconnectFlightsRef.current.delete(assistantMessageId);
      }
    },
    [connectionRecoveries, onDefect, reportProjectionReload, tailChatRun],
  );

  return {
    activeRunId,
    abortAll,
    cancelRun,
    tailChatRun,
    connectionRecoveries,
    reconnectRun,
  };
}
