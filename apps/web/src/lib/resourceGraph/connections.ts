import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

export type ConnectionActionEndpointOut = Schema<"ConnectionEndpointOut"> & {
  actionSubject: ResourceActionSubject;
};
export type ConnectionOut = Omit<Schema<"ConnectionOut">, "source" | "target" | "other"> & {
  source: ConnectionActionEndpointOut;
  target: ConnectionActionEndpointOut;
  other: ConnectionActionEndpointOut;
};
export type ConnectionPage = Omit<Schema<"ConnectionPageOut">, "items"> & {
  items: ConnectionOut[];
};
export type QueryConnectionsInput = Omit<Schema<"ConnectionQueryRequest">, "rollup" | "limit"> &
  Partial<Pick<Schema<"ConnectionQueryRequest">, "rollup" | "limit">>;

function endpointForActions(endpoint: Schema<"ConnectionEndpointOut">): ConnectionActionEndpointOut {
  return { ...endpoint, actionSubject: { ref: assumeCanonicalResourceRef(endpoint.ref) } };
}

/** Add the canonical action identity to native connection endpoints. */
export function connectionForActions(connection: Schema<"ConnectionOut">): ConnectionOut {
  return {
    ...connection,
    source: endpointForActions(connection.source),
    target: endpointForActions(connection.target),
    other: endpointForActions(connection.other),
  };
}

export async function queryConnections(
  input: QueryConnectionsInput,
  options: { signal?: AbortSignal } = {},
): Promise<ConnectionPage> {
  const { data } = await apiFetch<ApiJson<"/resource-graph/connections/query", "post">>(
    "/api/resource-graph/connections/query",
    { method: "POST", signal: options.signal, body: JSON.stringify(input) },
  );
  return { ...data, items: data.items.map(connectionForActions) };
}
