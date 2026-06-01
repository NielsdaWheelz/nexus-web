"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  isSearchCitationEventData,
  isWebCitationEventData,
  type SearchCitationEventData,
  type WebCitationEventData,
} from "@/lib/api/sse/citations";
import type {
  SSECitationIndexEvent,
  SSEReferenceAddedEvent,
  SSERetrievalResultEvent,
  SSEToolCallEvent,
} from "@/lib/api/sse/events";
import { conversationMessageText } from "@/lib/conversations/types";
import type {
  ConversationMessage,
  MessageDocument,
  MessageRetrievalResultRef,
  MessageRetrieval,
  MessageToolCall,
} from "@/lib/conversations/types";

function retrievalFromSearchCitation(
  citation: SearchCitationEventData,
  data: {
    tool_call_id?: string | null;
    tool_call_index?: number | null;
    tool_name?: string;
  },
  index: number,
): MessageRetrieval {
  const result_ref = citation as MessageRetrievalResultRef;
  return {
    tool_call_id: data.tool_call_id ?? undefined,
    tool_call_index: data.tool_call_index ?? null,
    ordinal: index,
    result_type: citation.result_type,
    source_id: citation.source_id,
    media_id: citation.media_id,
    evidence_span_id: citation.evidence_span_id ?? null,
    context_ref: citation.context_ref,
    result_ref,
    deep_link: citation.deep_link,
    citation_label: citation.citation_label ?? null,
    locator: citation.locator,
    score: citation.score,
    selected: citation.selected,
    source_title: citation.title,
    section_label: citation.source_label,
    exact_snippet: citation.snippet,
    retrieval_status: citation.selected ? "selected" : "retrieved",
    included_in_prompt: false,
    source_version: citation.source_version ?? null,
  };
}

function retrievalFromWebCitation(
  citation: WebCitationEventData,
  data: {
    tool_call_id?: string | null;
    tool_call_index?: number | null;
  },
  index: number,
): MessageRetrieval {
  const result_ref: MessageRetrievalResultRef = citation;
  return {
    tool_call_id: data.tool_call_id ?? undefined,
    tool_call_index: data.tool_call_index ?? null,
    ordinal: index,
    result_type: "web_result",
    source_id: citation.source_id,
    media_id: citation.media_id ?? null,
    context_ref: citation.context_ref,
    result_ref,
    deep_link: citation.deep_link,
    citation_label: citation.display_url ?? citation.source_name ?? null,
    locator: citation.locator,
    score: citation.score ?? null,
    selected: citation.selected ?? true,
    source_title: citation.title,
    exact_snippet: citation.snippet,
    retrieval_status: "web_result",
    included_in_prompt: false,
    source_version: citation.source_version,
  };
}

function sameToolBlock(
  block: {
    tool_call_id?: string | null;
    tool_call_index?: number | null;
    tool_name?: string | null;
  },
  data: {
    tool_call_id?: string | null;
    tool_call_index: number;
    tool_name?: string | null;
  },
): boolean {
  if (block.tool_name && data.tool_name && block.tool_name !== data.tool_name) {
    return false;
  }
  return data.tool_call_id
    ? block.tool_call_id === data.tool_call_id
    : block.tool_call_index === data.tool_call_index;
}

function messageDocumentWithText(
  message: ConversationMessage,
  content: string,
): MessageDocument {
  const existingBlocks = message.message_document?.blocks ?? [];
  return {
    type: "message_document",
    version: message.message_document?.version ?? 1,
    blocks: [
      ...(content.trim().length > 0
        ? [
            {
              type: "text" as const,
              format: "markdown" as const,
              text: content,
            },
          ]
        : []),
      ...existingBlocks.filter((block) => block.type !== "text"),
    ],
  };
}

function messageDocumentWithRetrievals(
  message: ConversationMessage,
  data: SSERetrievalResultEvent["data"],
  retrievals: MessageRetrieval[],
): MessageDocument {
  const existingBlocks = message.message_document?.blocks ?? [];
  return {
    type: "message_document",
    version: message.message_document?.version ?? 1,
    blocks: [
      ...existingBlocks.filter(
        (block) =>
          block.type !== "retrieval_result" || !sameToolBlock(block, data),
      ),
      ...retrievals.map((retrieval) => ({
        type: "retrieval_result" as const,
        ...retrieval,
      })),
    ],
  };
}

export function useChatMessageUpdates({
  setMessages,
  onReferenceAdded,
}: {
  setMessages: Dispatch<SetStateAction<ConversationMessage[]>>;
  onReferenceAdded?: (data: SSEReferenceAddedEvent["data"]) => void;
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
        if (!delta) return m;
        const content = conversationMessageText(m) + delta;
        return {
          ...m,
          message_document: messageDocumentWithText(m, content),
        };
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
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
    },
    [setMessages],
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
    (assistantId: string, data: SSERetrievalResultEvent["data"]) => {
      const results = Array.isArray(data.results) ? data.results : [];
      const retrievals: MessageRetrieval[] = results.flatMap(
        (citation, index) => {
          if (isWebCitationEventData(citation)) {
            return [retrievalFromWebCitation(citation, data, index)];
          }
          if (!isSearchCitationEventData(citation)) return [];
          return [retrievalFromSearchCitation(citation, data, index)];
        },
      );
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
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
            result_count: data.result_count,
            selected_count: data.selected_count,
          };
          const toolCalls =
            index >= 0
              ? existing.map((call, idx) => (idx === index ? nextCall : call))
              : [...existing, nextCall];
          const existingRetrievals = m.retrievals ?? [];
          const keyOf = (r: MessageRetrieval) =>
            `${r.tool_call_id ?? ""}:${r.ordinal ?? ""}`;
          const newKeys = new Set(retrievals.map(keyOf));
          const mergedRetrievals = [
            ...existingRetrievals.filter((r) => !newKeys.has(keyOf(r))),
            ...retrievals,
          ];
          return {
            ...m,
            tool_calls: toolCalls,
            retrievals: mergedRetrievals,
            message_document: messageDocumentWithRetrievals(
              m,
              data,
              retrievals,
            ),
          };
        }),
      );
    },
    [setMessages],
  );

  const handleCitationIndex = useCallback(
    (assistantId: string, data: SSECitationIndexEvent["data"]) => {
      const retrievals: MessageRetrieval[] = data.entries.flatMap((entry) => {
        const result = entry.result;
        if (!result) return [];
        const eventData = {
          tool_call_id: entry.tool_call_id,
          tool_call_index: null,
          tool_name: "app_search" as const,
        };
        const retrieval = isWebCitationEventData(result)
          ? retrievalFromWebCitation(result, eventData, entry.ordinal)
          : isSearchCitationEventData(result)
            ? retrievalFromSearchCitation(result, eventData, entry.ordinal)
            : null;
        return retrieval
          ? [
              {
                ...retrieval,
                id: entry.retrieval_id,
                ordinal: entry.ordinal,
                citation_ordinal: entry.n,
                selected: true,
                included_in_prompt: true,
              },
            ]
          : [];
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                citation_index: data.entries,
                retrievals: retrievals.length
                  ? [
                      ...(m.retrievals ?? []).filter(
                        (r) =>
                          !retrievals.some(
                            (next) =>
                              next.tool_call_id === r.tool_call_id &&
                              next.ordinal === r.ordinal,
                          ),
                      ),
                      ...retrievals,
                    ]
                  : m.retrievals,
              }
            : m,
        ),
      );
    },
    [setMessages],
  );

  const handleReferenceAdded = useCallback(
    (data: SSEReferenceAddedEvent["data"]) => {
      onReferenceAdded?.(data);
    },
    [onReferenceAdded],
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

      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const content = remaining
            ? conversationMessageText(m) + remaining
            : conversationMessageText(m);
          return {
            ...m,
            message_document: messageDocumentWithText(m, content),
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
    handleCitationIndex,
    handleReferenceAdded,
    handleDone,
  };
}
