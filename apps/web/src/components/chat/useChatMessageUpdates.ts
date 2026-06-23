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
  ChatToolStatus,
  SSECitationIndexEvent,
  SSEContextRefAddedEvent,
  SSEDoneEvent,
  SSEPromptAssemblyEvent,
  SSERetrievalPlanEvent,
  SSEToolCallDeltaEvent,
  SSEToolCallDoneEvent,
  SSEToolCallEvent,
  SSEToolLedgerSnapshotEvent,
  SSEToolResultEvent,
} from "@/lib/api/sse/events";
import { conversationMessageText } from "@/lib/conversations/types";
import type {
  ConversationMessage,
  MessageDocument,
  MessageRetrieval,
  MessageRetrievalResultRef,
  MessageToolCall,
} from "@/lib/conversations/types";

type RenderToolCallData = SSEToolCallEvent["data"] & {
  status?: ChatToolStatus;
};

function retrievalFromSearchCitation(
  citation: SearchCitationEventData,
  data: {
    tool_call_id?: string | null;
    tool_call_index?: number | null;
    tool_name?: string;
    scope: string;
  },
  index: number,
  retrievalId: string | null,
): MessageRetrieval {
  const result_ref = citation as MessageRetrievalResultRef;
  return {
    id: retrievalId ?? undefined,
    tool_call_id: data.tool_call_id ?? undefined,
    tool_call_index: data.tool_call_index ?? null,
    ordinal: index,
    scope: data.scope,
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
    summary_md: "summary_md" in citation ? (citation.summary_md ?? null) : null,
    exact_snippet: citation.snippet,
    retrieval_status: citation.selected ? "selected" : "retrieved",
    included_in_prompt: citation.selected,
    included_in_prompt_source: citation.selected ? "tool_output" : "none",
  };
}

function retrievalFromWebCitation(
  citation: WebCitationEventData,
  data: {
    tool_call_id?: string | null;
    tool_call_index?: number | null;
    scope: string;
  },
  index: number,
  retrievalId: string | null,
): MessageRetrieval {
  const result_ref: MessageRetrievalResultRef = citation;
  return {
    id: retrievalId ?? undefined,
    tool_call_id: data.tool_call_id ?? undefined,
    tool_call_index: data.tool_call_index ?? null,
    ordinal: index,
    scope: data.scope,
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
    included_in_prompt: citation.selected ?? true,
    included_in_prompt_source:
      citation.selected === false ? "none" : "tool_output",
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

export function useChatMessageUpdates({
  setMessages,
  onContextRefAdded,
}: {
  setMessages: Dispatch<SetStateAction<ConversationMessage[]>>;
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

  const shouldFoldEvent = useCallback((runId: string, seq: number) => {
    if (seq <= (foldedSeqRef.current.get(runId) ?? 0)) return false;
    foldedSeqRef.current.set(runId, seq);
    return true;
  }, []);

  const handleToolCall = useCallback(
    (assistantId: string, data: RenderToolCallData) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const trail = m.trust_trail;
          if (!trail) return m;
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
            status: data.status ?? "running",
            scope: "provider_tool",
            requested_types: previous?.requested_types ?? [],
            input_preview: previous?.input_preview,
            result_refs: previous?.result_refs ?? [],
            selected_context_refs: previous?.selected_context_refs ?? [],
            provider_request_ids: previous?.provider_request_ids ?? [],
            result_count: previous?.result_count ?? 0,
            selected_count: previous?.selected_count ?? 0,
            more_candidates_available:
              previous?.more_candidates_available ?? false,
            retrievals: previous?.retrievals ?? [],
            candidate_ledgers: previous?.candidate_ledgers ?? [],
            rerank_ledgers: previous?.rerank_ledgers ?? [],
          };
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

  const handleToolCallDelta = useCallback(
    (assistantId: string, data: SSEToolCallDeltaEvent["data"]) => {
      flushDeltas();
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const trail = m.trust_trail;
          if (!trail) return m;
          const existing = trail.tool_calls;
          const index = existing.findIndex(
            (call) => call.tool_call_index === data.tool_call_index,
          );
          // Provider-only deltas (no preceding tool_call_start that opened a
          // durable row) must not synthesize a row; they only fold a live input
          // preview into a row a real tool call already created.
          if (index < 0) {
            return {
              ...m,
              trust_trail: { ...trail, status: "running" },
            };
          }
          const previous = existing[index];
          const nextCall: MessageToolCall = {
            ...previous,
            id: data.tool_call_id ?? previous?.id,
            assistant_message_id: data.assistant_message_id,
            tool_name: data.tool_name,
            tool_call_index: data.tool_call_index,
            status: "running",
            scope: "provider_tool",
            requested_types: previous?.requested_types ?? [],
            input_preview: data.input_preview ?? previous?.input_preview,
            result_refs: previous?.result_refs ?? [],
            selected_context_refs: previous?.selected_context_refs ?? [],
            provider_request_ids: previous?.provider_request_ids ?? [],
            result_count: previous?.result_count ?? 0,
            selected_count: previous?.selected_count ?? 0,
            more_candidates_available:
              previous?.more_candidates_available ?? false,
            retrievals: previous?.retrievals ?? [],
            candidate_ledgers: previous?.candidate_ledgers ?? [],
            rerank_ledgers: previous?.rerank_ledgers ?? [],
          };
          const toolCalls = existing.map((call, idx) =>
            idx === index ? nextCall : call,
          );
          return {
            ...m,
            trust_trail: { ...trail, status: "running", tool_calls: toolCalls },
          };
        }),
      );
    },
    [flushDeltas, setMessages],
  );

  const handleToolCallDone = useCallback(
    (assistantId: string, data: SSEToolCallDoneEvent["data"]) => {
      flushDeltas();
      handleToolCall(assistantId, {
        ...data,
        status: "running",
      });
    },
    [flushDeltas, handleToolCall],
  );

  const handleToolResult = useCallback(
    (assistantId: string, data: SSEToolResultEvent["data"]) => {
      const results = Array.isArray(data.results) ? data.results : [];
      const retrievals: MessageRetrieval[] = results.flatMap(
        (citation, index) => {
          if (isWebCitationEventData(citation)) {
            return [
              retrievalFromWebCitation(
                citation,
                data,
                index,
                data.retrieval_ids[index] ?? null,
              ),
            ];
          }
          if (!isSearchCitationEventData(citation)) return [];
          return [
            retrievalFromSearchCitation(
              citation,
              data,
              index,
              data.retrieval_ids[index] ?? null,
            ),
          ];
        },
      );
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const trail = m.trust_trail;
          if (!trail) return m;
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
            scope: data.scope,
            requested_types: data.types,
            source_domain: data.source_domain,
            source_policy: data.source_policy,
            error_code: data.error_code ?? null,
            latency_ms: data.latency_ms,
            result_count: data.result_count ?? 0,
            selected_count: data.selected_count ?? 0,
            more_candidates_available: data.more_candidates_available ?? false,
            result_refs: data.results as Array<Record<string, unknown>>,
            selected_context_refs: previous?.selected_context_refs ?? [],
            provider_request_ids:
              data.provider_request_ids ?? previous?.provider_request_ids ?? [],
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

  const handlePromptAssembly = useCallback(
    (assistantId: string, data: SSEPromptAssemblyEvent["data"]) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const trail = m.trust_trail;
          if (!trail) return m;
          return {
            ...m,
            trust_trail: {
              ...trail,
              prompt: data.prompt,
            },
          };
        }),
      );
    },
    [setMessages],
  );

  const handleRetrievalPlan = useCallback(
    (assistantId: string, data: SSERetrievalPlanEvent["data"]) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const trail = m.trust_trail;
          if (!trail?.run) return m;
          return {
            ...m,
            trust_trail: {
              ...trail,
              run: {
                ...trail.run,
                retrieval_plan: data.retrieval_plan,
              },
            },
          };
        }),
      );
    },
    [setMessages],
  );

  const handleToolLedgerSnapshot = useCallback(
    (assistantId: string, data: SSEToolLedgerSnapshotEvent["data"]) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const trail = m.trust_trail;
          if (!trail) return m;
          const existing = trail.tool_calls;
          const index = existing.findIndex(
            (call) => call.tool_call_index === data.tool_call_index,
          );
          const previous = index >= 0 ? existing[index] : null;
          const nextCall: MessageToolCall = {
            ...(previous ?? {}),
            id: data.tool_call_id,
            assistant_message_id: data.assistant_message_id,
            tool_name: data.tool_name,
            tool_call_index: data.tool_call_index,
            status: previous?.status ?? "running",
            scope: data.scope,
            requested_types: data.requested_types,
            source_domain: data.source_domain,
            source_policy: data.source_policy,
            result_refs: previous?.result_refs ?? [],
            selected_context_refs: previous?.selected_context_refs ?? [],
            provider_request_ids: previous?.provider_request_ids ?? [],
            result_count: previous?.result_count ?? 0,
            selected_count: previous?.selected_count ?? 0,
            more_candidates_available:
              previous?.more_candidates_available ?? false,
            retrievals: previous?.retrievals ?? [],
            candidate_ledgers: data.candidate_ledgers,
            rerank_ledgers: data.rerank_ledgers,
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
      const citations = data.citations.map((item) => item.citation);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const trail = m.trust_trail;
          if (!trail) return m;
          return {
            ...m,
            citations,
            trust_trail: {
              ...trail,
              citations: data.citations.map((item) => ({
                citation_edge_id: item.citation_edge_id,
                ordinal: item.citation.ordinal,
                role: item.citation.role,
                target_ref: item.citation.target_ref,
                retrieval_id: item.retrieval_id ?? null,
                tool_call_id: item.tool_call_id ?? null,
                citation: item.citation,
              })),
              tool_calls: trail.tool_calls.map((tool) => ({
                ...tool,
                retrievals: tool.retrievals.map((retrieval) => {
                  const match = data.citations.find(
                    (item) =>
                      item.retrieval_id != null &&
                      item.retrieval_id === retrieval.id,
                  );
                  if (!match) return retrieval;
                  return {
                    ...retrieval,
                    id: match.retrieval_id ?? retrieval.id,
                    cited_edge_id: match.citation_edge_id,
                    citation_number: match.citation.ordinal,
                    citation_role: match.citation.role,
                  };
                }),
              })),
            },
          };
        }),
      );
    },
    [setMessages],
  );

  const handleContextRefAdded = useCallback(
    (
      assistantId: string,
      data: SSEContextRefAddedEvent["data"],
      seq: number,
    ) => {
      onContextRefAdded?.(data);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const trail = m.trust_trail;
          if (!trail) return m;
          const contextRef = {
            chat_run_event_seq: seq,
            id: data.id,
            conversation_id: data.conversation_id,
            resource_ref: data.resource_ref,
            activation: data.activation,
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
              context_refs_added: trail.context_refs_added.some(
                (existing) => existing.id === data.id,
              )
                ? trail.context_refs_added.map((existing) =>
                    existing.id === data.id ? contextRef : existing,
                  )
                : [...trail.context_refs_added, contextRef],
            },
          };
        }),
      );
    },
    [onContextRefAdded, setMessages],
  );

  const handleDone = useCallback(
    (assistantId: string, data: SSEDoneEvent["data"]) => {
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
            status: data.status,
            error_code: data.error_code,
            trust_trail: m.trust_trail
              ? {
                  ...m.trust_trail,
                  status: data.status,
                  run: m.trust_trail.run
                    ? {
                        ...m.trust_trail.run,
                        status: data.status,
                        usage: data.usage ?? m.trust_trail.run.usage,
                        error_code: data.error_code,
                        final_chars:
                          data.final_chars ?? m.trust_trail.run.final_chars,
                      }
                    : m.trust_trail.run,
                }
              : m.trust_trail,
          };
        }),
      );
    },
    [setMessages],
  );

  return {
    flushDeltas,
    shouldFoldEvent,
    handleOptimisticMessages,
    handleMetaReceived,
    handleDelta,
    handleToolCall,
    handleToolCallDelta,
    handleToolCallDone,
    handleToolResult,
    handlePromptAssembly,
    handleRetrievalPlan,
    handleToolLedgerSnapshot,
    handleCitationIndex,
    handleContextRefAdded,
    handleDone,
  };
}
