/** The one undo of an assistant write: the chat card, connections and settings. */
import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import type { Schema } from "@/lib/api/wire";
import type { Line } from "@/components/feedback/stage";

export type CreatedRef = Schema<"CreatedRefOut">;

const KICKERS: Record<CreatedRef["kind"], string> = {
  entry: "filed to",
  highlight: "highlighted",
  edge: "connected",
  note_block: "noted in",
  queue: "queued",
};

export function writeKicker(ref: Pick<CreatedRef, "kind" | "field">): string {
  return ref.field === "annotation" ? "annotated" : KICKERS[ref.kind];
}

export async function undoAssistantWrite(toolCallId: string): Promise<void> {
  await apiFetch<void>(`/api/assistant-writes/${toolCallId}/undo`, {
    method: "POST",
  });
  publishChange("Notes", "Entries", "AssistantWrites");
}

export const UNDO_LABEL = "undo";
export const UNDONE = "undone";
export const UNDO_TOO_OLD = "too old to undo";
export const UNDO_UNAVAILABLE = "undo unavailable";
export const UNDO_REFUSED = "couldn’t undo that.";
export const UNDO_UNKNOWN: Line = { fact: "not sure that was undone.", reason: UNKNOWN_OUTCOME_REASON };
