/** One transport port for the chat-owned assistant write undo. */
import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
export async function undoToolCall(conversationId: string, toolCallId: string): Promise<void> {
  await apiFetch<ApiJson<"/conversations/{conversation_id}/tool-calls/{tool_call_id}/undo", "post">>(
    `/api/conversations/${conversationId}/tool-calls/${toolCallId}/undo`,
    { method: "POST" },
  );
}
