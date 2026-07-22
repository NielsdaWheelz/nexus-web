/**
 * SSE chat-run event types and dispatcher.
 *
 * Framing rules:
 * 1. Only process `event:` + `data:` lines.
 * 2. Ignore comment lines (`:`); unknown event types are stream errors.
 * 3. `data:` payload is JSON, one object per event.
 * 4. Max event size: 256 KB. Exceeding this is a stream error.
 * 5. If JSON parse fails on a `data:` line: stream error.
 */

import { isRecord } from "@/lib/validation";
import {
  isCitationOut,
  type CitationOut,
} from "@/lib/conversations/citationOut";
import {
  normalizeResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { hasOnlyKeys, isOptionalString } from "./guards";
import {
  isCitationEventData,
  type CitationEventData,
} from "./citations";

/** Meta event: initial IDs and product-selection snapshot (profile_id/
 * reasoning_option_id). Resolved provider/model are operator facts filled in
 * later on the run record, not carried on this event (§10). */
interface SSEMetaEvent {
  type: "meta";
  data: {
    run_id: string;
    conversation_id: string;
    user_message_id: string;
    assistant_message_id: string;
    profile_id: string;
    reasoning_option_id: string;
    chat_subject: {
      requested_resource_ref: string;
      resource_ref: string;
      context_edge_id: string | null;
      companions: string[];
    } | null;
  };
}

interface SSEAssistantActivityEvent {
  type: "assistant_activity";
  data: {
    assistant_message_id: string;
    phase:
      | "queued"
      | "thinking"
      | "writing"
      | "tool_calling"
      | "waiting"
      | "retrying"
      | "cancelling";
    label?: string | null;
    provider_event_seq_start?: number | null;
    provider_event_seq_end?: number | null;
  };
}

/** Incremental assistant content. */
interface SSEAssistantTextDeltaEvent {
  type: "assistant_text_delta";
  data: {
    assistant_message_id: string;
    text: string;
    provider_event_seq_start: number;
    provider_event_seq_end: number;
  };
}

/** Done event: stream completion. */
interface SSEDoneEvent {
  type: "done";
  data: {
    status: "complete" | "error" | "cancelled";
    usage?: Record<string, unknown> | null;
    error_code: string | null;
    final_chars?: number | null;
    last_provider_event_seq?: number | null;
    cancelled?: boolean | null;
  };
}

export type ChatToolStatus =
  | "pending"
  | "running"
  | "complete"
  | "error"
  | "cancelled";

export interface SSEToolCallEvent {
  type: "tool_call_start";
  data: {
    tool_call_id?: string | null;
    assistant_message_id: string;
    tool_name: string;
    tool_call_index: number;
    provider_tool_call_id?: string | null;
    provider_event_seq_start: number;
    provider_event_seq_end: number;
  };
}

export interface SSEToolCallDeltaEvent {
  type: "tool_call_delta";
  data: SSEToolCallEvent["data"] & {
    input_delta: string;
    input_preview?: string | null;
  };
}

export interface SSEToolCallDoneEvent {
  type: "tool_call_done";
  data: SSEToolCallEvent["data"] & {
    input: Record<string, unknown>;
  };
}

export interface SSEToolResultEvent {
  type: "tool_result";
  data: {
    tool_call_id?: string | null;
    assistant_message_id: string;
    tool_name: string;
    tool_call_index: number;
    status: ChatToolStatus;
    scope: string;
    types: string[];
    error_code?: string | null;
    result_count?: number | null;
    selected_count?: number | null;
    latency_ms?: number | null;
    provider_request_ids?: string[];
    filters: Record<string, unknown>;
    results: CitationEventData[];
  };
}

/** One citation edge carrying the backend-built citation read model. */
export interface SSECitationIndexItem {
  citation_edge_id: string;
  citation: CitationOut;
}

export interface SSECitationIndexEvent {
  type: "citation_index";
  data: {
    assistant_message_id: string;
    citations: SSECitationIndexItem[];
  };
}

/** A citation-materialized context edge (`ContextRefOut` shape). */
export interface SSEContextRefAddedEvent {
  type: "context_ref_added";
  data: {
    id: string;
    conversation_id: string;
    resource_ref: string;
    activation: ResourceActivation;
    label: string;
    summary: string;
    missing: boolean;
    created_at: string;
    citation_edge_id: string | null;
  };
}

export type SSEEvent = (
  | SSEMetaEvent
  | SSEAssistantActivityEvent
  | SSEAssistantTextDeltaEvent
  | SSEDoneEvent
  | SSEToolCallEvent
  | SSEToolCallDeltaEvent
  | SSEToolCallDoneEvent
  | SSEToolResultEvent
  | SSECitationIndexEvent
  | SSEContextRefAddedEvent
) & { seq: number };

function parseMetaData(data: unknown): SSEMetaEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "run_id",
      "conversation_id",
      "user_message_id",
      "assistant_message_id",
      "profile_id",
      "reasoning_option_id",
      "chat_subject",
    ]) ||
    typeof data.run_id !== "string" ||
    typeof data.conversation_id !== "string" ||
    typeof data.user_message_id !== "string" ||
    typeof data.assistant_message_id !== "string" ||
    typeof data.profile_id !== "string" ||
    typeof data.reasoning_option_id !== "string" ||
    (data.chat_subject !== null && !isMetaSubject(data.chat_subject))
  ) {
    throw new Error("Invalid SSE payload for meta");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the meta payload.
  return data as SSEMetaEvent["data"];
}

function isMetaSubject(
  data: unknown,
): data is SSEMetaEvent["data"]["chat_subject"] {
  return (
    isRecord(data) &&
    hasOnlyKeys(data, [
      "requested_resource_ref",
      "resource_ref",
      "context_edge_id",
      "companions",
    ]) &&
    typeof data.requested_resource_ref === "string" &&
    typeof data.resource_ref === "string" &&
    (data.context_edge_id === null ||
      typeof data.context_edge_id === "string") &&
    Array.isArray(data.companions) &&
    data.companions.every((item) => typeof item === "string")
  );
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

function isAssistantActivityPhase(
  value: unknown,
): value is SSEAssistantActivityEvent["data"]["phase"] {
  return (
    value === "queued" ||
    value === "thinking" ||
    value === "writing" ||
    value === "tool_calling" ||
    value === "waiting" ||
    value === "retrying" ||
    value === "cancelling"
  );
}

function parseAssistantActivityData(data: unknown): SSEAssistantActivityEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "assistant_message_id",
      "phase",
      "label",
      "provider_event_seq_start",
      "provider_event_seq_end",
    ]) ||
    typeof data.assistant_message_id !== "string" ||
    !isAssistantActivityPhase(data.phase) ||
    !isOptionalString(data.label) ||
    !isOptionalNonNegativeInteger(data.provider_event_seq_start) ||
    !isOptionalNonNegativeInteger(data.provider_event_seq_end)
  ) {
    throw new Error("Invalid SSE payload for assistant_activity");
  }
  return data as SSEAssistantActivityEvent["data"];
}

function parseAssistantTextDeltaData(data: unknown): SSEAssistantTextDeltaEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "assistant_message_id",
      "text",
      "provider_event_seq_start",
      "provider_event_seq_end",
    ]) ||
    typeof data.assistant_message_id !== "string" ||
    typeof data.text !== "string" ||
    data.text.length === 0 ||
    typeof data.provider_event_seq_start !== "number" ||
    !Number.isInteger(data.provider_event_seq_start) ||
    data.provider_event_seq_start < 0 ||
    typeof data.provider_event_seq_end !== "number" ||
    !Number.isInteger(data.provider_event_seq_end) ||
    data.provider_event_seq_end < 0
  ) {
    throw new Error("Invalid SSE payload for assistant_text_delta");
  }
  return data as SSEAssistantTextDeltaEvent["data"];
}

function parseDoneData(data: unknown): SSEDoneEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "status",
      "usage",
      "error_code",
      "final_chars",
      "last_provider_event_seq",
      "cancelled",
    ]) ||
    (data.status !== "complete" &&
      data.status !== "error" &&
      data.status !== "cancelled") ||
    (data.usage !== undefined && data.usage !== null && !isRecord(data.usage)) ||
    !(typeof data.error_code === "string" || data.error_code === null) ||
    (data.final_chars !== undefined &&
      data.final_chars !== null &&
      (typeof data.final_chars !== "number" ||
        !Number.isInteger(data.final_chars) ||
        data.final_chars < 0)) ||
    !isOptionalNonNegativeInteger(data.last_provider_event_seq) ||
    (data.cancelled !== undefined &&
      data.cancelled !== null &&
      typeof data.cancelled !== "boolean")
  ) {
    throw new Error("Invalid SSE payload for done");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the done payload.
  return data as SSEDoneEvent["data"];
}

function parseToolCallStartData(data: unknown): SSEToolCallEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "tool_call_id",
      "assistant_message_id",
      "tool_name",
      "tool_call_index",
      "provider_tool_call_id",
      "provider_event_seq_start",
      "provider_event_seq_end",
    ]) ||
    typeof data.assistant_message_id !== "string" ||
    typeof data.tool_name !== "string" ||
    data.tool_name.length === 0 ||
    typeof data.tool_call_index !== "number" ||
    !Number.isInteger(data.tool_call_index) ||
    data.tool_call_index < 0 ||
    (data.tool_call_id !== undefined &&
      data.tool_call_id !== null &&
      typeof data.tool_call_id !== "string") ||
    !isOptionalString(data.provider_tool_call_id) ||
    typeof data.provider_event_seq_start !== "number" ||
    !Number.isInteger(data.provider_event_seq_start) ||
    data.provider_event_seq_start < 0 ||
    typeof data.provider_event_seq_end !== "number" ||
    !Number.isInteger(data.provider_event_seq_end) ||
    data.provider_event_seq_end < 0
  ) {
    throw new Error("Invalid SSE payload for tool_call_start");
  }
  return data as SSEToolCallEvent["data"];
}

function parseToolCallDeltaData(data: unknown): SSEToolCallDeltaEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "tool_call_id",
      "assistant_message_id",
      "tool_name",
      "tool_call_index",
      "provider_tool_call_id",
      "input_delta",
      "input_preview",
      "provider_event_seq_start",
      "provider_event_seq_end",
    ]) ||
    typeof data.input_delta !== "string" ||
    data.input_delta.length === 0 ||
    !isOptionalString(data.input_preview)
  ) {
    throw new Error("Invalid SSE payload for tool_call_delta");
  }
  const { input_delta, input_preview, ...base } = data;
  return {
    ...parseToolCallStartData(base),
    input_delta: input_delta as string,
    input_preview,
  };
}

function parseToolCallDoneData(data: unknown): SSEToolCallDoneEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "tool_call_id",
      "assistant_message_id",
      "tool_name",
      "tool_call_index",
      "provider_tool_call_id",
      "input",
      "provider_event_seq_start",
      "provider_event_seq_end",
    ]) ||
    !isRecord(data.input)
  ) {
    throw new Error("Invalid SSE payload for tool_call_done");
  }
  const { input, ...base } = data;
  return {
    ...parseToolCallStartData(base),
    input: input as Record<string, unknown>,
  };
}

function parseToolResultData(
  data: unknown,
): SSEToolResultEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "tool_call_id",
      "assistant_message_id",
      "tool_name",
      "tool_call_index",
      "status",
      "scope",
      "types",
      "error_code",
      "result_count",
      "selected_count",
      "latency_ms",
      "provider_request_ids",
      "filters",
      "results",
    ]) ||
    typeof data.assistant_message_id !== "string" ||
    typeof data.tool_name !== "string" ||
    data.tool_name.length === 0 ||
    !isOptionalString(data.tool_call_id) ||
    typeof data.tool_call_index !== "number" ||
    !Number.isInteger(data.tool_call_index) ||
    data.tool_call_index < 0 ||
    !isChatToolStatus(data.status) ||
    typeof data.scope !== "string" ||
    data.scope.length === 0 ||
    !Array.isArray(data.types) ||
    !data.types.every((item) => typeof item === "string") ||
    !isOptionalString(data.error_code) ||
    !isOptionalNonNegativeInteger(data.result_count) ||
    !isOptionalNonNegativeInteger(data.selected_count) ||
    (data.latency_ms !== undefined &&
      data.latency_ms !== null &&
      (typeof data.latency_ms !== "number" ||
        !Number.isInteger(data.latency_ms) ||
        data.latency_ms < 0)) ||
    (data.provider_request_ids !== undefined &&
      (!Array.isArray(data.provider_request_ids) ||
        !data.provider_request_ids.every((item) => typeof item === "string"))) ||
    !isRecord(data.filters) ||
    !Array.isArray(data.results) ||
    !data.results.every(isCitationEventData)
  ) {
    throw new Error("Invalid SSE payload for tool_result");
  }
  return data as SSEToolResultEvent["data"];
}

function isChatToolStatus(value: unknown): value is ChatToolStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "complete" ||
    value === "error" ||
    value === "cancelled"
  );
}

function parseCitationIndexData(data: unknown): SSECitationIndexEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, ["assistant_message_id", "citations"]) ||
    typeof data.assistant_message_id !== "string" ||
    !Array.isArray(data.citations)
  ) {
    throw new Error("Invalid SSE payload for citation_index");
  }
  return {
    assistant_message_id: data.assistant_message_id,
    citations: data.citations.map(parseCitationIndexItem),
  };
}

function parseCitationIndexItem(item: unknown): SSECitationIndexItem {
  if (
    !isRecord(item) ||
    !hasOnlyKeys(item, ["citation_edge_id", "citation"]) ||
    typeof item.citation_edge_id !== "string" ||
    !isCitationOut(item.citation) ||
    item.citation.ordinal < 1
  ) {
    throw new Error("Invalid SSE payload for citation_index");
  }
  return {
    citation_edge_id: item.citation_edge_id,
    citation: item.citation,
  };
}

function parseContextRefAddedData(
  data: unknown,
): SSEContextRefAddedEvent["data"] {
  const activation = isRecord(data)
    ? normalizeResourceActivation(data.activation)
    : null;
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "id",
      "conversation_id",
      "resource_ref",
      "activation",
      "label",
      "summary",
      "missing",
      "created_at",
      "citation_edge_id",
    ]) ||
    typeof data.id !== "string" ||
    typeof data.conversation_id !== "string" ||
    typeof data.resource_ref !== "string" ||
    activation === null ||
    typeof data.label !== "string" ||
    typeof data.summary !== "string" ||
    typeof data.missing !== "boolean" ||
    typeof data.created_at !== "string" ||
    !("citation_edge_id" in data) ||
    !(typeof data.citation_edge_id === "string" || data.citation_edge_id === null)
  ) {
    throw new Error("Invalid SSE payload for context_ref_added");
  }
  return {
    id: data.id,
    conversation_id: data.conversation_id,
    resource_ref: data.resource_ref,
    activation,
    label: data.label,
    summary: data.summary,
    missing: data.missing,
    created_at: data.created_at,
    citation_edge_id: data.citation_edge_id,
  };
}

export function toChatSSEEvent(eventType: string, data: unknown, id = "0"): SSEEvent {
  const seq = Number(id || 0);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error("Invalid SSE event id");
  }
  switch (eventType) {
    case "meta":
      return { seq, type: "meta", data: parseMetaData(data) };
    case "assistant_activity":
      return { seq, type: "assistant_activity", data: parseAssistantActivityData(data) };
    case "assistant_text_delta":
      return { seq, type: "assistant_text_delta", data: parseAssistantTextDeltaData(data) };
    case "done":
      return { seq, type: "done", data: parseDoneData(data) };
    case "tool_call_start":
      return { seq, type: "tool_call_start", data: parseToolCallStartData(data) };
    case "tool_call_delta":
      return { seq, type: "tool_call_delta", data: parseToolCallDeltaData(data) };
    case "tool_call_done":
      return { seq, type: "tool_call_done", data: parseToolCallDoneData(data) };
    case "tool_result":
      return { seq, type: "tool_result", data: parseToolResultData(data) };
    case "citation_index":
      return { seq, type: "citation_index", data: parseCitationIndexData(data) };
    case "context_ref_added":
      return { seq, type: "context_ref_added", data: parseContextRefAddedData(data) };
    default:
      throw new Error(`Unknown SSE event type: ${eventType || "message"}`);
  }
}
