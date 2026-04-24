import type { ContextItem, SearchCitationEventData } from "@/lib/api/sse";

export interface ConversationModel {
  id: string;
  provider: string;
  provider_display_name: string;
  model_name: string;
  model_display_name: string;
  model_tier: "sota" | "light";
  reasoning_modes: Array<"none" | "minimal" | "low" | "medium" | "high" | "max">;
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
  result_type: SearchCitationEventData["result_type"];
  source_id: string;
  media_id: string | null;
  context_ref: SearchCitationEventData["context_ref"];
  result_ref: SearchCitationEventData;
  deep_link: string | null;
  score: number | null;
  selected: boolean;
  created_at?: string;
}

export interface MessageToolCall {
  id?: string;
  conversation_id?: string;
  user_message_id?: string;
  assistant_message_id?: string;
  tool_name: "app_search" | string;
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
  status: "pending" | "complete" | "error";
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessagesResponse {
  data: ConversationMessage[];
  page: { next_cursor: string | null };
}
