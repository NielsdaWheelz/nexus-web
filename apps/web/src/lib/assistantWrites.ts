/** The one undo of an assistant write: the chat card, connections and settings. */
import {
  apiFetch,
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";

export async function undoAssistantWrite(toolCallId: string): Promise<void> {
  await apiFetch<void>(`/api/assistant-writes/${toolCallId}/undo`, {
    method: "POST",
  });
  publishChange("Notes", "Entries");
}

/** Copy for a failed undo or history read; anything unexpected is a defect. */
export function undoFailureMessage(error: unknown): string {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const transport = apiTransportFeedback(error, "request wasn’t confirmed");
  if (transport !== null) return transport.message ?? transport.title;
  switch (error.code) {
    case "E_NETWORK":
      return "Check your connection and try again.";
    case "E_RESOURCE_CONFLICT":
      return "library changed; this filing can’t be undone. review its libraries.";
    default:
      return "The request failed. Reload to see the current state.";
  }
}
