/**
 * The resource graph's http client: connection reads, link commands, and the one
 * owner-named removal of each fact. Committed link changes are announced to
 * subscribers (outlines, panes) after success only.
 */
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { dismissDiscoveryLink } from "@/lib/connectionDiscovery";
import { enqueueWrite } from "@/lib/notes/writes";
import { publishChange } from "@/lib/api/changes";
import { parseResourceRef } from "./resourceRef";
import { RESOURCE_CAPABILITIES } from "@/lib/resources/resourceCapabilities";
import { undoAssistantWrite } from "@/lib/assistantWrites";

export type ConnectionOut = Schema<"ConnectionOut">;
export type ConnectionMutation = NonNullable<ConnectionOut["mutation"]>;
export type InsertionSource = Schema<"InsertLink">["source"];
export type LinkTarget = Schema<"InsertLink">["target"];
export type Position = Schema<"Position">;
export type InsertionOut = Schema<"InsertionOut">;
/** Capability belongs to this resource's canonical identity, not its action owner. */
export function endpointForResource(ref: string): LinkTarget | null {
  const parsed = parseResourceRef(ref);
  if (!parsed) return null;
  const mode = RESOURCE_CAPABILITIES[parsed.scheme].link_mode;
  return mode === "none" ? null : mode === "direct" ? { kind: "resource", ref } : { kind: "passage", candidate_ref: ref };
}
export type LinkMutation =
  | { kind: "created"; sourceRef: string; targetRef: string }
  | { kind: "deleted"; linkId: string }
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
  for (const listener of listeners) listener(mutation);
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

/** Only the shared queue sends graph writes; insertion ids remain immutable. */
export function graphCommands(commands: Schema<"OutlineCommandsRequest">["commands"]): Promise<Schema<"OutlineCommandsOut">> {
  return new Promise((resolve, reject) => enqueueWrite<Schema<"OutlineCommandsOut">>({
    build: () => ({ path: "/api/resource-graph/commands", method: "POST", body: { commands } }),
    settle(reply) { acknowledgeGraphCommands(reply); resolve(reply); },
    fail: reject,
  }));
}

export function acknowledgeGraphCommands(reply: Schema<"OutlineCommandsOut">): void {
  publishChange("Notes");
  for (const result of reply.insertions) {
    const { source, target } = result.connection;
    announce({ kind: "created", sourceRef: source.ref, targetRef: target.ref });
  }
}
export async function createLink(input: Omit<Schema<"InsertLink">, "kind">): Promise<InsertionOut> {
  const result = await graphCommands([{ kind: "insert_link", ...input }]);
  return result.insertions[0]!;
}
export async function insertNote(input: Omit<Schema<"InsertNote">, "kind">): Promise<InsertionOut> {
  const result = await graphCommands([{ kind: "insert_note", ...input }]);
  return result.insertions[0]!;
}
export async function deleteLink(linkId: string): Promise<void> {
  await graphCommands([{ kind: "unlink", link_id: linkId }]);
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
