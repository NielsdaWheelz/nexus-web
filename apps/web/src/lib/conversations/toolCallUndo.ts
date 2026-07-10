import { apiFetch } from "@/lib/api/client";
import type { MessageToolCall } from "./types";

/** Revert one assistant write tool call; returns the updated (reverted) row. */
export async function undoToolCall(
  conversationId: string,
  toolCallId: string,
): Promise<MessageToolCall> {
  const response = await apiFetch<{ data: MessageToolCall }>(
    `/api/conversations/${conversationId}/tool-calls/${toolCallId}/undo`,
    { method: "POST" },
  );
  return response.data;
}
