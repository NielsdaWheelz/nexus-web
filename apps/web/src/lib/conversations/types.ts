import type {
  RetrievalContextRef,
  SearchCitationEventData,
  SearchCitationResultType,
  WebCitationEventData,
} from "@/lib/api/sse/citations";
import type { ChatToolStatus } from "@/lib/api/sse/events";
import type { RetrievalLocator } from "@/lib/api/sse/locators";
import type { CitationOut } from "@/lib/conversations/citationOut";

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
  latency_ms?: number | null;
  result_count?: number;
  selected_count?: number;
  status: ChatToolStatus;
  error_code?: string | null;
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
  included_in_prompt_source: "candidate_ledger" | "linked_retrieval";
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
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface MessageDocument {
  type: "message_document";
  blocks: Array<{
    type: "text";
    format: "plain" | "markdown";
    text: string;
  }>;
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
  | "assistant_selection"
  | "reader_context";

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
    }
  | {
      kind: "reader_context";
      message_id?: string;
      context_id?: string;
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

export interface ChatRunResponse {
  data: {
    run: ChatRun;
    conversation: ConversationSummary;
    user_message: ConversationMessage;
    assistant_message: ConversationMessage;
  };
}

export interface ChatRunListResponse {
  data: ChatRunResponse["data"][];
}
