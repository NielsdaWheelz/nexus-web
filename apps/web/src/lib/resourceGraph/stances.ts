/**
 * User stance mutation client (supports/contradicts). Mirrors
 * `nexus/schemas/resource_graph.py` (PutStanceRequest/StanceOut). One PUT replaces
 * the single directed stance on an unordered pair — there is no client
 * delete-then-create.
 */

import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";
import type { ConnectionOut } from "./connections";

export interface PutStanceInput {
  sourceRef: string;
  targetRef: string;
  kind: "supports" | "contradicts";
}

export interface StanceOut {
  connection: ConnectionOut;
}

interface StanceResponse {
  data: StanceOut;
}

export async function putStance(input: PutStanceInput): Promise<StanceOut> {
  const response = await apiFetch<StanceResponse>("/api/resource-graph/stances", {
    method: "PUT",
    body: JSON.stringify({
      source_ref: input.sourceRef,
      target_ref: input.targetRef,
      kind: input.kind,
    }),
  });
  return response.data;
}

export async function deleteStance(stanceId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/stances/${stanceId}` as ApiPath, {
    method: "DELETE",
  });
}
