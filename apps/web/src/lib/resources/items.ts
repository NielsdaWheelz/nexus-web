import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";

/** A resource's identity for this viewer; open it with `activateResource(item.activation, …)`. */
export type ResourceItem = Schema<"ResourceItemOut">;

/** One ref's item; an invisible ref comes back `missing` with a none activation. */
export async function resolveResourceItem(
  ref: string,
  signal?: AbortSignal,
  readingRef: string | null = null,
): Promise<ResourceItem> {
  const parameters = readingRef === null ? "" : `?${new URLSearchParams({ reading_media_id: readingRef.replace(/^media:/u, "") })}`;
  const response = await apiFetch<
    ApiJson<"/resource-items/{resource_ref}", "get">
  >(`/api/resource-items/${encodeURIComponent(ref)}${parameters}`, {
    signal,
    cache: "no-store",
  });
  return response.data;
}
