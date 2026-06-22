import type {
  RetrievalContextRef,
  SearchCitationEventData,
  SearchCitationResultType,
  WebCitationEventData,
} from "@/lib/api/sse/citations";
import type {
  ChatToolSourceDomain,
  ChatToolStatus,
  SourceBoundaryPolicy,
} from "@/lib/api/sse/events";
import type { RetrievalLocator } from "@/lib/api/sse/locators";
import type { CitationOut } from "@/lib/conversations/citationOut";
import type { ResourceActivation } from "@/lib/resources/activation";

export interface ConversationSummary {
  id: string;
  title: string;
  sharing: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationListItem {
  id: string;
  title: string;
  message_count: number;
  updated_at: string;
}

export interface ConversationModel {
  id: string;
  provider: string;
  provider_display_name: string;
  model_name: string;
  model_display_name: string;
  model_tier: "sota" | "light";
  reasoning_modes: Array<
    "default" | "none" | "minimal" | "low" | "medium" | "high" | "max"
  >;
  max_context_tokens: number;
  available_via: "byok" | "platform" | "both";
  provider_rank: number;
  model_rank: number;
  is_default: boolean;
  available_key_modes: Array<"auto" | "byok_only" | "platform_only">;
  capabilities: {
    prompt_cache: {
      mode: "none" | "turn_ttl" | "keyed_ttl";
      supported: boolean;
      key_required: boolean;
      ttl_options: Array<"5m" | "1h">;
    };
    streaming: boolean;
    tool_calling: boolean;
    structured_output: boolean;
    structured_output_streaming: boolean;
    reasoning_continuation: boolean;
  };
}

export interface MessageRetrieval {
  id?: string;
  tool_call_id?: string;
  tool_call_index?: number | null;
  ordinal?: number;
  scope: string;
  result_type: SearchCitationResultType | "web_result";
  source_id: string;
  media_id: string | null;
  evidence_span_id?: string | null;
  context_ref: RetrievalContextRef;
  result_ref: MessageRetrievalResultRef;
  deep_link: string | null;
  citation_label?: string | null;
  locator?: RetrievalLocator | null;
  score: number | null;
  selected: boolean;
  source_title?: string | null;
  section_label?: string | null;
  summary_md?: string | null;
  exact_snippet?: string | null;
  snippet_prefix?: string | null;
  snippet_suffix?: string | null;
  retrieval_status?: MessageEvidenceRetrievalStatus;
  included_in_prompt?: boolean;
  cited_edge_id?: string | null;
  citation_number?: number | null;
  citation_role?: "supports" | "contradicts" | "context" | null;
  included_in_prompt_source?:
    | "retrieval"
    | "candidate_ledger"
    | "prompt_assembly"
    | "tool_output"
    | "none";
  created_at?: string;
}

export type MessageRetrievalResultRef =
  | SearchCitationEventData
  | WebCitationEventData;

export type MessageEvidenceRetrievalStatus =
  | "attached_context"
  | "retrieved"
  | "selected"
  | "included_in_prompt"
  | "excluded_by_budget"
  | "excluded_by_scope"
  | "web_result";

export interface MessageToolCall {
  id?: string;
  conversation_id?: string;
  user_message_id?: string;
  assistant_message_id?: string;
  tool_name: string;
  tool_call_index: number;
  query_hash?: string | null;
  scope?: string;
  requested_types?: string[];
  result_refs: Array<Record<string, unknown>>;
  selected_context_refs: Array<Record<string, unknown>>;
  provider_request_ids: string[];
  source_domain?: ChatToolSourceDomain;
  source_policy?: SourceBoundaryPolicy;
  latency_ms?: number | null;
  result_count?: number;
  selected_count?: number;
  more_candidates_available?: boolean;
  status: ChatToolStatus;
  error_code?: string | null;
  input_preview?: string;
  created_at?: string;
  updated_at?: string;
  retrievals: MessageRetrieval[];
  candidate_ledgers: MessageRetrievalCandidateLedger[];
  rerank_ledgers: MessageRerankLedger[];
}

export interface MessageRetrievalCandidateLedger {
  id: string;
  tool_call_id: string;
  retrieval_id?: string | null;
  ordinal: number;
  result_type: MessageRetrieval["result_type"];
  source_id: string;
  score?: number | null;
  selected: boolean;
  included_in_prompt: boolean;
  ledger_included_in_prompt: boolean;
  linked_retrieval_included_in_prompt?: boolean | null;
  included_in_prompt_source: "candidate_ledger" | "linked_retrieval" | "tool_output";
  included_in_prompt_reconciled: boolean;
  selection_status: string;
  selection_reason: string;
  result_ref: MessageRetrievalResultRef;
  locator?: RetrievalLocator | null;
  created_at: string;
}

export interface MessageRerankLedger {
  id: string;
  tool_call_id: string;
  strategy: string;
  input_count: number;
  selected_count: number;
  budget_chars?: number | null;
  selected_chars: number;
  status: string;
  metadata: MessageRerankLedgerMetadata;
  created_at: string;
}

export interface MessageRerankLedgerMetadata {
  selection_strategy?: string;
  selection_policy_version?: string;
  ordering_policy?: string;
  diversity_policy?: string;
  budget_policy?: string;
  baseline_strategy?: string;
  provider?: string;
  model?: string;
  key_mode_used?: string;
  llm_call_id?: string;
  llm_call_ids?: string[];
  provider_request_id?: string;
  provider_request_ids?: string[];
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  latency_ms?: number;
  estimated_cost_usd_micros?: number;
  cost_status?: string;
  cost_statuses?: string[];
  candidate_limit?: number;
  selected_limit?: number;
  context_budget_chars?: number;
  scope_count?: number;
  graph_expanded_scope_count?: number;
  selected_source_map_count?: number;
  rerank_input_count?: number;
  rerank_output_count?: number;
  query_class?: string;
  retrieval_mode?: string;
  policy_reason?: string;
  rerank_mode?: string;
  rerank_reason?: string;
  context_route?: string;
  context_route_reason?: string;
  error_code?: string;
  failure_error_code?: string;
  private_snippet_policy?: string;
  private_snippet_policy_version?: string;
  private_snippet_policy_reason?: string;
  private_snippet_key_mode_used?: string;
  scope?: string;
  inclusion_surface?: string;
  result_type?: string;
  graph_expanded_scopes?: string[];
  resolved_scopes?: string[];
  result_type_mix?: Record<string, number>;
  selection_reason_counts?: Record<string, number>;
  candidate_rerank_trace?: MessageRerankTraceItemMetadata[];
  retrieval_guidance?: MessageRetrievalGuidanceUsageMetadata;
}

export interface MessageRerankTraceItemMetadata {
  from: number;
  to: number;
  result_type: string;
  source_id: string;
  source?: string;
  section?: string;
  rank?: number;
  score?: number;
  selection_score?: number;
  lexical?: number;
  phrase?: boolean;
  type_bonus?: number;
  citation_quality?: number;
  source_penalty?: number;
  section_penalty?: number;
  reason?: string;
  provider_reason?: string;
  provider_score?: number;
  selection_status: string;
  selection_reason: string;
  selected: boolean;
  included_in_prompt: boolean;
}

export interface MessageRetrievalGuidanceUsageMetadata {
  version?: string;
  status?: string;
}

export interface MessageDocument {
  type: "message_document";
  blocks: Array<{
    type: "text";
    format: "plain" | "markdown";
    text: string;
  }>;
}

export type TrustRetrievalToolName =
  | "app_search"
  | "web_search"
  | "read_resource"
  | "inspect_resource";

export interface TrustRetrievalPlan {
  version: "chat_retrieval_plan.v1";
  route_intent:
    | "no_retrieval"
    | "clarify_scope"
    | "answer_from_attached_context"
    | "private_exact_read"
    | "private_inspect_then_read"
    | "private_app_search"
    | "private_deep_retrieval"
    | "private_long_context_read"
    | "public_web_search"
    | "explicit_private_public_comparison";
  source_domain: "none" | "private_app" | "public_web" | "mixed";
  mixing_policy: "no_retrieval" | "single_domain" | "explicit_mixed";
  query_class:
    | "no_retrieval"
    | "attached_context"
    | "exact_lookup"
    | "single_source_summary"
    | "multi_hop_search_read_inspect_question"
    | "cross_document_synthesis"
    | "negative_absence_question"
    | "global_library_question"
    | "recency_or_conversation_question";
  allowed_tools: TrustRetrievalToolName[];
  blocked_tools: TrustRetrievalToolName[];
  candidate_tool_sequence: TrustRetrievalToolName[];
  internal_tool_sequence: TrustRetrievalToolName[];
  reason: string;
  context_ref_count: number;
  search_scope_count: number;
  search_scope_uris: string[];
  budget_policy: "tool_output_budget_from_prompt_assembly";
}

export interface AssistantTrustTrail {
  schema_version: "assistant_trust_trail.v1";
  assistant_message_id: string;
  conversation_id: string;
  chat_run_id: string | null;
  status: "pending" | "running" | "complete" | "error" | "cancelled";
  run: {
    run_id: string;
    model_id: string;
    provider: string;
    model_name: string;
    reasoning_mode: string | null;
    key_mode: string | null;
    status: "pending" | "running" | "complete" | "error" | "cancelled";
    usage: Record<string, unknown> | null;
    error_code: string | null;
    final_chars: number | null;
    started_at: string | null;
    completed_at: string | null;
    retrieval_plan: TrustRetrievalPlan | null;
  } | null;
  prompt: {
    id: string;
    cacheable_input_tokens_estimate: number;
    prompt_block_manifest: Record<string, unknown>;
    max_context_tokens: number;
    reserved_output_tokens: number;
    reserved_reasoning_tokens: number;
    input_budget_tokens: number;
    estimated_input_tokens: number;
    included_message_ids: string[];
    included_retrieval_ids: string[];
    included_context_refs: Array<Record<string, unknown>>;
    dropped_items: Array<Record<string, unknown>>;
    budget_breakdown: Record<string, unknown>;
    created_at: string;
  } | null;
  tool_calls: MessageToolCall[];
  citations: Array<{
    citation_edge_id: string;
    ordinal: number;
    role: "supports" | "contradicts" | "context";
    target_ref: CitationOut["target_ref"];
    retrieval_id: string | null;
    tool_call_id: string | null;
    citation: CitationOut;
  }>;
  context_refs_added: Array<{
    chat_run_event_seq: number;
    id: string;
    conversation_id: string;
    resource_ref: string;
    activation: ResourceActivation;
    label: string;
    summary: string;
    missing: boolean;
    created_at: string;
    citation_edge_id: string | null;
  }>;
  integrity_notices: Array<{ code: string; message: string }>;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  message_document?: MessageDocument;
  parent_message_id?: string | null;
  branch_root_message_id?: string | null;
  branch_anchor_kind?: BranchAnchorKind;
  branch_anchor?: BranchAnchor | null;
  trust_trail: AssistantTrustTrail | null;
  /**
   * Citation chips (the `[N]` markers in the assistant prose), built backend-side
   * from citation edges. Present on the message GET and refreshed live by the
   * `citation_index` SSE event. Rendered via `toReaderCitationData`.
   */
  citations?: CitationOut[];
  status: "pending" | "complete" | "error" | "cancelled";
  error_code: string | null;
  can_retry_response: boolean;
  created_at: string;
  updated_at: string;
}

export function conversationMessageText(
  message: Pick<ConversationMessage, "message_document">,
): string {
  return (message.message_document?.blocks ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

export interface ConversationMessagesResponse {
  data: ConversationMessage[];
  page: {
    next_cursor?: string | null;
    before_cursor?: string | null;
  };
}

type BranchAnchorKind =
  | "none"
  | "assistant_message"
  | "assistant_selection";

export type BranchAnchor =
  | { kind: "none" }
  | {
      kind: "assistant_message";
      message_id?: string;
    }
  | {
      kind: "assistant_selection";
      message_id: string;
      exact: string;
      prefix: string | null;
      suffix: string | null;
      offset_status: "mapped";
      start_offset: number;
      end_offset: number;
      client_selection_id: string;
    }
  | {
      kind: "assistant_selection";
      message_id: string;
      exact: string;
      prefix: string | null;
      suffix: string | null;
      offset_status: "unmapped";
      client_selection_id: string;
    };

export interface BranchDraft {
  parentMessageId: string;
  parentMessageSeq: number;
  parentMessagePreview: string;
  anchor: Extract<
    BranchAnchor,
    { kind: "assistant_message" | "assistant_selection" }
  >;
}

export type ForkStatus = "complete" | "pending" | "error" | "cancelled";

export interface ForkOption {
  id: string;
  parent_message_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  leaf_message_id: string;
  title: string | null;
  preview: string;
  branch_anchor_kind: BranchAnchorKind;
  branch_anchor_preview: string | null;
  status: ForkStatus;
  message_count: number;
  created_at: string;
  updated_at: string;
  active: boolean;
}

export interface BranchGraph {
  nodes: BranchGraphNode[];
  edges: BranchGraphEdge[];
  root_message_id: string | null;
}

export interface BranchGraphNode {
  id: string;
  message_id: string;
  parent_message_id: string | null;
  leaf_message_id: string;
  role: "user" | "assistant";
  depth: number;
  row: number;
  title: string | null;
  preview: string;
  branch_anchor_preview: string | null;
  status: ForkStatus;
  message_count: number;
  child_count: number;
  active_path: boolean;
  leaf: boolean;
  created_at: string;
}

interface BranchGraphEdge {
  from: string;
  to: string;
}

export interface ConversationTreeResponse {
  conversation: ConversationSummary;
  selected_path: ConversationMessage[];
  active_leaf_message_id: string | null;
  fork_options_by_parent_id: Record<string, ForkOption[]>;
  path_cache_by_leaf_id: Record<string, ConversationMessage[]>;
  branch_graph: BranchGraph;
  page: { before_cursor: string | null };
}

export interface ConversationForksResponse {
  data: {
    forks: ForkOption[];
  };
}

export interface ChatRun {
  id: string;
  status: "queued" | "running" | "complete" | "error" | "cancelled";
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string;
  model_id: string;
  reasoning: string;
  key_mode: string;
  cancel_requested_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatRunStreamState {
  status: "queued" | "running" | "complete" | "error" | "cancelled" | "interrupted";
  last_event_seq: number;
  folded_event_seq: number;
  assistant_current_text: string;
  tool_calls: MessageToolCall[];
  activity: {
    phase:
      | "queued"
      | "thinking"
      | "writing"
      | "tool_calling"
      | "waiting"
      | "retrying"
      | "cancelling";
    label: string | null;
  } | null;
  reconnectable: boolean;
  terminal: boolean;
}

export interface ChatRunResponse {
  data: {
    run: ChatRun;
    conversation: ConversationSummary;
    user_message: ConversationMessage;
    assistant_message: ConversationMessage;
    stream_state: ChatRunStreamState;
  };
}

export interface ChatRunListResponse {
  data: ChatRunResponse["data"][];
}
