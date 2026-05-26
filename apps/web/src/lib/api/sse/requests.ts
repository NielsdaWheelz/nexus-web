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
  source_version?: string;
  locator?: RetrievalLocator;
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

export interface SingletonTargetInput {
  kind: "media" | "library";
  target_id: string;
}

export interface ReaderContextHintInput {
  media_id: string | null;
  library_id: string | null;
}

type ChatRunContext =
  | {
      kind: "object_ref";
      type: ContextItemType;
      id: string;
      evidence_span_ids?: string[];
      source_version?: string;
      locator?: RetrievalLocator;
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
    ...(item.source_version ? { source_version: item.source_version } : {}),
    ...(item.locator ? { locator: item.locator } : {}),
  };
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
  contexts?: ChatRunContext[];
}
