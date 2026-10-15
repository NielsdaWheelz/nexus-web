import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";

/** A resource's identity for this viewer; open it with `activateResource(item.activation, …)`. */
export type ResourceItem = Schema<"ResourceItemOut">;

/** One ref's item; an invisible ref comes back `missing` with a none activation. */
export async function resolveResourceItem(
  ref: string,
  signal?: AbortSignal,
): Promise<ResourceItem> {
  const response = await apiFetch<
    ApiJson<"/resource-items/{resource_ref}", "get">
  >(`/api/resource-items/${encodeURIComponent(ref)}`, {
    signal,
    cache: "no-store",
  });
  return response.data;
}

/** Visible, route-activatable items for nexus find. */
export async function searchOpenableResources(request: {
  q: string;
  schemes: readonly ResourceScheme[] | null;
  signal?: AbortSignal;
}) {
  const response = await apiFetch<
    ApiJson<"/resource-items/openables/search", "post">
  >("/api/resource-items/openables/search", {
    method: "POST",
    signal: request.signal,
    body: JSON.stringify({ q: request.q, schemes: request.schemes }),
  });
  return response.data;
}
