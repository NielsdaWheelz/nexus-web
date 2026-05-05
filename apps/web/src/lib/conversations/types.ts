import type {
  CitationEventData,
  ContextItem,
  SearchCitationEventData,
} from "@/lib/api/sse";
import type { ContributorCredit } from "@/lib/contributors/types";

export type ConversationScope =
  | { type: "general" }
  | {
      type: "media";
      media_id: string;
      title?: string | null;
      media_kind?: string | null;
      contributors?: ContributorCredit[];
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
  title?: string;
  route?: string;
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
  citation_label?: string | null;
  resolver?: SearchCitationEventData["resolver"];
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

export type MessageEvidenceRetrievalStatus =
  | "attached_context"
  | "retrieved"
  | "selected"
  | "included_in_prompt"
  | "excluded_by_budget"
  | "excluded_by_scope"
  | "web_result";

export type MessageClaimSupportStatus =
  | "supported"
  | "partially_supported"
  | "contradicted"
  | "not_enough_evidence"
  | "out_of_scope"
  | "not_source_grounded";

export type MessageEvidenceRole =
  | "supports"
  | "contradicts"
  | "context"
  | "scope_boundary";

export type MessageEvidenceLocator =
  | {
      type: "epub_fragment_offsets";
      media_id: string;
      section_id: string;
      fragment_id: string;
      start_offset: number;
      end_offset: number;
    }
  | {
      type: "pdf_page_geometry";
      media_id: string;
      page_number: number;
      quads: unknown[];
      exact: string;
      prefix?: string | null;
      suffix?: string | null;
    }
  | {
      type: "transcript_time_range";
      media_id: string;
      transcript_version_id: string;
      t_start_ms: number;
      t_end_ms: number;
    }
  | {
      type: "conversation_message";
      conversation_id: string;
      message_id: string;
      message_seq: number;
    }
  | {
      type: "web_url";
      url: string;
      title?: string | null;
      display_url?: string | null;
      accessed_at?: string | null;
    }
  | {
      type: "external_source";
      source_name: string;
      source_id: string;
      url?: string | null;
    };

export interface MessageEvidenceSummary {
  id: string;
  message_id: string;
  scope_type: ConversationScope["type"];
  scope_ref: Record<string, unknown> | null;
  retrieval_status: MessageEvidenceRetrievalStatus;
  support_status: MessageClaimSupportStatus;
  verifier_status: string;
  claim_count: number;
  supported_claim_count: number;
  unsupported_claim_count: number;
  not_enough_evidence_count: number;
  prompt_assembly_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageClaim {
  id: string;
  message_id: string;
  ordinal: number;
  claim_text: string;
  answer_start_offset?: number | null;
  answer_end_offset?: number | null;
  claim_kind: string;
  support_status: MessageClaimSupportStatus;
  verifier_status: string;
  created_at: string;
}

export interface MessageClaimEvidence {
  id: string;
  claim_id: string;
  ordinal: number;
  evidence_role: MessageEvidenceRole;
  source_ref: ConversationSourceRef;
  retrieval_id?: string | null;
  context_ref?: Record<string, unknown> | null;
  result_ref?: Record<string, unknown> | null;
  exact_snippet?: string | null;
  snippet_prefix?: string | null;
  snippet_suffix?: string | null;
  locator?: MessageEvidenceLocator | null;
  deep_link?: string | null;
  citation_label?: string | null;
  resolver?: SearchCitationEventData["resolver"];
  score?: number | null;
  retrieval_status: MessageEvidenceRetrievalStatus;
  selected: boolean;
  included_in_prompt: boolean;
  source_version?: string | null;
  created_at: string;
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
  evidence_summary?: MessageEvidenceSummary | null;
  claims?: MessageClaim[];
  claim_evidence?: MessageClaimEvidence[];
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
