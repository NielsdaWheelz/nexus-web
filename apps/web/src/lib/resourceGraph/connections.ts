import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

export const EDGE_KINDS = ["context", "supports", "contradicts"] as const;
export type EdgeKind = Schema<"ConnectionOut">["kind"];
export const EDGE_ORIGINS = [
  "user", "citation", "system", "note_body", "highlight_note", "discovery",
  "document_embed", "assistant", "link_note",
] as const satisfies readonly Schema<"ConnectionOut">["origin"][];
export type EdgeOrigin = Schema<"ConnectionOut">["origin"];

export type ConnectionEndpointOut = Omit<Schema<"ConnectionEndpointOut">, "activation"> & {
  activation: ResourceActivation;
};
export type ConnectionActionEndpointOut = ConnectionEndpointOut & {
  actionSubject: ResourceActionSubject;
};
export type ConnectionCitationOut = Omit<Schema<"ConnectionCitationOut">, "activation"> & {
  activation: ResourceActivation;
};
export type ConnectionReaderTargetOut = Schema<"ConnectionReaderTargetOut">;
export type ConnectionLinkNoteOut = Schema<"ConnectionLinkNoteOut">;
export type ConnectionOut = Omit<Schema<"ConnectionOut">, "source" | "target" | "other" | "citation"> & {
  source: ConnectionActionEndpointOut;
  target: ConnectionActionEndpointOut;
  other: ConnectionActionEndpointOut;
  citation: ConnectionCitationOut | null;
};
export type ConnectionPage = Omit<Schema<"ConnectionPageOut">, "items"> & { items: ConnectionOut[] };
export type QueryConnectionsInput = Schema<"ConnectionQueryRequest">;

export function projectConnectionActivation(value: Schema<"ConnectionActivationOut">): ResourceActivation {
  return {
    resourceRef: value.resource_ref,
    kind: value.kind,
    href: value.href,
    unresolvedReason: value.unresolved_reason,
  };
}

function projectEndpoint(value: Schema<"ConnectionEndpointOut">): ConnectionActionEndpointOut {
  return {
    ...value,
    activation: projectConnectionActivation(value.activation),
    // justify-type-assertion: this generated field is a canonical backend ref;
    // the product brand cannot survive JSON serialization.
    actionSubject: { ref: value.ref as CanonicalResourceRef },
  };
}

export function projectConnection(value: Schema<"ConnectionOut">): ConnectionOut {
  return {
    ...value,
    source: projectEndpoint(value.source),
    target: projectEndpoint(value.target),
    other: projectEndpoint(value.other),
    citation: value.citation === null ? null : {
      ...value.citation,
      activation: projectConnectionActivation(value.citation.activation),
    },
  };
}

export async function queryConnections(
  input: QueryConnectionsInput,
  options: { signal?: AbortSignal } = {},
): Promise<ConnectionPage> {
  const response = await apiFetch<ApiJson<"/resource-graph/connections/query", "post">>(
    "/api/resource-graph/connections/query",
    { method: "POST", signal: options.signal, body: JSON.stringify(input) },
  );
  return { ...response.data, items: response.data.items.map(projectConnection) };
}
