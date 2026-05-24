import type { BranchAnchor } from "@/lib/conversations/types";
import type { ObjectType } from "@/lib/objectRefs";
import type { RetrievalLocator } from "./locators";

export type ContextItemType = ObjectType;
export type ContextItemColor = "yellow" | "green" | "blue" | "pink" | "purple";

export interface ObjectRefContextItem {
  kind: "object_ref";
  type: ContextItemType;
  id: string;
  evidence_span_ids?: string[];
  artifact_id?: string;
  artifact_key?: string | null;
  artifact_version?: number | null;
  source_version?: string;
  locator?: RetrievalLocator;
  artifact_part_provenance?: Record<string, unknown>;
  /** Display fields carried by the caller when available. */
  color?: ContextItemColor;
  preview?: string;
  mediaId?: string;
  mediaTitle?: string;
  exact?: string;
  prefix?: string;
  suffix?: string;
  mediaKind?: string;
}

export interface ReaderSelectionContextItem {
  kind: "reader_selection";
  client_context_id: string;
  media_id: string;
  media_kind: string;
  media_title: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  preview?: string;
  locator: RetrievalLocator;
  source_version: string;
  color?: ContextItemColor;
}

export type ContextItem = ObjectRefContextItem | ReaderSelectionContextItem;

export type ConversationScopeInput =
  | { type: "general" }
  | { type: "media"; media_id: string }
  | { type: "library"; library_id: string };

export type ArtifactIntentKind =
  | "off"
  | "auto"
  | "briefing_document"
  | "study_guide"
  | "faq"
  | "timeline"
  | "comparison_table"
  | "extraction_table"
  | "claim_table"
  | "contradiction_report"
  | "source_map"
  | "concept_map"
  | "outline"
  | "flashcards"
  | "quiz"
  | "audio_overview_script"
  | "audio_overview"
  | "video_slide_overview_manifest"
  | "bibliography"
  | "citation_audit";

export interface ArtifactIntentOptions {
  kind: ArtifactIntentKind;
}

export type ChatRunContext =
  | {
      kind: "object_ref";
      type: ContextItemType;
      id: string;
      evidence_span_ids?: string[];
      artifact_id?: string;
      artifact_key?: string | null;
      artifact_version?: number | null;
      source_version?: string;
      locator?: RetrievalLocator;
      artifact_part_provenance?: Record<string, unknown>;
    }
  | {
      kind: "reader_selection";
      client_context_id: string;
      media_id: string;
      media_kind: string;
      media_title: string;
      exact: string;
      prefix?: string;
      suffix?: string;
      locator: RetrievalLocator;
      source_version: string;
    };

export function toWireContextItem(item: ContextItem): ChatRunContext {
  if (item.kind === "reader_selection") {
    return {
      kind: "reader_selection",
      client_context_id: item.client_context_id,
      media_id: item.media_id,
      media_kind: item.media_kind,
      media_title: item.media_title,
      exact: item.exact,
      ...(item.prefix ? { prefix: item.prefix } : {}),
      ...(item.suffix ? { suffix: item.suffix } : {}),
      locator: item.locator,
      source_version: item.source_version,
    };
  }

  return {
    kind: "object_ref",
    type: item.type,
    id: item.id,
    ...(item.evidence_span_ids?.length
      ? { evidence_span_ids: item.evidence_span_ids }
      : {}),
    ...(item.artifact_id ? { artifact_id: item.artifact_id } : {}),
    ...(item.artifact_key ? { artifact_key: item.artifact_key } : {}),
    ...(item.artifact_version
      ? { artifact_version: item.artifact_version }
      : {}),
    ...(item.source_version ? { source_version: item.source_version } : {}),
    ...(item.locator ? { locator: item.locator } : {}),
    ...(item.artifact_part_provenance
      ? { artifact_part_provenance: item.artifact_part_provenance }
      : {}),
  };
}

export interface ChatRunCreateRequest {
  conversation_id?: string;
  content: string;
  model_id: string;
  reasoning: "default" | "none" | "minimal" | "low" | "medium" | "high" | "max";
  key_mode?: "auto" | "byok_only" | "platform_only";
  parent_message_id?: string;
  branch_anchor?: BranchAnchor;
  conversation_scope?: ConversationScopeInput;
  contexts?: ChatRunContext[];
  web_search: {
    mode: "off" | "auto" | "required";
    freshness_days?: number | null;
    allowed_domains?: string[];
    blocked_domains?: string[];
  };
  artifact_intent: ArtifactIntentOptions;
}
