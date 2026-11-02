/** The one undo of an assistant write: the chat card, connections and settings. */
import { apiFetch, isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";

export async function undoAssistantWrite(toolCallId: string): Promise<void> {
  await apiFetch<void>(`/api/assistant-writes/${toolCallId}/undo`, {
    method: "POST",
  });
  publishChange("Notes", "Entries");
}

export const UNDO_REFUSED = "couldn’t undo that.";
/** A refused undo's domain reason, ahead of the transport's: one attempt reverts every write or
 * none, so a conflict leaves the write in place. */
export const undoReason = (error: ApiError): string | null =>
  error.code === "E_RESOURCE_CONFLICT" ? "it’s still in place." : null;

/** Until L4's settings history migrates (L7): a refused undo's reason, else the bare fact. A
 * defect throws. */
export function undoFailureMessage(error: unknown): string {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  return undoReason(error) ?? TRANSPORT_LINES[transportOf(error)].command(UNDO_REFUSED).reason ?? UNDO_REFUSED;
}
