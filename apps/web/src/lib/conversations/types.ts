import type {
  RetrievalContextRef,
  SearchCitationEventData,
  SearchCitationResultType,
  WebCitationEventData,
} from "@/lib/api/sse/citations";
import type { ChatToolStatus } from "@/lib/api/sse/events";
import type { RetrievalLocator } from "@/lib/api/sse/locators";
import type {
  ContextItemColor,
  ContextItemType,
} from "@/lib/api/sse/requests";

export type SingletonKind = "media" | "library";

export interface Singleton {
  kind: SingletonKind;
  target_id: string;
}

export interface ConversationSingleton {
  kind: SingletonKind;
  target_id: string;
  target_title: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  sharing: string;
  message_count: number;
  singleton: ConversationSingleton | null;
  memory?: ConversationMemoryInspection | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationListItem {
  id: string;
  title: string | null;
  first_user_message_excerpt: string;
  message_count: number;
  updated_at: string;
  is_singleton: boolean;
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
}

export interface MessageContextSnapshot {
  kind: "object_ref" | "reader_selection";
  type?: ContextItemType | null;
  id?: string | null;
  evidence_span_ids?: string[];
  client_context_id?: string | null;
  color?: ContextItemColor;
  exact?: string;
  preview?: string;
  prefix?: string;
  suffix?: string;
  title?: string;
  route?: string;
  media_id?: string;
  source_media_id?: string;
  media_title?: string;
  media_kind?: string;
  locator?: RetrievalLocator | null;
  source_version?: string | null;
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
  exact_snippet?: string | null;
  snippet_prefix?: string | null;
  snippet_suffix?: string | null;
  retrieval_status?: MessageEvidenceRetrievalStatus;
  included_in_prompt?: boolean;
  source_version?: string | null;
  citation_ordinal?: number | null;
  created_at?: string;
}

export interface CitationIndexEntry {
  n: number;
  retrieval_id: string;
  tool_call_id: string;
  ordinal: number;
}

export type ConversationPinnedSourceKind = "media" | "library" | "reader_selection";

export interface ConversationPinnedSource {
  id: string;
  ordinal: number;
  kind: ConversationPinnedSourceKind;
  target_id: string | null;
  locator: RetrievalLocator | null;
  source_version: string | null;
  exact: string | null;
  title: string;
  created_at: string;
}

export type MessageRetrievalResultRef =
  | SearchCitationEventData
  | WebCitationEventData;

export type ConversationSourceRefType =
  | "message"
  | "message_context"
  | "message_retrieval"
  | "app_context_ref"
  | "web_result";

interface ConversationSourceRefLocation {
  page?: number | null;
  fragment_id?: string | null;
  t_start_ms?: number | null;
  start_offset?: number | null;
  end_offset?: number | null;
}

export interface ConversationSourceRef {
  type: ConversationSourceRefType;
  id: string;
  label?: string | null;
  conversation_id?: string | null;
  message_id?: string | null;
  message_seq?: number | null;
  tool_call_id?: string | null;
  retrieval_id?: string | null;
  context_ref?: RetrievalContextRef | null;
  result_ref?: MessageRetrievalResultRef | null;
  media_id?: string | null;
  deep_link?: string | null;
  location?: ConversationSourceRefLocation | null;
  source_version?: string | null;
}

export type MessageEvidenceRetrievalStatus =
  | "attached_context"
  | "retrieved"
  | "selected"
  | "included_in_prompt"
  | "excluded_by_budget"
  | "excluded_by_scope"
  | "web_result";

export type MessageEvidenceLocator = RetrievalLocator;

type ConversationMemoryKind =
  | "goal"
  | "constraint"
  | "decision"
  | "correction"
  | "open_question"
  | "task"
  | "assistant_commitment"
  | "user_preference"
  | "source_claim";

type ConversationMemoryStatus = "active" | "superseded" | "invalid";

export type ConversationMemoryEvidenceRole =
  | "supports"
  | "contradicts"
  | "supersedes"
  | "context";

export interface ConversationMemorySource {
  id?: string;
  ordinal?: number | null;
  evidence_role: ConversationMemoryEvidenceRole;
  source_ref: ConversationSourceRef;
}

export interface ConversationMemoryItem {
  id: string;
  kind: ConversationMemoryKind;
  status: ConversationMemoryStatus;
  body: string;
  source_required: boolean;
  confidence?: number | null;
  valid_from_seq?: number | null;
  valid_through_seq?: number | null;
  supersedes_id?: string | null;
  created_by_message_id?: string | null;
  prompt_version?: string | null;
  memory_version?: string | number | null;
  sources: ConversationMemorySource[];
  created_at?: string;
  updated_at?: string;
}

export interface ConversationStateSnapshot {
  id: string;
  status: ConversationMemoryStatus;
  covered_through_seq: number;
  prompt_version?: string | null;
  snapshot_version?: string | number | null;
  memory_item_ids: string[];
  source_refs: ConversationSourceRef[];
  created_at?: string;
  updated_at?: string;
}

export interface ConversationMemoryInspection {
  state_snapshot?: ConversationStateSnapshot | null;
  memory_items: ConversationMemoryItem[];
}

export interface MessageToolCall {
  id?: string;
  conversation_id?: string;
  user_message_id?: string;
  assistant_message_id?: string;
  tool_name: "app_search" | "web_search" | string;
  tool_call_index: number;
  query_hash?: string | null;
  scope?: string;
  requested_types?: string[];
  semantic?: boolean;
  result_refs?: MessageRetrievalResultRef[];
  selected_context_refs?: RetrievalContextRef[];
  provider_request_ids?: string[];
  latency_ms?: number | null;
  result_count?: number;
  selected_count?: number;
  status: ChatToolStatus;
  error_code?: string | null;
  created_at?: string;
  updated_at?: string;
  retrievals?: MessageRetrieval[];
}

export interface MessageSourceManifestDelta {
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
  source_version?: string | null;
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
  version: number;
  blocks: Array<
    | {
        type: "text";
        format: "plain" | "markdown";
        text: string;
      }
    | {
        type: "source_manifest";
        assistant_message_id: string;
        tool_call_id?: string | null;
        tool_name: "app_search" | "web_search";
        tool_call_index: number;
        query_hash?: string | null;
        scope?: string;
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
        status: "pending" | "running" | "complete" | "error" | "cancelled";
      }
    | ({
        type: "retrieval_result";
      } & MessageRetrieval)
  >;
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
  contexts?: MessageContextSnapshot[];
  tool_calls?: MessageToolCall[];
  retrievals?: MessageRetrieval[];
  citation_index?: CitationIndexEntry[];
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
  page: { next_cursor: string | null };
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
