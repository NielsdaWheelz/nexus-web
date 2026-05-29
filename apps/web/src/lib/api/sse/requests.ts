import type { BranchAnchor } from "@/lib/conversations/types";

export interface SingletonTargetInput {
  kind: "media" | "library";
  target_id: string;
}

export interface ReaderContextHintInput {
  media_id: string | null;
  library_id: string | null;
}

export interface ChatRunCreateRequest {
  conversation_id?: string;
  singleton: SingletonTargetInput | null;
  content: string;
  model_id: string;
  reasoning: "default" | "none" | "minimal" | "low" | "medium" | "high" | "max";
  key_mode?: "auto" | "byok_only" | "platform_only";
  parent_message_id?: string;
  branch_anchor?: BranchAnchor;
  reader_context: ReaderContextHintInput | null;
}
