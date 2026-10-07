import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { ContextEdgeActionKind } from "@/lib/actions/contextEdgeActions";
import { dismissDiscoveryLink } from "@/lib/connectionDiscovery";
import { undoToolCall } from "@/lib/conversations/toolCallUndo";
import type { ConnectionOut } from "./connections";
import { removeContextRef } from "./contextRefs";
import { deleteLink } from "./links";

export type ConnectionMutation = NonNullable<ConnectionOut["mutation"]>;

export function connectionMutationAction(mutation: ConnectionMutation): ContextEdgeActionKind {
  switch (mutation.kind) {
    case "unlink": return "Unlink";
    case "dismiss_discovery": return "Dismiss";
    case "detach_context": return "RemoveFromContext";
    case "undo_assistant_chat":
    case "undo_assistant_generation": return "UndoAssistant";
  }
}

/** The server names the owning command; provenance alone never authorizes removal. */
export async function mutateConnection(edgeId: string, mutation: ConnectionMutation): Promise<void> {
  switch (mutation.kind) {
    case "unlink": await deleteLink(edgeId); return;
    case "dismiss_discovery": await dismissDiscoveryLink(edgeId); return;
    case "detach_context": await removeContextRef(mutation.conversation_id, edgeId); return;
    case "undo_assistant_chat": await undoToolCall(mutation.conversation_id, mutation.tool_call_id); return;
    case "undo_assistant_generation":
      await apiFetch(`/api/generation-effects/${mutation.position_id}/undo`, { method: "POST" });
      return;
  }
}

export function connectionMutationErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NETWORK":
    case "E_UPSTREAM_TIMEOUT":
      return { tone: "Warning", title: "Couldn’t confirm the change.", message: "Retry checks the same change.", requestId: error.requestId };
    case "E_NOT_FOUND":
    case "E_CONVERSATION_NOT_FOUND":
    case "E_FORBIDDEN":
    case "E_OWNER_REQUIRED":
    case "E_INVALID_REQUEST":
    case "write_position_not_found":
    case "write_did_not_succeed":
    case "operation_in_progress_or_uncertain":
      return { tone: "Warning", title: "This change is no longer available.", message: "Reload Connections to see its current state.", requestId: error.requestId };
    default: throw error;
  }
}
