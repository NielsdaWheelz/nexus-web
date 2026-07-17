/**
 * messageUpdateReducer — the single owner of conversation message-list transitions.
 *
 * Every change to the rendered `messages[]` is one named, total action. The chat
 * engine (`useConversation`) holds the `messages` state and is the ONLY caller of
 * `setMessages`; it does so exclusively through this reducer. The fold layer
 * (`useChatMessageUpdates`) and the run-tail orchestrator (`useChatRunTail`)
 * dispatch actions; they never mutate the list directly.
 *
 * The reducer is pure and total: it returns the next `messages[]` for a given
 * state + action, performs no I/O, holds no refs, and an unknown action is a
 * compile error (exhaustive `switch`). It is the single place message identity,
 * ordering, and per-field updates change.
 *
 * Behavior is a faithful port of the prior in-hook `setMessages` bodies — the
 * action payloads carry the same SSE event data the fold handlers consumed, and
 * the per-field logic is identical. This is an ownership cutover, not a behavior
 * change.
 */

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
  SSEToolCallDeltaEvent,
  SSEToolCallEvent,
  SSEToolResultEvent,
} from "@/lib/api/sse/events";
import { selectedPathAfterRun } from "@/lib/conversations/branching";
import {
  conversationMessageText,
  createRunningAssistantTrustTrail,
} from "@/lib/conversations/types";
import type {
  AssistantTrustTrail,
  ChatRunResponse,
  ConversationMessage,
  MessageDocument,
  MessageRetrieval,
  MessageRetrievalResultRef,
  MessageToolCall,
} from "@/lib/conversations/types";

type ChatRunData = ChatRunResponse["data"];
type TerminalRunStatus = "complete" | "error" | "cancelled";

/** A render-time provider tool-call patch from `tool_call_start`/`tool_call_done`. */
export type RenderToolCallData = SSEToolCallEvent["data"] & {
  status?: ChatToolStatus;
};

/**
 * The two provider tool-call patches that share `message_tool_calls` lifecycle but
 * differ in field handling:
 *   - `lifecycle` (tool_call_start / tool_call_done): resets `requested_types`,
 *     preserves prior `input_preview`, status defaults to "running".
 *   - `input` (tool_call_delta): preserves prior `requested_types`, takes the
 *     streamed input preview when present, status is always "running".
 */
export type ToolCallPatch =
  | { kind: "lifecycle"; data: RenderToolCallData }
  | { kind: "input"; data: SSEToolCallDeltaEvent["data"] };

export type MessageUpdateAction =
  | { type: "set_all"; messages: ConversationMessage[] }
  | { type: "prepend_older"; messages: ConversationMessage[] }
  | {
      type: "seed_optimistic";
      user: ConversationMessage;
      assistant: ConversationMessage;
    }
  | {
      type: "swap_meta_ids";
      map: ReadonlyArray<{ tempId: string; realId: string }>;
    }
  | { type: "fold_text_delta"; assistantId: string; delta: string }
  | { type: "apply_tool_call"; assistantId: string; call: ToolCallPatch }
  | {
      type: "apply_tool_result";
      assistantId: string;
      data: SSEToolResultEvent["data"];
    }
  | {
      type: "apply_citation_index";
      assistantId: string;
      data: SSECitationIndexEvent["data"];
    }
  | {
      type: "apply_context_ref";
      assistantId: string;
      data: SSEContextRefAddedEvent["data"];
    }
  | {
      type: "finalize_done";
      assistantId: string;
      status: TerminalRunStatus;
      errorCode: string | null;
      /** Any text still buffered when the run finished (the RAF flush remainder). */
      delta?: string;
    }
  | {
      type: "merge_run_pair";
      run: ChatRunData;
      idsToReplace: readonly string[];
    };

// ---------------------------------------------------------------------------
// Pure field helpers (ported verbatim from the prior fold handlers)
// ---------------------------------------------------------------------------

function messageDocumentWithText(content: string): MessageDocument {
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
  return createRunningAssistantTrustTrail({
    assistantMessageId: assistantId,
    conversationId,
    createdAt: message.created_at,
    updatedAt: message.updated_at,
  });
}

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
    summary_md: "summary_md" in citation ? (citation.summary_md ?? null) : null,
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

// ---------------------------------------------------------------------------
// Per-action transitions
// ---------------------------------------------------------------------------

function foldTextDelta(
  state: ConversationMessage[],
  assistantId: string,
  delta: string,
): ConversationMessage[] {
  if (delta.length === 0) return state;
  return state.map((m) => {
    if (m.id !== assistantId) return m;
    const content = conversationMessageText(m) + delta;
    return { ...m, message_document: messageDocumentWithText(content) };
  });
}

function applyToolCall(
  state: ConversationMessage[],
  assistantId: string,
  patch: ToolCallPatch,
): ConversationMessage[] {
  const { data } = patch;
  return state.map((m) => {
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
      status:
        patch.kind === "lifecycle" ? (patch.data.status ?? "running") : "running",
      scope: "provider_tool",
      requested_types:
        patch.kind === "lifecycle" ? [] : (previous?.requested_types ?? []),
      input_preview:
        patch.kind === "input"
          ? (patch.data.input_preview ?? previous?.input_preview)
          : previous?.input_preview,
      result_refs: previous?.result_refs ?? [],
      selected_context_refs: previous?.selected_context_refs ?? [],
      provider_request_ids: previous?.provider_request_ids ?? [],
      result_count: previous?.result_count ?? 0,
      selected_count: previous?.selected_count ?? 0,
      retrievals: previous?.retrievals ?? [],
    };
    const toolCalls =
      index >= 0
        ? existing.map((call, idx) =>
            idx === index
              ? patch.kind === "lifecycle"
                ? { ...call, ...nextCall }
                : nextCall
              : call,
          )
        : [...existing, nextCall];
    return {
      ...m,
      trust_trail: { ...trail, status: "running", tool_calls: toolCalls },
    };
  });
}

function applyToolResult(
  state: ConversationMessage[],
  assistantId: string,
  data: SSEToolResultEvent["data"],
): ConversationMessage[] {
  const results = Array.isArray(data.results) ? data.results : [];
  const retrievals: MessageRetrieval[] = results.flatMap((citation, index) => {
    if (isWebCitationEventData(citation)) {
      return [retrievalFromWebCitation(citation, data, index)];
    }
    if (!isSearchCitationEventData(citation)) return [];
    return [retrievalFromSearchCitation(citation, data, index)];
  });
  return state.map((m) => {
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
      scope: data.scope,
      requested_types: data.types,
      error_code: data.error_code ?? null,
      latency_ms: data.latency_ms,
      result_count: data.result_count ?? 0,
      selected_count: data.selected_count ?? 0,
      result_refs: data.results as Array<Record<string, unknown>>,
      selected_context_refs: previous?.selected_context_refs ?? [],
      provider_request_ids:
        data.provider_request_ids ?? previous?.provider_request_ids ?? [],
      retrievals,
    };
    const toolCalls =
      index >= 0
        ? existing.map((call, idx) => (idx === index ? nextCall : call))
        : [...existing, nextCall];
    return { ...m, trust_trail: { ...trail, tool_calls: toolCalls } };
  });
}

function applyCitationIndex(
  state: ConversationMessage[],
  assistantId: string,
  data: SSECitationIndexEvent["data"],
): ConversationMessage[] {
  const citations = data.citations.map((item) => item.citation);
  return state.map((m) => {
    if (m.id !== assistantId) return m;
    const trail = trustTrailFor(m, data.assistant_message_id);
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
          retrieval_id: null,
          tool_call_id: null,
          citation: item.citation,
        })),
      },
    };
  });
}

function applyContextRef(
  state: ConversationMessage[],
  assistantId: string,
  data: SSEContextRefAddedEvent["data"],
): ConversationMessage[] {
  return state.map((m) => {
    if (m.id !== assistantId) return m;
    const trail = trustTrailFor(m, assistantId, data.conversation_id);
    const contextRef = {
      chat_run_event_seq: 0,
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
  });
}

function finalizeDone(
  state: ConversationMessage[],
  assistantId: string,
  status: TerminalRunStatus,
  errorCode: string | null,
  delta: string | undefined,
): ConversationMessage[] {
  return state.map((m) => {
    if (m.id !== assistantId) return m;
    const content = delta
      ? conversationMessageText(m) + delta
      : conversationMessageText(m);
    return {
      ...m,
      message_document: messageDocumentWithText(content),
      status,
      error_code: errorCode,
      trust_trail: m.trust_trail
        ? { ...m.trust_trail, status }
        : m.trust_trail,
    };
  });
}

export function messageUpdateReducer(
  state: ConversationMessage[],
  action: MessageUpdateAction,
): ConversationMessage[] {
  switch (action.type) {
    case "set_all":
      return action.messages;
    case "prepend_older": {
      const existingIds = new Set(state.map((m) => m.id));
      const next = action.messages.filter((m) => !existingIds.has(m.id));
      return [...next, ...state];
    }
    case "seed_optimistic":
      return [action.user, action.assistant];
    case "swap_meta_ids":
      return state.map((m) => {
        const swap = action.map.find((pair) => pair.tempId === m.id);
        if (!swap) return m;
        return {
          ...m,
          id: swap.realId,
          trust_trail: m.trust_trail
            ? { ...m.trust_trail, assistant_message_id: swap.realId }
            : m.trust_trail,
        };
      });
    case "fold_text_delta":
      return foldTextDelta(state, action.assistantId, action.delta);
    case "apply_tool_call":
      return applyToolCall(state, action.assistantId, action.call);
    case "apply_tool_result":
      return applyToolResult(state, action.assistantId, action.data);
    case "apply_citation_index":
      return applyCitationIndex(state, action.assistantId, action.data);
    case "apply_context_ref":
      return applyContextRef(state, action.assistantId, action.data);
    case "finalize_done":
      return finalizeDone(
        state,
        action.assistantId,
        action.status,
        action.errorCode,
        action.delta,
      );
    case "merge_run_pair":
      return selectedPathAfterRun(state, action.run, [...action.idsToReplace]);
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
