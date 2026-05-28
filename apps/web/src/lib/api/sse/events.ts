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
  isOptionalRecord,
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

export interface SSESourceManifestDeltaEvent {
  type: "source_manifest_delta";
  data: {
    assistant_message_id: string;
    tool_call_id?: string | null;
    tool_name: "app_search" | "web_search";
    tool_call_index: number;
    query_hash?: string | null;
    scope: string;
    filters: Record<string, unknown>;
    requested_types: string[];
    candidate_count: number;
    result_count: number;
    selected_count: number;
    included_in_prompt_count: number;
    excluded_by_budget_count: number;
    excluded_by_scope_count: number;
    stale_count: number;
    unreadable_count: number;
    index_versions: string[];
    metadata?: Record<string, unknown>;
    latency_ms?: number | null;
    status: ChatToolStatus;
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

export type SSEEvent =
  | SSEMetaEvent
  | SSEDeltaEvent
  | SSEDoneEvent
  | SSEToolCallEvent
  | SSERetrievalResultEvent
  | SSESourceManifestDeltaEvent
  | SSECitationIndexEvent;

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

function parseSourceManifestDeltaData(
  data: unknown,
): SSESourceManifestDeltaEvent["data"] {
  if (
    !isRecord(data) ||
    typeof data.assistant_message_id !== "string" ||
    !isOptionalString(data.tool_call_id) ||
    (data.tool_name !== "app_search" && data.tool_name !== "web_search") ||
    !Number.isInteger(data.tool_call_index) ||
    !isOptionalString(data.query_hash) ||
    typeof data.scope !== "string" ||
    !isRecord(data.filters) ||
    !Array.isArray(data.requested_types) ||
    !data.requested_types.every((item) => typeof item === "string") ||
    !Number.isInteger(data.candidate_count) ||
    !Number.isInteger(data.result_count) ||
    !Number.isInteger(data.selected_count) ||
    !Number.isInteger(data.included_in_prompt_count) ||
    !Number.isInteger(data.excluded_by_budget_count) ||
    !Number.isInteger(data.excluded_by_scope_count) ||
    !Number.isInteger(data.stale_count) ||
    !Number.isInteger(data.unreadable_count) ||
    !Array.isArray(data.index_versions) ||
    !data.index_versions.every((item) => typeof item === "string") ||
    !isOptionalRecord(data.metadata) ||
    (data.latency_ms !== undefined &&
      data.latency_ms !== null &&
      !Number.isInteger(data.latency_ms)) ||
    !isChatToolStatus(data.status)
  ) {
    throw new Error("Invalid SSE payload for source_manifest_delta");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the source_manifest_delta payload.
  return data as SSESourceManifestDeltaEvent["data"];
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
    !Array.isArray(data.entries) ||
    !data.entries.every(
      (entry) =>
        isRecord(entry) &&
        Number.isInteger(entry.n) &&
        (entry.n as number) >= 1 &&
        typeof entry.retrieval_id === "string" &&
        typeof entry.tool_call_id === "string" &&
        Number.isInteger(entry.ordinal),
    )
  ) {
    throw new Error("Invalid SSE payload for citation_index");
  }
  return data as SSECitationIndexEvent["data"];
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
    case "source_manifest_delta":
      return {
        type: "source_manifest_delta",
        data: parseSourceManifestDeltaData(data),
      };
    case "citation_index":
      return { type: "citation_index", data: parseCitationIndexData(data) };
    default:
      throw new Error(`Unknown SSE event type: ${eventType || "message"}`);
  }
}
