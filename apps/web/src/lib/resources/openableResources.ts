import type { Presence } from "@/lib/api/presence";
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";

export interface ResourceOpenableSearchRequest {
  q: string;
  schemes: Presence<readonly ResourceScheme[]>;
  signal?: AbortSignal;
}
export type ResourceOpenableSearchResponse = Schema<"ResourceOpenableSearchResponse">;

export async function searchOpenableResources(
  request: ResourceOpenableSearchRequest,
): Promise<ResourceOpenableSearchResponse> {
  const response = await apiFetch<ApiJson<"/resource-items/openables/search", "post">>(
    "/api/resource-items/openables/search", {
      method: "POST", signal: request.signal,
      body: JSON.stringify({ q: request.q, schemes: request.schemes }),
    },
  );
  return response.data;
}
