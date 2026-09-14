import {
  conversationMessageText,
  type ConversationMessage,
} from "@/lib/conversations/types";

export function isAssistantPrimaryBodyVisible(
  message: Pick<
    ConversationMessage,
    "message_document" | "status" | "trust_trail"
  >,
): boolean {
  if (message.trust_trail?.run?.failure?.code === "refused") return false;
  return message.status !== "error" && message.status !== "cancelled"
    ? true
    : conversationMessageText(message).trim().length > 0;
}
