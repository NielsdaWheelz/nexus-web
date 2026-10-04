/** The confirming feature freezes its mutation id so retries replay the same Link. */
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ResourceTarget } from "@/lib/resources/resourceTargets";
import { connectionForActions, type ConnectionOut } from "./connections";

export type LinkSource = Schema<"CreateLinkRequest">["source"];
export type LinkTarget = Schema<"CreateLinkRequest">["target"];
export type CreateLinkOut = Omit<Schema<"CreateLinkOut">, "connection"> & {
  connection: ConnectionOut;
};

export function toLinkTarget(target: ResourceTarget): LinkTarget {
  return target.kind === "resource"
    ? { kind: "resource", ref: target.item.ref }
    : { kind: "passage", candidate_ref: target.candidateRef };
}

export function targetLabel(target: ResourceTarget): string {
  return target.kind === "resource" ? target.item.label : target.label;
}

/** Committed generic link actions invalidate the same graph used by writing surfaces. */
export type LinkMutation =
  | { kind: "created"; sourceRef: string; targetRef: string }
  | { kind: "deleted"; linkId: string };

const linkMutationListeners = new Set<(mutation: LinkMutation) => void>();

export function subscribeLinkMutations(listener: (mutation: LinkMutation) => void): () => void {
  linkMutationListeners.add(listener);
  return () => { linkMutationListeners.delete(listener); };
}

export async function createLink(input: {
  clientMutationId: string;
  source: LinkSource;
  target: LinkTarget;
}): Promise<CreateLinkOut> {
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
  const result = { ...data, connection: connectionForActions(data.connection) };
  const mutation: LinkMutation = { kind: "created", sourceRef: result.connection.source_ref, targetRef: result.connection.target_ref };
  for (const listener of linkMutationListeners) listener(mutation);
  return result;
}

export async function deleteLink(linkId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/links/${linkId}`, { method: "DELETE" });
  const mutation: LinkMutation = { kind: "deleted", linkId };
  for (const listener of linkMutationListeners) listener(mutation);
}
