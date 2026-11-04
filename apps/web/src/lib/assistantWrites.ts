/** The one undo of an assistant write: the chat card, connections and settings. */
import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";

export async function undoAssistantWrite(toolCallId: string): Promise<void> {
  await apiFetch<void>(`/api/assistant-writes/${toolCallId}/undo`, {
    method: "POST",
  });
  publishChange("Notes", "Entries");
}

export const UNDO_REFUSED = "couldn’t undo that.";
