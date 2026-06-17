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

/** Meta event: initial IDs and model info. */
interface SSEMetaEvent {
  type: "meta";
  data: {
    run_id: string;
    conversation_id: string;
    user_message_id: string;
    assistant_message_id: string;
    model_id: string;
    provider: string;
    chat_subject: {
      requested_resource_ref: string;
      resource_ref: string;
      context_edge_id: string | null;
      companions: string[];
    } | null;
  };
}

/** Delta event: incremental content chunk. */
interface SSEDeltaEvent {
  type: "delta";
  data: {
    delta: string;
  };
}

/** Done event: stream completion. */
interface SSEDoneEvent {
  type: "done";
  data: {
    status: "complete" | "error" | "cancelled";
    error_code: string | null;
    final_chars?: number | null;
  };
}

export type ChatToolStatus =
  | "pending"
  | "running"
  | "complete"
  | "error"
  | "cancelled";

export interface SSEToolCallEvent {
  type: "tool_call";
  data: {
    tool_call_id?: string | null;
    assistant_message_id: string;
    tool_name: string;
    tool_call_index: number;
    status: ChatToolStatus;
    scope: string;
    types: string[];
    filters: Record<string, unknown>;
    error_code?: string | null;
  };
}

export interface SSERetrievalResultEvent {
  type: "retrieval_result";
  data: {
    tool_call_id?: string | null;
    assistant_message_id: string;
    tool_name: string;
    tool_call_index: number;
    status: ChatToolStatus;
    error_code?: string | null;
    result_count: number;
    selected_count: number;
    latency_ms?: number | null;
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

export type SSEEvent =
  | SSEMetaEvent
  | SSEDeltaEvent
  | SSEDoneEvent
  | SSEToolCallEvent
  | SSERetrievalResultEvent
  | SSECitationIndexEvent
  | SSEContextRefAddedEvent;

function parseMetaData(data: unknown): SSEMetaEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "run_id",
      "conversation_id",
      "user_message_id",
      "assistant_message_id",
      "model_id",
      "provider",
      "chat_subject",
    ]) ||
    typeof data.run_id !== "string" ||
    typeof data.conversation_id !== "string" ||
    typeof data.user_message_id !== "string" ||
    typeof data.assistant_message_id !== "string" ||
    typeof data.model_id !== "string" ||
    typeof data.provider !== "string" ||
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

function parseDeltaData(data: unknown): SSEDeltaEvent["data"] {
  if (!isRecord(data) || !hasOnlyKeys(data, ["delta"]) || typeof data.delta !== "string") {
    throw new Error("Invalid SSE payload for delta");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the delta payload.
  return data as SSEDeltaEvent["data"];
}

function parseDoneData(data: unknown): SSEDoneEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, ["status", "error_code", "final_chars"]) ||
    (data.status !== "complete" &&
      data.status !== "error" &&
      data.status !== "cancelled") ||
    !(typeof data.error_code === "string" || data.error_code === null) ||
    (data.final_chars !== undefined &&
      data.final_chars !== null &&
      (typeof data.final_chars !== "number" ||
        !Number.isInteger(data.final_chars) ||
        data.final_chars < 0))
  ) {
    throw new Error("Invalid SSE payload for done");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the done payload.
  return data as SSEDoneEvent["data"];
}

function parseToolCallData(data: unknown): SSEToolCallEvent["data"] {
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
      "filters",
      "error_code",
    ]) ||
    typeof data.assistant_message_id !== "string" ||
    typeof data.tool_name !== "string" ||
    data.tool_name.length === 0 ||
    typeof data.tool_call_index !== "number" ||
    !Number.isInteger(data.tool_call_index) ||
    data.tool_call_index < 0 ||
    !isChatToolStatus(data.status) ||
    (data.tool_call_id !== undefined &&
      data.tool_call_id !== null &&
      typeof data.tool_call_id !== "string") ||
    typeof data.scope !== "string" ||
    !Array.isArray(data.types) ||
    !data.types.every((item) => typeof item === "string") ||
    !isRecord(data.filters) ||
    !isOptionalString(data.error_code)
  ) {
    throw new Error("Invalid SSE payload for tool_call");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the tool_call payload.
  return data as SSEToolCallEvent["data"];
}

function parseRetrievalResultData(
  data: unknown,
): SSERetrievalResultEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "tool_call_id",
      "assistant_message_id",
      "tool_name",
      "tool_call_index",
      "status",
      "error_code",
      "result_count",
      "selected_count",
      "latency_ms",
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
    !isOptionalString(data.error_code) ||
    typeof data.result_count !== "number" ||
    !Number.isInteger(data.result_count) ||
    data.result_count < 0 ||
    typeof data.selected_count !== "number" ||
    !Number.isInteger(data.selected_count) ||
    data.selected_count < 0 ||
    (data.latency_ms !== undefined &&
      data.latency_ms !== null &&
      (typeof data.latency_ms !== "number" ||
        !Number.isInteger(data.latency_ms) ||
        data.latency_ms < 0)) ||
    !isRecord(data.filters) ||
    !Array.isArray(data.results) ||
    !data.results.every(isCitationEventData)
  ) {
    throw new Error("Invalid SSE payload for retrieval_result");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the retrieval_result payload.
  return data as SSERetrievalResultEvent["data"];
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

export function toChatSSEEvent(eventType: string, data: unknown): SSEEvent {
  switch (eventType) {
    case "meta":
      return { type: "meta", data: parseMetaData(data) };
    case "delta":
      return { type: "delta", data: parseDeltaData(data) };
    case "done":
      return { type: "done", data: parseDoneData(data) };
    case "tool_call":
      return { type: "tool_call", data: parseToolCallData(data) };
    case "retrieval_result":
      return { type: "retrieval_result", data: parseRetrievalResultData(data) };
    case "citation_index":
      return { type: "citation_index", data: parseCitationIndexData(data) };
    case "context_ref_added":
      return { type: "context_ref_added", data: parseContextRefAddedData(data) };
    default:
      throw new Error(`Unknown SSE event type: ${eventType || "message"}`);
  }
}
