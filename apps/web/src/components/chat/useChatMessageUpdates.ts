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
import type { CitationOut } from "@/lib/conversations/citationOut";
import { conversationMessageText } from "@/lib/conversations/types";
import type {
  AssistantTrustTrail,
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
    summary_md:
      "summary_md" in citation ? (citation.summary_md ?? null) : null,
    exact_snippet: citation.snippet,
    retrieval_status: citation.selected ? "selected" : "retrieved",
    included_in_prompt: false,
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
  };
}

function messageDocumentWithText(
  message: ConversationMessage,
  content: string,
): MessageDocument {
  return {
    type: "message_document",
    blocks:
      content.trim().length > 0
        ? [{ type: "text", format: "markdown", text: content }]
        : [],
  };
}

function trustTrailFor(
  message: ConversationMessage,
  assistantId: string,
  conversationId = "",
): AssistantTrustTrail {
  if (message.trust_trail) return message.trust_trail;
  return {
    schema_version: "assistant_trust_trail.v1",
    assistant_message_id: assistantId,
    conversation_id: conversationId,
    chat_run_id: null,
    status: "running",
    run: null,
    prompt: null,
    tool_calls: [],
    citations: [],
    references_added: [],
    integrity_notices: [],
    created_at: message.created_at,
    updated_at: message.updated_at,
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
          if (m.id === tempAsstId) {
            return {
              ...m,
              id: realAsstId,
              trust_trail: m.trust_trail
                ? { ...m.trust_trail, assistant_message_id: realAsstId }
                : m.trust_trail,
            };
          }
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
          const trail = trustTrailFor(m, data.assistant_message_id);
          const existing = trail.tool_calls;
          const previous = existing.find(
            (call) => call.tool_call_index === data.tool_call_index,
          );
          const nextCall: MessageToolCall = {
            ...(previous ?? {}),
            id: data.tool_call_id ?? previous?.id,
            assistant_message_id: data.assistant_message_id,
            tool_name: data.tool_name,
            tool_call_index: data.tool_call_index,
            status: data.status,
            scope: data.scope,
            requested_types: data.types,
            result_refs: previous?.result_refs ?? [],
            selected_context_refs: previous?.selected_context_refs ?? [],
            provider_request_ids: previous?.provider_request_ids ?? [],
            result_count: previous?.result_count ?? 0,
            selected_count: previous?.selected_count ?? 0,
            retrievals: previous?.retrievals ?? [],
            candidate_ledgers: previous?.candidate_ledgers ?? [],
            rerank_ledgers: previous?.rerank_ledgers ?? [],
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
          return {
            ...m,
            trust_trail: { ...trail, status: "running", tool_calls: toolCalls },
          };
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
          const trail = trustTrailFor(m, data.assistant_message_id);
          const existing = trail.tool_calls;
          const index = existing.findIndex(
            (call) => call.tool_call_index === data.tool_call_index,
          );
          const previous = index >= 0 ? existing[index] : null;
          const nextCall: MessageToolCall = {
            ...(previous ?? {}),
            id: data.tool_call_id ?? previous?.id,
            assistant_message_id: data.assistant_message_id,
            tool_name: data.tool_name,
            tool_call_index: data.tool_call_index,
            status: data.status,
            scope: previous?.scope ?? "all",
            requested_types: previous?.requested_types ?? [],
            error_code: data.error_code ?? null,
            latency_ms: data.latency_ms,
            result_count: data.result_count,
            selected_count: data.selected_count,
            result_refs: data.results as Array<Record<string, unknown>>,
            selected_context_refs: previous?.selected_context_refs ?? [],
            provider_request_ids: previous?.provider_request_ids ?? [],
            retrievals,
            candidate_ledgers: previous?.candidate_ledgers ?? [],
            rerank_ledgers: previous?.rerank_ledgers ?? [],
          };
          const toolCalls =
            index >= 0
              ? existing.map((call, idx) => (idx === index ? nextCall : call))
              : [...existing, nextCall];
          return {
            ...m,
            trust_trail: { ...trail, tool_calls: toolCalls },
          };
        }),
      );
    },
    [setMessages],
  );

  const handleCitationIndex = useCallback(
    (assistantId: string, data: SSECitationIndexEvent["data"]) => {
      // Edge entries are already the chip read-model: map them straight to the
      // message's CitationOut[]. media_id/locator are absent (D11) — the jump is
      // the snapshot deep_link plus the target grain.
      const citations: CitationOut[] = data.entries.map((entry) => ({
        ordinal: entry.n,
        role: entry.kind,
        target_ref: entry.target_ref,
        media_id: null,
        locator: null,
        deep_link: entry.deep_link,
        snapshot: entry.snapshot,
      }));
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const trail = trustTrailFor(m, data.assistant_message_id);
          return {
            ...m,
            citations,
            trust_trail: {
              ...trail,
              citations: data.entries.map((entry, index) => ({
                citation_edge_id: entry.citation_edge_id,
                ordinal: entry.n,
                role: entry.kind,
                target_ref: entry.target_ref,
                retrieval_id: null,
                tool_call_id: null,
                citation: citations[index],
              })),
            },
          };
        }),
      );
    },
    [setMessages],
  );

  const handleReferenceAdded = useCallback(
    (assistantId: string, data: SSEReferenceAddedEvent["data"]) => {
      onReferenceAdded?.(data);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const trail = trustTrailFor(m, assistantId, data.conversation_id);
          const reference = {
            chat_run_event_seq: 0,
            id: data.id,
            conversation_id: data.conversation_id,
            resource_ref: data.resource_ref,
            label: data.label,
            summary: data.summary,
            missing: data.missing,
            created_at: data.created_at,
            citation_edge_id: data.citation_edge_id,
          };
          return {
            ...m,
            trust_trail: {
              ...trail,
              references_added: trail.references_added.some(
                (existing) => existing.id === data.id,
              )
                ? trail.references_added.map((existing) =>
                    existing.id === data.id ? reference : existing,
                  )
                : [...trail.references_added, reference],
            },
          };
        }),
      );
    },
    [onReferenceAdded, setMessages],
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
            trust_trail: m.trust_trail
              ? { ...m.trust_trail, status }
              : m.trust_trail,
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
