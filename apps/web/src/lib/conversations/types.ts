import type {
  RetrievalContextRef,
  SearchCitationEventData,
  SearchCitationResultType,
  WebCitationEventData,
} from "@/lib/api/sse/citations";
import type { ChatToolStatus } from "@/lib/api/sse/events";
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

/** One reasoning option a profile offers (GET /llm-profiles). */
export interface LlmReasoningOption {
  id: string;
  label: string;
}

/**
 * A product-facing LLM profile (GET /llm-profiles). The browser owns no
 * provider/model/reasoning enum, ordering, default, capability, key, or
 * availability policy — it renders exactly what this endpoint returns.
 * Deliberately has no resolved provider/model field: that pair is an
 * internal runtime fact, not a selection control (§10).
 */
export interface LlmProfile {
  id: string;
  label: string;
  description: string;
  provider_label: string;
  model_label: string;
  reasoning_options: LlmReasoningOption[];
  default_reasoning_option_id: string;
  privacy_notice: string;
}

/** Response schema for GET /llm-profiles. */
export interface LlmProfilesOut {
  default_profile_id: string;
  profiles: LlmProfile[];
}

// =============================================================================
// ExpectedChatFailure — mirrors python/nexus/schemas/llm.py EXACTLY.
//
// Closed, discriminated union (discriminator `code`) exposed by ChatRunOut,
// message hydration, terminal SSE, reconnect folding, and the trust trail.
// A DEFECT (internal error) exposes NO variant — `failure` is null but the
// run status is terminal-failed with a support_id; render the same generic,
// non-rerunnable card (see chatFailureMessage in lib/llm/failure.ts).
// =============================================================================

interface ExpectedChatFailureBase {
  support_id: string | null;
  can_rerun: boolean;
}

/** Streamed Fable refusal (provider_stream) or non-streamed provider refusal
 * (provider_http). Never rerunnable. */
export interface RefusedChatFailure extends ExpectedChatFailureBase {
  code: "refused";
  origin: "provider_http" | "provider_stream";
}

/** Provider-declared incomplete completion, or local truncation folded to the
 * same closed code. */
export interface IncompleteChatFailure extends ExpectedChatFailureBase {
  code: "incomplete";
  origin: "provider_response";
}

/** Run status `cancelled` alone drives this variant — a cancelled run's error
 * columns are NULL, so it carries no `origin`. */
export interface CancelledChatFailure extends ExpectedChatFailureBase {
  code: "cancelled";
}

/** Owner-side assembly rejected the intent before generation began (`intent`,
 * ledgerless), or the provider rejected an in-bound request as oversize
 * (`provider_http`). */
export interface ContextTooLargeChatFailure extends ExpectedChatFailureBase {
  code: "context_too_large";
  origin: "intent" | "provider_http";
}

export interface InvalidToolArgumentsChatFailure extends ExpectedChatFailureBase {
  code: "invalid_tool_arguments";
  origin: "tool_arguments";
}

/** Platform-token-reservation denial. Never rerunnable. */
export interface BudgetExceededChatFailure extends ExpectedChatFailureBase {
  code: "budget_exceeded";
  origin: "budget";
}

/** Transient: mapped from the runtime's TransientExhausted(cause=
 * ProviderRateLimit) leaf. */
export interface RateLimitedChatFailure extends ExpectedChatFailureBase {
  code: "rate_limited";
  origin: "provider_http";
  attempts: number;
}

/** Transient: mapped from the runtime's TransientExhausted(cause=
 * ProviderTimeout) leaf. */
export interface TimeoutChatFailure extends ExpectedChatFailureBase {
  code: "timeout";
  origin: "transport";
  attempts: number;
}

/** Transient: mapped from either TransientExhausted(cause=
 * ProviderHttpUnavailable) (provider_http) or TransientExhausted(cause=
 * TransportUnavailable) (transport). */
export interface ProviderUnavailableChatFailure extends ExpectedChatFailureBase {
  code: "provider_unavailable";
  origin: "provider_http" | "transport";
  attempts: number;
}

/** Transient: mapped from TransientExhausted(cause=
 * ProviderStreamInterrupted), and from crashed/interrupted-run recovery when
 * provider output existed without a terminal. This is the SERVER-side
 * variant — distinct from the CLIENT-only ConnectionLostStatusUnknown owned
 * by useChatRunTail.ts, which is never persisted and never SSE. */
export interface StreamInterruptedChatFailure extends ExpectedChatFailureBase {
  code: "stream_interrupted";
  origin: "provider_stream";
  attempts: number;
}

export type ExpectedChatFailure =
  | RefusedChatFailure
  | IncompleteChatFailure
  | CancelledChatFailure
  | ContextTooLargeChatFailure
  | InvalidToolArgumentsChatFailure
  | BudgetExceededChatFailure
  | RateLimitedChatFailure
  | TimeoutChatFailure
  | ProviderUnavailableChatFailure
  | StreamInterruptedChatFailure;

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
  included_in_prompt_source?: "retrieval" | "prompt_assembly" | "none";
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
  input_preview?: string;
  // Undo lifecycle for assistant write tool calls; set once reverted (amanuensis).
  reverted_at?: string | null;
  created_at?: string;
  updated_at?: string;
  retrievals: MessageRetrieval[];
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
    profile_id: string | null;
    reasoning_option_id: string | null;
    provider: string | null;
    model_name: string | null;
    status: "pending" | "running" | "complete" | "error" | "cancelled";
    usage: Record<string, unknown> | null;
    error_code: string | null;
    error_origin: string | null;
    failure: ExpectedChatFailure | null;
    final_chars: number | null;
    started_at: string | null;
    completed_at: string | null;
    total_cost_usd_micros: number | null;
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

export function createRunningAssistantTrustTrail({
  assistantMessageId,
  conversationId = "",
  createdAt,
  updatedAt,
}: {
  assistantMessageId: string;
  conversationId?: string;
  createdAt: string;
  updatedAt: string;
}): AssistantTrustTrail {
  return {
    schema_version: "assistant_trust_trail.v1",
    assistant_message_id: assistantMessageId,
    conversation_id: conversationId,
    chat_run_id: null,
    status: "running",
    run: null,
    prompt: null,
    tool_calls: [],
    citations: [],
    context_refs_added: [],
    integrity_notices: [],
    created_at: createdAt,
    updated_at: updatedAt,
  };
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
  can_rerun: boolean;
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
  /** Product-selection snapshot taken at creation; null only before the run
   * record has been fully hydrated. */
  profile_id: string | null;
  reasoning_option_id: string | null;
  /** Resolved operator facts filled in from the plan at execution — null
   * until then. Not selection controls. */
  provider: string | null;
  model_name: string | null;
  reasoning_effort: string | null;
  error_origin: string | null;
  support_id: string | null;
  /** The one chat_failure_projection read. Null for a run that is not a
   * card-bearing failure (still running, or a defect with no stored closed
   * code — render the generic defect card via chatFailureMessage(null)). */
  failure: ExpectedChatFailure | null;
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
