import type {
  CitationEventData,
  ContextItem,
  SearchCitationEventData,
} from "@/lib/api/sse";

export type ConversationScope =
  | { type: "general" }
  | {
      type: "media";
      media_id: string;
      title?: string | null;
      media_kind?: string | null;
      authors?: string[];
      published_date?: string | null;
      publisher?: string | null;
      canonical_source_url?: string | null;
    }
  | {
      type: "library";
      library_id: string;
      title?: string | null;
      library_name?: string | null;
      entry_count?: number | null;
      media_kinds?: string[];
      source_policy?: string | null;
    };

export interface ConversationSummary {
  id: string;
  title: string;
  sharing: string;
  message_count: number;
  scope: ConversationScope;
  memory?: ConversationMemoryInspection | null;
  created_at: string;
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
}

export interface MessageContextSnapshot {
  type: ContextItem["type"];
  id: string;
  color?: ContextItem["color"];
  exact?: string;
  preview?: string;
  prefix?: string;
  suffix?: string;
  annotation_body?: string;
  media_id?: string;
  media_title?: string;
  media_kind?: string;
}

export interface MessageRetrieval {
  id?: string;
  tool_call_id?: string;
  ordinal?: number;
  result_type: SearchCitationEventData["result_type"] | "web_result";
  source_id: string;
  media_id: string | null;
  context_ref: SearchCitationEventData["context_ref"] | { type: "web_result"; id: string };
  result_ref: CitationEventData;
  deep_link: string | null;
  score: number | null;
  selected: boolean;
  created_at?: string;
}

export type ConversationSourceRefType =
  | "message"
  | "message_context"
  | "message_retrieval"
  | "app_context_ref"
  | "web_result";

export interface ConversationSourceRefLocation {
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
  context_ref?: { type: string; id: string } | null;
  result_ref?: Record<string, unknown> | null;
  media_id?: string | null;
  deep_link?: string | null;
  location?: ConversationSourceRefLocation | null;
  source_version?: string | null;
}

export type ConversationMemoryKind =
  | "goal"
  | "constraint"
  | "decision"
  | "correction"
  | "open_question"
  | "task"
  | "assistant_commitment"
  | "user_preference"
  | "source_claim";

export type ConversationMemoryStatus = "active" | "superseded" | "invalid";

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
  result_refs?: unknown[];
  selected_context_refs?: unknown[];
  provider_request_ids?: string[];
  latency_ms?: number | null;
  status: "pending" | "complete" | "error" | "started" | string;
  error_code?: string | null;
  created_at?: string;
  updated_at?: string;
  retrievals: MessageRetrieval[];
}

export interface ConversationMessage {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  contexts?: MessageContextSnapshot[];
  tool_calls?: MessageToolCall[];
  status: "pending" | "complete" | "error" | "cancelled";
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessagesResponse {
  data: ConversationMessage[];
  page: { next_cursor: string | null };
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
