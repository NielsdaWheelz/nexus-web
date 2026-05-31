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
  hasOnlyKeys,
  isOptionalString,
} from "./guards";
import {
  isCitationEventData,
  type CitationEventData,
} from "./citations";

/** Meta event: initial IDs and model info. */
interface SSEMetaEvent {
  type: "meta";
  data: {
    conversation_id: string;
    user_message_id: string;
    assistant_message_id: string;
    model_id: string;
    provider: string;
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
    final_chars?: number;
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
    tool_name: "app_search" | "web_search";
    tool_call_index: number;
    status: ChatToolStatus;
    scope: string;
    types: string[];
    semantic: boolean;
    filters: Record<string, unknown>;
    freshness_days?: number | null;
    allowed_domains?: string[];
    blocked_domains?: string[];
    error_code?: string | null;
  };
}

export interface SSERetrievalResultEvent {
  type: "retrieval_result";
  data: {
    tool_call_id?: string | null;
    assistant_message_id: string;
    tool_name: "app_search" | "web_search";
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

export interface SSECitationIndexEvent {
  type: "citation_index";
  data: {
    assistant_message_id: string;
    entries: Array<{
      n: number;
      retrieval_id: string;
      tool_call_id: string;
      ordinal: number;
    }>;
  };
}

export interface SSEReferenceAddedEvent {
  type: "reference_added";
  data: {
    reference_id: string;
    conversation_id: string;
    resource_uri: string;
    label: string;
    summary: string;
    inline_body: string | null;
    fetch_hint: string;
    missing: boolean;
    created_at: string;
  };
}

export type SSEEvent =
  | SSEMetaEvent
  | SSEDeltaEvent
  | SSEDoneEvent
  | SSEToolCallEvent
  | SSERetrievalResultEvent
  | SSECitationIndexEvent
  | SSEReferenceAddedEvent;

function parseMetaData(data: unknown): SSEMetaEvent["data"] {
  if (
    !isRecord(data) ||
    typeof data.conversation_id !== "string" ||
    typeof data.user_message_id !== "string" ||
    typeof data.assistant_message_id !== "string" ||
    typeof data.model_id !== "string" ||
    typeof data.provider !== "string"
  ) {
    throw new Error("Invalid SSE payload for meta");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the meta payload.
  return data as SSEMetaEvent["data"];
}

function parseDeltaData(data: unknown): SSEDeltaEvent["data"] {
  if (!isRecord(data) || typeof data.delta !== "string") {
    throw new Error("Invalid SSE payload for delta");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the delta payload.
  return data as SSEDeltaEvent["data"];
}

function parseDoneData(data: unknown): SSEDoneEvent["data"] {
  if (
    !isRecord(data) ||
    (data.status !== "complete" &&
      data.status !== "error" &&
      data.status !== "cancelled") ||
    !(typeof data.error_code === "string" || data.error_code === null) ||
    (data.final_chars !== undefined && !Number.isInteger(data.final_chars))
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
      "semantic",
      "filters",
      "freshness_days",
      "allowed_domains",
      "blocked_domains",
      "error_code",
    ]) ||
    typeof data.assistant_message_id !== "string" ||
    (data.tool_name !== "app_search" && data.tool_name !== "web_search") ||
    !Number.isInteger(data.tool_call_index) ||
    !isChatToolStatus(data.status) ||
    (data.tool_call_id !== undefined &&
      data.tool_call_id !== null &&
      typeof data.tool_call_id !== "string") ||
    typeof data.scope !== "string" ||
    !Array.isArray(data.types) ||
    !data.types.every((item) => typeof item === "string") ||
    typeof data.semantic !== "boolean" ||
    !isRecord(data.filters) ||
    (data.freshness_days !== undefined &&
      data.freshness_days !== null &&
      !Number.isInteger(data.freshness_days)) ||
    (data.allowed_domains !== undefined &&
      (!Array.isArray(data.allowed_domains) ||
        !data.allowed_domains.every((item) => typeof item === "string"))) ||
    (data.blocked_domains !== undefined &&
      (!Array.isArray(data.blocked_domains) ||
        !data.blocked_domains.every((item) => typeof item === "string"))) ||
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
    (data.tool_name !== "app_search" && data.tool_name !== "web_search") ||
    !isOptionalString(data.tool_call_id) ||
    !Number.isInteger(data.tool_call_index) ||
    !isChatToolStatus(data.status) ||
    !isOptionalString(data.error_code) ||
    !Number.isInteger(data.result_count) ||
    !Number.isInteger(data.selected_count) ||
    (data.latency_ms !== undefined &&
      data.latency_ms !== null &&
      !Number.isInteger(data.latency_ms)) ||
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
    typeof data.assistant_message_id !== "string" ||
    !Array.isArray(data.entries)
  ) {
    throw new Error("Invalid SSE payload for citation_index");
  }
  return {
    assistant_message_id: data.assistant_message_id,
    entries: data.entries.map(parseCitationIndexEntry),
  };
}

function parseCitationIndexEntry(
  entry: unknown,
): SSECitationIndexEvent["data"]["entries"][number] {
  if (!isRecord(entry)) {
    throw new Error("Invalid SSE payload for citation_index");
  }
  const n = entry.n;
  const retrievalId = entry.retrieval_id;
  const toolCallId = entry.tool_call_id;
  const ordinal = entry.ordinal;
  if (
    typeof n !== "number" ||
    !Number.isInteger(n) ||
    n < 1 ||
    typeof retrievalId !== "string" ||
    typeof toolCallId !== "string" ||
    typeof ordinal !== "number" ||
    !Number.isInteger(ordinal)
  ) {
    throw new Error("Invalid SSE payload for citation_index");
  }
  return {
    n,
    retrieval_id: retrievalId,
    tool_call_id: toolCallId,
    ordinal,
  };
}

function parseReferenceAddedData(
  data: unknown,
): SSEReferenceAddedEvent["data"] {
  if (
    !isRecord(data) ||
    typeof data.reference_id !== "string" ||
    typeof data.conversation_id !== "string" ||
    typeof data.resource_uri !== "string" ||
    typeof data.label !== "string" ||
    typeof data.summary !== "string" ||
    !(typeof data.inline_body === "string" || data.inline_body === null) ||
    typeof data.fetch_hint !== "string" ||
    typeof data.missing !== "boolean" ||
    typeof data.created_at !== "string"
  ) {
    throw new Error("Invalid SSE payload for reference_added");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the reference_added payload.
  return data as SSEReferenceAddedEvent["data"];
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
    case "reference_added":
      return { type: "reference_added", data: parseReferenceAddedData(data) };
    default:
      throw new Error(`Unknown SSE event type: ${eventType || "message"}`);
  }
}
