import { FileText, Library, type LucideIcon } from "lucide-react";
import type {
  ContextItem,
  ContextItemColor,
  ContextItemType,
} from "@/lib/api/sse/requests";
import type {
  ConversationSingleton,
  MessageContextSnapshot,
  SingletonKind,
} from "@/lib/conversations/types";

type DisplayContext =
  | ContextItem
  | MessageContextSnapshot
  | {
      kind?: "object_ref";
      type: ContextItemType;
      id: string;
      color?: ContextItemColor;
      exact?: string;
      preview?: string;
      mediaTitle?: string;
      media_title?: string;
    };

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

export function getContextExact(context: DisplayContext): string | undefined {
  return context.exact || context.preview;
}

export function getContextChipLabel(context: DisplayContext, maxLength = 60): string {
  const text = getContextExact(context);
  if (text) {
    return truncateText(text, maxLength);
  }
  if ("kind" in context && context.kind === "reader_selection") {
    return "Selected quote";
  }
  if (!("type" in context) || !("id" in context) || !context.type || !context.id) {
    return "Context";
  }
  return `${context.type}: ${context.id.slice(0, 8)}...`;
}

export function getContextMediaTitle(context: DisplayContext): string | undefined {
  if ("media_title" in context && context.media_title) {
    return context.media_title;
  }
  if ("mediaTitle" in context && context.mediaTitle) {
    return context.mediaTitle;
  }
  return undefined;
}

export function getContextMediaKind(context: DisplayContext): string | undefined {
  if ("media_kind" in context && context.media_kind) {
    return context.media_kind;
  }
  if ("mediaKind" in context && context.mediaKind) {
    return context.mediaKind;
  }
  return undefined;
}

export function formatSelectionContext(prefix?: string, suffix?: string): string | undefined {
  const parts: string[] = [];
  if (prefix) {
    parts.push(`...${truncateText(prefix, 40)}`);
  }
  if (suffix) {
    parts.push(`${truncateText(suffix, 40)}...`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" [selection] ");
}

export function formatContextMeta(
  mediaTitle?: string,
  mediaKind?: string,
): string | undefined {
  const parts = [mediaTitle, mediaKind].filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" - ");
}

export const SINGLETON_KIND_ICONS: Record<SingletonKind, LucideIcon> = {
  media: FileText,
  library: Library,
};

export function formatSingletonLabel(singleton: ConversationSingleton): string {
  return `Chat about *${singleton.target_title}*`;
}
