/** The one undo of an assistant write: the chat card, connections and settings. */
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";

export function undoAssistantWrite(toolCallId: string): Promise<void> {
  return apiFetch<void>(`/api/assistant-writes/${toolCallId}/undo`, {
    method: "POST",
  });
}

/** Copy for a failed undo or history read; anything unexpected is a defect. */
export function undoFailureMessage(error: unknown): string {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NETWORK":
      return "Check your connection and try again.";
    case "E_RESOURCE_CONFLICT":
      return "This write created nothing to undo.";
    case "E_MEDIA_LAST_REFERENCE":
      return "This item is in no other library, so it stays filed. Remove it from Nexus to delete it.";
    default:
      return "The request failed. Reload to see the current state.";
  }
}
