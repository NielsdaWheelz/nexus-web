/** The sole user-link transport. Callers retain the mutation id with its intent. */
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ResourceTarget } from "@/lib/resources/resourceTargets";
import { projectConnection, type ConnectionOut } from "./connections";

export type LinkSource = Schema<"CreateLinkRequest">["source"];
export type LinkTarget = Schema<"CreateLinkRequest">["target"];
export type LinkFragmentSelectionSource = Schema<"LinkFragmentSelectionSource">;
export type LinkPdfSelectionSource = Schema<"LinkPdfSelectionSource">;
export type CreateLinkInput = Omit<Schema<"CreateLinkRequest">, "client_mutation_id"> & {
  clientMutationId: string;
};
export type CreateLinkOut = Omit<Schema<"CreateLinkOut">, "connection"> & { connection: ConnectionOut };
export type LinkNoteOut = Omit<Schema<"LinkNoteOut">, "connection"> & { connection: ConnectionOut };

export function toLinkTarget(target: ResourceTarget): LinkTarget {
  return target.kind === "resource"
    ? { kind: "resource", ref: target.item.ref }
    : { kind: "passage", candidate_ref: target.candidateRef };
}

export function targetLabel(target: ResourceTarget): string {
  return target.kind === "resource" ? target.item.label : target.label;
}

export type LinkMutation =
  | { kind: "created"; sourceRef: string; targetRef: string }
  | { kind: "deleted"; linkId: string };
const linkMutationListeners = new Set<(mutation: LinkMutation) => void>();
export function subscribeLinkMutations(listener: (mutation: LinkMutation) => void): () => void {
  linkMutationListeners.add(listener);
  return () => { linkMutationListeners.delete(listener); };
}

export async function createLink(input: CreateLinkInput): Promise<CreateLinkOut> {
  const response = await apiFetch<ApiJson<"/resource-graph/links", "post">>(
    "/api/resource-graph/links", {
      method: "POST",
      body: JSON.stringify({
        client_mutation_id: input.clientMutationId, source: input.source, target: input.target,
      } satisfies Schema<"CreateLinkRequest">),
    },
  );
  const result = { ...response.data, connection: projectConnection(response.data.connection) };
  const mutation: LinkMutation = {
    kind: "created", sourceRef: result.connection.source_ref, targetRef: result.connection.target_ref,
  };
  for (const listener of linkMutationListeners) listener(mutation);
  return result;
}

export async function deleteLink(linkId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/links/${linkId}`, { method: "DELETE" });
  for (const listener of linkMutationListeners) listener({ kind: "deleted", linkId });
}

export function projectLinkNote(value: Schema<"LinkNoteOut">): LinkNoteOut {
  return { ...value, connection: projectConnection(value.connection) };
}
