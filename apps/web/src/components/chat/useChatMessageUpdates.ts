"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  SSECitationEvent,
  SSEToolCallEvent,
  SSEToolResultEvent,
} from "@/lib/api/sse";
import {
  isSearchCitation,
  isWebCitation,
  toWebCitationChipData,
  type WebCitationChipData,
} from "@/lib/chat/citations";
import type {
  ConversationMessage,
  MessageRetrieval,
  MessageToolCall,
} from "@/lib/conversations/types";

type MessageWithWebCitations = ConversationMessage & {
  citations?: WebCitationChipData[];
};

function appendWebCitations(
  existing: WebCitationChipData[] | undefined,
  incoming: WebCitationChipData[],
): WebCitationChipData[] {
  if (incoming.length === 0) return existing ?? [];

  const next = [...(existing ?? [])];
  const seen = new Set(
    next.map((citation) => citation.result_ref || citation.url),
  );

  for (const citation of incoming) {
    const key = citation.result_ref || citation.url;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(citation);
  }

  return next;
}

export function useChatMessageUpdates({
  setMessages,
  shouldScrollRef,
}: {
  setMessages: Dispatch<SetStateAction<ConversationMessage[]>>;
  shouldScrollRef?: MutableRefObject<boolean>;
}) {
  const deltaBufferRef = useRef<Map<string, string>>(new Map());
  const rafRef = useRef<number | null>(null);

  const flushDeltas = useCallback(() => {
    rafRef.current = null;
    const buffer = deltaBufferRef.current;
    if (buffer.size === 0) return;
    const snapshot = new Map(buffer);
    buffer.clear();
    setMessages((prev) =>
      prev.map((m) => {
        const delta = snapshot.get(m.id);
        return delta ? { ...m, content: m.content + delta } : m;
      }),
    );
  }, [setMessages]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handleOptimisticMessages = useCallback(
    (userMsg: ConversationMessage, assistantMsg: ConversationMessage) => {
      if (shouldScrollRef) {
        shouldScrollRef.current = true;
      }
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
    },
    [setMessages, shouldScrollRef],
  );

  const handleMetaReceived = useCallback(
    (
      tempUserId: string,
      realUserId: string,
      tempAsstId: string,
      realAsstId: string,
    ) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === tempUserId) return { ...m, id: realUserId };
          if (m.id === tempAsstId) return { ...m, id: realAsstId };
          return m;
        }),
      );
    },
    [setMessages],
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

  const handleToolCall = useCallback(
    (assistantId: string, data: SSEToolCallEvent["data"]) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const existing = m.tool_calls ?? [];
          const nextCall: MessageToolCall = {
            id: data.tool_call_id ?? undefined,
            assistant_message_id: data.assistant_message_id,
            tool_name: data.tool_name,
            tool_call_index: data.tool_call_index,
            status: data.status,
            scope: data.scope,
            requested_types: data.types,
            semantic: data.semantic,
            retrievals: [],
          };
          const index = existing.findIndex(
            (call) => call.tool_call_index === data.tool_call_index,
          );
          const toolCalls =
            index >= 0
              ? existing.map((call, idx) =>
                  idx === index ? { ...call, ...nextCall } : call,
                )
              : [...existing, nextCall];
          return { ...m, tool_calls: toolCalls };
        }),
      );
    },
    [setMessages],
  );

  const handleToolResult = useCallback(
    (assistantId: string, data: SSEToolResultEvent["data"]) => {
      const retrievals: MessageRetrieval[] = data.citations.filter(isSearchCitation).map(
        (citation, index) => ({
          tool_call_id: data.tool_call_id ?? undefined,
          ordinal: index,
          result_type: citation.result_type,
          source_id: citation.source_id,
          media_id: citation.media_id,
          context_ref: citation.context_ref,
          result_ref: citation,
          deep_link: citation.deep_link,
          score: citation.score,
          selected: citation.selected,
        }),
      );
      const webCitations = data.citations
        .filter(isWebCitation)
        .map((citation, index) =>
          toWebCitationChipData({
            ...citation,
            assistant_message_id:
              citation.assistant_message_id ?? data.assistant_message_id,
            tool_call_id: citation.tool_call_id ?? data.tool_call_id,
            tool_call_index: citation.tool_call_index ?? data.tool_call_index,
            citation_index: citation.citation_index ?? citation.index ?? index,
          }),
        );

      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const message = m as MessageWithWebCitations;
          const existing = m.tool_calls ?? [];
          const index = existing.findIndex(
            (call) => call.tool_call_index === data.tool_call_index,
          );
          const nextCall: MessageToolCall = {
            ...(index >= 0 ? existing[index] : {}),
            id: data.tool_call_id ?? existing[index]?.id,
            assistant_message_id: data.assistant_message_id,
            tool_name: data.tool_name,
            tool_call_index: data.tool_call_index,
            status: data.status,
            error_code: data.error_code ?? null,
            latency_ms: data.latency_ms,
            retrievals,
          };
          const toolCalls =
            index >= 0
              ? existing.map((call, idx) => (idx === index ? nextCall : call))
              : [...existing, nextCall];
          return {
            ...m,
            tool_calls: toolCalls,
            citations: appendWebCitations(message.citations, webCitations),
          };
        }),
      );
    },
    [setMessages],
  );

  const handleCitation = useCallback(
    (assistantId: string, data: SSECitationEvent["data"]) => {
      const citation = toWebCitationChipData(data);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const message = m as MessageWithWebCitations;
          return {
            ...m,
            citations: appendWebCitations(message.citations, [citation]),
          };
        }),
      );
    },
    [setMessages],
  );

  const handleDone = useCallback(
    (
      assistantId: string,
      status: "complete" | "error" | "cancelled",
      errorCode: string | null,
    ) => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const buffer = deltaBufferRef.current;
      const remaining = buffer.get(assistantId);
      buffer.delete(assistantId);

      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          return {
            ...m,
            content: remaining ? m.content + remaining : m.content,
            status,
            error_code: errorCode,
          };
        }),
      );
    },
    [setMessages],
  );

  return {
    flushDeltas,
    handleOptimisticMessages,
    handleMetaReceived,
    handleDelta,
    handleToolCall,
    handleToolResult,
    handleCitation,
    handleDone,
  };
}
