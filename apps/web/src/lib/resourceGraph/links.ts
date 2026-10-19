/**
 * The resource graph's http client: connection reads, link commands, and the one
 * owner-named removal of each fact. Committed link changes are announced to
 * subscribers (outlines, panes) after success only.
 */
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { dismissDiscoveryLink } from "@/lib/connectionDiscovery";
import { undoAssistantWrite } from "@/lib/assistantWrites";

export type ConnectionOut = Schema<"ConnectionOut">;
export type ConnectionMutation = NonNullable<ConnectionOut["mutation"]>;
export type LinkSource = Schema<"CreateLinkRequest">["source"];
export type LinkTarget = Schema<"CreateLinkRequest">["target"];
export type LinkMutation =
  | { kind: "created"; sourceRef: string; targetRef: string }
  | { kind: "deleted"; linkId: string; origin: object | null }
  | { kind: "context_detached"; sourceRef: string; targetRef: string }
  | { kind: "resource_deleted"; ref: string };

const listeners = new Set<(mutation: LinkMutation) => void>();
const deletedResources = new Set<string>();

/** A committed deletion outranks older reads, including for later subscribers. */
export function isDeletedResource(ref: string): boolean {
  return deletedResources.has(ref);
}

export function subscribeLinkMutations(
  listener: (mutation: LinkMutation) => void,
): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function announce(mutation: LinkMutation): void {
  const defects: unknown[] = [];
  for (const listener of listeners) {
    try { listener(mutation); } catch (error) { defects.push(error); }
  }
  if (defects.length) queueMicrotask(() => { throw new AggregateError(defects, "link observers failed"); });
}

/** Only the acknowledged resource teardown may announce this fact. */
export function announceResourceDeletion(ref: string): void {
  deletedResources.add(ref);
  announce({ kind: "resource_deleted", ref });
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
    body: JSON.stringify({ ...input, limit: input.limit === undefined ? undefined : Math.min(input.limit, 100) }),
  });
  return data;
}

/** The caller mints `link_id` once per intent, so a retry that landed answers the
 * same link. The announcement carries the stored (canonical) order, also for a
 * reused link. */
export async function createLink(
  input: Schema<"CreateLinkRequest">,
): Promise<Schema<"CreateLinkOut">> {
  const { data } = await apiFetch<ApiJson<"/resource-graph/links", "post">>(
    "/api/resource-graph/links",
    { method: "POST", body: JSON.stringify(input) },
  );
  const { source, target } = data.connection;
  announce({ kind: "created", sourceRef: source.ref, targetRef: target.ref });
  return data;
}

export async function deleteLink(linkId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/links/${linkId}`, { method: "DELETE" });
  announceLinkDeletions({ linkIds: [linkId], origin: null });
}

/** The origin has already finalized its own local state before notifying observers. */
export function announceLinkDeletions(input: { linkIds: readonly string[]; origin: object | null }): void {
  for (const linkId of input.linkIds) announce({ kind: "deleted", linkId, origin: input.origin });
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
        `/api/conversations/${mutation.conversation_id}/context/${encodeURIComponent(mutation.target_ref)}?expected_context_version=${mutation.expected_context_version}`,
        { method: "DELETE" },
      );
      announce({ kind: "context_detached", sourceRef: `conversation:${mutation.conversation_id}`, targetRef: mutation.target_ref });
      return;
    case "undo_assistant_write":
      return undoAssistantWrite(mutation.tool_call_id);
  }
}

const GONE = new Set([
  "E_NOT_FOUND",
  "E_CONVERSATION_NOT_FOUND",
  "E_FORBIDDEN",
  "E_INVALID_REQUEST",
  "E_RESOURCE_CONFLICT",
  "E_CONTEXT_CHANGED",
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
