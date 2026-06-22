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
import { isCitationEventData, type CitationEventData } from "./citations";
import { isRetrievalLocator } from "./locators";
import type {
  AssistantTrustTrail,
  MessageRetrievalCandidateLedger,
  MessageRerankLedger,
  MessageRerankLedgerMetadata,
  TrustRetrievalPlan,
} from "@/lib/conversations/types";

type TrustPromptAssembly = NonNullable<AssistantTrustTrail["prompt"]>;

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
export interface SSEDoneEvent {
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

export type ChatToolSourceDomain =
  | "private_app"
  | "public_web"
  | "provider_control";
export type EvidenceSourceDomain = "private_app" | "public_web";

export interface SourceBoundaryPolicy {
  version: "source_boundary_policy.v1";
  decision: "allowed" | "blocked";
  source_domain: ChatToolSourceDomain;
  mixing_allowed: boolean;
  reason: string;
  domains_seen: EvidenceSourceDomain[];
  requested_domains: EvidenceSourceDomain[];
}

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
    source_domain: ChatToolSourceDomain;
    source_policy: SourceBoundaryPolicy;
    error_code?: string | null;
    result_count?: number | null;
    selected_count?: number | null;
    more_candidates_available?: boolean | null;
    latency_ms?: number | null;
    provider_request_ids?: string[];
    retrieval_ids: string[];
    filters: Record<string, unknown>;
    results: CitationEventData[];
  };
}

export interface SSEPromptAssemblyEvent {
  type: "prompt_assembly";
  data: {
    assistant_message_id: string;
    prompt: TrustPromptAssembly;
  };
}

export interface SSERetrievalPlanEvent {
  type: "retrieval_plan";
  data: {
    assistant_message_id: string;
    retrieval_plan: TrustRetrievalPlan;
  };
}

export interface SSEToolLedgerSnapshotEvent {
  type: "tool_ledger_snapshot";
  data: {
    assistant_message_id: string;
    tool_call_id: string;
    tool_name: string;
    tool_call_index: number;
    scope: string;
    requested_types: string[];
    source_domain: ChatToolSourceDomain;
    source_policy: SourceBoundaryPolicy;
    candidate_ledgers: MessageRetrievalCandidateLedger[];
    rerank_ledgers: MessageRerankLedger[];
  };
}

/** One citation edge carrying the backend-built citation read model. */
export interface SSECitationIndexItem {
  citation_edge_id: string;
  retrieval_id?: string | null;
  tool_call_id?: string | null;
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
  | SSERetrievalPlanEvent
  | SSEPromptAssemblyEvent
  | SSEToolLedgerSnapshotEvent
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
      "model_id",
      "provider",
      "chat_subject",
    ]) ||
    !isUuidString(data.run_id) ||
    !isUuidString(data.conversation_id) ||
    !isUuidString(data.user_message_id) ||
    !isUuidString(data.assistant_message_id) ||
    !isUuidString(data.model_id) ||
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
    (data.context_edge_id === null || isUuidString(data.context_edge_id)) &&
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

function isUuidString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isOptionalUuidString(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || value === null || isUuidString(value);
}

function isOptionalNonEmptyString(
  value: unknown,
): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.length > 0)
  );
}

function isOptionalMaxString(
  value: unknown,
  maxLength: number,
): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.length <= maxLength)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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

function parseAssistantActivityData(
  data: unknown,
): SSEAssistantActivityEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "assistant_message_id",
      "phase",
      "label",
      "provider_event_seq_start",
      "provider_event_seq_end",
    ]) ||
    !isUuidString(data.assistant_message_id) ||
    !isAssistantActivityPhase(data.phase) ||
    !isOptionalString(data.label) ||
    !isOptionalNonNegativeInteger(data.provider_event_seq_start) ||
    !isOptionalNonNegativeInteger(data.provider_event_seq_end)
  ) {
    throw new Error("Invalid SSE payload for assistant_activity");
  }
  return data as SSEAssistantActivityEvent["data"];
}

function parseAssistantTextDeltaData(
  data: unknown,
): SSEAssistantTextDeltaEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "assistant_message_id",
      "text",
      "provider_event_seq_start",
      "provider_event_seq_end",
    ]) ||
    !isUuidString(data.assistant_message_id) ||
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
    (data.usage !== undefined &&
      data.usage !== null &&
      !isRecord(data.usage)) ||
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
    !isUuidString(data.assistant_message_id) ||
    typeof data.tool_name !== "string" ||
    data.tool_name.length === 0 ||
    typeof data.tool_call_index !== "number" ||
    !Number.isInteger(data.tool_call_index) ||
    data.tool_call_index < 0 ||
    !isOptionalUuidString(data.tool_call_id) ||
    !isOptionalNonEmptyString(data.provider_tool_call_id) ||
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
    !isOptionalMaxString(data.input_preview, 512)
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

function parseToolResultData(data: unknown): SSEToolResultEvent["data"] {
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
      "source_domain",
      "source_policy",
      "error_code",
      "result_count",
      "selected_count",
      "more_candidates_available",
      "latency_ms",
      "provider_request_ids",
      "retrieval_ids",
      "filters",
      "results",
    ]) ||
    !isUuidString(data.assistant_message_id) ||
    typeof data.tool_name !== "string" ||
    data.tool_name.length === 0 ||
    !isOptionalUuidString(data.tool_call_id) ||
    typeof data.tool_call_index !== "number" ||
    !Number.isInteger(data.tool_call_index) ||
    data.tool_call_index < 0 ||
    !isChatToolStatus(data.status) ||
    typeof data.scope !== "string" ||
    data.scope.length === 0 ||
    !Array.isArray(data.types) ||
    !data.types.every((item) => typeof item === "string") ||
    !isChatToolSourceDomain(data.source_domain) ||
    !isSourceBoundaryPolicy(data.source_policy) ||
    data.source_policy.source_domain !== data.source_domain ||
    !isOptionalString(data.error_code) ||
    !isOptionalNonNegativeInteger(data.result_count) ||
    !isOptionalNonNegativeInteger(data.selected_count) ||
    (data.more_candidates_available !== undefined &&
      data.more_candidates_available !== null &&
      typeof data.more_candidates_available !== "boolean") ||
    (data.latency_ms !== undefined &&
      data.latency_ms !== null &&
      (typeof data.latency_ms !== "number" ||
        !Number.isInteger(data.latency_ms) ||
        data.latency_ms < 0)) ||
    (data.provider_request_ids !== undefined &&
      (!Array.isArray(data.provider_request_ids) ||
        !data.provider_request_ids.every(
          (item) => typeof item === "string",
        ))) ||
    !isToolResultFilters(data.filters) ||
    !Array.isArray(data.results) ||
    !data.results.every(isCitationEventData) ||
    !Array.isArray(data.retrieval_ids) ||
    data.retrieval_ids.length !== data.results.length ||
    !data.retrieval_ids.every(isUuidString)
  ) {
    throw new Error("Invalid SSE payload for tool_result");
  }
  return data as SSEToolResultEvent["data"];
}

function isToolResultFilters(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.semantic === undefined &&
    value.content_kinds === undefined &&
    value.contributor_handles === undefined
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

function isChatToolSourceDomain(value: unknown): value is ChatToolSourceDomain {
  return (
    value === "private_app" ||
    value === "public_web" ||
    value === "provider_control"
  );
}

function isEvidenceSourceDomain(value: unknown): value is EvidenceSourceDomain {
  return value === "private_app" || value === "public_web";
}

function isSourceBoundaryPolicy(value: unknown): value is SourceBoundaryPolicy {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "version",
      "decision",
      "source_domain",
      "mixing_allowed",
      "reason",
      "domains_seen",
      "requested_domains",
    ]) &&
    value.version === "source_boundary_policy.v1" &&
    (value.decision === "allowed" || value.decision === "blocked") &&
    isChatToolSourceDomain(value.source_domain) &&
    typeof value.mixing_allowed === "boolean" &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    Array.isArray(value.domains_seen) &&
    value.domains_seen.every(isEvidenceSourceDomain) &&
    Array.isArray(value.requested_domains) &&
    value.requested_domains.every(isEvidenceSourceDomain)
  );
}

function parseCitationIndexData(data: unknown): SSECitationIndexEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, ["assistant_message_id", "citations"]) ||
    !isUuidString(data.assistant_message_id) ||
    !Array.isArray(data.citations)
  ) {
    throw new Error("Invalid SSE payload for citation_index");
  }
  return {
    assistant_message_id: data.assistant_message_id,
    citations: data.citations.map(parseCitationIndexItem),
  };
}

function parsePromptAssemblyData(
  data: unknown,
): SSEPromptAssemblyEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, ["assistant_message_id", "prompt"]) ||
    !isUuidString(data.assistant_message_id) ||
    !isTrustPromptAssembly(data.prompt)
  ) {
    throw new Error("Invalid SSE payload for prompt_assembly");
  }
  return {
    assistant_message_id: data.assistant_message_id,
    prompt: data.prompt,
  };
}

function parseRetrievalPlanData(data: unknown): SSERetrievalPlanEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, ["assistant_message_id", "retrieval_plan"]) ||
    !isUuidString(data.assistant_message_id) ||
    !isTrustRetrievalPlan(data.retrieval_plan)
  ) {
    throw new Error("Invalid SSE payload for retrieval_plan");
  }
  return {
    assistant_message_id: data.assistant_message_id,
    retrieval_plan: data.retrieval_plan,
  };
}

function isTrustRetrievalPlan(value: unknown): value is TrustRetrievalPlan {
  const tools = ["app_search", "web_search", "read_resource", "inspect_resource"];
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "route_intent",
      "source_domain",
      "mixing_policy",
      "query_class",
      "allowed_tools",
      "blocked_tools",
      "candidate_tool_sequence",
      "internal_tool_sequence",
      "reason",
      "context_ref_count",
      "search_scope_count",
      "search_scope_uris",
      "budget_policy",
    ]) ||
    value.version !== "chat_retrieval_plan.v1" ||
    ![
      "no_retrieval",
      "clarify_scope",
      "answer_from_attached_context",
      "private_exact_read",
      "private_inspect_then_read",
      "private_app_search",
      "private_deep_retrieval",
      "private_long_context_read",
      "public_web_search",
      "explicit_private_public_comparison",
    ].includes(String(value.route_intent)) ||
    !["none", "private_app", "public_web", "mixed"].includes(String(value.source_domain)) ||
    !["no_retrieval", "single_domain", "explicit_mixed"].includes(
      String(value.mixing_policy),
    ) ||
    ![
      "no_retrieval",
      "attached_context",
      "exact_lookup",
      "single_source_summary",
      "multi_hop_search_read_inspect_question",
      "cross_document_synthesis",
      "negative_absence_question",
      "global_library_question",
      "recency_or_conversation_question",
    ].includes(String(value.query_class)) ||
    !Array.isArray(value.allowed_tools) ||
    !value.allowed_tools.every((item) => tools.includes(String(item))) ||
    !Array.isArray(value.blocked_tools) ||
    !value.blocked_tools.every((item) => tools.includes(String(item))) ||
    !Array.isArray(value.candidate_tool_sequence) ||
    !value.candidate_tool_sequence.every((item) => tools.includes(String(item))) ||
    !Array.isArray(value.internal_tool_sequence) ||
    !value.internal_tool_sequence.every((item) => tools.includes(String(item))) ||
    typeof value.reason !== "string" ||
    !isNonNegativeInteger(value.context_ref_count) ||
    !isNonNegativeInteger(value.search_scope_count) ||
    !Array.isArray(value.search_scope_uris) ||
    !value.search_scope_uris.every((item) => typeof item === "string") ||
    value.budget_policy !== "tool_output_budget_from_prompt_assembly"
  ) {
    return false;
  }
  const allowedTools = new Set(value.allowed_tools);
  const blockedTools = new Set(value.blocked_tools);
  return (
    allowedTools.size === value.allowed_tools.length &&
    blockedTools.size === value.blocked_tools.length &&
    tools.every((tool) => allowedTools.has(tool) || blockedTools.has(tool)) &&
    value.allowed_tools.every((tool) => !blockedTools.has(tool)) &&
    value.candidate_tool_sequence.every((tool) => allowedTools.has(tool)) &&
    new Set(value.internal_tool_sequence).size ===
      value.internal_tool_sequence.length &&
    new Set(value.search_scope_uris).size === value.search_scope_uris.length &&
    value.search_scope_count === value.search_scope_uris.length &&
    value.search_scope_uris.every((uri) => uri.trim().length > 0)
  );
}

function isTrustPromptAssembly(value: unknown): value is TrustPromptAssembly {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "cacheable_input_tokens_estimate",
      "prompt_block_manifest",
      "max_context_tokens",
      "reserved_output_tokens",
      "reserved_reasoning_tokens",
      "input_budget_tokens",
      "estimated_input_tokens",
      "included_message_ids",
      "included_retrieval_ids",
      "included_context_refs",
      "dropped_items",
      "budget_breakdown",
      "created_at",
    ]) ||
    !isUuidString(value.id) ||
    !isNonNegativeInteger(value.cacheable_input_tokens_estimate) ||
    !isRecord(value.prompt_block_manifest) ||
    !isNonNegativeInteger(value.max_context_tokens) ||
    !isNonNegativeInteger(value.reserved_output_tokens) ||
    !isNonNegativeInteger(value.reserved_reasoning_tokens) ||
    !isNonNegativeInteger(value.input_budget_tokens) ||
    !isNonNegativeInteger(value.estimated_input_tokens) ||
    !isStringArray(value.included_message_ids) ||
    !isStringArray(value.included_retrieval_ids) ||
    !isRecordArray(value.included_context_refs) ||
    !isRecordArray(value.dropped_items) ||
    !isRecord(value.budget_breakdown) ||
    typeof value.created_at !== "string"
  ) {
    return false;
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isRecordArray(
  value: unknown,
): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isRecord);
}

function parseToolLedgerSnapshotData(
  data: unknown,
): SSEToolLedgerSnapshotEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "assistant_message_id",
      "tool_call_id",
      "tool_name",
      "tool_call_index",
      "scope",
      "requested_types",
      "source_domain",
      "source_policy",
      "candidate_ledgers",
      "rerank_ledgers",
    ]) ||
    !isUuidString(data.assistant_message_id) ||
    !isUuidString(data.tool_call_id) ||
    typeof data.tool_name !== "string" ||
    data.tool_name.length === 0 ||
    typeof data.tool_call_index !== "number" ||
    !Number.isInteger(data.tool_call_index) ||
    data.tool_call_index < 0 ||
    typeof data.scope !== "string" ||
    data.scope.length === 0 ||
    !Array.isArray(data.requested_types) ||
    !data.requested_types.every((item) => typeof item === "string") ||
    !isChatToolSourceDomain(data.source_domain) ||
    !isSourceBoundaryPolicy(data.source_policy) ||
    data.source_policy.source_domain !== data.source_domain ||
    !Array.isArray(data.candidate_ledgers) ||
    !data.candidate_ledgers.every(isCandidateLedger) ||
    !Array.isArray(data.rerank_ledgers) ||
    !data.rerank_ledgers.every(isRerankLedger)
  ) {
    throw new Error("Invalid SSE payload for tool_ledger_snapshot");
  }
  return {
    assistant_message_id: data.assistant_message_id,
    tool_call_id: data.tool_call_id,
    tool_name: data.tool_name,
    tool_call_index: data.tool_call_index,
    scope: data.scope,
    requested_types: data.requested_types,
    source_domain: data.source_domain,
    source_policy: data.source_policy,
    candidate_ledgers: data.candidate_ledgers,
    rerank_ledgers: data.rerank_ledgers,
  };
}

function isCandidateLedger(
  item: unknown,
): item is MessageRetrievalCandidateLedger {
  if (!isRecord(item)) return false;
  const locator = item.locator === undefined ? null : item.locator;
  return (
    hasOnlyKeys(item, [
      "id",
      "tool_call_id",
      "retrieval_id",
      "ordinal",
      "result_type",
      "source_id",
      "score",
      "selected",
      "included_in_prompt",
      "ledger_included_in_prompt",
      "linked_retrieval_included_in_prompt",
      "included_in_prompt_source",
      "included_in_prompt_reconciled",
      "selection_status",
      "selection_reason",
      "result_ref",
      "locator",
      "created_at",
    ]) &&
    isUuidString(item.id) &&
    isUuidString(item.tool_call_id) &&
    isOptionalUuidString(item.retrieval_id) &&
    typeof item.ordinal === "number" &&
    Number.isInteger(item.ordinal) &&
    item.ordinal >= 0 &&
    typeof item.result_type === "string" &&
    item.result_type.length > 0 &&
    typeof item.source_id === "string" &&
    item.source_id.length > 0 &&
    (item.score === undefined ||
      item.score === null ||
      (typeof item.score === "number" &&
        Number.isFinite(item.score) &&
        item.score >= 0)) &&
    typeof item.selected === "boolean" &&
    typeof item.included_in_prompt === "boolean" &&
    typeof item.ledger_included_in_prompt === "boolean" &&
    (item.linked_retrieval_included_in_prompt === undefined ||
      item.linked_retrieval_included_in_prompt === null ||
      typeof item.linked_retrieval_included_in_prompt === "boolean") &&
    (item.included_in_prompt_source === "candidate_ledger" ||
      item.included_in_prompt_source === "linked_retrieval" ||
      item.included_in_prompt_source === "tool_output") &&
    typeof item.included_in_prompt_reconciled === "boolean" &&
    typeof item.selection_status === "string" &&
    item.selection_status.length > 0 &&
    typeof item.selection_reason === "string" &&
    item.selection_reason.length > 0 &&
    isCitationEventData(item.result_ref) &&
    item.result_ref.result_type === item.result_type &&
    item.result_ref.source_id === item.source_id &&
    stableJson(item.result_ref.locator ?? null) === stableJson(locator) &&
    (item.locator === undefined ||
      item.locator === null ||
      isRetrievalLocator(item.locator)) &&
    typeof item.created_at === "string"
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRerankLedger(item: unknown): item is MessageRerankLedger {
  return (
    isRecord(item) &&
    hasOnlyKeys(item, [
      "id",
      "tool_call_id",
      "strategy",
      "input_count",
      "selected_count",
      "budget_chars",
      "selected_chars",
      "status",
      "metadata",
      "created_at",
    ]) &&
    isUuidString(item.id) &&
    isUuidString(item.tool_call_id) &&
    typeof item.strategy === "string" &&
    item.strategy.length > 0 &&
    isOptionalNonNegativeInteger(item.input_count) &&
    item.input_count !== undefined &&
    item.input_count !== null &&
    isOptionalNonNegativeInteger(item.selected_count) &&
    item.selected_count !== undefined &&
    item.selected_count !== null &&
    isOptionalNonNegativeInteger(item.budget_chars) &&
    isOptionalNonNegativeInteger(item.selected_chars) &&
    item.selected_chars !== undefined &&
    item.selected_chars !== null &&
    typeof item.status === "string" &&
    isRerankMetadata(item.metadata) &&
    typeof item.created_at === "string"
  );
}

function isRerankMetadata(
  value: unknown,
): value is MessageRerankLedgerMetadata {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "selection_strategy",
      "selection_policy_version",
      "ordering_policy",
      "diversity_policy",
      "budget_policy",
      "baseline_strategy",
      "provider",
      "model",
      "key_mode_used",
      "llm_call_id",
      "llm_call_ids",
      "provider_request_id",
      "provider_request_ids",
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "latency_ms",
      "estimated_cost_usd_micros",
      "cost_status",
      "cost_statuses",
      "candidate_limit",
      "selected_limit",
      "context_budget_chars",
      "scope_count",
      "graph_expanded_scope_count",
      "selected_source_map_count",
      "rerank_input_count",
      "rerank_output_count",
      "query_class",
      "retrieval_mode",
      "policy_reason",
      "rerank_mode",
      "rerank_reason",
      "context_route",
      "context_route_reason",
      "error_code",
      "failure_error_code",
      "private_snippet_policy",
      "private_snippet_policy_version",
      "private_snippet_policy_reason",
      "private_snippet_key_mode_used",
      "scope",
      "inclusion_surface",
      "result_type",
      "graph_expanded_scopes",
      "resolved_scopes",
      "result_type_mix",
      "selection_reason_counts",
      "candidate_rerank_trace",
      "retrieval_guidance",
    ])
  ) {
    return false;
  }
  const optionalStrings = [
    "selection_strategy",
    "selection_policy_version",
    "ordering_policy",
    "diversity_policy",
    "budget_policy",
    "baseline_strategy",
    "provider",
    "model",
    "key_mode_used",
    "llm_call_id",
    "provider_request_id",
    "cost_status",
    "query_class",
    "retrieval_mode",
    "policy_reason",
    "rerank_mode",
    "rerank_reason",
    "context_route",
    "context_route_reason",
    "error_code",
    "failure_error_code",
    "private_snippet_policy",
    "private_snippet_policy_version",
    "private_snippet_policy_reason",
    "private_snippet_key_mode_used",
    "scope",
    "inclusion_surface",
    "result_type",
  ];
  for (const key of optionalStrings) {
    if (!isOptionalString(value[key])) return false;
  }
  const optionalNumbers = [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "latency_ms",
    "estimated_cost_usd_micros",
    "candidate_limit",
    "selected_limit",
    "context_budget_chars",
    "scope_count",
    "graph_expanded_scope_count",
    "selected_source_map_count",
    "rerank_input_count",
    "rerank_output_count",
  ];
  for (const key of optionalNumbers) {
    if (!isOptionalNonNegativeInteger(value[key])) return false;
  }
  for (const key of [
    "llm_call_ids",
    "provider_request_ids",
    "cost_statuses",
    "graph_expanded_scopes",
    "resolved_scopes",
  ]) {
    const item = value[key];
    if (item !== undefined && item !== null) {
      if (
        !Array.isArray(item) ||
        !item.every((entry) => typeof entry === "string")
      ) {
        return false;
      }
    }
  }
  for (const key of ["result_type_mix", "selection_reason_counts"]) {
    const item = value[key];
    if (item !== undefined && item !== null) {
      if (!isRecord(item)) return false;
      if (
        Object.values(item).some(
          (entry) =>
            typeof entry !== "number" || !Number.isInteger(entry) || entry < 0,
        )
      ) {
        return false;
      }
    }
  }
  if (
    value.candidate_rerank_trace !== undefined &&
    value.candidate_rerank_trace !== null &&
    (!Array.isArray(value.candidate_rerank_trace) ||
      !value.candidate_rerank_trace.every(isRerankTraceItem))
  ) {
    return false;
  }
  return (
    value.retrieval_guidance === undefined ||
    value.retrieval_guidance === null ||
    isRetrievalGuidanceMetadata(value.retrieval_guidance)
  );
}

function isRerankTraceItem(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "from",
      "to",
      "result_type",
      "source_id",
      "source",
      "section",
      "rank",
      "score",
      "selection_score",
      "lexical",
      "phrase",
      "type_bonus",
      "citation_quality",
      "source_penalty",
      "section_penalty",
      "reason",
      "provider_reason",
      "provider_score",
      "selection_status",
      "selection_reason",
      "selected",
      "included_in_prompt",
    ])
  ) {
    return false;
  }
  for (const key of ["from", "to"]) {
    const item = value[key];
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0)
      return false;
  }
  if (!isOptionalString(value.source)) return false;
  if (!isOptionalString(value.section)) return false;
  if (
    value.rank !== undefined &&
    value.rank !== null &&
    (typeof value.rank !== "number" ||
      !Number.isInteger(value.rank) ||
      value.rank < 0)
  ) {
    return false;
  }
  for (const key of [
    "score",
    "citation_quality",
    "source_penalty",
    "section_penalty",
  ]) {
    const item = value[key];
    if (item !== undefined && item !== null) {
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0)
        return false;
    }
  }
  // selection_score is a signed composite (base score plus a possibly-negative
  // type bonus, minus diversity penalties) and can fall below zero; only require
  // it to be a finite number.
  if (
    value.selection_score !== undefined &&
    value.selection_score !== null &&
    (typeof value.selection_score !== "number" ||
      !Number.isFinite(value.selection_score))
  ) {
    return false;
  }
  for (const key of ["lexical", "provider_score"]) {
    const item = value[key];
    if (item !== undefined && item !== null) {
      if (
        typeof item !== "number" ||
        !Number.isFinite(item) ||
        item < 0 ||
        item > 1
      )
        return false;
    }
  }
  if (
    value.type_bonus !== undefined &&
    value.type_bonus !== null &&
    (typeof value.type_bonus !== "number" || !Number.isFinite(value.type_bonus))
  ) {
    return false;
  }
  if (
    value.phrase !== undefined &&
    value.phrase !== null &&
    typeof value.phrase !== "boolean"
  ) {
    return false;
  }
  for (const key of ["reason", "provider_reason"]) {
    if (!isOptionalString(value[key])) return false;
  }
  for (const key of [
    "result_type",
    "source_id",
    "selection_status",
    "selection_reason",
  ]) {
    const item = value[key];
    if (typeof item !== "string" || item.length === 0) return false;
  }
  for (const key of ["selected", "included_in_prompt"]) {
    if (typeof value[key] !== "boolean") return false;
  }
  return true;
}

function isRetrievalGuidanceMetadata(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["version", "status"])) {
    return false;
  }
  for (const key of ["version", "status"]) {
    if (!isOptionalString(value[key])) return false;
  }
  return true;
}

function parseCitationIndexItem(item: unknown): SSECitationIndexItem {
  if (
    !isRecord(item) ||
    !hasOnlyKeys(item, [
      "citation_edge_id",
      "retrieval_id",
      "tool_call_id",
      "citation",
    ]) ||
    !isUuidString(item.citation_edge_id) ||
    !isOptionalUuidString(item.retrieval_id) ||
    !isOptionalUuidString(item.tool_call_id) ||
    !isCitationOut(item.citation) ||
    item.citation.ordinal < 1
  ) {
    throw new Error("Invalid SSE payload for citation_index");
  }
  return {
    citation_edge_id: item.citation_edge_id,
    retrieval_id: item.retrieval_id,
    tool_call_id: item.tool_call_id,
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
    !isUuidString(data.id) ||
    !isUuidString(data.conversation_id) ||
    typeof data.resource_ref !== "string" ||
    activation === null ||
    typeof data.label !== "string" ||
    typeof data.summary !== "string" ||
    typeof data.missing !== "boolean" ||
    typeof data.created_at !== "string" ||
    !("citation_edge_id" in data) ||
    !(isUuidString(data.citation_edge_id) || data.citation_edge_id === null)
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

export function toChatSSEEvent(
  eventType: string,
  data: unknown,
  id = "0",
): SSEEvent {
  const seq = Number(id || 0);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error("Invalid SSE event id");
  }
  switch (eventType) {
    case "meta":
      return { seq, type: "meta", data: parseMetaData(data) };
    case "assistant_activity":
      return {
        seq,
        type: "assistant_activity",
        data: parseAssistantActivityData(data),
      };
    case "assistant_text_delta":
      return {
        seq,
        type: "assistant_text_delta",
        data: parseAssistantTextDeltaData(data),
      };
    case "done":
      return { seq, type: "done", data: parseDoneData(data) };
    case "tool_call_start":
      return {
        seq,
        type: "tool_call_start",
        data: parseToolCallStartData(data),
      };
    case "tool_call_delta":
      return {
        seq,
        type: "tool_call_delta",
        data: parseToolCallDeltaData(data),
      };
    case "tool_call_done":
      return { seq, type: "tool_call_done", data: parseToolCallDoneData(data) };
    case "tool_result":
      return { seq, type: "tool_result", data: parseToolResultData(data) };
    case "retrieval_plan":
      return {
        seq,
        type: "retrieval_plan",
        data: parseRetrievalPlanData(data),
      };
    case "prompt_assembly":
      return {
        seq,
        type: "prompt_assembly",
        data: parsePromptAssemblyData(data),
      };
    case "tool_ledger_snapshot":
      return {
        seq,
        type: "tool_ledger_snapshot",
        data: parseToolLedgerSnapshotData(data),
      };
    case "citation_index":
      return {
        seq,
        type: "citation_index",
        data: parseCitationIndexData(data),
      };
    case "context_ref_added":
      return {
        seq,
        type: "context_ref_added",
        data: parseContextRefAddedData(data),
      };
    default:
      throw new Error(`Unknown SSE event type: ${eventType || "message"}`);
  }
}
