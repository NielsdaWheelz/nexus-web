"use client";

import { useCallback, useEffect, useRef } from "react";
import type {
  SSECitationIndexEvent,
  SSEContextRefAddedEvent,
  SSEToolCallDeltaEvent,
  SSEToolCallDoneEvent,
  SSEToolResultEvent,
} from "@/lib/api/sse/events";
import type {
  MessageUpdateAction,
  RenderToolCallData,
} from "@/lib/conversations/messageUpdateReducer";

/**
 * useChatMessageUpdates — the fold layer.
 *
 * Translates streamed run events into `messageUpdateReducer` actions and owns
 * the RAF text-delta buffer + the per-run folded-seq dedupe. It never mutates
 * the message list directly; every transition is a dispatched action handled by
 * the single reducer-backed engine (`useConversation`).
 */
export function useChatMessageUpdates({
  dispatch,
  onContextRefAdded,
}: {
  dispatch: (action: MessageUpdateAction) => void;
  onContextRefAdded?: (data: SSEContextRefAddedEvent["data"]) => void;
}) {
  const deltaBufferRef = useRef<Map<string, string>>(new Map());
  const foldedSeqRef = useRef<Map<string, number>>(new Map());
  const rafRef = useRef<number | null>(null);

  const flushDeltas = useCallback(() => {
    rafRef.current = null;
    const buffer = deltaBufferRef.current;
    if (buffer.size === 0) return;
    const snapshot = new Map(buffer);
    buffer.clear();
    for (const [assistantId, delta] of snapshot) {
      dispatch({ type: "fold_text_delta", assistantId, delta });
    }
  }, [dispatch]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handleMetaReceived = useCallback(
    (
      tempUserId: string,
      realUserId: string,
      tempAsstId: string,
      realAsstId: string,
    ) => {
      dispatch({
        type: "swap_meta_ids",
        map: [
          { tempId: tempUserId, realId: realUserId },
          { tempId: tempAsstId, realId: realAsstId },
        ],
      });
    },
    [dispatch],
  );

  const handleDelta = useCallback(
    (assistantId: string, delta: string) => {
      const buffer = deltaBufferRef.current;
      buffer.set(assistantId, (buffer.get(assistantId) ?? "") + delta);
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushDeltas);
      }
    },
    [flushDeltas],
  );

  const shouldFoldEvent = useCallback((runId: string, seq: number) => {
    if (seq <= (foldedSeqRef.current.get(runId) ?? 0)) return false;
    foldedSeqRef.current.set(runId, seq);
    return true;
  }, []);

  const handleToolCall = useCallback(
    (assistantId: string, data: RenderToolCallData) => {
      dispatch({
        type: "apply_tool_call",
        assistantId,
        call: { kind: "lifecycle", data },
      });
    },
    [dispatch],
  );

  const handleToolCallDelta = useCallback(
    (assistantId: string, data: SSEToolCallDeltaEvent["data"]) => {
      flushDeltas();
      dispatch({
        type: "apply_tool_call",
        assistantId,
        call: { kind: "input", data },
      });
    },
    [dispatch, flushDeltas],
  );

  const handleToolCallDone = useCallback(
    (assistantId: string, data: SSEToolCallDoneEvent["data"]) => {
      flushDeltas();
      handleToolCall(assistantId, { ...data, status: "running" });
    },
    [flushDeltas, handleToolCall],
  );

  const handleToolResult = useCallback(
    (assistantId: string, data: SSEToolResultEvent["data"]) => {
      dispatch({ type: "apply_tool_result", assistantId, data });
    },
    [dispatch],
  );

  const handleCitationIndex = useCallback(
    (assistantId: string, data: SSECitationIndexEvent["data"]) => {
      dispatch({ type: "apply_citation_index", assistantId, data });
    },
    [dispatch],
  );

  const handleContextRefAdded = useCallback(
    (assistantId: string, data: SSEContextRefAddedEvent["data"]) => {
      onContextRefAdded?.(data);
      dispatch({ type: "apply_context_ref", assistantId, data });
    },
    [dispatch, onContextRefAdded],
  );

  const handleDone = useCallback(
    (
      assistantId: string,
      status: "complete" | "error" | "cancelled",
      errorCode: string | null,
    ) => {
      const buffer = deltaBufferRef.current;
      const remaining = buffer.get(assistantId);
      buffer.delete(assistantId);
      dispatch({
        type: "finalize_done",
        assistantId,
        status,
        errorCode,
        delta: remaining,
      });
    },
    [dispatch],
  );

  return {
    flushDeltas,
    shouldFoldEvent,
    handleMetaReceived,
    handleDelta,
    handleToolCall,
    handleToolCallDelta,
    handleToolCallDone,
    handleToolResult,
    handleCitationIndex,
    handleContextRefAdded,
    handleDone,
  };
}
