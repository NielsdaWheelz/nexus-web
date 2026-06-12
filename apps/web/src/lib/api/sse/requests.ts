import type { BranchAnchor } from "@/lib/conversations/types";

export interface ReaderContextHintInput {
  media_id: string | null;
  library_id: string | null;
}

/** The exact passage the user is asking about — a bind-only turn anchor. */
export interface ReaderSelectionInput {
  exact: string;
  prefix?: string;
  suffix?: string;
  media_id: string;
  highlight_id: string;
}

export interface ChatRunCreateRequest {
  conversation_id: string;
  content: string;
  model_id: string;
  reasoning: "default" | "none" | "minimal" | "low" | "medium" | "high" | "max";
  key_mode: "auto" | "byok_only" | "platform_only";
  parent_message_id?: string;
  branch_anchor?: BranchAnchor;
  reader_context: ReaderContextHintInput | null;
  reader_selection?: ReaderSelectionInput | null;
}
