/** One typed search for visible resources and passage candidates. */
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";

export interface ResourceTargetSearchInput {
  q: string;
  sourceRef?: string;
  schemes?: readonly ResourceScheme[];
  excludeRefs?: readonly string[];
  cursor?: string;
  limit?: number;
}
export type ResourceTargetResource = Schema<"ResourceTargetResourceOut">;
export type ResourceTargetPassage = Schema<"ResourceTargetPassageOut">;
export type ResourceTarget = ResourceTargetResource | ResourceTargetPassage;
export type ResourceTargetSearchResult = Schema<"ResourceTargetSearchResponse">;

export async function searchResourceTargets(
  input: ResourceTargetSearchInput,
  signal?: AbortSignal,
): Promise<ResourceTargetSearchResult> {
  const response = await apiFetch<ApiJson<"/resource-items/targets/search", "post">>(
    "/api/resource-items/targets/search", {
      method: "POST", signal,
      body: JSON.stringify({
        q: input.q, source_ref: input.sourceRef, schemes: input.schemes,
        exclude_refs: input.excludeRefs ?? [], cursor: input.cursor, limit: input.limit,
      }),
    },
  );
  return response.data;
}
