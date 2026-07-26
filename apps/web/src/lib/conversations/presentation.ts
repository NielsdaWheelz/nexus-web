/** Pure, locale-aware copy for conversation list surfaces. */

import {
  formatDisplayNumber,
  formatRelativeTime,
} from "@/lib/display/format";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";

type ConversationListPresentationInput = {
  readonly title: string;
  readonly message_count: number;
  readonly updated_at: string;
};

export function conversationTitle(
  conversation: Pick<ConversationListPresentationInput, "title">,
): string {
  const trimmed = conversation.title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled chat";
}

export function messageCountLabel(
  count: number,
  environment: Pick<RenderEnvironment, "displayLocale">,
): string {
  return count === 1
    ? "1 message"
    : `${formatDisplayNumber(count, environment)} messages`;
}

export function conversationListMetadata(
  conversation: Pick<
    ConversationListPresentationInput,
    "message_count" | "updated_at"
  >,
  environment: Pick<RenderEnvironment, "displayLocale" | "currentInstant">,
): string {
  const relative = formatRelativeTime(
    conversation.updated_at,
    environment,
    new Date(environment.currentInstant),
  );
  const count = messageCountLabel(conversation.message_count, environment);
  return relative ? `${relative} · ${count}` : count;
}

export function presentConversationListItem(
  conversation: ConversationListPresentationInput,
  environment: Pick<RenderEnvironment, "displayLocale" | "currentInstant">,
): { readonly title: string; readonly metadata: string } {
  return {
    title: conversationTitle(conversation),
    metadata: conversationListMetadata(conversation, environment),
  };
}
