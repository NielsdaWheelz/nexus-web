/**
 * The resource graph's http client: connection reads, link commands, and the one
 * owner-named removal of each fact. Committed link changes are announced to
 * subscribers (outlines, panes) after success only. Unlink retries the selected
 * uuid through the write queue; context detachment retains its version fence.
 */
import { ApiError, apiFetch, apiTransportFeedback, isApiError, isSameSystemApiDefect, outcomeUnknown } from "@/lib/api/client";
import { assertNever } from "@/lib/assertNever";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { admitWriting, captureLane, type WritingAck, type WritingCommand } from "@/lib/notes/writes";
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
export type WritingInsertion = WritingAck["insertions"][number];
/** Resolve a result by requested identity; array ordering is never causal evidence. */
export function insertionTarget(ack: WritingAck, insertion: WritingInsertion): string {
  const link = ack.links.find(item => item.link_id === insertion.canonical_link_id);
  if (!link) throw new ApiError(409, "E_WRITING_DEPENDENCY_GONE", "the saved link is no longer available");
  return link.source_ref === insertion.source_ref ? link.target_ref : link.source_ref;
}
/** Capability belongs to this resource's canonical identity, not its action owner. */
export function endpointForResource(ref: string): LinkTarget | null {
  const parsed = parseResourceRef(ref);
  if (!parsed) return null;
  const mode = RESOURCE_CAPABILITIES[parsed.scheme].link_mode;
  return mode === "none" ? null : mode === "direct" ? { kind: "resource", ref } : { kind: "passage", candidate_ref: ref, passage_target: null };
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

/** Absolute commands are immutable after admission; a retry reuses its sealed bytes. */
export async function graphCommands(commands: WritingCommand[]): Promise<WritingAck> {
  return admitWriting({ kind: "outline", commands }).settled;
}

/** Called once by the account's committed acknowledgement receiver. */
export function acknowledgeGraphCommands(reply: WritingAck): void {
  for (const ref of reply.deleted_refs) announceResourceDeletion(ref);
  announceLinkDeletions({ linkIds: reply.removed_link_ids, origin: null });
  for (const link of reply.links)
    announce({ kind: "created", sourceRef: link.source_ref, targetRef: link.target_ref });
}
export async function createLink(input: Omit<Schema<"InsertLink">, "kind" | "require_created">): Promise<WritingInsertion> {
  const ref = input.source.kind === "resource" ? input.source.ref : input.source.kind === "daily_page" ? `page:${input.source.page_id}` : null;
  if (input.position !== null && ref === null)
    throw new ApiError(409, "E_RESOURCE_CONFLICT", "the captured destination cannot supply a placement version");
  const position = input.position === null ? null : {
    after: input.position.after,
    expected_links_version: captureLane(ref!, "links", input.position.expected_links_version),
  };
  const result = await graphCommands([{ kind: "insert_link", ...input, position, require_created: false }]);
  const insertion = result.insertions.find(item => item.requested_link_id === input.link_id);
  if (!insertion) throw new ApiError(409, "E_WRITING_DEPENDENCY_GONE", "this link is no longer available");
  return insertion;
}
export async function insertNote(input: Omit<Schema<"InsertNote">, "kind">): Promise<WritingInsertion> {
  const ref = input.source.kind === "resource" ? input.source.ref : input.source.kind === "daily_page" ? `page:${input.source.page_id}` : null;
  if (input.position !== null && ref === null)
    throw new ApiError(409, "E_RESOURCE_CONFLICT", "the captured destination cannot supply a placement version");
  const result = await graphCommands([{ kind: "insert_note", ...input, position: input.position === null ? null : {
    after: input.position.after, expected_links_version: captureLane(ref!, "links", input.position.expected_links_version),
  } }]);
  const insertion = result.insertions.find(item => item.requested_link_id === input.link_id);
  if (!insertion) throw new ApiError(409, "E_WRITING_DEPENDENCY_GONE", "this note is no longer available");
  return insertion;
}
export async function deleteLink({ linkId }: { linkId: string }): Promise<void> {
  await graphCommands([{ kind: "unlink", link_id: linkId, expected: null }]);
}

/** The origin has already finalized its own local state before notifying observers. */
export function announceLinkDeletions(input: { linkIds: readonly string[]; origin: object | null }): void {
  for (const linkId of input.linkIds) announce({ kind: "deleted", linkId, origin: input.origin });
}

/** The server names the owning command; provenance alone never authorizes removal. */
export async function mutateConnection(
  command: ConnectionCommand,
): Promise<void> {
  switch (command.kind) {
    case "unlink":
      return deleteLink({ linkId: command.link_id });
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
  if (outcomeUnknown(error)) {
    return {
      tone: "Warning",
      title: "couldn’t confirm removal",
      requestId,
    };
  }
  const transport = apiTransportFeedback(error, "couldn’t remove connection");
  if (transport !== null) return transport;
  if (GONE.has(code)) {
    return {
      tone: "Warning",
      title: "this connection can’t be removed here",
      requestId,
    };
  }
  throw error;
}
