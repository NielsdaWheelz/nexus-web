/**
 * The resource graph's http client: connection reads, link commands, and the one
 * owner-named removal of each fact. Committed link changes are announced to
 * subscribers (outlines, panes) after success only.
 */
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { dismissDiscoveryLink } from "@/lib/connectionDiscovery";
import { undoToolCall } from "@/lib/chat/toolCallUndo";

export type ConnectionOut = Schema<"ConnectionOut">;
export type ConnectionMutation = NonNullable<ConnectionOut["mutation"]>;
export type LinkSource = Schema<"CreateLinkRequest">["source"];
export type LinkTarget = Schema<"CreateLinkRequest">["target"];
export type LinkMutation =
  | { kind: "created"; sourceRef: string; targetRef: string }
  | { kind: "deleted"; linkId: string };

const listeners = new Set<(mutation: LinkMutation) => void>();

export function subscribeLinkMutations(
  listener: (mutation: LinkMutation) => void,
): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function announce(mutation: LinkMutation): void {
  for (const listener of listeners) listener(mutation);
}

export async function queryConnections(
  input: Schema<"ConnectionQueryRequest">,
  signal?: AbortSignal,
): Promise<Schema<"ConnectionPageOut">> {
  const { data } = await apiFetch<
    ApiJson<"/resource-graph/connections/query", "post">
  >("/api/resource-graph/connections/query", {
    method: "POST",
    signal,
    body: JSON.stringify(input),
  });
  return data;
}

/** The caller freezes `clientMutationId` per intent, so a retry replays the same link.
 * The announcement carries the stored (canonical) order, also for a reused link. */
export async function createLink(input: {
  clientMutationId: string;
  source: LinkSource;
  target: LinkTarget;
}): Promise<Schema<"CreateLinkOut">> {
  const { data } = await apiFetch<ApiJson<"/resource-graph/links", "post">>(
    "/api/resource-graph/links",
    {
      method: "POST",
      body: JSON.stringify({
        client_mutation_id: input.clientMutationId,
        source: input.source,
        target: input.target,
      }),
    },
  );
  const { source, target } = data.connection;
  announce({ kind: "created", sourceRef: source.ref, targetRef: target.ref });
  return data;
}

export async function deleteLink(linkId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/links/${linkId}`, { method: "DELETE" });
  announce({ kind: "deleted", linkId });
}

/** The server names the owning command; provenance alone never authorizes removal. */
export async function mutateConnection(
  edgeId: string,
  mutation: ConnectionMutation,
): Promise<void> {
  switch (mutation.kind) {
    case "unlink":
      return deleteLink(edgeId);
    case "dismiss_discovery":
      return dismissDiscoveryLink(edgeId);
    case "detach_context":
      await apiFetch(
        `/api/conversations/${mutation.conversation_id}/context-refs/${edgeId}`,
        { method: "DELETE" },
      );
      return;
    case "undo_assistant_chat":
      return undoToolCall(mutation.conversation_id, mutation.tool_call_id);
    case "undo_assistant_generation":
      await apiFetch(`/api/generation-effects/${mutation.position_id}/undo`, {
        method: "POST",
      });
  }
}

const GONE = new Set([
  "E_NOT_FOUND",
  "E_CONVERSATION_NOT_FOUND",
  "E_FORBIDDEN",
  "E_INVALID_REQUEST",
  "write_position_not_found",
  "write_did_not_succeed",
  "operation_in_progress_or_uncertain",
]);

export function connectionMutationErrorMessage(
  error: unknown,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const { code, requestId } = error;
  if (code === "E_NETWORK" || code === "E_UPSTREAM_TIMEOUT") {
    return {
      tone: "Warning",
      title: "Couldn’t confirm the change.",
      message: "Retry checks the same change.",
      requestId,
    };
  }
  if (GONE.has(code)) {
    return {
      tone: "Warning",
      title: "This change is no longer available.",
      message: "Reload Connections to see its current state.",
      requestId,
    };
  }
  throw error;
}
