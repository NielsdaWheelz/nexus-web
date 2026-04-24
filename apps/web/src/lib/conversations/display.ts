import type { ContextItem } from "@/lib/api/sse";
import type { MessageContextSnapshot } from "@/lib/conversations/types";

type DisplayContext =
  | ContextItem
  | MessageContextSnapshot
  | {
      type: ContextItem["type"];
      id: string;
      color?: ContextItem["color"];
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
  return `${context.type}: ${context.id.slice(0, 8)}...`;
}

export function getContextMediaTitle(context: DisplayContext): string | undefined {
  if ("mediaTitle" in context && context.mediaTitle) {
    return context.mediaTitle;
  }
  if ("media_title" in context && context.media_title) {
    return context.media_title;
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
