/**
 * Target-search client: `POST /resource-items/targets/search`. One request
 * shape serves both the `purpose=link` hybrid profile (may embed, may emit
 * passage candidates) and the `purpose=reference` lexical profile (1-char,
 * direct-target-only, never embeds) — universal-link-authoring-hard-cutover.md
 * §Resource Target Search. Uses the owned generated request and response.
 *
 * `candidateRef` on a passage target is transient — reloaded and re-validated
 * at Link confirmation, never persisted here. This client returns whatever
 * ref the backend already resolved; it never maps a search-result type to a
 * ResourceRef itself (spec rule 9 / AC9).
 */

import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";

export type ResourceTargetSearchPurpose = Schema<"ResourceTargetSearchRequest">["purpose"];
export type ResourceTarget =
  ApiJson<"/resource-items/targets/search", "post">["data"]["targets"][number];

export async function searchResourceTargets(
  input: {
    q: string;
    purpose: ResourceTargetSearchPurpose;
    /** Source self-exclusion and existing-link identity. */
    sourceRef?: string;
    schemes?: readonly ResourceScheme[];
    excludeRefs?: readonly string[];
    cursor?: string;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<ApiJson<"/resource-items/targets/search", "post">["data"]> {
  const response = await apiFetch<ApiJson<"/resource-items/targets/search", "post">>(
    "/api/resource-items/targets/search",
    {
      method: "POST",
      signal,
      body: JSON.stringify({
        q: input.q,
        purpose: input.purpose,
        source_ref: input.sourceRef,
        schemes: input.schemes,
        exclude_refs: input.excludeRefs ?? [],
        cursor: input.cursor,
        limit: input.limit,
      }),
    },
  );
  return response.data;
}
