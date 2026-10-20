/**
 * The resource graph's http client: connection reads, link commands, and the one
 * owner-named removal of each fact. Committed link changes are announced to
 * subscribers (outlines, panes) after success only. Unlink retries the selected
 * uuid through the write queue; context detachment retains its version fence.
 */
import { ApiError, apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { assertNever } from "@/lib/assertNever";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { enqueueWrite, wakeCancelledWrite } from "@/lib/notes/writes";
import { publishChange } from "@/lib/api/changes";
import { parseResourceRef } from "./resourceRef";
import { RESOURCE_CAPABILITIES } from "@/lib/resources/resourceCapabilities";

export type ConnectionOut = Schema<"ConnectionOut">;
export type ConnectionMutation = NonNullable<ConnectionOut["mutation"]>;
export type ConnectionCommand =
  | { kind: "unlink"; link_id: string }
  | Extract<ConnectionMutation, { kind: "detach_context" }>;
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
  for (const listener of listeners) {
    try { listener(mutation); }
    catch (error) { reportError(error); }
  }
}

/** Announce only confirmed absence or acknowledged resource teardown. */
export function announceResourceDeletion(ref: string): void {
  if (deletedResources.has(ref)) return;
  deletedResources.add(ref);
  announce({ kind: "resource_deleted", ref });
  wakeCancelledWrite();
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

/** Known deletion fences every queued graph creator, including a daily proposal. */
export function commandsReferToDeletedResource(commands: Schema<"OutlineCommandsRequest">["commands"]): boolean {
  return commands.some(command => {
    if ("endpoint" in command && isDeletedResource(command.endpoint)) return true;
    if ("destination" in command && typeof command.destination === "string" && isDeletedResource(command.destination)) return true;
    if ("note_id" in command && isDeletedResource(`note_block:${command.note_id}`)) return true;
    if ("page_id" in command && isDeletedResource(`page:${command.page_id}`)) return true;
    const endpoints = [...("source" in command ? [command.source] : []), ...("target" in command ? [command.target] : [])];
    return endpoints.some(endpoint => endpoint.kind === "resource" ? isDeletedResource(endpoint.ref) : endpoint.kind === "daily_page" ? isDeletedResource(`page:${endpoint.page_id}`) : false);
  });
}

/** Only the shared queue sends graph writes; insertion ids remain immutable. */
export function graphCommands(commands: Schema<"OutlineCommandsRequest">["commands"], retrying?: (error: unknown) => void): Promise<Schema<"OutlineCommandsOut">> {
  return new Promise((resolve, reject) => enqueueWrite<Schema<"OutlineCommandsOut">>({
    cancelled: () => commandsReferToDeletedResource(commands),
    cancel: () => reject(new ApiError(404, "E_NOT_FOUND", "a resource used by this change is no longer available")),
    build: () => ({ path: "/api/resource-graph/commands", method: "POST", body: { commands } }),
    settle(reply) { resolve(reply); acknowledgeGraphCommands(reply); },
    fail: reject,
    retrying,
  }));
}

export function acknowledgeGraphCommands(reply: Schema<"OutlineCommandsOut">): void {
  publishChange("Notes");
  for (const result of reply.insertions) {
    const { source, target } = result.connection;
    announce({ kind: "created", sourceRef: source.ref, targetRef: target.ref });
  }
}
export async function createLink(input: Omit<Schema<"InsertLink">, "kind" | "require_created">): Promise<InsertionOut> {
  const result = await graphCommands([{ kind: "insert_link", ...input, require_created: false }]);
  return result.insertions[0]!;
}
export async function insertNote(input: Omit<Schema<"InsertNote">, "kind">): Promise<InsertionOut> {
  const result = await graphCommands([{ kind: "insert_note", ...input }]);
  return result.insertions[0]!;
}
export async function deleteLink({ linkId, requireUnannotated }: { linkId: string; requireUnannotated: boolean }, retrying?: (error: unknown) => void): Promise<void> {
  await graphCommands([{ kind: "unlink", link_id: linkId, require_unannotated: requireUnannotated }], retrying);
  announceLinkDeletions({ linkIds: [linkId], origin: null });
}

/** The origin has already finalized its own local state before notifying observers. */
export function announceLinkDeletions(input: { linkIds: readonly string[]; origin: object | null }): void {
  for (const linkId of input.linkIds) announce({ kind: "deleted", linkId, origin: input.origin });
}

/** The server names the owning command; provenance alone never authorizes removal. */
export async function mutateConnection(
  command: ConnectionCommand,
  retrying?: (error: unknown) => void,
): Promise<void> {
  switch (command.kind) {
    case "unlink":
      return deleteLink({ linkId: command.link_id, requireUnannotated: false }, retrying);
    case "detach_context":
      await apiFetch(
        `/api/conversations/${command.conversation_id}/context/${encodeURIComponent(command.target_ref)}?expected_context_version=${command.expected_context_version}`,
        { method: "DELETE" },
      );
      announce({ kind: "context_detached", sourceRef: `conversation:${command.conversation_id}`, targetRef: command.target_ref });
      return;
  }
  return assertNever(command);
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
      title: "couldn’t confirm removal",
      requestId,
    };
  }
  if (GONE.has(code)) {
    return {
      tone: "Warning",
      title: "this connection can’t be removed here",
      requestId,
    };
  }
  throw error;
}
