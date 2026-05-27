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

import type {
  MessageClaimEvidence,
  MessageClaimKind,
  MessageClaimSupportStatus,
  MessageEvidenceRetrievalStatus,
  MessageEvidenceRole,
  MessageEvidenceVerifierStatus,
} from "@/lib/conversations/types";
import { isRecord } from "@/lib/validation";
import {
  hasOnlyKeys,
  isOptionalRecord,
  isOptionalString,
} from "./guards";
import {
  isCitationEventData,
  isRetrievalContextRef,
  type CitationEventData,
} from "./citations";
import { isRetrievalLocator } from "./locators";

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

export interface SSEClaimEvent {
  type: "claim";
  data: {
    id?: string;
    message_id?: string;
    ordinal?: number;
    claim_text: string;
    answer_start_offset?: number | null;
    answer_end_offset?: number | null;
    claim_kind: MessageClaimKind;
    support_status: MessageClaimSupportStatus;
    unsupported_reason?: string | null;
    confidence?: number | null;
    verifier_status: MessageEvidenceVerifierStatus;
    created_at?: string;
  };
}

export interface SSEClaimEvidenceEvent {
  type: "claim_evidence";
  data: MessageClaimEvidence;
}

export type SSEEvent =
  | SSEMetaEvent
  | SSEDeltaEvent
  | SSEDoneEvent
  | SSEToolCallEvent
  | SSERetrievalResultEvent
  | SSESourceManifestDeltaEvent
  | SSEClaimEvent
  | SSEClaimEvidenceEvent;

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

function parseClaimData(data: unknown): SSEClaimEvent["data"] {
  if (
    !isRecord(data) ||
    (data.id !== undefined && typeof data.id !== "string") ||
    (data.message_id !== undefined && typeof data.message_id !== "string") ||
    (data.ordinal !== undefined && !Number.isInteger(data.ordinal)) ||
    typeof data.claim_text !== "string" ||
    (data.answer_start_offset !== undefined &&
      data.answer_start_offset !== null &&
      !Number.isInteger(data.answer_start_offset)) ||
    (data.answer_end_offset !== undefined &&
      data.answer_end_offset !== null &&
      !Number.isInteger(data.answer_end_offset)) ||
    !isMessageClaimKind(data.claim_kind) ||
    !isMessageClaimSupportStatus(data.support_status) ||
    (data.unsupported_reason !== undefined &&
      data.unsupported_reason !== null &&
      typeof data.unsupported_reason !== "string") ||
    (data.confidence !== undefined &&
      data.confidence !== null &&
      typeof data.confidence !== "number") ||
    !isMessageEvidenceVerifierStatus(data.verifier_status) ||
    (data.created_at !== undefined && typeof data.created_at !== "string")
  ) {
    throw new Error("Invalid SSE payload for claim");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the claim payload.
  return data as SSEClaimEvent["data"];
}

function parseClaimEvidenceData(data: unknown): MessageClaimEvidence {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "id",
      "claim_id",
      "ordinal",
      "evidence_role",
      "source_ref",
      "retrieval_id",
      "evidence_span_id",
      "context_ref",
      "result_ref",
      "exact_snippet",
      "snippet_prefix",
      "snippet_suffix",
      "locator",
      "deep_link",
      "citation_label",
      "score",
      "retrieval_status",
      "selected",
      "included_in_prompt",
      "source_version",
      "created_at",
    ]) ||
    typeof data.id !== "string" ||
    typeof data.claim_id !== "string" ||
    !Number.isInteger(data.ordinal) ||
    !isMessageEvidenceRole(data.evidence_role) ||
    !isSourceRef(data.source_ref) ||
    !isMessageEvidenceRetrievalStatus(data.retrieval_status) ||
    typeof data.selected !== "boolean" ||
    typeof data.included_in_prompt !== "boolean" ||
    (data.retrieval_id !== undefined &&
      data.retrieval_id !== null &&
      typeof data.retrieval_id !== "string") ||
    (data.evidence_span_id !== undefined &&
      data.evidence_span_id !== null &&
      typeof data.evidence_span_id !== "string") ||
    !isOptionalRetrievalContextRef(data.context_ref) ||
    !isOptionalRetrievalResultRef(data.result_ref) ||
    !isOptionalString(data.exact_snippet) ||
    !isOptionalString(data.snippet_prefix) ||
    !isOptionalString(data.snippet_suffix) ||
    (data.locator !== undefined &&
      data.locator !== null &&
      !isRetrievalLocator(data.locator)) ||
    !isOptionalString(data.deep_link) ||
    !isOptionalString(data.citation_label) ||
    (data.score !== undefined &&
      data.score !== null &&
      typeof data.score !== "number") ||
    !isOptionalString(data.source_version) ||
    typeof data.created_at !== "string" ||
    ((data.evidence_role === "supports" ||
      data.evidence_role === "contradicts") &&
      (data.locator === undefined ||
        data.locator === null ||
        typeof data.source_version !== "string" ||
        !data.source_version.trim() ||
        typeof data.exact_snippet !== "string" ||
        !data.exact_snippet.trim()))
  ) {
    throw new Error("Invalid SSE payload for claim_evidence");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the claim_evidence payload; the `unknown` step is required
  // because a Record<string, unknown> index signature is not directly
  // assignable to the specific MessageClaimEvidence field types.
  return data as unknown as MessageClaimEvidence;
}

function isOptionalRetrievalContextRef(value: unknown): boolean {
  return value === undefined || value === null || isRetrievalContextRef(value);
}

function isOptionalRetrievalResultRef(value: unknown): boolean {
  return value === undefined || value === null || isCitationEventData(value);
}

function isSourceRefLocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "page",
      "fragment_id",
      "t_start_ms",
      "start_offset",
      "end_offset",
    ]) &&
    (value.page === undefined ||
      value.page === null ||
      (typeof value.page === "number" &&
        Number.isInteger(value.page) &&
        value.page >= 1)) &&
    isOptionalString(value.fragment_id) &&
    (value.t_start_ms === undefined ||
      value.t_start_ms === null ||
      (typeof value.t_start_ms === "number" &&
        Number.isInteger(value.t_start_ms) &&
        value.t_start_ms >= 0)) &&
    (value.start_offset === undefined ||
      value.start_offset === null ||
      (typeof value.start_offset === "number" &&
        Number.isInteger(value.start_offset) &&
        value.start_offset >= 0)) &&
    (value.end_offset === undefined ||
      value.end_offset === null ||
      (typeof value.end_offset === "number" &&
        Number.isInteger(value.end_offset) &&
        value.end_offset >= 0)) &&
    !(
      typeof value.start_offset === "number" &&
      typeof value.end_offset === "number" &&
      value.end_offset < value.start_offset
    )
  );
}

function isSourceRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "type",
      "id",
      "label",
      "conversation_id",
      "message_id",
      "message_context_id",
      "message_seq",
      "tool_call_id",
      "retrieval_id",
      "context_ref",
      "result_ref",
      "media_id",
      "evidence_span_id",
      "deep_link",
      "location",
      "source_version",
    ]) &&
    (value.type === "message" ||
      value.type === "message_context" ||
      value.type === "message_retrieval" ||
      value.type === "app_context_ref" ||
      value.type === "web_result") &&
    typeof value.id === "string" &&
    isOptionalString(value.label) &&
    isOptionalString(value.conversation_id) &&
    isOptionalString(value.message_id) &&
    isOptionalString(value.message_context_id) &&
    (value.message_seq === undefined ||
      value.message_seq === null ||
      (typeof value.message_seq === "number" &&
        Number.isInteger(value.message_seq) &&
        value.message_seq >= 1)) &&
    isOptionalString(value.tool_call_id) &&
    isOptionalString(value.retrieval_id) &&
    isOptionalRetrievalContextRef(value.context_ref) &&
    isOptionalRetrievalResultRef(value.result_ref) &&
    isOptionalString(value.media_id) &&
    isOptionalString(value.evidence_span_id) &&
    isOptionalString(value.deep_link) &&
    (value.location === undefined ||
      value.location === null ||
      isSourceRefLocation(value.location)) &&
    isOptionalString(value.source_version)
  );
}

function isMessageClaimKind(value: unknown): value is MessageClaimKind {
  return value === "answer" || value === "insufficient_evidence";
}

function isMessageEvidenceRole(value: unknown): value is MessageEvidenceRole {
  return (
    value === "supports" ||
    value === "contradicts" ||
    value === "context" ||
    value === "scope_boundary"
  );
}

function isMessageEvidenceRetrievalStatus(
  value: unknown,
): value is MessageEvidenceRetrievalStatus {
  return (
    value === "attached_context" ||
    value === "retrieved" ||
    value === "selected" ||
    value === "included_in_prompt" ||
    value === "excluded_by_budget" ||
    value === "excluded_by_scope" ||
    value === "web_result"
  );
}

function isMessageClaimSupportStatus(
  value: unknown,
): value is MessageClaimSupportStatus {
  return (
    value === "supported" ||
    value === "partially_supported" ||
    value === "contradicted" ||
    value === "not_enough_evidence" ||
    value === "out_of_scope" ||
    value === "not_source_grounded"
  );
}

function isMessageEvidenceVerifierStatus(
  value: unknown,
): value is MessageEvidenceVerifierStatus {
  return (
    value === "llm_verified" || value === "parse_failed" || value === "failed"
  );
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
    case "claim":
      return { type: "claim", data: parseClaimData(data) };
    case "claim_evidence":
      return { type: "claim_evidence", data: parseClaimEvidenceData(data) };
    default:
      throw new Error(`Unknown SSE event type: ${eventType || "message"}`);
  }
}
